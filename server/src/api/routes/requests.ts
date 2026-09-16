/* Заявки: список, карточка, приём, правка, перенос, сдвиг окна и подсказка дат.
 *
 * Здесь живут два правила, из-за которых приём вообще устроен так, как устроен:
 * замок даты (дата ушла под маршруты — оператор на неё больше не записывает) и
 * потолок по городу (план задаёт руководитель, приём закрывается на +10 %).
 * Оба вынесены в `src/rules.ts` и здесь только применяются.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth.ts';
import { notFound, ruleError } from '../errors.ts';
import { bookedIn, bookedOn, loadDay, loadDevices, loadDevicesFor, lockFactsFor, nextId, slotDays } from '../store.ts';
import { normPhone } from '../../db.ts';
import {
  SLOT_MAX, SLOT_MIN, canShift, cityCapProblem, dayState, lockedFor, reqProblem, slotsFor, type Role,
} from '../../rules.ts';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

/** Поля заявки, которые приходят с формы приёма и правки. */
const REQUEST_FIELDS = {
  client_type: { type: 'string', enum: ['Физлицо', 'Юрлицо'] },
  name: { type: 'string' },
  inn: { type: 'string' },
  phone: { type: 'string' },
  contact: { type: 'string' },
  phone2: { type: 'string' },
  contact2: { type: 'string' },
  email: { type: 'string' },
  city: { type: 'string' },
  street: { type: 'string' },
  house: { type: 'string' },
  entrance: { type: 'string' },
  floor: { type: 'string' },
  flat: { type: 'string' },
  intercom: { type: 'boolean' },
  time_slot: { type: 'integer', minimum: SLOT_MIN, maximum: SLOT_MAX },
  comment_operator: { type: 'string' },
  comment_verifier: { type: 'string' },
  svcs: { type: 'array', items: { type: 'string' } },
} as const;

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/requests', {
    schema: {
      tags: ['заявки'],
      summary: 'Список заявок по дате, городу, статусу, маршруту или телефону',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          date: DATE, date_from: DATE, date_to: DATE,
          city: { type: 'string' }, status: { type: 'string' },
          route_id: { type: 'string' }, phone: { type: 'string' },
          free: { type: 'boolean', default: false },
          // Свои заявки: оператору — принятые им, поверителю — выполненные им.
          // Без этого экран заработка тянул бы весь месяц по всей конторе.
          own: { type: 'boolean', default: false },
          // Что приложить к каждой заявке: `devices`, `payment` или оба через запятую.
          // Начисление и оплата считаются по строкам приборов, и запрашивать их
          // заявка за заявкой — это сотни запросов на один экран.
          with: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as Record<string, string | number | boolean | undefined>;
    // Поверитель работает по своим выездам: чужие адреса и телефоны клиентов ему не нужны.
    const mine = user.role === 'verifier' ? user.id : null;
    const { rows } = await app.db.query(
      `SELECT r.*, r.date::text AS date, r.created_date::text AS created_date
         FROM requests r
        WHERE ($1::date IS NULL OR r.date = $1)
          AND ($2::date IS NULL OR r.date >= $2)
          AND ($3::date IS NULL OR r.date <= $3)
          AND ($4::text IS NULL OR r.city = $4)
          AND ($5::text IS NULL OR r.status = $5)
          AND ($6::text IS NULL OR r.route_id = $6)
          AND ($7::text IS NULL OR r.phone_norm = $7)
          AND (NOT $8::boolean OR r.route_id IS NULL)
          AND ($9::text IS NULL OR r.verifier_id = $9
               OR r.route_id IN (SELECT id FROM routes WHERE verifier_id = $9))
          AND ($10::text IS NULL OR r.operator_id = $10 OR r.verifier_id = $10)
        ORDER BY r.date DESC, r.time_slot, r.id
        LIMIT $11 OFFSET $12`,
      [q.date ?? null, q.date_from ?? null, q.date_to ?? null, q.city ?? null, q.status ?? null,
       q.route_id ?? null, q.phone ? normPhone(String(q.phone)) : null, !!q.free, mine,
       q.own ? user.id : null, q.limit ?? 100, q.offset ?? 0]);

    const want = new Set(String(q.with ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    if (rows.length && want.size) {
      const ids = rows.map((r) => String(r.id));
      if (want.has('devices')) {
        const byRequest = await loadDevicesFor(app.db, ids, app.sessionSecret);
        for (const r of rows) r.devices = byRequest.get(String(r.id)) ?? [];
      }
      if (want.has('payment')) {
        const { rows: pays } = await app.db.query<Record<string, unknown>>(
          'SELECT * FROM payments WHERE request_id = ANY($1)', [ids]);
        const byRequest = new Map(pays.map((p) => [String(p.request_id), p]));
        for (const r of rows) r.payment = byRequest.get(String(r.id)) ?? null;
      }
    }
    return { requests: rows };
  });

  app.get('/requests/:id', {
    schema: {
      tags: ['заявки'], summary: 'Карточка заявки: акт, оплата, точка маршрута',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    requireUser(req);
    const { id } = req.params as { id: string };
    const { rows } = await app.db.query(
      `SELECT r.*, r.date::text AS date, r.created_date::text AS created_date FROM requests r WHERE r.id = $1`, [id]);
    const request = rows[0];
    if (!request) throw notFound(`Нет заявки «${id}».`);
    const { rows: pay } = await app.db.query('SELECT * FROM payments WHERE request_id = $1', [id]);
    const { rows: stop } = await app.db.query(
      'SELECT * FROM stops WHERE request_id = $1 ORDER BY id DESC LIMIT 1', [id]);
    const { rows: wait } = await app.db.query(
      'SELECT * FROM wait_list WHERE request_id = $1 ORDER BY at DESC', [id]);
    return { request, devices: await loadDevices(app.db, id, app.sessionSecret),
      payment: pay[0] ?? null, stop: stop[0] ?? null, waits: wait };
  });

  app.get('/clients', {
    schema: {
      tags: ['заявки'],
      summary: 'Клиент по телефону: карточка и история прежних заявок',
      security: [{ session: [] }],
      querystring: { type: 'object', required: ['phone'], properties: { phone: { type: 'string' } } },
    },
  }, async (req) => {
    requireUser(req);
    const { phone } = req.query as { phone: string };
    const norm = normPhone(phone);
    const { rows: clients } = await app.db.query('SELECT * FROM clients WHERE phone_norm = $1', [norm]);
    // История ищется и по дополнительному номеру: в прототипе «тот же клиент» —
    // это тот же номер в основном или в запасном поле любой прежней заявки.
    // Карточку целиком, а не выжимку: по истории оператор подставляет в новую
    // заявку адрес, контакты и тип клиента — для этого нужны все поля.
    const { rows: history } = await app.db.query(
      `SELECT *, date::text AS date, created_date::text AS created_date
         FROM requests WHERE phone_norm = $1 OR regexp_replace(phone2, '\\D', '', 'g') LIKE '%' || $2
        ORDER BY date DESC, id DESC LIMIT 50`, [norm, norm.slice(-10)]);
    return { client: clients[0] ?? null, history };
  });

  app.get('/slots', {
    schema: {
      tags: ['заявки'],
      summary: 'Подсказка дат под выбранные услуги и город с учётом компетенций смены',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          svcs: { type: 'string', description: 'услуги через запятую, например wv,wr' },
          city: { type: 'string' },
          from: DATE,
          days: { type: 'integer', minimum: 1, maximum: 120, default: 45 },
          limit: { type: 'integer', minimum: 1, maximum: 60, default: 14 },
        },
      },
    },
  }, async (req) => {
    requireUser(req);
    const q = req.query as { svcs?: string; city?: string; from?: string; days?: number; limit?: number };
    const ids = (q.svcs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const from = q.from ?? new Date().toISOString().slice(0, 10);
    const days = await slotDays(app.db, from, q.days ?? 45, q.city ?? null);
    return { slots: slotsFor(days, ids, q.city ?? null, q.limit ?? 14) };
  });

  app.post('/requests', {
    schema: {
      tags: ['заявки'],
      summary: 'Приём заявки: проверяются замок даты и план по городу',
      security: [{ session: [] }],
      body: {
        type: 'object',
        required: ['date', 'name', 'phone', 'house'],
        additionalProperties: false,
        properties: { date: DATE, ...REQUEST_FIELDS },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const b = req.body as Record<string, unknown> & { date: string };
    const day = await loadDay(app.db, b.date);
    const city = String(b.city ?? (day?.cities ?? [])[0] ?? '');

    // 1. Замок даты. Руководитель — исключение: он ставит адрес и в собранный маршрут.
    const lock = lockedFor(await lockFactsFor(app.db, b.date), user.role as Role);
    if (lock) {
      throw ruleError(
        `${b.date.split('-').reverse().join('.')}: приём закрыт — ${lock}. ` +
        'Добавить заявку на эту дату может только руководитель.', 'lock');
    }
    // 2. Поля заявки — те же проверки и те же тексты, что видел оператор в прототипе.
    const bad = reqProblem({
      client_type: (b.client_type as 'Физлицо' | 'Юрлицо') ?? 'Физлицо',
      name: String(b.name ?? ''), inn: String(b.inn ?? ''), phone: String(b.phone ?? ''),
      phone2: String(b.phone2 ?? ''), email: String(b.email ?? ''), city,
      house: String(b.house ?? ''), time_slot: b.time_slot as number | undefined,
    }, day?.cities ?? []);
    if (bad) throw ruleError(bad, 'form');
    // 3. Потолок по городу. Считается по тому, каким день станет с этой заявкой:
    // отказывать нужно до записи, а не после того, как перебор уже случился.
    const state = dayState(day, city, (await bookedIn(app.db, b.date, city)) + 1, (await bookedOn(app.db, b.date)) + 1);
    const capBad = cityCapProblem(day, city, state, user.role as Role);
    if (capBad) throw ruleError(capBad, 'cap');

    return app.db.tx(async (db) => {
      const id = await nextId(db, 'requests', 'R');
      const clientId = await upsertClient(db, b, city);
      const { rows } = await db.query(
        `INSERT INTO requests (id, client_id, date, created_date, city, client_type, name, inn,
            phone, phone_norm, contact, phone2, contact2, email, street, house, entrance, floor,
            flat, intercom, time_slot, comment_operator, comment_verifier, svcs, status, operator_id)
         VALUES ($1,$2,$3,current_date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'создана',$24)
         RETURNING *, date::text AS date, created_date::text AS created_date`,
        [id, clientId, b.date, city, b.client_type ?? 'Физлицо', b.name, b.client_type === 'Юрлицо' ? b.inn ?? '' : '',
         b.phone, normPhone(String(b.phone)), b.contact ?? '', b.phone2 ?? '', b.contact2 ?? '',
         String(b.email ?? '').trim(), b.street ?? '', b.house, b.entrance ?? '', b.floor ?? '',
         b.flat ?? '', b.intercom ?? true, b.time_slot ?? 12, b.comment_operator ?? '',
         b.comment_verifier ?? '', b.svcs ?? [], user.id]);
      return { request: rows[0] };
    });
  });

  app.patch('/requests/:id', {
    schema: {
      tags: ['заявки'],
      summary: 'Правка заявки. Смена даты — это перенос: заявка снимается с маршрута',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', additionalProperties: false, properties: { date: DATE, ...REQUEST_FIELDS } },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const { rows: found } = await app.db.query<Record<string, unknown>>(
      'SELECT *, date::text AS date FROM requests WHERE id = $1', [id]);
    const cur = found[0];
    if (!cur) throw notFound(`Нет заявки «${id}».`);

    const date = String(b.date ?? cur.date);
    const city = String(b.city ?? cur.city);
    const day = await loadDay(app.db, date);
    const moved = date !== cur.date;

    if (moved) {
      // Перенос на новую дату — это тот же приём: проверяются и замок, и план.
      const lock = lockedFor(await lockFactsFor(app.db, date), user.role as Role);
      if (lock) throw ruleError(`${date.split('-').reverse().join('.')}: перенос закрыт — ${lock}.`, 'lock');
      const state = dayState(day, city, (await bookedIn(app.db, date, city)) + 1, (await bookedOn(app.db, date)) + 1);
      const capBad = cityCapProblem(day, city, state, user.role as Role);
      if (capBad) throw ruleError(capBad, 'cap');
    }
    const bad = reqProblem({
      client_type: (b.client_type ?? cur.client_type) as 'Физлицо' | 'Юрлицо',
      name: String(b.name ?? cur.name), inn: String(b.inn ?? cur.inn), phone: String(b.phone ?? cur.phone),
      phone2: String(b.phone2 ?? cur.phone2), email: String(b.email ?? cur.email), city,
      house: String(b.house ?? cur.house), time_slot: (b.time_slot ?? cur.time_slot) as number,
    }, day?.cities ?? [city]);
    if (bad) throw ruleError(bad, 'form');

    return app.db.tx(async (db) => {
      const fields = Object.keys(b).filter((f) => f !== 'date');
      if (fields.length) {
        const set = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
        await db.query(`UPDATE requests SET ${set}, updated_at = now() WHERE id = $1`,
          [id, ...fields.map((f) => (f === 'phone' ? String(b[f]) : b[f]))]);
        if (b.phone) await db.query('UPDATE requests SET phone_norm = $2 WHERE id = $1', [id, normPhone(String(b.phone))]);
      }
      if (moved) {
        // Перенос снимает заявку с маршрута: в старом выезде её больше нет,
        // в новый её ставят руками — состав маршрута решает руководитель.
        await db.query('DELETE FROM stops WHERE request_id = $1', [id]);
        await db.query(
          `UPDATE requests SET date = $2, route_id = NULL, status = 'создана', updated_at = now() WHERE id = $1`,
          [id, date]);
        // Перенос по дате — это и есть решение оператора по листу ожидания.
        // Адрес переезжает той же заявкой, поэтому `moved_to` указывает на неё же.
        await db.query(
          `UPDATE wait_list SET state = 'перенесена', moved_to = $1, handled_by = $2, handled_at = now()
            WHERE request_id = $1 AND state = 'не обработана'`, [id, user.id]);
      }
      const { rows } = await db.query(
        'SELECT *, date::text AS date, created_date::text AS created_date FROM requests WHERE id = $1', [id]);
      return { request: rows[0], moved };
    });
  });

  app.post('/requests/:id/shift', {
    schema: {
      tags: ['заявки'],
      summary: 'Сдвинуть окно приезда на час вперёд или назад',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['delta'], properties: { delta: { type: 'integer', minimum: -6, maximum: 6 } } },
    },
  }, async (req) => {
    requireUser(req);
    const { id } = req.params as { id: string };
    const { delta } = req.body as { delta: number };
    const { rows: found } = await app.db.query<{ time_slot: number }>(
      'SELECT time_slot FROM requests WHERE id = $1', [id]);
    if (!found[0]) throw notFound(`Нет заявки «${id}».`);
    if (!canShift(found[0].time_slot, delta)) {
      throw ruleError(`Окно приезда бывает только с ${SLOT_MIN} до ${SLOT_MAX} часов.`, 'slot');
    }
    const { rows } = await app.db.query(
      'UPDATE requests SET time_slot = time_slot + $2, updated_at = now() WHERE id = $1 RETURNING id, time_slot',
      [id, delta]);
    return { request: rows[0] };
  });
};

/** Клиент — это номер телефона: ключ нормализуется, карточка заводится при первом
 *  обращении, дальше заявки цепляются к ней и складываются в историю. */
async function upsertClient(db: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
                            b: Record<string, unknown>, city: string): Promise<string> {
  const norm = normPhone(String(b.phone));
  const { rows } = await db.query(
    `INSERT INTO clients (phone_norm, phone_raw, client_type, name, inn, email, city)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (phone_norm) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [norm, String(b.phone), b.client_type ?? 'Физлицо', b.name, b.inn ?? '', String(b.email ?? '').trim(), city || null]);
  return String(rows[0]!.id);
}

export default plugin;
