/* Телефония: приёмник событий АТС, пульт оператора, звонки и записи.
 *
 * Как это работает целиком (пункт int-novofon, ТЗ — «Учёткин — телефония
 * Новофон, запрос и ТЗ», часть II):
 *
 *   АТС ──событие──▶ /api/webhooks/novofon ──▶ строка в calls + шина ──SSE──▶ пульт
 *   пульт ──«позвонить»──▶ /api/calls/dial ──▶ АТС звонит оператору, потом клиенту
 *   АТС ──«кому звонить»──▶ /api/webhooks/novofon/routing ──▶ кто сейчас на линии
 *   АТС ──«запись готова»──▶ пометка ──фоном──▶ бакет записей ──▶ ссылка в карточке
 *
 * Голос через CRM не идёт: у оператора рядом софтфон Новофона (вариант А из
 * части I ТЗ), а система показывает карточку, ведёт историю и звонит по кнопке.
 * Веб-телефон в браузере — вторая очередь, отдельным решением после запуска.
 *
 * Приёмник отвечает АТС сразу: она ждёт ответа пару секунд и при задержке
 * повторяет доставку, а клиент в это время слушает гудок. Поэтому в обработчике
 * только запись события и подъём карточки — ни похода за файлом записи, ни
 * обращений к АТС.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireUser } from '../auth.ts';
import { ApiError, notFound } from '../errors.ts';
import { normPhone } from '../../db.ts';
import { canCall, canReceive, cabinetUrls, NOVOFON_IP, type NovofonConfig } from '../../novofon/config.ts';
import { checkV1Event, isKnownV1Event, sameSecret } from '../../novofon/signature.ts';
import { parseEvent, type CallEvent } from '../../novofon/events.ts';
import { markRecorded, takeOne } from '../../novofon/recordings.ts';
import { RECORD_CONTENT_TYPE } from '../../storage.ts';

/** Сколько живёт ссылка на запись разговора. Столько же, сколько ссылка на
 *  снимок акта: её хватает, чтобы дослушать, и мало, чтобы передать дальше. */
const RECORD_URL_TTL_S = 15 * 60;

/** Карточка клиента для полосы входящего: кто звонит и что с ним уже было.
 *  Ищем по последним десяти цифрам — в базе номера лежат в разных видах. */
async function clientCard(app: FastifyInstance, phone: string) {
  const norm = normPhone(phone);
  const { rows: clients } = await app.db.query<Record<string, unknown>>(
    'SELECT * FROM clients WHERE phone_norm = $1', [norm]);
  const { rows: history } = await app.db.query<Record<string, unknown>>(
    `SELECT r.id, r.date::text AS date, r.city, r.street, r.house, r.flat, r.name, r.status
       FROM requests r WHERE r.phone_norm = $1
      ORDER BY r.date DESC, r.id DESC LIMIT 10`, [norm]);
  return { phone: norm, client: clients[0] ?? null, history };
}

/** Кому показать полосу входящего: оператору, на чей внутренний номер идёт
 *  вызов. Номер неизвестен (АТС звонит всей группе) — показываем всем, кто на
 *  смене: лишняя карточка у соседа безобиднее, чем её отсутствие у того, кто
 *  снял трубку. */
async function operatorByExt(app: FastifyInstance, ext: string | null): Promise<string | null> {
  if (!ext) return null;
  const { rows } = await app.db.query<{ id: string }>(
    'SELECT id FROM staff WHERE ext = $1 AND blocked_at IS NULL', [ext]);
  return rows[0]?.id ?? null;
}

/** Событие АТС → строка в `calls`. Повторная доставка того же события не
 *  заводит второй звонок: АТС повторяет доставку по своему усмотрению, и
 *  идемпотентность здесь обязательна (общие требования ТЗ, раздел 12). */
