/* Сервис платежей: что происходит между актом, провайдером и кассой.
 *
 *   акт ──«показать QR»──▶ createOnlinePayment ──▶ провайдер ──▶ QR или ссылка
 *   провайдер ──уведомление──▶ applyEvent ──▶ «оплачен» ──▶ registerReceipt ──▶ чек
 *   касса ──чек на почту клиента──▶ уведомление «чек» (пункт int-notify)
 *   руководитель ──возврат / отмена──▶ провайдер ──▶ «возвращён» / «отменён»
 *
 * Правила, которые здесь держатся:
 *
 *  - Сумма платежа — цена акта на момент создания, и никакая другая: поверитель
 *    сумму не вводит. Если акт после этого изменили, закрыть позицию с таким
 *    платежом нельзя (`openPaymentProblem`), пока его не отменят.
 *  - Уведомление провайдера обрабатывается один раз, сколько бы раз ни пришло:
 *    ключ повтора в `payment_events` и переходы состояния «только вперёд».
 *  - Чек — отдельный шаг после оплаты, с позициями акта, и его неудача не
 *    отменяет оплату: деньги уже на счёте, чек можно пробить повторно.
 *  - Безнал в подотчёт не попадает: у платежа нет «принял руками», и способ
 *    оплаты не входит в PAY_HAND.
 */
import type { Db } from '../api/db.ts';
import { ruleError, notFound, ApiError } from '../api/errors.ts';
import { loadDevices, loadServices } from '../api/store.ts';
import {
  onlineMethodOf, priceOf, receiptItems, receiptTotal, type ClientType, type OnlineKind, type ReceiptItem,
} from '../rules.ts';
import { enqueueQuietly } from '../notify/events.ts';
import type { PaymentConfig } from './config.ts';
import { ProviderError, type PaymentProvider, type WebhookEvent } from './provider.ts';

