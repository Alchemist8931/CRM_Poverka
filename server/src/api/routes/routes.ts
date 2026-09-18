/* Маршруты: конструктор, сборка, назначение поверителя, точки, обзвон и чат.
 *
 * Открытый конструктор и уже собранный маршрут закрывают дату для приёма —
 * это правило `dayLock`, и живёт оно в `src/rules.ts`. Здесь открытие и закрытие
 * конструктора всего лишь ставят и снимают строку в `route_builder`.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db.ts';
import { requireRole, requireUser } from '../auth.ts';
import { notFound, ruleError } from '../errors.ts';
import { nextId } from '../store.ts';
import { canSeeRoute, type Role } from '../../rules.ts';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;
const STOP_PARAMS = {
  type: 'object', required: ['id', 'requestId'],
  properties: { id: { type: 'string' }, requestId: { type: 'string' } },
} as const;

/** Сколько адресов кладётся в один автоматический маршрут: норматив на поверителя
 *  в смене. Ровно этим числом прототип нарезал свободный пул на выезды. */
const ROUTE_CHUNK = 25;

/** Уволенного на новый выезд не поставить (пункт be-users). В прошлых маршрутах
 *  он остаётся: история не переписывается оттого, что человек ушёл. Проверка
 *  стоит на сервере, а не только в выпадающем списке, — список экран мог
 *  отрисовать до увольнения и остаться открытым. */
async function assertHired(db: Db, ids: (string | null | undefined)[]): Promise<void> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  const { rows } = await db.query<{ full_name: string }>(
    'SELECT full_name FROM staff WHERE id = ANY($1) AND blocked_at IS NOT NULL', [list]);
  if (rows[0]) {
    throw ruleError(`${rows[0].full_name} — учётная запись отключена при увольнении. Выберите другого.`, 'blocked');
  }
}

/** Порядок объезда: точки перенумеровываются по окну приезда. Позиция при этом
 *  остаётся тем, чем была, — ручной последовательностью, которую правит руководитель
 *  стрелками; пересортировка идёт только при добавлении адреса, как в прототипе. */
async function renumber(db: Db, routeId: string): Promise<void> {
  await db.query(
    `WITH ord AS (
        SELECT s.id, row_number() OVER (ORDER BY r.time_slot, s.id) AS pos
          FROM stops s JOIN requests r ON r.id = s.request_id WHERE s.route_id = $1)
     UPDATE stops SET position = ord.pos FROM ord WHERE stops.id = ord.id`, [routeId]);
}

