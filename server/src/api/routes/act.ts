/* Акт: приборы, закрытие и возврат позиции, отметка «не обслужена» и лист ожидания.
 *
 * Закрытие позиции — самое строгое место в системе: после него работа считается
 * сданной, деньги — принятыми, а сдельная оплата — начисленной. Поэтому проверки
 * закрытия (услуга в каждой строке, заводской номер, причина непригодности,
 * номер бланка) перенесены из прототипа дословно и лежат в `closeProblem`.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db.ts';
import { requireRole, requireUser, type User } from '../auth.ts';
import { notFound, ruleError } from '../errors.ts';
import { actorOr403, loadDevices, loadServices, nextId } from '../store.ts';
import {
  FAIL_REASONS, PAY_HAND, PAY_METHODS, PAY_ONLINE, WAIT_REASONS, closeProblem, payMethods, priceOf, priceOfDevice,
  rateO, rateV, unservedProblem, type ClientType, type Role,
} from '../../rules.ts';
import { arshinConfig } from '../../arshin/config.ts';
import { dropUnsent, syncRecords } from '../../arshin/records.ts';
import { canPay } from '../../payment/config.ts';
import { activeOf, openPaymentProblem } from '../../payment/service.ts';

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;
const STOP_PARAMS = {
  type: 'object', required: ['id', 'requestId'],
  properties: { id: { type: 'string' }, requestId: { type: 'string' } },
} as const;

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/requests/:id/devices', {
    schema: { tags: ['акт'], summary: 'Приборы в акте заявки', security: [{ session: [] }], params: ID },
  }, async (req) => {
    requireUser(req);
    const { id } = req.params as { id: string };
    return { devices: await loadDevices(app.db, id) };
  });

  app.post('/requests/:id/devices', {
    schema: {
      tags: ['акт'], summary: 'Добавить строку прибора в акт', security: [{ session: [] }], params: ID,
      body: {
        type: 'object', required: ['service_id', 'device_type', 'carrier'],
        properties: {
          service_id: { type: 'string' }, device_type: { type: 'string' }, grsi: { type: 'string' },
          carrier: { type: 'string', enum: ['ХВС', 'ГВС', 'Тепло'] },
          serial: { type: 'string' }, reading: { type: 'string' },
          room: { type: 'string', enum: ['Кухня', 'Санузел', 'Иное'] },
          seal: { type: 'boolean' }, pensioner: { type: 'boolean' },
          swap: { type: 'boolean' }, swap_of: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    await actorOr403(app.db, user, id);
    const { map } = await loadServices(app.db);
    if (!map.has(String(b.service_id))) throw ruleError(`Нет услуги «${b.service_id}» в справочнике.`);
    return app.db.tx(async (db) => {
      const { rows: pos } = await db.query<{ n: string }>(
        'SELECT coalesce(max(position), 0) + 1 AS n FROM devices WHERE request_id = $1', [id]);
      const { rows } = await db.query(
        `INSERT INTO devices (request_id, position, service_id, device_type, grsi, carrier, serial,
            reading, room, seal, pensioner, swap, swap_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [id, Number(pos[0]!.n), b.service_id, b.device_type, b.grsi ?? '', b.carrier, b.serial ?? '',
         b.reading ?? '', b.room ?? 'Кухня', b.seal ?? true, b.pensioner ?? false, b.swap ?? false, b.swap_of ?? '']);
      return { device: rows[0] };
    });
  });

  app.patch('/devices/:id', {
    schema: {
      tags: ['акт'], summary: 'Правка строки прибора: показания, номер, результат поверки',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          service_id: { type: 'string' }, device_type: { type: 'string' }, grsi: { type: 'string' },
          carrier: { type: 'string', enum: ['ХВС', 'ГВС', 'Тепло'] },
          serial: { type: 'string' }, reading: { type: 'string' },
          room: { type: 'string', enum: ['Кухня', 'Санузел', 'Иное'] },
          seal: { type: 'boolean' }, pensioner: { type: 'boolean' },
          bad: { type: 'boolean' }, bad_reason: { type: ['string', 'null'], enum: [...FAIL_REASONS, null] },
          bad_note: { type: 'string' }, blank: { type: 'boolean' }, blank_no: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: number };
    const b = req.body as Record<string, unknown>;
    const { rows: found } = await app.db.query<{ request_id: string; bad: boolean; bad_reason: string | null }>(
      'SELECT request_id, bad, bad_reason FROM devices WHERE id = $1', [id]);
    if (!found[0]) throw notFound(`Нет строки прибора №${id}.`);
    await actorOr403(app.db, user, found[0].request_id);

    // «Непригоден» и причина ходят парой: без причины прибор не попадёт ни в
    // свидетельство, ни в «Аршин», а причина без отметки о непригодности бессмысленна.
    const bad = b.bad ?? found[0].bad;
    const reason = 'bad_reason' in b ? b.bad_reason : found[0].bad_reason;
    if (bad && !reason) throw ruleError('У непригодного прибора обязательна причина.', 'bad');
    // Вернули «годен» — снимаем всё, что тянулось за непригодностью.
    const patch: Record<string, unknown> = {
      ...b, ...(bad ? {} : { bad_reason: null, bad_note: '', blank: false, blank_no: '' }),
    };

    const fields = Object.keys(patch);
    const set = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const { rows } = await app.db.query(
      `UPDATE devices SET ${set} WHERE id = $1 RETURNING *`, [id, ...fields.map((f) => patch[f])]);
    return { device: rows[0] };
  });

  app.delete('/devices/:id', {
    schema: {
      tags: ['акт'], summary: 'Убрать строку прибора из акта', security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: number };
    const { rows: found } = await app.db.query<{ request_id: string }>(
      'SELECT request_id FROM devices WHERE id = $1', [id]);
    if (!found[0]) throw notFound(`Нет строки прибора №${id}.`);
    await actorOr403(app.db, user, found[0].request_id);
    await app.db.query('DELETE FROM devices WHERE id = $1', [id]);
    return { removed: id };
  });

  app.post('/devices/:id/replacement', {
    schema: {
      tags: ['акт'],
      summary: 'Замена непригодного прибора: предложена, отложена или отметка снята',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object', required: ['mode'],
        properties: { mode: { type: ['string', 'null'], enum: ['предложена', 'отложена', null] } },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: number };
    const { mode } = req.body as { mode: 'предложена' | 'отложена' | null };
    const { rows: found } = await app.db.query<{ request_id: string; bad: boolean; serial: string; bad_reason: string | null; bad_note: string; replacement_wait_id: string | null }>(
      'SELECT request_id, bad, serial, bad_reason, bad_note, replacement_wait_id FROM devices WHERE id = $1', [id]);
    const d = found[0];
    if (!d) throw notFound(`Нет строки прибора №${id}.`);
    if (!d.bad) throw ruleError('Замена предлагается только взамен непригодного прибора.', 'bad');
    const request = await actorOr403(app.db, user, d.request_id);

    return app.db.tx(async (db) => {
      // Прежняя запись в листе ожидания снимается: решение клиента поменялось.
      if (d.replacement_wait_id) {
        await db.query('UPDATE devices SET replacement_wait_id = NULL WHERE id = $1', [id]);
        await db.query('DELETE FROM wait_list WHERE id = $1', [d.replacement_wait_id]);
      }
      let waitId: string | null = null;
      if (mode === 'отложена') {
        // Клиент отложил замену — адрес уходит оператору: он перезвонит и оформит
        // замену отдельной заявкой. Выполненную работу это не отменяет.
        waitId = await nextId(db, 'wait_list', 'W');
        const note = `${d.serial ? 'Прибор №' + d.serial : 'Прибор без читаемого номера'} непригоден · ` +
          `${String(d.bad_reason ?? '').toLowerCase()}${d.bad_note ? ' · ' + d.bad_note : ''}. Клиент отложил замену.`;
        await db.query(
          `INSERT INTO wait_list (id, request_id, route_id, city, kind, reason, note, at, by_staff)
           VALUES ($1, $2, $3, $4, 'замена', 'Нужна замена', $5, now(), $6)`,
          [waitId, d.request_id, request.route_id ?? null, request.city, note, user.id]);
      }
      const { rows } = await db.query(
        'UPDATE devices SET replacement = $2, replacement_wait_id = $3 WHERE id = $1 RETURNING *',
        [id, mode, waitId]);
      return { device: rows[0], wait_id: waitId };
    });
  });

  /* ── закрытие и возврат позиции ─────────────────────────────── */

  app.post('/requests/:id/close', {
    schema: {
      tags: ['акт'],
      summary: 'Закрыть позицию: акт сдан, цена и ставки записываются снимком',
      security: [{ session: [] }], params: ID,
      body: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: [...PAY_METHODS] },
          amount: { type: 'integer', minimum: 0 },
          note: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { method?: string; amount?: number; note?: string };
    const request = await actorOr403(app.db, user, id);
    const devices = await loadDevices(app.db, id);
    const { rows: stops } = await app.db.query<{ id: string; unserved_reason: string | null }>(
      'SELECT id, unserved_reason FROM stops WHERE request_id = $1 AND route_id = $2', [id, request.route_id]);
    const stop = stops[0];

    const bad = closeProblem(devices as never, !!stop?.unserved_reason);
    if (bad) throw ruleError(bad, 'act');

    const { map } = await loadServices(app.db);
    const clientType = request.client_type as ClientType;
    const act = devices.map((d) => ({ service_id: String(d.service_id), pensioner: !!d.pensioner }));
    const price = priceOf(map, clientType, act);
    const wage = rateV(map, act);

    // Способ по умолчанию и допустимость: по счёту — только юрлицу, безнал
    // через провайдера — только там, где он подключён.
    const method = b.method ?? (clientType === 'Юрлицо' ? 'по счёту' : 'наличные');
    const online = PAY_ONLINE.includes(method as never);
    if (!payMethods(clientType, !!app.payments && canPay(app.paymentConfig)).includes(method as never)) {
      throw ruleError(online
        ? 'Эквайринг не подключён к этому контуру: принимайте наличными или переводом.'
        : 'По счёту платит только юрлицо — физлицу этот способ недоступен.', 'method');
    }
    // Сумма безналичного платежа обязана совпадать с суммой акта на момент его
    // создания (пункт int-pay): разошлась — позиция не закрывается.
    const stale = await openPaymentProblem(app.db, id, method, price);
    if (stale) throw ruleError(stale, 'payment');
    const onlinePay = online ? await activeOf(app.db, id) : null;

    return app.db.tx(async (db) => {
      // Снимок цены и ставок на момент выполнения: переписанный прайс не должен
      // менять ни закрытый акт, ни начисленную по нему сдельную оплату.
      for (const d of devices) {
        const svc = map.get(String(d.service_id));
        await db.query(
          'UPDATE devices SET price_charged = $2, rate_verifier = $3, rate_operator = $4 WHERE id = $1',
          [d.id, priceOfDevice(svc, clientType, !!d.pensioner), svc?.rate_verifier ?? 0, svc?.rate_operator ?? 0]);
      }
      const verifier = (request.route_verifier as string) ?? (user.role === 'verifier' ? user.id : null);
      if (stop) await db.query(`UPDATE stops SET done = true, called = coalesce(called, 'подтверждена') WHERE id = $1`, [stop.id]);
      await db.query(
        `UPDATE requests SET status = 'выполнена', verifier_id = coalesce($2, verifier_id),
                svcs = $3, updated_at = now() WHERE id = $1`,
        [id, verifier, [...new Set(act.map((d) => d.service_id))]]);
      if (request.route_id) {
        await db.query(
          `UPDATE routes SET status = 'в работе', updated_at = now()
            WHERE id = $1 AND status IN ('черновик', 'обзвонен')`, [request.route_id]);
      }
      // Деньги фиксируются в момент закрытия: закрыть можно и без оплаты — тогда
      // адрес останется в долгах, видимых оператору и руководителю.
      // Безнал через провайдера поверитель руками не принимает: сумма — из
      // платежа, отметка «оплачено» — из уведомления провайдера, а не из
      // закрытия; до него позиция закрыта, но ждёт оплаты.
      const amount = method === 'не оплачено' ? 0 : online ? (onlinePay?.paid_amount ?? onlinePay?.amount ?? price) : b.amount ?? price;
      const paidAt = online ? onlinePay?.paid_at ?? null : new Date();
      if (!online) {
        // Наличными при живом безнале: ожидающий QR или ссылка уступают место
        // и отменяются у нас (у провайдера истекут сами).
        await db.query(
          `UPDATE online_payments SET status = 'отменён', error = 'позиция закрыта другим способом оплаты', handled_by = $2, updated_at = now()
            WHERE request_id = $1 AND status IN ('создан', 'ожидает')`, [id, user.id]);
      }
      const { rows: pay } = await db.query(
        `INSERT INTO payments (request_id, method, amount, charged, manual, note, paid_at, by_staff)
         VALUES ($1,$2,$3,$4,$5,$6, $8, $7)
         ON CONFLICT (request_id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount,
           charged = EXCLUDED.charged, manual = EXCLUDED.manual, note = EXCLUDED.note,
           paid_at = EXCLUDED.paid_at, by_staff = EXCLUDED.by_staff
         RETURNING *`,
        [id, method, amount, price, !online && b.amount != null, b.note ?? '', verifier, paidAt]);
      // Поверка становится юридически действительной только после передачи
      // сведений во ФГИС «Аршин», поэтому запись о поверке рождается здесь же,
      // при закрытии акта, а не когда до неё дойдут руки (пункт int-arshin).
      // Считать её отдельно на каждый прибор, включая «не годен», требует
      // пункт 26 приказа Минпромторга России № 2906.
      const arshin = await syncRecords(db, id, arshinConfig());
      return {
        closed: id, price, wage, payment: pay[0],
        hand: PAY_HAND.includes(method as never) ? amount : 0,
        online: onlinePay,
        arshin,
      };
    });
  });

  app.post('/requests/:id/reopen', {
    schema: {
      tags: ['акт'],
      summary: 'Вернуть позицию в работу: начисление и отметка об оплате снимаются',
      security: [{ session: [] }], params: ID,
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await actorOr403(app.db, user, id);
    return app.db.tx(async (db) => {
      await db.query('UPDATE stops SET done = false WHERE request_id = $1', [id]);
      await db.query(
        `UPDATE requests SET status = CASE WHEN route_id IS NULL THEN 'создана' ELSE 'в маршруте' END,
                verifier_id = NULL, updated_at = now() WHERE id = $1`, [id]);
      // Способ и сумму оставляем — снимаем только отметку о принятии денег.
      // Оплаченный безнал не трогаем: деньги у провайдера, отметка «оплачено»
      // принадлежит платежу, а не закрытию, и снять её может только возврат.
      await db.query(
        `UPDATE payments SET paid_at = NULL WHERE request_id = $1
            AND NOT (method IN ('СБП по QR', 'платёжная ссылка')
                     AND EXISTS (SELECT 1 FROM online_payments o WHERE o.request_id = $1 AND o.status = 'оплачен'))`, [id]);
      // Непереданные записи «Аршина» уходят вместе с закрытием: акт снова в
      // работе, и передавать пока нечего. Уже переданное остаётся — отозвать
      // сведения из реестра система не может.
      const arshin = await dropUnsent(db, id);
      return { reopened: id, arshin };
    });
  });

  /* ── не обслужена ───────────────────────────────────────────── */

  app.post('/routes/:id/stops/:requestId/unserved', {
    schema: {
      tags: ['акт'],
      summary: 'Отметить адрес не обслуженным: заявка уходит в лист ожидания',
      security: [{ session: [] }], params: STOP_PARAMS,
      body: {
        type: 'object', required: ['reason'],
        properties: { reason: { type: 'string', enum: [...WAIT_REASONS] }, note: { type: 'string' } },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id, requestId } = req.params as { id: string; requestId: string };
    const b = req.body as { reason: string; note?: string };
    const note = String(b.note ?? '').trim();
    const bad = unservedProblem(b.reason, note);
    if (bad) throw ruleError(bad, 'unserved');
    const request = await actorOr403(app.db, user, requestId);

    return app.db.tx(async (db) => {
      const { rows: stop } = await db.query<{ id: string; done: boolean }>(
        'SELECT id, done FROM stops WHERE route_id = $1 AND request_id = $2', [id, requestId]);
      if (!stop[0]) throw notFound(`Заявки «${requestId}» нет в маршруте «${id}».`);
      if (stop[0].done) throw ruleError('Позиция закрыта — сначала верните её в работу.', 'done');
      await db.query(
        `UPDATE stops SET unserved_reason = $2, unserved_note = $3, unserved_at = now(), unserved_by = $4, done = false
          WHERE id = $1`, [stop[0].id, b.reason, note, user.id]);
      await db.query(`UPDATE requests SET status = 'ожидание', updated_at = now() WHERE id = $1`, [requestId]);
      const waitId = await nextId(db, 'wait_list', 'W');
      await db.query(
        `INSERT INTO wait_list (id, request_id, route_id, city, kind, reason, note, at, by_staff)
         VALUES ($1, $2, $3, $4, 'адрес', $5, $6, now(), $7)`,
        [waitId, requestId, id, request.city, b.reason, note, user.id]);
      return { wait_id: waitId, request_id: requestId };
    });
  });

  app.delete('/routes/:id/stops/:requestId/unserved', {
    schema: {
      tags: ['акт'],
      summary: 'Снять отметку «не обслужена», пока оператор не взялся за запись',
      security: [{ session: [] }], params: STOP_PARAMS,
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id, requestId } = req.params as { id: string; requestId: string };
    await actorOr403(app.db, user, requestId);
    return app.db.tx(async (db) => {
      const { rows: wait } = await db.query<{ id: string; state: string }>(
        `SELECT id, state FROM wait_list WHERE request_id = $1 AND kind = 'адрес' ORDER BY at DESC LIMIT 1`, [requestId]);
      // Оператор уже обработал запись — отметку снимать поздно, адрес живёт своей жизнью.
      if (wait[0] && wait[0].state !== 'не обработана') {
        throw ruleError('Оператор уже обработал эту запись листа ожидания.', 'handled');
      }
      if (wait[0]) await db.query('DELETE FROM wait_list WHERE id = $1', [wait[0].id]);
      await db.query(
        `UPDATE stops SET unserved_reason = NULL, unserved_note = '', unserved_at = NULL, unserved_by = NULL
          WHERE route_id = $1 AND request_id = $2`, [id, requestId]);
      await db.query(
        `UPDATE requests SET status = CASE WHEN route_id IS NULL THEN 'создана' ELSE 'в маршруте' END,
                updated_at = now() WHERE id = $1`, [requestId]);
      return { cleared: requestId };
    });
  });

  /* ── лист ожидания ──────────────────────────────────────────── */

  app.get('/wait-list', {
    schema: {
      tags: ['акт'], summary: 'Лист ожидания: не обслуженные адреса и отложенные замены',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: { state: { type: 'string' }, city: { type: 'string' }, kind: { type: 'string' } },
      },
    },
  }, async (req) => {
    requireRole(req, 'operator', 'senior', 'supervisor');
    const q = req.query as { state?: string; city?: string; kind?: string };
    const { rows } = await app.db.query(
      `SELECT w.*, r.name, r.phone, r.street, r.house, r.flat, r.date::text AS request_date, r.status AS request_status
         FROM wait_list w JOIN requests r ON r.id = w.request_id
        WHERE ($1::text IS NULL OR w.state = $1) AND ($2::text IS NULL OR w.city = $2)
          AND ($3::text IS NULL OR w.kind = $3)
        ORDER BY (w.state = 'не обработана') DESC, w.at DESC`,
      [q.state ?? null, q.city ?? null, q.kind ?? null]);
    return { waits: rows };
  });

  app.post('/wait-list/:id/to-route', {
    schema: {
      tags: ['акт'], summary: 'Поставить адрес из листа ожидания в маршрут', security: [{ session: [] }], params: ID,
      body: { type: 'object', required: ['route_id'], properties: { route_id: { type: 'string' } } },
    },
  }, async (req) => {
    const user = requireRole(req, 'operator', 'senior', 'supervisor');
    const { id } = req.params as { id: string };
    const { route_id } = req.body as { route_id: string };
    return app.db.tx(async (db) => {
      const { rows: waits } = await db.query<{ id: string; request_id: string; state: string; kind: string }>(
        'SELECT id, request_id, state, kind FROM wait_list WHERE id = $1', [id]);
      const w = waits[0];
      if (!w) throw notFound(`Нет записи листа ожидания «${id}».`);
      if (w.kind === 'замена') {
        throw ruleError('Отложенная замена оформляется отдельной заявкой, а не переносом адреса.', 'kind');
      }
      const { rows: routes } = await db.query<{ id: string; date: string }>(
        'SELECT id, date::text AS date FROM routes WHERE id = $1', [route_id]);
      if (!routes[0]) throw notFound(`Нет маршрута «${route_id}».`);
      // Старая точка остаётся в прежнем маршруте следом неудачного выезда —
      // по ней виден срыв. Заявка переезжает на дату нового маршрута.
      await db.query(`UPDATE requests SET date = $2, route_id = $3, status = 'в маршруте', updated_at = now() WHERE id = $1`,
        [w.request_id, routes[0].date, route_id]);
      await db.query('INSERT INTO stops (route_id, request_id, position) VALUES ($1, $2, 1)', [route_id, w.request_id]);
      await db.query(
        `WITH ord AS (SELECT s.id, row_number() OVER (ORDER BY r.time_slot, s.id) AS pos
                        FROM stops s JOIN requests r ON r.id = s.request_id WHERE s.route_id = $1)
         UPDATE stops SET position = ord.pos FROM ord WHERE stops.id = ord.id`, [route_id]);
      await db.query(
        `UPDATE wait_list SET state = 'перенесена', moved_to = $2, handled_by = $3, handled_at = now() WHERE id = $1`,
        [id, w.request_id, user.id]);
      return { wait_id: id, route_id, request_id: w.request_id };
    });
  });

  app.post('/wait-list/:id/drop', {
    schema: { tags: ['акт'], summary: 'Снять запись с листа ожидания (заявку не трогает)', security: [{ session: [] }], params: ID },
  }, async (req) => {
    const user = requireRole(req, 'operator', 'senior', 'supervisor');
    const { id } = req.params as { id: string };
    const { rows } = await app.db.query(
      `UPDATE wait_list SET state = 'снята', handled_by = $2, handled_at = now() WHERE id = $1 RETURNING *`, [id, user.id]);
    if (!rows[0]) throw notFound(`Нет записи листа ожидания «${id}».`);
    return { wait: rows[0] };
  });

  app.post('/wait-list/:id/cancel', {
    schema: { tags: ['акт'], summary: 'Отменить заявку и снять адрес с листа ожидания', security: [{ session: [] }], params: ID },
  }, async (req) => {
    const user = requireRole(req, 'operator', 'senior', 'supervisor');
    const { id } = req.params as { id: string };
    return app.db.tx(async (db) => {
      const { rows } = await db.query<{ request_id: string; kind: string }>(
        `UPDATE wait_list SET state = 'отменена', handled_by = $2, handled_at = now() WHERE id = $1
         RETURNING request_id, kind`, [id, user.id]);
      if (!rows[0]) throw notFound(`Нет записи листа ожидания «${id}».`);
      // Отложенную замену отменяют, не трогая заявку: работа по ней сдана и оплачена.
      if (rows[0].kind !== 'замена') {
        await db.query(`UPDATE requests SET status = 'отменена', updated_at = now() WHERE id = $1`, [rows[0].request_id]);
      }
      return { wait_id: id, request_id: rows[0].request_id };
    });
  });
};

export default plugin;
