/* ЮKassa: платежи по СБП и по ссылке, возвраты, чеки через партнёрскую кассу.
 *
 * Документация: yookassa.ru/developers/api — разделы «Платежи», «Возвраты»,
 * «Чеки» (сценарий «чек отдельным запросом», он же «после оплаты») и
 * «Входящие уведомления».
 *
 * Что здесь важно знать, чтобы не сделать хуже:
 *
 *  - Идентификация — Basic: shopId и секретный ключ. Тестовый магазин и боевой
 *    различаются только ключами; адрес API один.
 *  - Заголовок `Idempotence-Key` обязателен у всех POST: провайдер обязан
 *    отдать тот же ответ на повтор с тем же ключом и не создать второй платёж.
 *    Ключ хранится у нас в `online_payments.idempotence_key`.
 *  - Подписи у уведомлений нет. Провайдер советует два способа подтверждения:
 *    список своих адресов и повторное чтение объекта из API. Делаем оба.
 *  - Суммы у провайдера — строки с двумя знаками («900.00»); у нас целые рубли.
 */
import type { PaymentConfig } from './config.ts';
import { ipAllowed } from './config.ts';
import {
  ProviderError,
  type CreatePayment, type PaymentProvider, type ProviderPayment, type ProviderReceipt, type ProviderRefund,
  type ProviderStatus, type ReceiptDraft, type RegisterReceipt, type WebhookEvent, type WebhookInput,
} from './provider.ts';

interface YkAmount { value: string; currency: string }
interface YkPayment {
  id: string;
  status: ProviderStatus;
  paid: boolean;
  amount: YkAmount;
  confirmation?: { type: string; confirmation_data?: string; confirmation_url?: string };
  captured_at?: string;
  created_at?: string;
  metadata?: Record<string, string>;
}
interface YkRefund { id: string; status: 'pending' | 'succeeded' | 'canceled'; amount: YkAmount; payment_id: string }
interface YkReceipt {
  id: string;
  status: 'pending' | 'succeeded' | 'canceled';
  fiscal_document_number?: string;
  fiscal_storage_number?: string;
  fiscal_attribute?: string;
  registered_at?: string;
}
interface YkError { type?: string; code?: string; description?: string; parameter?: string }

/** Рубли → «900.00». */
export const money = (rub: number): YkAmount => ({ value: rub.toFixed(2), currency: 'RUB' });
/** «900.00» → 900. Копейки в системе не ходят, но у провайдера они возможны:
 *  округляем к рублю, расхождение поймает сверка суммы с актом. */
export const rub = (a: YkAmount | undefined): number => Math.round(Number(a?.value ?? 0));

/** Позиции чека в форме провайдера. */
export function ykItems(draft: ReceiptDraft) {
  return draft.items.map((i) => ({
    description: i.description,
    quantity: i.quantity.toFixed(2),
    amount: money(i.amount),
    vat_code: i.vat_code,
    payment_subject: i.payment_subject,
    payment_mode: i.payment_mode,
  }));
}

/** Покупатель в чеке: почта или телефон — хотя бы одно, иначе кассе некуда
 *  отправить чек и она отвергнет запрос. */
export function ykCustomer(c: ReceiptDraft['customer']) {
  const out: { email?: string; phone?: string } = {};
  if (c.email) out.email = c.email;
  if (c.phone) out.phone = c.phone.replace(/\D/g, '');
  return out;
}

function toPayment(p: YkPayment): ProviderPayment {
  return {
    id: p.id,
    status: p.status,
    paid: !!p.paid,
    amount: rub(p.amount),
    confirmation: p.confirmation?.confirmation_data ?? p.confirmation?.confirmation_url ?? '',
    paidAt: p.captured_at ?? null,
    raw: p,
  };
}

const toReceipt = (r: YkReceipt): ProviderReceipt => ({
  id: r.id, status: r.status, fiscalNumber: r.fiscal_document_number ?? null, raw: r,
});

