/* Интерфейс платёжного провайдера.
 *
 * Обработчики API и сервис платежей (service.ts) знают только его. Реализация
 * под ЮKassa — yookassa.ts; эмулятор проверок притворяется самой ЮKassa по
 * HTTP (emulator.ts), а не реализует интерфейс второй раз: так проверяется тот
 * же клиент, что ходит к настоящему провайдеру.
 *
 * Суммы — целые рубли, как во всей системе (docs/schema.md, «Время и деньги»);
 * в копейки их переводит реализация.
 */
import type { ReceiptItem } from '../rules.ts';

export type Kind = 'qr' | 'link';

/** Состояние платежа у провайдера в общих словах. `waiting_for_capture`
 *  бывает при двухстадийной оплате; у нас `capture: true`, но состояние
 *  описано, чтобы не потерять его при разборе уведомления. */
export type ProviderStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';

export interface ReceiptCustomer {
  email?: string;
  phone?: string;
}

/** Чек: кому, что и по какой системе налогообложения. */
export interface ReceiptDraft {
  customer: ReceiptCustomer;
  items: ReceiptItem[];
  taxSystem: number;
}

export interface CreatePayment {
  amount: number;
  kind: Kind;
  description: string;
  /** Ключ повтора: второй запрос с тем же ключом не создаёт второго платежа. */
  idempotenceKey: string;
  /** Куда вернуть клиента после оплаты по ссылке. */
  returnUrl?: string;
  /** Что провайдер вернёт в уведомлении: номер заявки и платежа у нас. */
  metadata: Record<string, string>;
  /** Срок, после которого неоплаченный платёж отменяется провайдером. */
  expiresAt?: Date;
}

export interface ProviderPayment {
  id: string;
  status: ProviderStatus;
  paid: boolean;
  amount: number;
  /** Строка для QR (СБП) или адрес страницы оплаты — что показать клиенту. */
  confirmation: string;
  /** Когда оплачен, по часам провайдера. */
  paidAt: string | null;
  raw: unknown;
}

export interface ProviderReceipt {
  id: string;
  status: 'pending' | 'succeeded' | 'canceled';
  /** Номер фискального документа — он печатается клиенту как «чек №». */
  fiscalNumber: string | null;
  raw: unknown;
}

export interface ProviderRefund {
  id: string;
  status: 'pending' | 'succeeded' | 'canceled';
  amount: number;
  raw: unknown;
}

export interface RegisterReceipt extends ReceiptDraft {
  type: 'payment' | 'refund';
  paymentId?: string;
  refundId?: string;
  /** Чем расплатились: для безнала — `cashless`. */
  settlement: 'cashless' | 'cash';
  amount: number;
  /** Отправить ли чек клиенту силами кассы. */
  send: boolean;
}

/** Уведомление провайдера, разобранное и подтверждённое. */
export interface WebhookEvent {
  event: string;
  paymentId: string | null;
  refundId: string | null;
  /** Состояние объекта — то, что провайдер подтвердил при повторном чтении. */
  status: string;
  amount: number | null;
  paidAt: string | null;
  raw: unknown;
}

export interface WebhookInput {
  rawBody: string;
  headers: Record<string, unknown>;
  ip: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(req: CreatePayment): Promise<ProviderPayment>;
  getPayment(id: string): Promise<ProviderPayment>;
  /** Отмена неоплаченного. У некоторых провайдеров QR отменить нельзя — тогда
   *  реализация возвращает текущее состояние, а сервис отменяет у себя. */
  cancelPayment(id: string): Promise<ProviderPayment>;
  refund(req: { paymentId: string; amount: number; idempotenceKey: string; receipt?: ReceiptDraft }): Promise<ProviderRefund>;
  registerReceipt(req: RegisterReceipt, idempotenceKey: string): Promise<ProviderReceipt>;
  getReceipt(id: string): Promise<ProviderReceipt>;
  /** Подлинность и разбор уведомления. Возвращает событие, подтверждённое у
   *  провайдера, или причину отказа. */
  verifyWebhook(input: WebhookInput): Promise<{ ok: true; event: WebhookEvent } | { ok: false; reason: string; event?: Partial<WebhookEvent> }>;
}

/** Ошибка провайдера: код ответа и текст, который можно показать руководителю. */
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}
