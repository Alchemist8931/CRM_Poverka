/* Деньги: оплата на месте, заработок, сдельная оплата по всем и подотчёт.
 *
 * Наличные и перевод на карту поверитель берёт на адресе и держит у себя как
 * подотчёт до конца месяца: у такого платежа нет ни провайдера, ни внешнего
 * идентификатора — только способ, сумма и кто принял. Безнал через провайдера
 * (СБП по QR, платёжная ссылка — пункт int-pay, `routes/payment.ts`) в подотчёт
 * не попадает: деньги приходят на расчётный счёт ИП, а отметка «оплачено»
 * ставится уведомлением провайдера, а не рукой поверителя.
 *
 * Начисления считаются по снимку в строках приборов (`rate_verifier`,
 * `rate_operator`), а не по текущему прайсу: переписанная цена не должна менять
 * уже начисленную сдельную оплату.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireRole, requireUser } from '../auth.ts';
import { notFound, ruleError } from '../errors.ts';
import { loadDevices, loadServices } from '../store.ts';
import {
  PAY_HAND, PAY_METHODS, PAY_ONLINE, canManageUsers, canSeeEarningsOf, payMethods, priceOf, type ClientType, type Role,
} from '../../rules.ts';
import { canPay } from '../../payment/config.ts';
import { activeOf, openPaymentProblem } from '../../payment/service.ts';

const MONTH = { type: 'string', pattern: '^\\d{4}-\\d{2}$' } as const;

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/requests/:id/payment', {
    schema: {
      tags: ['деньги'], summary: 'Отметка об оплате по заявке и способы, доступные клиенту',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    requireUser(req);
    const { id } = req.params as { id: string };
    const { rows: reqs } = await app.db.query<{ client_type: ClientType }>(
      'SELECT client_type FROM requests WHERE id = $1', [id]);
    if (!reqs[0]) throw notFound(`Нет заявки «${id}».`);
    const { rows } = await app.db.query('SELECT * FROM payments WHERE request_id = $1', [id]);
    const { map } = await loadServices(app.db);
    const devices = await loadDevices(app.db, id);
    return {
      payment: rows[0] ?? null,
      // Счёт выставляется только юрлицу — физлицу этот способ не показываем;
      // безнал через провайдера — только там, где он подключён.
      methods: payMethods(reqs[0].client_type, !!app.payments && canPay(app.paymentConfig)),
      charged: priceOf(map, reqs[0].client_type, devices.map((d) => ({ service_id: String(d.service_id), pensioner: !!d.pensioner }))),
      online: await activeOf(app.db, id),
    };
  });

  app.put('/requests/:id/payment', {
    schema: {
      tags: ['деньги'],
      summary: 'Отметить оплату на месте: способ, сумма, примечание',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['method'],
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
    const b = req.body as { method: string; amount?: number; note?: string };
    const { rows: reqs } = await app.db.query<{ client_type: ClientType; verifier_id: string | null }>(
      'SELECT client_type, verifier_id FROM requests WHERE id = $1', [id]);
    const request = reqs[0];
    if (!request) throw notFound(`Нет заявки «${id}».`);
    const online = PAY_ONLINE.includes(b.method as never);
    if (!payMethods(request.client_type, !!app.payments && canPay(app.paymentConfig)).includes(b.method as never)) {
      throw ruleError(online
        ? 'Эквайринг не подключён к этому контуру: принимайте наличными или переводом.'
        : 'По счёту платит только юрлицо — физлицу этот способ недоступен.', 'method');
    }
    const { map } = await loadServices(app.db);
    const devices = await loadDevices(app.db, id);
    const charged = priceOf(map, request.client_type,
      devices.map((d) => ({ service_id: String(d.service_id), pensioner: !!d.pensioner })));
    // Оплаченный безнал руками не переписывается, ожидающий с другой суммой —
    // не принимается: те же правила, что при закрытии позиции.
    const stale = await openPaymentProblem(app.db, id, b.method, charged);
    if (stale) throw ruleError(stale, 'payment');
    const onlinePay = online ? await activeOf(app.db, id) : null;
    // «Не оплачено» — это долг, а не платёж на ноль рублей: сумма при нём нулевая.
    // У безнала сумма — из платежа, отметка «оплачено» — из уведомления провайдера.
    const amount = b.method === 'не оплачено' ? 0 : online ? (onlinePay?.paid_amount ?? onlinePay?.amount ?? charged) : b.amount ?? 0;
    const paidAt = b.method === 'не оплачено' ? null : online ? onlinePay?.paid_at ?? null : new Date();

    const { rows } = await app.db.query(
      `INSERT INTO payments (request_id, method, amount, charged, manual, note, paid_at, by_staff)
       VALUES ($1,$2,$3,$4,$5,$6, $8, $7)
       ON CONFLICT (request_id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount,
         charged = EXCLUDED.charged, manual = EXCLUDED.manual, note = EXCLUDED.note,
         paid_at = EXCLUDED.paid_at, by_staff = EXCLUDED.by_staff
       RETURNING *`,
      [id, b.method, amount, charged, !online && b.amount != null, b.note ?? '',
       request.verifier_id ?? (user.role === 'verifier' ? user.id : null), paidAt]);
    return { payment: rows[0], online: onlinePay };
  });

  app.get('/payments/:id/status', {
    schema: {
      tags: ['деньги'],
      summary: 'Состояние платежа: у наличных — по отметке о приёме, у безнала — по платежу провайдера',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    },
  }, async (req) => {
    requireUser(req);
    const { id } = req.params as { id: number };
    const { rows } = await app.db.query<{ request_id: string; method: string; amount: number; charged: number; paid_at: string | null; receipt_number: string | null }>(
      'SELECT request_id, method, amount, charged, paid_at, receipt_number FROM payments WHERE id = $1', [id]);
    const p = rows[0];
    if (!p) throw notFound(`Нет платежа №${id}.`);
    const online = PAY_ONLINE.includes(p.method as never) ? await activeOf(app.db, p.request_id) : null;
    return {
      id,
      provider: online?.provider ?? null,
      // У наличных состояние выводится из способа и отметки о приёме денег;
      // у безнала его называет платёж провайдера.
      state: p.method === 'не оплачено' ? 'долг'
        : online ? online.status
        : p.paid_at ? 'принят' : 'ожидает приёма',
      in_hand: PAY_HAND.includes(p.method as never),
      amount: p.amount,
      charged: p.charged,
      receipt_number: p.receipt_number,
      online,
    };
  });

  app.get('/payments', {
    schema: {
      tags: ['деньги'], summary: 'Платежи за период: по способу, сотруднику и долгам',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          month: MONTH, staff_id: { type: 'string' }, method: { type: 'string' },
          unpaid: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as { month?: string; staff_id?: string; method?: string; unpaid?: boolean };
    // Поверитель видит только собранное собой: это его подотчёт, а не касса компании.
    const staffId = user.role === 'verifier' ? user.id : q.staff_id ?? null;
    const { rows } = await app.db.query(
      `SELECT p.*, r.date::text AS date, r.city, r.name, r.street, r.house, r.flat
         FROM payments p JOIN requests r ON r.id = p.request_id
        WHERE ($1::text IS NULL OR to_char(r.date, 'YYYY-MM') = $1)
          AND ($2::text IS NULL OR p.by_staff = $2)
          AND ($3::text IS NULL OR p.method = $3)
          AND (NOT $4::boolean OR p.method = 'не оплачено')
        ORDER BY r.date DESC, p.id DESC`,
      [q.month ?? null, staffId, q.method ?? null, !!q.unpaid]);
    return { payments: rows };
  });

  /* ── заработок ──────────────────────────────────────────────── */

  app.get('/earnings', {
    schema: {
      tags: ['деньги'],
      summary: 'Сдельная за месяц: свой заработок у каждого, чужой — у руководителя',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: { month: MONTH, staff_id: { type: 'string' } },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as { month?: string; staff_id?: string };
    const staffId = q.staff_id ?? user.id;
    if (!canSeeEarningsOf(user.role as Role, user.id, staffId)) {
      throw ruleError('Свой заработок видит каждый, чужой — только руководитель.', 'role');
    }
    const month = q.month ?? new Date().toISOString().slice(0, 7);
    const { rows: who } = await app.db.query<{ role: Role }>('SELECT role FROM staff WHERE id = $1', [staffId]);
    if (!who[0]) throw notFound(`Нет сотрудника «${staffId}».`);
    const isVerifier = who[0].role === 'verifier';
    // Ставка берётся из снимка в строке прибора, а не из текущего прайса.
    const rate = isVerifier ? 'd.rate_verifier' : 'd.rate_operator';
    const link = isVerifier ? 'r.verifier_id' : 'r.operator_id';
    const { rows: byDay } = await app.db.query(
      `SELECT r.date::text AS date, count(DISTINCT r.id)::int AS requests, sum(${rate})::int AS wage
         FROM requests r JOIN devices d ON d.request_id = r.id
        WHERE r.status = 'выполнена' AND ${link} = $1 AND to_char(r.date, 'YYYY-MM') = $2
        GROUP BY r.date ORDER BY r.date`, [staffId, month]);
    const total = byDay.reduce((a, d) => a + Number((d as { wage: number }).wage ?? 0), 0);
    const { rows: wip } = await app.db.query(
      `SELECT count(*)::int AS n FROM requests r WHERE ${link} = $1 AND r.status IN ('создана', 'в маршруте', 'перенос')`,
      [staffId]);
    return { staff_id: staffId, month, role: who[0].role, total, by_day: byDay, in_progress: wip[0] };
  });

  app.get('/payroll', {
    schema: {
      tags: ['деньги'],
      summary: 'Сдельная по всем сотрудникам за месяц — только руководитель',
      security: [{ session: [] }],
      querystring: { type: 'object', properties: { month: MONTH } },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { month = new Date().toISOString().slice(0, 7) } = req.query as { month?: string };
    const { rows } = await app.db.query(
      `SELECT s.id, s.full_name, s.role,
              count(DISTINCT r.id)::int AS requests,
              sum(CASE WHEN s.role = 'verifier' THEN d.rate_verifier ELSE d.rate_operator END)::int AS wage
         FROM staff s
         JOIN requests r ON (s.role = 'verifier' AND r.verifier_id = s.id)
                         OR (s.role <> 'verifier' AND r.operator_id = s.id)
         JOIN devices d ON d.request_id = r.id
        WHERE r.status = 'выполнена' AND to_char(r.date, 'YYYY-MM') = $1
        GROUP BY s.id, s.full_name, s.role ORDER BY s.role, s.full_name`, [month]);
    const { rows: revenue } = await app.db.query<{ sum: string }>(
      `SELECT coalesce(sum(d.price_charged), 0)::text AS sum FROM requests r JOIN devices d ON d.request_id = r.id
        WHERE r.status = 'выполнена' AND to_char(r.date, 'YYYY-MM') = $1`, [month]);
    return { month, staff: rows, revenue: Number(revenue[0]!.sum) };
  });

  /* ── подотчёт ───────────────────────────────────────────────── */

  app.get('/handovers', {
    schema: {
      tags: ['деньги'],
      summary: 'Подотчёт поверителя за месяц: собрано, начислено, сдано, остаток',
      security: [{ session: [] }],
      querystring: { type: 'object', properties: { month: MONTH, staff_id: { type: 'string' } } },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as { month?: string; staff_id?: string };
    // Без сотрудника руководитель получает подотчёт всей бригады за месяц —
    // так экран «Сдельная оплата» узнаёт, кто что сдал. Остальным без
    // сотрудника отдаётся своё: чужой подотчёт им не положен.
    const staffId = q.staff_id ?? (canManageUsers(user.role as Role) ? null : user.id);
    if (staffId && !canSeeEarningsOf(user.role as Role, user.id, staffId)) {
      throw ruleError('Чужой подотчёт видит только руководитель.', 'role');
    }
    const month = q.month ?? new Date().toISOString().slice(0, 7);
    // В подотчёт идёт лишь то, что поверитель забрал лично: деньги по счёту
    // приходят на расчётный счёт и через его руки не проходят.
    const { rows: money } = await app.db.query<{ cash: string; card: string; acct: string; wage: string }>(
      `SELECT coalesce(sum(p.amount) FILTER (WHERE p.method = 'наличные'), 0)::text AS cash,
              coalesce(sum(p.amount) FILTER (WHERE p.method = 'перевод на карту'), 0)::text AS card,
              coalesce(sum(p.amount) FILTER (WHERE p.method = 'по счёту'), 0)::text AS acct,
              coalesce((SELECT sum(d.rate_verifier) FROM requests r2 JOIN devices d ON d.request_id = r2.id
                         WHERE r2.status = 'выполнена' AND ($1::text IS NULL OR r2.verifier_id = $1)
                           AND to_char(r2.date, 'YYYY-MM') = $2), 0)::text AS wage
         FROM payments p JOIN requests r ON r.id = p.request_id
        WHERE r.status = 'выполнена' AND ($1::text IS NULL OR r.verifier_id = $1) AND to_char(r.date, 'YYYY-MM') = $2`,
      [staffId, month]);
    const { rows: hos } = await app.db.query(
      `SELECT *, at::text AS at FROM handovers
        WHERE ($1::text IS NULL OR staff_id = $1) AND period = $2 ORDER BY handovers.at`, [staffId, month]);
    const got = Number(money[0]!.cash) + Number(money[0]!.card);
    const given = hos.reduce((a, h) => a + Number((h as { amount: number }).amount), 0);
    const wage = Number(money[0]!.wage);
    return {
      staff_id: staffId, period: month,
      cash: Number(money[0]!.cash), card: Number(money[0]!.card), acct: Number(money[0]!.acct),
      got, wage, given, left: got - wage - given, handovers: hos,
    };
  });

  app.post('/handovers', {
    schema: {
      tags: ['деньги'],
      summary: 'Принять подотчёт от поверителя — только руководитель',
      security: [{ session: [] }],
      body: {
        type: 'object', required: ['staff_id', 'period', 'amount'],
        properties: {
          staff_id: { type: 'string' }, period: MONTH,
          amount: { type: 'integer', minimum: 1 },
          at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          note: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const b = req.body as { staff_id: string; period: string; amount: number; at?: string; note?: string };
    return app.db.tx(async (db) => {
      const id = 'H' + Date.now().toString(36);
      // Сдача привязана к месяцу, за который её принесли, а не ко дню приёмки:
      // деньги за август обычно везут в первых числах сентября.
      const { rows } = await db.query(
        `INSERT INTO handovers (id, staff_id, at, period, amount, accepted_by, note)
         VALUES ($1, $2, coalesce($3::date, current_date), $4, $5, $6, $7) RETURNING *, at::text AS at`,
        [id, b.staff_id, b.at ?? null, b.period, b.amount, user.id, b.note ?? '']);
      return { handover: rows[0] };
    });
  });
};

export default plugin;