export interface OnlinePayment {
  id: number;
  request_id: string;
  provider: string;
  external_id: string | null;
  kind: OnlineKind;
  amount: number;
  status: 'создан' | 'ожидает' | 'оплачен' | 'отменён' | 'возвращён' | 'ошибка';
  confirmation: string;
  idempotence_key: string;
  items: ReceiptItem[];
  customer_email: string;
  customer_phone: string;
  paid_at: string | null;
  paid_amount: number | null;
  mismatch: boolean;
  receipt_id: string | null;
  receipt_status: 'ожидает' | 'зарегистрирован' | 'ошибка' | null;
  receipt_number: string | null;
  receipt_sent_at: string | null;
  refund_id: string | null;
  refund_amount: number | null;
  refund_reason: string;
  refund_receipt_number: string | null;
  refunded_at: string | null;
  error: string | null;
  created_by: string | null;
  handled_by: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestRow {
  id: string;
  client_type: ClientType;
  name: string;
  email: string;
  phone_norm: string;
  verifier_id: string | null;
  route_verifier: string | null;
  status: string;
}

export interface Log { warn(o: unknown, m: string): void; error(o: unknown, m: string): void }

const OPEN = ['создан', 'ожидает'];

async function requestOf(db: Db, id: string): Promise<RequestRow> {
  const { rows } = await db.query<RequestRow>(
    `SELECT r.id, r.client_type, r.name, r.email, r.phone_norm, r.verifier_id, r.status, rt.verifier_id AS route_verifier
       FROM requests r LEFT JOIN routes rt ON rt.id = r.route_id WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound(`Нет заявки «${id}».`);
  return rows[0];
}

/** Цена акта и позиции чека по текущим строкам приборов — то, что сравнивается
 *  с суммой платежа в каждом решении ниже. */
export async function actOf(db: Db, requestId: string, cfg: PaymentConfig) {
  const r = await requestOf(db, requestId);
  const { map } = await loadServices(db);
  const devices = await loadDevices(db, requestId);
  const act = devices.map((d) => ({
    service_id: String(d.service_id), pensioner: !!d.pensioner,
    device_type: d.device_type as string, serial: d.serial as string,
  }));
  const price = priceOf(map, r.client_type, act);
  const items = receiptItems(map, r.client_type, act, cfg.vatCode);
  return { request: r, price, items };
}

export async function onlineById(db: Db, id: number): Promise<OnlinePayment> {
  const { rows } = await db.query<OnlinePayment>('SELECT * FROM online_payments WHERE id = $1', [id]);
  if (!rows[0]) throw notFound(`Нет платежа №${id}.`);
  return rows[0];
}

/** Действующий платёж по заявке: последний, который не отменён. */
export async function activeOf(db: Db, requestId: string): Promise<OnlinePayment | null> {
  const { rows } = await db.query<OnlinePayment>(
    `SELECT * FROM online_payments WHERE request_id = $1 AND status <> 'отменён' AND status <> 'ошибка'
      ORDER BY id DESC LIMIT 1`, [requestId]);
  return rows[0] ?? null;
}

/** Почему позицию нельзя закрыть с этим способом: сумма действующего платежа
 *  разошлась с актом. Возвращает текст или null. */
export async function openPaymentProblem(db: Db, requestId: string, method: string, price: number): Promise<string | null> {
  const p = await activeOf(db, requestId);
  if (!p) {
    return onlineMethodOf('qr') === method || onlineMethodOf('link') === method
      ? 'Безналичный способ выбран, а платёж не создан — покажите клиенту QR или ссылку.'
      : null;
  }
  if (p.status === 'возвращён') return null;
  const online = onlineMethodOf(p.kind) === method;
  if (!online) {
    // Закрывают наличными при живом безнале: оплаченный так не бросить,
    // ожидающий — отменится сам (см. supersede в close).
    return p.status === 'оплачен'
      ? `Заявка уже оплачена по ${p.kind === 'qr' ? 'QR' : 'ссылке'} на ${p.amount} ₽ — способ оплаты менять нельзя, возврат делает руководитель.`
      : null;
  }
  if (p.amount !== price) {
    return `Сумма акта изменилась: платёж создан на ${p.amount} ₽, а в акте сейчас ${price} ₽. ` +
      (p.status === 'оплачен'
        ? 'Разница видна руководителю в сверке; акт под оплаченный платёж больше не правится.'
        : 'Создайте QR или ссылку заново — старый платёж отменится.');
  }
  return null;
}

/** Создать платёж на сумму акта: строка у нас, платёж у провайдера, отметка
 *  оплаты в заявке. Повторный вызов с той же суммой и видом отдаёт тот же
 *  действующий платёж — QR не плодятся от повторного нажатия. */
export async function createOnlinePayment(
  db: Db, provider: PaymentProvider, cfg: PaymentConfig,
  args: { requestId: string; kind: OnlineKind; userId: string; log?: Log },
): Promise<OnlinePayment> {
  const { request, price, items } = await actOf(db, args.requestId, cfg);
  if (price <= 0 || !items.length) throw ruleError('В акте нет платных позиций — платить не за что.', 'act');
  if (receiptTotal(items) !== price) throw ruleError('Позиции чека не сходятся с ценой акта — сообщите разработчику.', 'act');

  const current = await activeOf(db, args.requestId);
  if (current && OPEN.includes(current.status) && current.kind === args.kind && current.amount === price) return current;
  if (current?.status === 'оплачен') throw ruleError(`Заявка уже оплачена (платёж №${current.id}). Возврат делает руководитель.`, 'paid');

  const method = onlineMethodOf(args.kind);
  const verifier = request.verifier_id ?? request.route_verifier ?? null;
  const row = await db.tx(async (t) => {
    // Прежний ожидающий платёж (другая сумма или другой вид) уступает место.
    await t.query(
      `UPDATE online_payments SET status = 'отменён', error = 'заменён новым платежом', handled_by = $2, updated_at = now()
        WHERE request_id = $1 AND status IN ('создан', 'ожидает')`, [args.requestId, args.userId]);
    const { rows } = await t.query<OnlinePayment>(
      `INSERT INTO online_payments (request_id, provider, kind, amount, items, customer_email, customer_phone, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
      [args.requestId, provider.name, args.kind, price, JSON.stringify(items),
       (request.email ?? '').trim(), request.phone_norm ?? '', args.userId]);
    // Отметка оплаты в заявке: способ и сумма известны, деньги ещё не пришли.
    await t.query(
      `INSERT INTO payments (request_id, method, amount, charged, manual, note, paid_at, by_staff)
       VALUES ($1, $2, $3, $3, false, '', NULL, $4)
       ON CONFLICT (request_id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount,
         charged = EXCLUDED.charged, manual = false, paid_at = NULL, by_staff = EXCLUDED.by_staff`,
      [args.requestId, method, price, verifier]);
    return rows[0]!;
  });