async function routeOr404(db: Db, id: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT *, date::text AS date FROM routes WHERE id = $1', [id]);
  if (!rows[0]) throw notFound(`Нет маршрута «${id}».`);
  return rows[0];
}

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/routes', {
    schema: {
      tags: ['маршруты'], summary: 'Маршруты по дате, городу и поверителю',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: { date: DATE, date_from: DATE, date_to: DATE, city: { type: 'string' },
                      verifier_id: { type: 'string' }, status: { type: 'string' } },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as Record<string, string | undefined>;
    // Поверитель видит только свои маршруты — это правило доступа, а не фильтр экрана.
    const onlyMine = user.role === 'verifier' ? user.id : null;
    const { rows } = await app.db.query(
      `SELECT r.*, r.date::text AS date,
              (SELECT count(*)::int FROM stops s WHERE s.route_id = r.id) AS stops,
              (SELECT count(*)::int FROM stops s WHERE s.route_id = r.id AND s.done) AS done,
              -- Обзвонено: список маршрутов показывает готовность к выезду, а точки
              -- в нём не приезжают — их грузят, когда маршрут открывают.
              (SELECT count(*)::int FROM stops s WHERE s.route_id = r.id AND s.called IS NOT NULL) AS called
         FROM routes r
        WHERE ($1::date IS NULL OR r.date = $1)
          AND ($2::date IS NULL OR r.date >= $2) AND ($3::date IS NULL OR r.date <= $3)
          AND ($4::text IS NULL OR r.city = $4)
          AND ($5::text IS NULL OR r.verifier_id = $5)
          AND ($6::text IS NULL OR r.status = $6)
          AND ($7::text IS NULL OR r.verifier_id = $7)
        ORDER BY r.date DESC, r.id`,
      [q.date ?? null, q.date_from ?? null, q.date_to ?? null, q.city ?? null,
       q.verifier_id ?? null, q.status ?? null, onlyMine]);
    return { routes: rows };
  });

  app.get('/routes/:id', {
    schema: {
      tags: ['маршруты'], summary: 'Маршрут с точками, заявками и перепиской',
      security: [{ session: [] }], params: ID,
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const route = await routeOr404(app.db, id);
    if (!canSeeRoute(user.role as Role, user.id, (route.verifier_id as string) ?? null)) {
      throw ruleError('Поверитель видит только свои маршруты.', 'role');
    }
    const { rows: stops } = await app.db.query(
      `SELECT s.*, row_to_json(r) AS request FROM stops s
         JOIN (SELECT *, date::text AS date FROM requests) r ON r.id = s.request_id
        WHERE s.route_id = $1 ORDER BY s.position`, [id]);
    const { rows: chat } = await app.db.query(
      'SELECT * FROM route_chat WHERE route_id = $1 ORDER BY at', [id]);
    return { route, stops, chat };
  });

  /* ── конструктор: он же замок даты ──────────────────────────── */

  app.post('/route-builder/:date', {
    schema: {
      tags: ['маршруты'],
      summary: 'Открыть конструктор на дату — с этого момента приём по ней закрыт',
      security: [{ session: [] }],
      params: { type: 'object', required: ['date'], properties: { date: DATE } },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const { date } = req.params as { date: string };
    await app.db.query(
      `INSERT INTO route_builder (date, staff_id) VALUES ($1, $2)
       ON CONFLICT (date) DO UPDATE SET staff_id = EXCLUDED.staff_id, opened_at = now()`, [date, user.id]);
    return { date, building: true };
  });

  app.delete('/route-builder/:date', {
    schema: {
      tags: ['маршруты'], summary: 'Закрыть конструктор: замок с даты снимается',
      security: [{ session: [] }],
      params: { type: 'object', required: ['date'], properties: { date: DATE } },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { date } = req.params as { date: string };
    await app.db.query('DELETE FROM route_builder WHERE date = $1', [date]);
    return { date, building: false };
  });

  /* ── сборка ─────────────────────────────────────────────────── */

  app.post('/routes', {
    schema: {
      tags: ['маршруты'],
      summary: 'Собрать маршрут из выбранных заявок',
      security: [{ session: [] }],
      body: {
        type: 'object', required: ['date', 'request_ids'],
        properties: {
          date: DATE, city: { type: 'string' },
          request_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
          verifier_id: { type: 'string' }, duty_operator_id: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const b = req.body as { date: string; city?: string; request_ids: string[]; verifier_id?: string; duty_operator_id?: string };
    // Маршрут — это последовательность объезда, и по одной точке её не построить.
    if (b.request_ids.length < 2) {
      throw ruleError('Выберите на карте хотя бы две точки — маршрут строится по последовательности.', 'points');
    }
    return app.db.tx(async (db) => {
      await assertHired(db, [b.verifier_id, b.duty_operator_id]);
      const { rows: reqs } = await db.query<{ id: string; city: string; route_id: string | null; status: string }>(
        `SELECT id, city, route_id, status FROM requests WHERE id = ANY($1) AND date = $2`,
        [b.request_ids, b.date]);
      if (reqs.length !== b.request_ids.length) {
        throw ruleError('Часть выбранных заявок не найдена на эту дату — обновите список свободных.', 'points');
      }
      const taken = reqs.find((r) => r.route_id);
      if (taken) throw ruleError(`Заявка ${taken.id} уже стоит в маршруте ${taken.route_id}.`, 'points');
      const city = b.city ?? reqs[0]!.city;
      const id = await nextId(db, 'routes', 'M');
      await db.query(
        `INSERT INTO routes (id, date, city, verifier_id, duty_operator_id, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, b.date, city, b.verifier_id ?? null, b.duty_operator_id ?? null,
         // Назначенный поверитель переводит черновик в «обзвонен» — так же, как в прототипе.
         b.verifier_id ? 'обзвонен' : 'черновик']);
      for (const r of b.request_ids) {
        await db.query('INSERT INTO stops (route_id, request_id, position) VALUES ($1, $2, 1)', [id, r]);
      }
      await renumber(db, id);
      await db.query(`UPDATE requests SET route_id = $1, status = 'в маршруте', updated_at = now() WHERE id = ANY($2)`,
        [id, b.request_ids]);
      return { route: (await db.query('SELECT *, date::text AS date FROM routes WHERE id = $1', [id])).rows[0] };
    });
  });

  app.post('/routes/build', {
    schema: {
      tags: ['маршруты'],
      summary: `Нарезать свободные заявки города на маршруты по ${ROUTE_CHUNK} адресов`,
      security: [{ session: [] }],
      body: {
        type: 'object', required: ['date', 'city'],
        properties: { date: DATE, city: { type: 'string' } },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const b = req.body as { date: string; city: string };
    return app.db.tx(async (db) => {
      const { rows: pool } = await db.query<{ id: string }>(
        `SELECT id FROM requests
          WHERE date = $1 AND city = $2 AND route_id IS NULL AND status NOT IN ('отменена', 'перенос')
          ORDER BY time_slot, id`, [b.date, b.city]);
      if (!pool.length) throw ruleError(`Свободных заявок на ${b.date}, ${b.city} нет.`, 'points');
      const made: string[] = [];
      for (let i = 0; i < pool.length; i += ROUTE_CHUNK) {
        const chunk = pool.slice(i, i + ROUTE_CHUNK).map((r) => r.id);
        const id = await nextId(db, 'routes', 'M');
        await db.query(`INSERT INTO routes (id, date, city, status) VALUES ($1, $2, $3, 'черновик')`, [id, b.date, b.city]);
        for (const r of chunk) {
          await db.query('INSERT INTO stops (route_id, request_id, position) VALUES ($1, $2, 1)', [id, r]);
        }
        await renumber(db, id);
        await db.query(`UPDATE requests SET route_id = $1, status = 'в маршруте', updated_at = now() WHERE id = ANY($2)`,
          [id, chunk]);
        made.push(id);
      }
      return { routes: made };
    });
  });

  app.patch('/routes/:id', {
    schema: {
      tags: ['маршруты'],
      summary: 'Назначить поверителя, дежурного оператора или сменить статус',
      security: [{ session: [] }], params: ID,
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          verifier_id: { type: ['string', 'null'] },
          duty_operator_id: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['черновик', 'обзвонен', 'в работе', 'выполнен'] },
        },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor', 'senior', 'operator');
    const { id } = req.params as { id: string };
    const b = req.body as { verifier_id?: string | null; duty_operator_id?: string | null; status?: string };
    return app.db.tx(async (db) => {
      await assertHired(db, [b.verifier_id, b.duty_operator_id]);
      const route = await routeOr404(db, id);
      let status = b.status ?? (route.status as string);
      // Назначили поверителя черновику — маршрут готов к выдаче.
      if (b.verifier_id && !b.status && route.status === 'черновик') status = 'обзвонен';
      const { rows } = await db.query(
        `UPDATE routes SET verifier_id = coalesce($2, verifier_id), duty_operator_id = coalesce($3, duty_operator_id),
                status = $4, updated_at = now() WHERE id = $1 RETURNING *, date::text AS date`,
        [id, b.verifier_id ?? null, b.duty_operator_id ?? null, status]);
      // Закрытие маршрута: подтверждённые обзвоном точки считаются выполненными.
      if (status === 'выполнен') {
        await db.query(
          `UPDATE stops SET done = true WHERE route_id = $1 AND called = 'подтверждена' AND unserved_reason IS NULL`, [id]);
        await db.query(
          `UPDATE requests SET status = 'выполнена', verifier_id = $2, updated_at = now()
            WHERE route_id = $1 AND id IN (SELECT request_id FROM stops WHERE route_id = $1 AND done)`,
          [id, rows[0]!.verifier_id]);
      }
      return { route: rows[0] };
    });
  });

  app.delete('/routes/:id', {
    schema: {
      tags: ['маршруты'], summary: 'Расформировать маршрут: адреса возвращаются в свободные',
      security: [{ session: [] }], params: ID,
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { id } = req.params as { id: string };
    return app.db.tx(async (db) => {
      const route = await routeOr404(db, id);
      const { rows: done } = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM stops WHERE route_id = $1 AND done', [id]);
      // Выполненный адрес нельзя вернуть в свободные: по нему уже есть акт и деньги.
      if (Number(done[0]!.n) > 0) {
        throw ruleError('В маршруте есть закрытые позиции — расформировать его уже нельзя.', 'done');
      }
      await db.query(
        `UPDATE requests SET route_id = NULL, status = 'создана', updated_at = now() WHERE route_id = $1`, [id]);
      await db.query('DELETE FROM stops WHERE route_id = $1', [id]);
      await db.query('DELETE FROM routes WHERE id = $1', [id]);
      return { disbanded: route.id };
    });
  });

  /* ── точки ──────────────────────────────────────────────────── */

  app.post('/routes/:id/stops', {
    schema: {
      tags: ['маршруты'], summary: 'Добавить заявку в маршрут',
      security: [{ session: [] }], params: ID,
      body: { type: 'object', required: ['request_id'], properties: { request_id: { type: 'string' } } },
    },
  }, async (req) => {
    requireRole(req, 'supervisor', 'senior', 'operator');
    const { id } = req.params as { id: string };
    const { request_id } = req.body as { request_id: string };
    return app.db.tx(async (db) => {
      const route = await routeOr404(db, id);
      const { rows: reqs } = await db.query<{ id: string; date: string; route_id: string | null }>(
        'SELECT id, date::text AS date, route_id FROM requests WHERE id = $1', [request_id]);
      const r = reqs[0];
      if (!r) throw notFound(`Нет заявки «${request_id}».`);
      if (r.route_id) throw ruleError(`Заявка ${r.id} уже стоит в маршруте ${r.route_id}.`, 'points');
      if (r.date !== route.date) {
        throw ruleError(`Заявка записана на ${r.date}, а маршрут собран на ${route.date}. Сначала перенесите заявку.`, 'date');
      }
      await db.query('INSERT INTO stops (route_id, request_id, position) VALUES ($1, $2, 1)', [id, request_id]);
      await renumber(db, id);
      await db.query(`UPDATE requests SET route_id = $1, status = 'в маршруте', updated_at = now() WHERE id = $2`,
        [id, request_id]);
      return { route_id: id, request_id };
    });
  });

  app.delete('/routes/:id/stops/:requestId', {
    schema: {
      tags: ['маршруты'],
      summary: 'Исключить адрес из маршрута; последний адрес расформировывает маршрут',
      security: [{ session: [] }], params: STOP_PARAMS,
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { id, requestId } = req.params as { id: string; requestId: string };
    return app.db.tx(async (db) => {
      await routeOr404(db, id);
      const { rows: stop } = await db.query<{ done: boolean }>(
        'SELECT done FROM stops WHERE route_id = $1 AND request_id = $2', [id, requestId]);
      if (!stop[0]) throw notFound(`Заявки «${requestId}» нет в маршруте «${id}».`);
      if (stop[0].done) throw ruleError('Позиция закрыта — сначала верните её в работу.', 'done');
      await db.query('DELETE FROM stops WHERE route_id = $1 AND request_id = $2', [id, requestId]);
      await db.query(`UPDATE requests SET route_id = NULL, status = 'создана', updated_at = now() WHERE id = $1`, [requestId]);
      const { rows: left } = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM stops WHERE route_id = $1', [id]);
      // Маршрут без точек не нужен: в прототипе он в этот момент расформировывался сам.
      if (Number(left[0]!.n) === 0) {
        await db.query('DELETE FROM routes WHERE id = $1', [id]);
        return { removed: requestId, disbanded: id };
      }
      await renumber(db, id);
      return { removed: requestId, disbanded: null };
    });
  });

  app.post('/routes/:id/stops/:requestId/move', {
    schema: {
      tags: ['маршруты'], summary: 'Переставить точку в порядке объезда',
      security: [{ session: [] }], params: STOP_PARAMS,
      body: { type: 'object', required: ['delta'], properties: { delta: { type: 'integer', enum: [-1, 1] } } },
    },
  }, async (req) => {
    requireRole(req, 'supervisor', 'senior', 'operator');
    const { id, requestId } = req.params as { id: string; requestId: string };
    const { delta } = req.body as { delta: number };
    return app.db.tx(async (db) => {
      const { rows: mine } = await db.query<{ id: string; position: number }>(
        'SELECT id, position FROM stops WHERE route_id = $1 AND request_id = $2', [id, requestId]);
      if (!mine[0]) throw notFound(`Заявки «${requestId}» нет в маршруте «${id}».`);
      const { rows: other } = await db.query<{ id: string; position: number }>(
        'SELECT id, position FROM stops WHERE route_id = $1 AND position = $2', [id, mine[0].position + delta]);
      if (!other[0]) throw ruleError('Точка уже с краю маршрута.', 'position');
      // Позиции меняются местами внутри транзакции: ограничение уникальности
      // отложенное (DEFERRABLE) как раз ради этого — временные номера не нужны.
      await db.query('UPDATE stops SET position = $2 WHERE id = $1', [mine[0].id, other[0].position]);
      await db.query('UPDATE stops SET position = $2 WHERE id = $1', [other[0].id, mine[0].position]);
      return { moved: requestId, position: other[0].position };
    });
  });

  app.post('/routes/:id/stops/:requestId/call', {
    schema: {
      tags: ['маршруты'],
      summary: 'Результат обзвона точки: подтверждена, перенос или отказ',
      security: [{ session: [] }], params: STOP_PARAMS,
      body: {
        type: 'object', required: ['result'],
        properties: { result: { type: 'string', enum: ['подтверждена', 'перенос', 'отказ'] } },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor', 'senior', 'operator');
    const { id, requestId } = req.params as { id: string; requestId: string };
    const { result } = req.body as { result: 'подтверждена' | 'перенос' | 'отказ' };
    return app.db.tx(async (db) => {
      const { rows } = await db.query(
        'UPDATE stops SET called = $3 WHERE route_id = $1 AND request_id = $2 RETURNING *', [id, requestId, result]);
      if (!rows[0]) throw notFound(`Заявки «${requestId}» нет в маршруте «${id}».`);
      // Отказ снимает адрес совсем, перенос оставляет его оператору на перезапись.
      if (result !== 'подтверждена') {
        await db.query('UPDATE requests SET status = $2, updated_at = now() WHERE id = $1',
          [requestId, result === 'отказ' ? 'отменена' : 'перенос']);
      }
      // Все точки обзвонены — маршрут можно отдавать поверителю.
      const { rows: left } = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM stops WHERE route_id = $1 AND called IS NULL', [id]);
      if (Number(left[0]!.n) === 0) {
        await db.query(`UPDATE routes SET status = 'обзвонен', updated_at = now() WHERE id = $1 AND status = 'черновик'`, [id]);
      }
      return { stop: rows[0] };
    });
  });

  /* ── чат маршрута ───────────────────────────────────────────── */

  app.get('/routes/:id/chat', {
    schema: { tags: ['маршруты'], summary: 'Переписка оператора и поверителя по маршруту', security: [{ session: [] }], params: ID },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const route = await routeOr404(app.db, id);
    if (!canSeeRoute(user.role as Role, user.id, (route.verifier_id as string) ?? null)) {
      throw ruleError('Поверитель видит только свои маршруты.', 'role');
    }
    const { rows } = await app.db.query('SELECT * FROM route_chat WHERE route_id = $1 ORDER BY at', [id]);
    return { chat: rows };
  });

  app.post('/routes/:id/chat', {
    schema: {
      tags: ['маршруты'], summary: 'Написать в чат маршрута', security: [{ session: [] }], params: ID,
      body: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } },
    },
  }, async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    const route = await routeOr404(app.db, id);
    if (!canSeeRoute(user.role as Role, user.id, (route.verifier_id as string) ?? null)) {
      throw ruleError('Поверитель пишет только в чат своего маршрута.', 'role');
    }
    const { rows } = await app.db.query(
      `INSERT INTO route_chat (route_id, author_id, is_verifier, text, at) VALUES ($1, $2, $3, $4, now()) RETURNING *`,
      [id, user.id, user.role === 'verifier', text.trim()]);
    return { message: rows[0] };
  });
};

export default plugin;