async function saveCall(app: FastifyInstance, ev: CallEvent, operatorId: string | null): Promise<string | null> {
  const clientPhone = ev.direction === 'входящий' ? normPhone(ev.from) : normPhone(ev.to);
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO calls (pbx_id, platform, direction, from_number, to_number, client_phone, started,
        duration_sec, disposition, answered_at, ended_at, operator_id, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             (SELECT id FROM clients WHERE phone_norm = $6))
     ON CONFLICT (pbx_id) DO UPDATE SET
        duration_sec = COALESCE(EXCLUDED.duration_sec, calls.duration_sec),
        disposition  = COALESCE(EXCLUDED.disposition, calls.disposition),
        answered_at  = COALESCE(EXCLUDED.answered_at, calls.answered_at),
        ended_at     = COALESCE(EXCLUDED.ended_at, calls.ended_at),
        operator_id  = COALESCE(EXCLUDED.operator_id, calls.operator_id),
        client_id    = COALESCE(calls.client_id, EXCLUDED.client_id)
     RETURNING id::text`,
    [ev.sessionId, ev.platform, ev.direction, ev.from, ev.to, clientPhone, ev.at,
      ev.durationSec, ev.disposition,
      ev.kind === 'ответ' ? ev.at : null,
      ev.kind === 'завершение' || ev.kind === 'пропущен' ? ev.at : null,
      operatorId]);
  return rows[0]?.id ?? null;
}

/** Разбор события: строка звонка, карточка клиента, толчок на пульт.
 *  Вынесен из обработчика, потому что тем же путём идут события эмулятора
 *  в сквозной проверке. */
export async function handleEvent(app: FastifyInstance, ev: CallEvent): Promise<{ callId: string | null }> {
  if (ev.kind === 'запись') {
    await markRecorded(app.db, ev.sessionId, ev.recordRef);
    const { rows } = await app.db.query<{ id: string; started: string; record_ref: string | null; pbx_id: string }>(
      'SELECT id::text, started, record_ref, pbx_id FROM calls WHERE pbx_id = $1', [ev.sessionId]);
    const call = rows[0];
    // Файл тянем после ответа АТС и по ссылке из события: она живёт недолго,
    // а следующий подход очереди — через минуты.
    if (call) {
      setImmediate(() => {
        void takeOne({ db: app.db, store: app.records, api: app.novofon, log: (m, e) => app.log.warn({ err: e }, m) },
          { id: call.id, pbx_id: call.pbx_id, record_ref: call.record_ref, record_tries: 0, started: call.started },
          ev.recordUrl);
      });
    }
    app.calls.publish({ kind: 'запись', to: null, call_id: call?.id ?? null, session_id: ev.sessionId });
    return { callId: call?.id ?? null };
  }

  const operatorId = await operatorByExt(app, ev.internal);
  const callId = await saveCall(app, ev, operatorId);
  const card = ev.direction === 'входящий' ? await clientCard(app, ev.from) : null;
  app.calls.publish({
    kind: ev.kind,
    to: operatorId,
    call_id: callId,
    session_id: ev.sessionId,
    direction: ev.direction,
    from: ev.from,
    to_number: ev.to,
    at: ev.at,
    duration_sec: ev.durationSec,
    disposition: ev.disposition,
    ...(card ?? {}),
  });
  return { callId };
}

/** Тело уведомления: 1.0 шлёт форму, платформа 2.0 — JSON или параметры в
 *  адресе. Складываем всё в один объект — разбирать его будет events.ts. */
function payloadOf(req: FastifyRequest): Record<string, unknown> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  return { ...query, ...body };
}

/** Подлинность уведомления. У двух линий она подтверждается по-разному, и это
 *  не наш выбор: подпись есть только у API 1.0 (см. novofon/signature.ts). */
function checkIncoming(cfg: NovofonConfig, req: FastifyRequest, payload: Record<string, unknown>): void {
  if (!canReceive(cfg)) throw new ApiError(503, 'Приёмник звонков не настроен: не задан NOVOFON_WEBHOOK_SECRET.');
  if (cfg.allowedIps.length && !cfg.allowedIps.includes(req.ip)) {
    throw new ApiError(403, `Уведомление пришло с адреса ${req.ip}, которого нет в списке разрешённых.`);
  }
  if (cfg.platform === 'v1') {
    const event = String(payload.event ?? '');
    if (!isKnownV1Event(event)) throw new ApiError(400, `Неизвестное событие ${event || '—'}: подпись для него не описана.`);
    const header = (req.headers.signature ?? req.headers['x-signature']) as string | undefined;
    if (!checkV1Event(payload, header, cfg.secret!)) throw new ApiError(401, 'Подпись уведомления не сходится.');
    return;
  }
  // Платформа 2.0: подписи у уведомлений нет, подтверждает секрет в адресе.
  const { secret } = req.params as { secret?: string };
  if (!sameSecret(secret, cfg.secret!)) throw new ApiError(401, 'Приёмник вызван без секрета в адресе.');
}

const plugin: FastifyPluginAsync = async (app) => {
  const cfg = app.novofonConfig;

  /* ── приёмник уведомлений ────────────────────────────────────────────── */

  const webhook = async (req: FastifyRequest, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    const payload = payloadOf(req);
    let ok = true;
    let failure: unknown = null;
    try {
      checkIncoming(cfg, req, payload);
    } catch (err) {
      ok = false;
      failure = err;
    }
    const ev = ok ? parseEvent(cfg.platform, payload) : null;
    // В журнал идёт всё, включая непринятое: «кто-то стучится с чужой подписью»
    // и «уведомление настроено не теми полями» — это ровно то, что потом
    // приходится искать при разборе жалобы.
    await app.db.query(
      `INSERT INTO call_events (platform, kind, session_id, ok, source_ip, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [cfg.platform, String(payload.event ?? '—'), ev?.sessionId ?? null, ok, req.ip, JSON.stringify(payload)]);
    if (!ok) throw failure;
    if (ev) await handleEvent(app, ev);
    return reply.code(200).send({ accepted: true });
  };

  const WEBHOOK_SCHEMA = {
    tags: ['связь'],
    summary: 'Уведомление о звонке от АТС. 1.0 — подпись в заголовке Signature, 2.0 — секрет в адресе',
    params: { type: 'object', properties: { secret: { type: 'string' } } },
  };
  for (const url of ['/webhooks/novofon', '/webhooks/novofon/:secret']) {
    app.post(url, { schema: WEBHOOK_SCHEMA }, webhook as never);
    // Уведомления платформы 2.0 настраиваются в кабинете и методом GET тоже —
    // выбор делает администратор при создании уведомления.
    app.get(url, { schema: WEBHOOK_SCHEMA }, webhook as never);
  }

  /* ── интерактивная обработка вызова ──────────────────────────────────── */

  /** АТС спрашивает, кому направить входящий. Отвечаем внутренними номерами
   *  тех, кто сейчас на смене и не на паузе. Пустой ответ означал бы «никому»,
   *  поэтому при пустой смене отдаём всех, у кого есть внутренний номер, — и
   *  руководителя тоже: это и есть поведение «звонок идёт всем», как в АТС
   *  сейчас. Поверители без внутреннего номера в список не попадают. */
  const routing = async (req: FastifyRequest) => {
    const payload = payloadOf(req);
    checkIncoming({ ...cfg, platform: 'v2' }, req, payload);
    const { rows: free } = await app.db.query<{ ext: string }>(
      `SELECT s.ext FROM call_line l JOIN staff s ON s.id = l.staff_id
        WHERE l.on_shift AND NOT l.paused AND s.ext IS NOT NULL AND s.blocked_at IS NULL`);
    let phones = free.map((r) => r.ext);
    if (!phones.length) {
      const { rows: all } = await app.db.query<{ ext: string }>(
        `SELECT ext FROM staff WHERE ext IS NOT NULL AND blocked_at IS NULL ORDER BY ext`);
      phones = all.map((r) => r.ext);
    }
    await app.db.query(
      `INSERT INTO call_events (platform, kind, session_id, ok, source_ip, payload)
       VALUES ('v2', 'routing', $1, true, $2, $3)`,
      [String(payload.call_session_id ?? ''), req.ip, JSON.stringify({ ...payload, phones })]);
    return { phones };
  };
  for (const url of ['/webhooks/novofon/routing', '/webhooks/novofon/routing/:secret']) {
    app.get(url, { schema: { tags: ['связь'], summary: 'Кому направить входящий: номера операторов на линии' } }, routing as never);
    app.post(url, { schema: { tags: ['связь'], summary: 'Кому направить входящий: номера операторов на линии' } }, routing as never);
  }

  /* ── поток событий на пульт оператора ────────────────────────────────── */

  app.get('/calls/stream', {
    schema: {
      tags: ['связь'],
      summary: 'Поток событий телефонии для пульта оператора (SSE)',
      security: [{ session: [] }],
    },
  }, async (req, reply) => {
    const user = requireUser(req);
    if (user.role === 'verifier') throw new ApiError(403, 'Пульт оператора доступен операторам и руководителю.');
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Балансировщик и nginx буферизуют ответ и держат события у себя, пока не
      // накопится блок. Для потока это означает карточку через минуту.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': поток событий телефонии открыт\n\n');
    const send = (event: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const off = app.calls.subscribe(user.id, send);
    // Прокси рвут молчащее соединение: пустой комментарий раз в четверть минуты
    // дешевле, чем переподключение браузера каждые тридцать секунд.
    const beat = setInterval(() => reply.raw.write(': тишина\n\n'), 15_000);
    beat.unref?.();
    req.raw.on('close', () => { clearInterval(beat); off(); });
    // Ответ уходит потоком: fastify не должен закрывать его за нас.
    return reply;
  });

  /* ── звонок клиенту из карточки ──────────────────────────────────────── */

  app.post('/calls/dial', {
    schema: {
      tags: ['связь'],
      summary: 'Позвонить клиенту: АТС соединяет оператора с номером',
      security: [{ session: [] }],
      body: {
        type: 'object',
        required: ['phone'],
        properties: { phone: { type: 'string' }, request_id: { type: 'string' } },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    if (user.role === 'verifier') throw new ApiError(403, 'Звонок из системы доступен операторам и руководителю.');
    if (!app.novofon || !canCall(cfg)) {
      throw new ApiError(503, 'Телефония не подключена к этому контуру: звонок делается из софтфона.');
    }
    const { phone, request_id } = req.body as { phone: string; request_id?: string };
    const { rows } = await app.db.query<{ novofon_employee_id: number | null; ext: string | null }>(
      'SELECT novofon_employee_id, ext FROM staff WHERE id = $1', [user.id]);
    const me = rows[0];
    if (!me?.novofon_employee_id) {
      throw new ApiError(422, 'Ваша учётная запись не связана с сотрудником АТС — руководитель настраивает связь на экране телефонии.',
        'novofon-employee');
    }
    // Номер уходит в АТС в международном виде: +7 (912) 345-67-89 она не примет.
    const contact = normPhone(phone).replace('+', '');
    const { sessionId } = await app.novofon.startEmployeeCall({
      contact, employeeId: me.novofon_employee_id, employeePhone: me.ext, externalId: request_id,
    });
    // Строку звонка заведут события АТС: у исходящего это NOTIFY_OUT_START или
    // «Исходящий звонок». Заводить её здесь значит завести вторую.
    return { started: true, session_id: sessionId };
  });

  /* ── смена оператора ─────────────────────────────────────────────────── */

  app.post('/calls/line', {
    schema: {
      tags: ['связь'],
      summary: 'Отметка «на смене» и «на паузе»: в CRM и, если АТС позволяет, в АТС',
      security: [{ session: [] }],
      body: {
        type: 'object',
        required: ['on_shift'],
        properties: { on_shift: { type: 'boolean' }, paused: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    if (user.role === 'verifier') throw new ApiError(403, 'Пульт оператора доступен операторам и руководителю.');
    const { on_shift, paused } = req.body as { on_shift: boolean; paused?: boolean };
    const pause = !!paused;
    let synced = false;
    let error: string | null = null;
    // Отдельного метода «оператор на перерыве» в Data API нет — ближайшее по
    // смыслу меняет доступность номера сотрудника в группе. Если группа или
    // номер не настроены, отметка остаётся только в CRM: входящие всё равно
    // распределяются по ответу интерактивной обработки вызова, а он читает эту
    // же таблицу.
    const { rows } = await app.db.query<{ novofon_phone_number_id: number | null }>(
      'SELECT novofon_phone_number_id FROM staff WHERE id = $1', [user.id]);
    const numberId = rows[0]?.novofon_phone_number_id ?? null;
    if (app.novofon && cfg.groupId && numberId) {
      try {
        await app.novofon.setAvailable(cfg.groupId, numberId, on_shift && !pause);
        synced = true;
      } catch (err) {
        error = (err as Error).message;
        app.log.warn({ err }, 'Отметку линии не приняла АТС');
      }
    }
    await app.db.query(
      `INSERT INTO call_line (staff_id, on_shift, paused, since, synced, sync_error)
       VALUES ($1,$2,$3,now(),$4,$5)
       ON CONFLICT (staff_id) DO UPDATE SET on_shift = EXCLUDED.on_shift, paused = EXCLUDED.paused,
         since = now(), synced = EXCLUDED.synced, sync_error = EXCLUDED.sync_error`,
      [user.id, on_shift, pause, synced, error]);
    return { on_shift, paused: pause, synced, error };
  });

  app.get('/calls/line', {
    schema: { tags: ['связь'], summary: 'Своя отметка линии', security: [{ session: [] }] },
  }, async (req) => {
    const user = requireUser(req);
    const { rows } = await app.db.query(
      'SELECT on_shift, paused, synced, sync_error FROM call_line WHERE staff_id = $1', [user.id]);
    return rows[0] ?? { on_shift: false, paused: false, synced: false, sync_error: null };
  });

  /* ── журнал звонков и записи ─────────────────────────────────────────── */

  app.get('/calls', {
    schema: {
      tags: ['связь'], summary: 'Лента звонков', security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          phone: { type: 'string' }, operator_id: { type: 'string' }, request_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as { phone?: string; operator_id?: string; request_id?: string; limit?: number };
    // Поверителю лента звонков не нужна и не положена: это персональные данные
    // клиентов и разговоры операторов.
    if (user.role === 'verifier') throw new ApiError(403, 'Лента звонков доступна операторам и руководителю.');
    const { rows } = await app.db.query(
      `SELECT c.*, s.full_name AS operator_name FROM calls c
         LEFT JOIN staff s ON s.id = c.operator_id
        WHERE ($1::text IS NULL OR c.client_phone = $1)
          AND ($2::text IS NULL OR c.operator_id = $2)
          AND ($3::text IS NULL OR c.request_id = $3)
        ORDER BY c.started DESC LIMIT $4`,
      [q.phone ? normPhone(q.phone) : null, q.operator_id ?? null, q.request_id ?? null, q.limit ?? 50]);
    // Право слушать запись есть только у руководителя (ТЗ, раздел 12): оператор
    // видит, что запись есть, но ссылку на неё не получает.
    return { calls: rows, may_listen: user.role === 'supervisor' };
  });

  app.post('/calls/:id/request', {
    schema: {
      tags: ['связь'],
      summary: 'Подшить звонок к заявке: из него она и создавалась',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: { type: 'object', required: ['request_id'], properties: { request_id: { type: 'string' } } },
    },
  }, async (req) => {
    const user = requireUser(req);
    if (user.role === 'verifier') throw new ApiError(403, 'Связывать звонок с заявкой могут операторы и руководитель.');
    const { id } = req.params as { id: number };
    const { request_id } = req.body as { request_id: string };
    const { rows } = await app.db.query<{ id: string }>(
      'UPDATE calls SET request_id = $2 WHERE id = $1 RETURNING id::text', [id, request_id]);
    if (!rows[0]) throw notFound(`Нет звонка №${id}.`);
    return { call_id: rows[0].id, request_id };
  });

  app.get('/calls/:id/record', {
    schema: {
      tags: ['связь'],
      summary: 'Запись разговора: ссылка на прослушивание. Каждое обращение попадает в журнал',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    },
  }, async (req) => {
    // Разговор с клиентом — персональные данные обеих сторон, и слушать его
    // может не всякий вошедший. Само обращение пишется в журнал действий
    // отдельным действием «прослушивание» (`src/api/audit.ts`): по 152-ФЗ
    // обращение к записи должно быть видно, даже когда оно законно.
    const user = requireUser(req);
    if (user.role !== 'supervisor') throw new ApiError(403, 'Записи разговоров слушает руководитель.');
    const { id } = req.params as { id: number };
    const { rows } = await app.db.query<{ id: string; record_key: string | null; record_status: string }>(
      'SELECT id::text, record_key, record_status FROM calls WHERE id = $1', [id]);
    const call = rows[0];
    if (!call) throw notFound(`Нет звонка №${id}.`);
    // Запись докачивает фоновая задача уже после звонка, поэтому «записи ещё
    // нет» — обычное состояние свежего разговора, а не сбой.
    if (!call.record_key) {
      throw notFound(call.record_status === 'ждёт'
        ? `Запись звонка №${id} ещё не забрана из АТС.`
        : `У звонка №${id} записи разговора нет.`);
    }
    if (!app.records) throw new ApiError(503, 'Хранилище записей не подключено к этому контуру.');
    return {
      call_id: call.id,
      url: await app.records.viewUrl(call.record_key, RECORD_URL_TTL_S, RECORD_CONTENT_TYPE),
      expires_in: RECORD_URL_TTL_S,
    };
  });

  /* ── настройка кабинета ──────────────────────────────────────────────── */

  app.get('/calls/settings', {
    schema: {
      tags: ['связь'],
      summary: 'Что вписано в кабинет Новофон: адреса приёмников, платформа, связь сотрудников',
      security: [{ session: [] }],
    },
  }, async (req) => {
    const user = requireUser(req);
    if (user.role !== 'supervisor') throw new ApiError(403, 'Настройка телефонии — у руководителя.');
    const { rows: staff } = await app.db.query(
      `SELECT id, full_name, ext, novofon_employee_id, novofon_phone_number_id FROM staff
        WHERE role IN ('operator','senior','supervisor') AND blocked_at IS NULL ORDER BY full_name`);
    return {
      platform: cfg.platform,
      // Адрес приёмника не зашит в коде: он считается от PUBLIC_BASE_URL, и
      // при переезде на боевой домен меняются ровно эти строки — их и надо
      // заменить в кабинете (Настройки → Уведомления).
      public_base_url: cfg.publicBaseUrl,
      urls: cabinetUrls(cfg),
      receiving: canReceive(cfg),
      calling: canCall(cfg),
      records_bucket: app.records?.bucket ?? null,
      novofon_ip: NOVOFON_IP,
      staff,
    };
  });
};

export default plugin;