  try {
    const created = await provider.createPayment({
      amount: price, kind: args.kind,
      description: `Заявка ${request.id}: поверка счётчиков, ${request.name}`.slice(0, 128),
      idempotenceKey: row.idempotence_key,
      returnUrl: cfg.publicBaseUrl ? `${cfg.publicBaseUrl}/?paid=${encodeURIComponent(request.id)}` : undefined,
      metadata: { request_id: request.id, online_id: String(row.id) },
    });
    const { rows } = await db.query<OnlinePayment>(
      `UPDATE online_payments SET external_id = $2, confirmation = $3,
              status = CASE WHEN $4 THEN 'оплачен' ELSE 'ожидает' END,
              paid_at = CASE WHEN $4 THEN now() ELSE NULL END, updated_at = now()
        WHERE id = $1 RETURNING *`, [row.id, created.id, created.confirmation, created.status === 'succeeded']);
    return rows[0]!;
  } catch (err) {
    const message = (err as Error).message;
    await db.query(`UPDATE online_payments SET status = 'ошибка', error = $2, updated_at = now() WHERE id = $1`, [row.id, message]);
    args.log?.error({ err, requestId: args.requestId }, 'платёж у провайдера не создан');
    throw new ApiError(err instanceof ProviderError ? 502 : 500, message);
  }
}

/** Чек по оплаченному платежу: позиции акта, покупатель, отправка клиенту.
 *  Неудача пишется в строку и не поднимается выше: деньги уже приняты. */
export async function registerReceipt(
  db: Db, provider: PaymentProvider, cfg: PaymentConfig, id: number, log?: Log,
): Promise<OnlinePayment> {
  const p = await onlineById(db, id);
  if (p.status !== 'оплачен' || !p.external_id) throw ruleError('Чек пробивается только по оплаченному платежу.', 'status');
  if (p.receipt_status === 'зарегистрирован') return p;
  if (!p.customer_email && !p.customer_phone) {
    await db.query(`UPDATE online_payments SET receipt_status = 'ошибка', error = $2, updated_at = now() WHERE id = $1`,
      [id, 'у клиента нет ни почты, ни телефона — чек отправить некуда']);
    return onlineById(db, id);
  }
  const items = (typeof p.items === 'string' ? JSON.parse(p.items) : p.items) as ReceiptItem[];
  try {
    const receipt = await provider.registerReceipt({
      type: 'payment', paymentId: p.external_id, settlement: 'cashless', send: true,
      amount: p.paid_amount ?? p.amount, items, taxSystem: cfg.taxSystem,
      customer: { email: p.customer_email || undefined, phone: p.customer_email ? undefined : p.customer_phone },
    }, `receipt:${p.idempotence_key}`);
    const done = receipt.status === 'succeeded';
    await db.tx(async (t) => {
      await t.query(
        `UPDATE online_payments SET receipt_id = $2, receipt_status = $3, receipt_number = $4,
                receipt_sent_at = CASE WHEN $3 = 'зарегистрирован' THEN now() ELSE receipt_sent_at END,
                error = NULL, updated_at = now() WHERE id = $1`,
        [id, receipt.id, done ? 'зарегистрирован' : 'ожидает', receipt.fiscalNumber]);
      if (done) {
        await t.query(
          `UPDATE payments SET receipt_number = $2, receipt_sent_at = now() WHERE request_id = $1`,
          [p.request_id, receipt.fiscalNumber]);
      }
    });
    if (done) {
      // Событие «чек отправлен» — по правилам уведомлений: с согласия клиента,
      // в очередь, не роняя обработку платежа.
      enqueueQuietly(db, 'чек', p.request_id, {
        receipt: { number: receipt.fiscalNumber ?? receipt.id, amount: p.paid_amount ?? p.amount, email: p.customer_email },
      }, log);
    }
  } catch (err) {
    await db.query(`UPDATE online_payments SET receipt_status = 'ошибка', error = $2, updated_at = now() WHERE id = $1`,
      [id, (err as Error).message]);
    log?.warn({ err, id }, 'чек не зарегистрирован');
  }
  return onlineById(db, id);
}

