/* Планирование дня и отсутствия.
 *
 * День планирует руководитель целиком: города приёма, план по каждому городу,
 * смена поверителей и смена операторов. От этой записи считается всё остальное —
 * и загрузка дня, и подсказка дат при приёме, и потолок по городу.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireRole, requireUser } from '../auth.ts';
import { notFound, ruleError } from '../errors.ts';
import { absentOn, bookedIn, bookedOn, loadDay, loadStaff, lockFactsFor } from '../store.ts';
import { MAX_CITIES, MAX_OPS, dayProblem, dayLock, dayState, dayTotal, worksOn } from '../../rules.ts';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/days', {
    schema: {
      tags: ['планирование'],
      summary: 'Дни с загрузкой: план, записано, состояние плитки',
      security: [{ session: [] }],
      querystring: { type: 'object', required: ['from', 'to'], properties: { from: DATE, to: DATE } },
    },
  }, async (req) => {
    requireUser(req);
    const { from, to } = req.query as { from: string; to: string };
    const { rows: days } = await app.db.query<{ date: string; cities: string[]; plan: Record<string, number>; crew: string[]; ops: string[]; note: string | null }>(
      `SELECT date::text AS date, cities, plan, crew, ops, note FROM days
        WHERE date BETWEEN $1 AND $2 ORDER BY date`, [from, to]);
    const { rows: booked } = await app.db.query<{ date: string; city: string; n: string }>(
      `SELECT date::text AS date, city, count(*)::text AS n FROM requests
        WHERE date BETWEEN $1 AND $2 AND status <> 'отменена' GROUP BY date, city`, [from, to]);
    const { rows: withRoutes } = await app.db.query<{ date: string }>(
      'SELECT DISTINCT date::text AS date FROM routes WHERE date BETWEEN $1 AND $2', [from, to]);
    const { rows: building } = await app.db.query<{ date: string }>(
      `SELECT date::text AS date FROM route_builder WHERE opened_at > now() - interval '2 hours'`);

    const total = new Map<string, number>();
    const byCity = new Map<string, number>();
    for (const b of booked) {
      total.set(b.date, (total.get(b.date) ?? 0) + Number(b.n));
      byCity.set(`${b.date}#${b.city}`, Number(b.n));
    }
    const hasRoutes = new Set(withRoutes.map((r) => r.date));
    const isBuilding = new Set(building.map((r) => r.date));

    return {
      days: days.map((d) => ({
        ...d,
        load: dayTotal(d, total.get(d.date) ?? 0),
        cityLoad: Object.fromEntries(d.cities.map((c) =>
          [c, dayState(d, c, byCity.get(`${d.date}#${c}`) ?? 0, total.get(d.date) ?? 0)])),
        lock: dayLock({ building: isBuilding.has(d.date), hasRoutes: hasRoutes.has(d.date) }),
      })),
    };
  });

  app.get('/days/:date', {
    schema: {
      tags: ['планирование'],
      summary: 'Один день: города, план, смены, загрузка, замок и доступные услуги',
      security: [{ session: [] }],
      params: { type: 'object', required: ['date'], properties: { date: DATE } },
    },
  }, async (req) => {
    requireUser(req);
    const { date } = req.params as { date: string };
    const day = await loadDay(app.db, date);
    const facts = await lockFactsFor(app.db, date);
    const total = await bookedOn(app.db, date);
    const absent = await absentOn(app.db, date);
    const staff = await loadStaff(app.db);
    const crew = (day?.crew ?? []).map((id) => staff.find((p) => p.id === id)).filter((p) => !!p);
    const onShift = crew.filter((p) => !absent.has(p!.id));
    const cityLoad: Record<string, unknown> = {};
    for (const c of day?.cities ?? []) {
      cityLoad[c] = dayState(day, c, await bookedIn(app.db, date, c), total);
    }
    return {
      day: day ?? { date, cities: [], plan: {}, crew: [], ops: [] },
      load: dayTotal(day, total),
      cityLoad,
      lock: dayLock(facts),
      crew,
      ops: (day?.ops ?? []).map((id) => staff.find((p) => p.id === id)).filter((p) => !!p),
      absent: [...absent],
      // Что можно выполнить в этот день — объединение компетенций смены.
      works: worksOn(onShift.map((p) => ({ svcs: p!.svcs }))),
      limits: { cities: MAX_CITIES, ops: MAX_OPS },
    };
  });

  app.put('/days/:date', {
    schema: {
      tags: ['планирование'],
      summary: 'Запись дня целиком: города, план по городам, смены. Только руководитель',
      security: [{ session: [] }],
      params: { type: 'object', required: ['date'], properties: { date: DATE } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cities: { type: 'array', items: { type: 'string' } },
          plan: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
          crew: { type: 'array', items: { type: 'string' } },
          ops: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const { date } = req.params as { date: string };
    const body = req.body as Partial<{ cities: string[]; plan: Record<string, number>; crew: string[]; ops: string[]; note: string }>;
    const prev = await loadDay(app.db, date);
    const next = {
      cities: body.cities ?? prev?.cities ?? [],
      plan: body.plan ?? prev?.plan ?? {},
      crew: body.crew ?? prev?.crew ?? [],
      ops: body.ops ?? prev?.ops ?? [],
      note: body.note ?? null,
    };

    const { rows: cityRows } = await app.db.query<{ name: string }>('SELECT name FROM cities WHERE active');
    const staff = await loadStaff(app.db);
    const known = {
      cities: new Set(cityRows.map((c) => c.name)),
      verifiers: new Set(staff.filter((p) => p.role === 'verifier' && !p.blocked_at).map((p) => p.id)),
      operators: new Set(staff.filter((p) => ['operator', 'senior'].includes(p.role) && !p.blocked_at).map((p) => p.id)),
    };
    // Потолки в пять городов и четыре оператора и состав смены — те же правила,
    // что в прототипе не давали нажать лишнюю плитку.
    const bad = dayProblem(next, known);
    if (bad) throw ruleError(bad);

    const { rows } = await app.db.query(
      `INSERT INTO days (date, cities, plan, crew, ops, note, updated_by)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (date) DO UPDATE SET cities = EXCLUDED.cities, plan = EXCLUDED.plan,
         crew = EXCLUDED.crew, ops = EXCLUDED.ops, note = EXCLUDED.note,
         updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING date::text AS date, cities, plan, crew, ops, note`,
      [date, next.cities, JSON.stringify(next.plan), next.crew, next.ops, next.note, user.id]);
    return { day: rows[0] };
  });

  /* ── отсутствия ───────────────────────────────────────────────── */

  app.get('/absences', {
    schema: {
      tags: ['планирование'], summary: 'Запросы на отсутствие', security: [{ session: [] }],
      querystring: { type: 'object', properties: { status: { type: 'string' }, staff_id: { type: 'string' } } },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as { status?: string; staff_id?: string };
    // Свои запросы видит каждый, чужие — руководитель: это сведения о человеке,
    // а не общая лента.
    const staffId = user.role === 'supervisor' ? q.staff_id ?? null : user.id;
    const { rows } = await app.db.query(
      `SELECT a.*, s.full_name FROM absences a JOIN staff s ON s.id = a.staff_id
        WHERE ($1::text IS NULL OR a.staff_id = $1) AND ($2::text IS NULL OR a.status = $2)
        ORDER BY a.date_from DESC`, [staffId, q.status ?? null]);
    return { absences: rows };
  });

  app.post('/absences', {
    schema: {
      tags: ['планирование'], summary: 'Запросить отсутствие', security: [{ session: [] }],
      body: {
        type: 'object', required: ['date_from', 'date_to', 'reason'],
        properties: { date_from: DATE, date_to: DATE, reason: { type: 'string' }, comment: { type: 'string' } },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const b = req.body as { date_from: string; date_to: string; reason: string; comment?: string };
    if (b.date_to < b.date_from) throw ruleError('Конец отсутствия раньше начала.');
    const id = 'A' + Date.now().toString(36);
    const { rows } = await app.db.query(
      `INSERT INTO absences (id, staff_id, date_from, date_to, reason, comment)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, user.id, b.date_from, b.date_to, b.reason, b.comment ?? '']);
    // До согласования дни остаются рабочими по графику — статус лежит в записи.
    return { absence: rows[0] };
  });

  app.post('/absences/:id/decide', {
    schema: {
      tags: ['планирование'], summary: 'Согласовать или отклонить отсутствие — руководитель',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['status'],
        properties: { status: { type: 'string', enum: ['согласовано', 'отклонено'] }, comment: { type: 'string' } },
      },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const { id } = req.params as { id: string };
    const b = req.body as { status: string; comment?: string };
    const { rows } = await app.db.query(
      `UPDATE absences SET status = $2, decided_by = $3, decided_at = now(),
              comment = coalesce($4, comment)
        WHERE id = $1 RETURNING *`, [id, b.status, user.id, b.comment ?? null]);
    if (!rows[0]) throw notFound(`Нет запроса на отсутствие «${id}».`);
    return { absence: rows[0] };
  });
};

export default plugin;