export function yookassa(cfg: PaymentConfig): PaymentProvider {
  if (!cfg.shopId || !cfg.secretKey) throw new Error('ЮKassa: не заданы PAYMENT_SHOP_ID и PAYMENT_SECRET_KEY.');
  const auth = 'Basic ' + Buffer.from(`${cfg.shopId}:${cfg.secretKey}`).toString('base64');

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotenceKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: auth, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotenceKey) headers['idempotence-key'] = idempotenceKey;
    let res: Response;
    try {
      res = await fetch(`${cfg.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new ProviderError(502, `Провайдер платежей недоступен: ${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const e = (data ?? {}) as YkError;
      const what = e.description ? `${e.description}${e.parameter ? ` (${e.parameter})` : ''}` : text.slice(0, 200) || res.statusText;
      throw new ProviderError(res.status, `Провайдер платежей ответил ${res.status}: ${what}`);
    }
    return data as T;
  }

  async function getRefund(id: string): Promise<ProviderRefund> {
    const r = await call<YkRefund>('GET', `/refunds/${encodeURIComponent(id)}`);
    return { id: r.id, status: r.status, amount: rub(r.amount), raw: r };
  }

  return {
    name: 'yookassa',

    async createPayment(req: CreatePayment) {
      const body: Record<string, unknown> = {
        amount: money(req.amount),
        capture: true,
        description: req.description.slice(0, 128),
        metadata: req.metadata,
        confirmation: req.kind === 'qr'
          ? { type: 'qr' }
          : { type: 'redirect', return_url: req.returnUrl ?? cfg.publicBaseUrl ?? 'https://uchetkin.ru' },
      };
      // QR СБП — это способ оплаты «sbp» с подтверждением «qr». У ссылки способ
      // не задаётся: клиент выбирает его сам на странице провайдера.
      if (req.kind === 'qr') body.payment_method_data = { type: 'sbp' };
      const p = await call<YkPayment>('POST', '/payments', body, req.idempotenceKey);
      return toPayment(p);
    },

    async getPayment(id) {
      return toPayment(await call<YkPayment>('GET', `/payments/${encodeURIComponent(id)}`));
    },

    async cancelPayment(id) {
      const current = await this.getPayment(id);
      // Отменить у провайдера можно только платёж, ждущий подтверждения.
      // Ожидающий QR отменять нечем: он истечёт сам, а у нас помечается сразу.
      if (current.status !== 'waiting_for_capture') return current;
      const p = await call<YkPayment>('POST', `/payments/${encodeURIComponent(id)}/cancel`, {}, `cancel:${id}`);
      return toPayment(p);
    },

    async refund({ paymentId, amount, idempotenceKey, receipt }) {
      const body: Record<string, unknown> = { payment_id: paymentId, amount: money(amount) };
      // Чек возврата провайдер пробивает сам, если передать позиции здесь.
      if (receipt) {
        body.receipt = { customer: ykCustomer(receipt.customer), items: ykItems(receipt), tax_system_code: receipt.taxSystem };
      }
      const r = await call<YkRefund>('POST', '/refunds', body, idempotenceKey);
      return { id: r.id, status: r.status, amount: rub(r.amount), raw: r };
    },

    async registerReceipt(req: RegisterReceipt, idempotenceKey: string) {
      const body: Record<string, unknown> = {
        type: req.type,
        send: req.send,
        customer: ykCustomer(req.customer),
        items: ykItems(req),
        settlements: [{ type: req.settlement, amount: money(req.amount) }],
        tax_system_code: req.taxSystem,
      };
      if (req.type === 'payment') body.payment_id = req.paymentId;
      else body.refund_id = req.refundId;
      return toReceipt(await call<YkReceipt>('POST', '/receipts', body, idempotenceKey));
    },

    async getReceipt(id) {
      return toReceipt(await call<YkReceipt>('GET', `/receipts/${encodeURIComponent(id)}`));
    },

    async verifyWebhook({ rawBody, ip }: WebhookInput) {
      let data: { type?: string; event?: string; object?: { id?: string; status?: string; payment_id?: string } };
      try {
        data = JSON.parse(rawBody);
      } catch {
        return { ok: false, reason: 'тело уведомления — не JSON' };
      }
      const event = String(data.event ?? '');
      const objectId = String(data.object?.id ?? '');
      const partial: Partial<WebhookEvent> = {
        event, paymentId: event.startsWith('payment.') ? objectId || null : data.object?.payment_id ?? null,
        refundId: event.startsWith('refund.') ? objectId || null : null, raw: data,
      };
      if (data.type !== 'notification' || !event || !objectId) {
        return { ok: false, reason: 'уведомление без события или объекта', event: partial };
      }
      if (!ipAllowed(ip, cfg.allowedIps)) {
        return { ok: false, reason: `адрес ${ip} не из списка провайдера`, event: partial };
      }
      // Подтверждение — повторное чтение объекта из API: состояние и сумму
      // берём оттуда, а не из тела, которое мог прислать кто угодно.
      try {
        if (event.startsWith('payment.')) {
          const p = await this.getPayment(objectId);
          return {
            ok: true,
            event: { event, paymentId: p.id, refundId: null, status: p.status, amount: p.amount, paidAt: p.paidAt, raw: data },
          };
        }
        if (event.startsWith('refund.')) {
          const r = await getRefund(objectId);
          const paymentId = String(data.object?.payment_id ?? (r.raw as YkRefund).payment_id ?? '') || null;
          return {
            ok: true,
            event: { event, paymentId, refundId: r.id, status: r.status, amount: r.amount, paidAt: null, raw: data },
          };
        }
        return { ok: false, reason: `событие ${event} системе не нужно`, event: partial };
      } catch (err) {
        return { ok: false, reason: `объект не подтверждён у провайдера: ${(err as Error).message}`, event: partial };
      }
    },
  };
}