/** Чек, который касса регистрировала не сразу: дочитать состояние. */
export async function refreshReceipt(db: Db, provider: PaymentProvider, id: number, log?: Log): Promise<OnlinePayment> {
  const p = await onlineById(db, id);
  if (!p.receipt_id || p.receipt_status === 'зарегистрирован') return p;
  try {
    const receipt = await provider.getReceipt(p.receipt_id);
    if (receipt.status === 'succeeded') {
      await db.tx(async (t) => {
        await t.query(
          `UPDATE online_payments SET receipt_status = 'зарегистрирован', receipt_number = $2,
                  receipt_sent_at = now(), error = NULL, updated_at = now() WHERE id = $1`, [id, receipt.fiscalNumber]);
        await t.query(`UPDATE payments SET receipt_number = $2, receipt_sent_at = now() WHERE request_id = $1`,
          [p.request_id, receipt.fiscalNumber]);
      });
      enqueueQuietly(db, 'чек', p.request_id, {
        receipt: { number: receipt.fiscalNumber ?? receipt.id, amount: p.paid_amount ?? p.amount, email: p.customer_email },
      }, log);
    } else if (receipt.status === 'canceled') {
      await db.query(`UPDATE online_payments SET receipt_status = 'ошибка', error = 'касса отклонила чек', updated_at = now() WHERE id = $1`, [id]);
    }
  } catch (err) {
    log?.warn({ err, id }, 'состояние чека не прочитано');
  }
  return onlineById(db, id);
}

/** Событие провайдера, уже подтверждённое (verifyWebhook) — в состояние платежа.
 *  Идемпотентно: повтор того же события ничего не меняет и чек второй раз не
 *  пробивает. Возвращает, что сделано, — для журнала событий. */
export async function applyEvent(
  db: Db, provider: PaymentProvider, cfg: PaymentConfig, ev: WebhookEvent, log?: Log,
): Promise<{ applied: string; payment: OnlinePayment | null }> {
  if (!ev.paymentId) return { applied: 'без платежа', payment: null };
  const { rows } = await db.query<OnlinePayment>(
    'SELECT * FROM online_payments WHERE provider = $1 AND external_id = $2', [provider.name, ev.paymentId]);
  const p = rows[0];
  if (!p) return { applied: 'платёж неизвестен', payment: null };

  if (ev.status === 'succeeded' && ev.event.startsWith('payment.')) {
    if (p.status === 'оплачен' || p.status === 'возвращён') return { applied: 'уже оплачен', payment: p };
    const paid = ev.amount ?? p.amount;
    const { price } = await actOf(db, p.request_id, cfg);
    const mismatch = paid !== p.amount || price !== p.amount;
    const updated = await db.tx(async (t) => {
      const { rows: u } = await t.query<OnlinePayment>(
        `UPDATE online_payments SET status = 'оплачен', paid_at = COALESCE($2::timestamptz, now()), paid_amount = $3,
                mismatch = $4, error = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
        [p.id, ev.paidAt, paid, mismatch]);
      await t.query(
        `INSERT INTO payments (request_id, method, amount, charged, manual, note, paid_at, by_staff)
         VALUES ($1, $2, $3, $4, false, $5, now(), (SELECT COALESCE(r.verifier_id, rt.verifier_id) FROM requests r
                 LEFT JOIN routes rt ON rt.id = r.route_id WHERE r.id = $1))
         ON CONFLICT (request_id) DO UPDATE SET method = EXCLUDED.method, amount = EXCLUDED.amount,
           charged = EXCLUDED.charged, manual = false, paid_at = now(), note = EXCLUDED.note`,
        [p.request_id, onlineMethodOf(p.kind), paid, price,
         mismatch ? `Сумма платежа ${paid} ₽ разошлась с актом (${price} ₽) — см. сверку эквайринга` : '']);
      return u[0]!;
    });
    if (mismatch) log?.warn({ id: p.id, paid, price, created: p.amount }, 'сумма платежа разошлась с актом');
    const withReceipt = await registerReceipt(db, provider, cfg, updated.id, log);
    return { applied: 'оплачен', payment: withReceipt };
  }
  if (ev.status === 'canceled' && ev.event.startsWith('payment.')) {
    if (!OPEN.includes(p.status)) return { applied: 'состояние не меняется', payment: p };
    const updated = await db.tx(async (t) => {
      const { rows: u } = await t.query<OnlinePayment>(
        `UPDATE online_payments SET status = 'отменён', error = 'отменён провайдером', updated_at = now() WHERE id = $1 RETURNING *`, [p.id]);
      await t.query(
        `UPDATE payments SET method = 'не оплачено', amount = 0, paid_at = NULL, note = 'платёж отменён провайдером'
          WHERE request_id = $1 AND paid_at IS NULL AND method IN ('СБП по QR', 'платёжная ссылка')`, [p.request_id]);
      return u[0]!;
    });
    return { applied: 'отменён', payment: updated };
  }
  if (ev.event.startsWith('refund.') && ev.status === 'succeeded') {
    if (p.status === 'возвращён') return { applied: 'уже возвращён', payment: p };
    // Возврат, сделанный из кабинета провайдера, а не из системы: отмечаем как
    // есть, причина — «из кабинета», руководитель увидит его в сверке.
    const { rows: u } = await db.query<OnlinePayment>(
      `UPDATE online_payments SET status = 'возвращён', refund_id = $2, refund_amount = $3,
              refund_reason = COALESCE(NULLIF(refund_reason, ''), 'возврат из кабинета провайдера'),
              refunded_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id, ev.refundId, ev.amount ?? p.paid_amount ?? p.amount]);
    await db.query(
      `UPDATE payments SET method = 'не оплачено', amount = 0, paid_at = NULL, note = $2 WHERE request_id = $1`,
      [p.request_id, `возврат по эквайрингу ${ev.amount ?? p.amount} ₽`]);
    return { applied: 'возвращён', payment: u[0]! };
  }
  return { applied: 'состояние не меняется', payment: p };
}

/** Спросить провайдера о платеже и применить ответ так же, как уведомление.
 *  Нужно там, куда уведомления не доходят (машина разработчика), и для кнопки
 *  «проверить оплату» на телефоне, когда клиент говорит «я заплатил». */
export async function syncOnline(
  db: Db, provider: PaymentProvider, cfg: PaymentConfig, id: number, log?: Log,
): Promise<OnlinePayment> {
  const p = await onlineById(db, id);
  if (!p.external_id || !OPEN.includes(p.status)) return p;
  const remote = await provider.getPayment(p.external_id);
  const out = await applyEvent(db, provider, cfg, {
    event: `payment.${remote.status}`, paymentId: remote.id, refundId: null,
    status: remote.status, amount: remote.amount, paidAt: remote.paidAt, raw: remote.raw,
  }, log);
  return out.payment ?? p;
}

/** Ожидающие платежи, чей срок вышел: отметить у себя, чтобы сверка не
 *  показывала вечные «ожидает». Провайдер свои отменяет сам. */
export async function expireStale(db: Db, cfg: PaymentConfig): Promise<number> {
  const { rows } = await db.query<{ id: number; request_id: string }>(
    `UPDATE online_payments SET status = 'отменён', error = 'срок оплаты вышел', updated_at = now()
      WHERE status IN ('создан', 'ожидает') AND created_at < now() - ($1::int * interval '1 minute')
      RETURNING id, request_id`, [cfg.ttlMinutes]);
  for (const r of rows) {
    await db.query(
      `UPDATE payments SET method = 'не оплачено', amount = 0, note = 'срок оплаты QR или ссылки вышел'
        WHERE request_id = $1 AND paid_at IS NULL AND method IN ('СБП по QR', 'платёжная ссылка')`, [r.request_id]);
  }
  return rows.length;
}

/** Отмена ожидающего платежа — руководителем. */
export async function cancelOnline(
  db: Db, provider: PaymentProvider, args: { id: number; userId: string; log?: Log },
): Promise<OnlinePayment> {
  const p = await onlineById(db, args.id);
  if (!OPEN.includes(p.status)) throw ruleError(`Платёж №${p.id} в состоянии «${p.status}» — отменять нечего.`, 'status');
  if (p.external_id) {
    try {
      await provider.cancelPayment(p.external_id);
    } catch (err) {
      // Отмена у провайдера не обязательна: неоплаченный QR истечёт сам.
      args.log?.warn({ err, id: p.id }, 'провайдер отмену не принял, платёж отменён у нас');
    }
  }
  return db.tx(async (t) => {
    const { rows } = await t.query<OnlinePayment>(
      `UPDATE online_payments SET status = 'отменён', error = 'отменён руководителем', handled_by = $2, updated_at = now()
        WHERE id = $1 RETURNING *`, [p.id, args.userId]);
    await t.query(
      `UPDATE payments SET method = 'не оплачено', amount = 0, paid_at = NULL, note = 'платёж отменён руководителем'
        WHERE request_id = $1 AND paid_at IS NULL AND method IN ('СБП по QR', 'платёжная ссылка')`, [p.request_id]);
    return rows[0]!;
  });
}

/** Возврат оплаченного — руководителем, с чеком возврата. Деньги уходят на тот
 *  же счёт клиента, заявка становится «не оплачено» с причиной. */
export async function refundOnline(
  db: Db, provider: PaymentProvider, cfg: PaymentConfig,
  args: { id: number; userId: string; reason: string; log?: Log },
): Promise<OnlinePayment> {
  const p = await onlineById(db, args.id);
  const reason = args.reason.trim();
  if (!reason) throw ruleError('Укажите причину возврата — она попадёт в журнал и в чек.', 'reason');
  if (p.status !== 'оплачен' || !p.external_id) throw ruleError(`Возврат возможен только по оплаченному платежу (сейчас «${p.status}»).`, 'status');
  const amount = p.paid_amount ?? p.amount;
  const items = (typeof p.items === 'string' ? JSON.parse(p.items) : p.items) as ReceiptItem[];
  let refund;
  try {
    refund = await provider.refund({
      paymentId: p.external_id, amount, idempotenceKey: `refund:${p.idempotence_key}`,
      receipt: { items, taxSystem: cfg.taxSystem,
        customer: { email: p.customer_email || undefined, phone: p.customer_email ? undefined : p.customer_phone } },
    });
  } catch (err) {
    throw new ApiError(err instanceof ProviderError ? 502 : 500, (err as Error).message);
  }
  return db.tx(async (t) => {
    const { rows } = await t.query<OnlinePayment>(
      `UPDATE online_payments SET status = 'возвращён', refund_id = $2, refund_amount = $3, refund_reason = $4,
              refunded_at = now(), handled_by = $5, updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id, refund.id, refund.amount, reason, args.userId]);
    await t.query(
      `UPDATE payments SET method = 'не оплачено', amount = 0, paid_at = NULL, note = $2 WHERE request_id = $1`,
      [p.request_id, `возврат по эквайрингу ${refund.amount} ₽: ${reason}`]);
    return rows[0]!;
  });
}

/** Сверка за период у руководителя: платежи с заявками и итоги. */
export async function reconciliation(db: Db, from: string, to: string, status?: string | null) {
  const { rows } = await db.query(
    `SELECT p.*, r.date::text AS request_date, r.city, r.name, r.street, r.house, r.flat, r.client_type,
            s.full_name AS created_by_name, h.full_name AS handled_by_name
       FROM online_payments p
       JOIN requests r ON r.id = p.request_id
       LEFT JOIN staff s ON s.id = p.created_by
       LEFT JOIN staff h ON h.id = p.handled_by
      WHERE COALESCE(p.paid_at, p.created_at) >= $1::date AND COALESCE(p.paid_at, p.created_at) < $2::date + 1
        AND ($3::text IS NULL OR p.status = $3)
      ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC`, [from, to, status ?? null]);
  const { rows: totals } = await db.query<{ paid: string; refunded: string; pending: string; n_paid: string; n_receipts: string; n_mismatch: string }>(
    `SELECT coalesce(sum(paid_amount) FILTER (WHERE status = 'оплачен'), 0)::text AS paid,
            coalesce(sum(refund_amount) FILTER (WHERE status = 'возвращён'), 0)::text AS refunded,
            coalesce(sum(amount) FILTER (WHERE status IN ('создан', 'ожидает')), 0)::text AS pending,
            count(*) FILTER (WHERE status = 'оплачен')::text AS n_paid,
            count(*) FILTER (WHERE receipt_status = 'зарегистрирован')::text AS n_receipts,
            count(*) FILTER (WHERE mismatch)::text AS n_mismatch
       FROM online_payments
      WHERE COALESCE(paid_at, created_at) >= $1::date AND COALESCE(paid_at, created_at) < $2::date + 1`, [from, to]);
  const t = totals[0]!;
  return {
    payments: rows,
    totals: {
      paid: Number(t.paid), refunded: Number(t.refunded), pending: Number(t.pending),
      n_paid: Number(t.n_paid), n_receipts: Number(t.n_receipts), n_mismatch: Number(t.n_mismatch),
    },
  };
}
