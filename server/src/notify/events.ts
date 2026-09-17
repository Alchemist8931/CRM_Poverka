/* События и постановка сообщений в очередь.
 *
 * Четыре события заказчика: заявка принята, напоминание накануне, утреннее
 * окно прибытия с именем поверителя, перенос даты. Каждое превращается в
 * набор подстановок и — по шаблону своего канала — в строку очереди.
 *
 * Два правила, из которых здесь всё следует.
 *
 * 1. Без согласия не уходит ничего. Галочка стоит в заявке (`notify_consent`),
 *    её ставит оператор при приёме со слов клиента. Проверка одна и в одном
 *    месте — в `enqueue`: тогда забыть её в новом событии физически негде.
 *
 * 2. Уведомление никого не заменяет. Подтверждение даты собирает оператор
 *    обзвоном накануне, и так остаётся. Поэтому постановка в очередь не имеет
 *    права уронить приём заявки: вызов делается после того, как заявка уже
 *    записана, а ошибка пишется в журнал приложения и на этом кончается.
 */
import type { Db } from '../api/db.ts';
import { notifyConfig, type NotifyConfig } from './config.ts';
import { render, type Channel, type NotifyEvent } from './templates.ts';
import { payMethods, priceOfDevice, type ClientType, type Service } from '../rules.ts';

/** Заявка в том виде, в каком её читают уведомления. */
interface RequestRow {
  id: string;
  client_id: string | null;
  date: string;
  city: string;
  client_type: ClientType;
  name: string;
  phone_norm: string;
  email: string;
  street: string;
  house: string;
  flat: string;
  time_slot: number;
  svcs: string[];
  notify_consent: boolean;
  verifier_name: string | null;
}

/** Услуга справочника с названием: цена нужна для суммы, название — для текста. */
type ServiceRow = Service & { name: string };

export interface EnqueueOptions {
  /** Дата, с которой перенесли: подстановка {прежняя_дата} у события «перенос». */
  movedFrom?: string;
  /** Какие каналы трогать. По умолчанию все, у которых есть шаблон и адрес. */
  channels?: Channel[];
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Дата человеку: 14.09.2026. */
export const ruDate = (iso: string): string => iso.split('-').reverse().join('.');

/** Окно прибытия: в заявке хранится середина, клиенту говорят границы. */
export const windowOf = (slot: number): { from: string; to: string } =>
  ({ from: `${two(slot - 1)}:00`, to: `${two(slot + 1)}:00` });

/** Подстановки для шаблона. Собираются здесь целиком, а не по месту: так
 *  видно, что обещано клиенту, и ровно это проверяется в тестах. */
export function varsFor(cfg: NotifyConfig, r: RequestRow, services: Map<string, ServiceRow>, opts: EnqueueOptions = {}) {
  const win = windowOf(r.time_slot);
  // Предварительная сумма: по одной услуге из заявки по прайсу для этого типа
  // клиента. Точная цена появится в акте — там считают приборы, а не пожелания,
  // и пенсионную скидку ставит поверитель на месте. Поэтому в шаблоне слово
  // «предварительная», а не «к оплате».
  const sum = (r.svcs ?? []).reduce((a, id) => a + priceOfDevice(services.get(id), r.client_type), 0);
  const names = (r.svcs ?? []).map((id) => services.get(id)?.name ?? id);
  return {
    'имя': r.name,
    'дата': ruDate(r.date),
    'прежняя_дата': opts.movedFrom ? ruDate(opts.movedFrom) : '',
    'окно_с': win.from,
    'окно_до': win.to,
    'адрес': [r.city, r.street && `ул. ${r.street}`, r.house && `д. ${r.house}`, r.flat && `кв. ${r.flat}`]
      .filter(Boolean).join(', '),
    'услуги': names.join(', '),
    'сумма': sum,
    // Эквайринга нет и до пункта int-pay не будет: на месте берут наличными
    // или переводом, и обещать клиенту ссылку на оплату нельзя.
    'оплата': payMethods(r.client_type).filter((m) => m !== 'не оплачено').join(' или '),
    'поверитель': r.verifier_name ?? '',
    'контора': cfg.office,
    'телефон_конторы': cfg.officePhone,
    'подпись': cfg.signature,
  };
}

/** Услуги справочника с ценами и названиями — одним запросом на событие. */
async function servicesOf(db: Db): Promise<Map<string, ServiceRow>> {
  const { rows } = await db.query<ServiceRow>(
    'SELECT id, name, price_person, price_pensioner, price_org, rate_verifier, rate_operator FROM services');
  return new Map(rows.map((s) => [s.id, s]));
}

/** Заявка с именем поверителя: имя берётся из маршрута, если он уже собран. */
async function requestOf(db: Db, id: string): Promise<RequestRow | null> {
  const { rows } = await db.query<RequestRow>(
    `SELECT r.id, r.client_id, r.date::text AS date, r.city, r.client_type, r.name, r.phone_norm,
            r.email, r.street, r.house, r.flat, r.time_slot, r.svcs, r.notify_consent,
            s.full_name AS verifier_name
       FROM requests r
       LEFT JOIN routes ro ON ro.id = r.route_id
       LEFT JOIN staff s ON s.id = COALESCE(r.verifier_id, ro.verifier_id)
      WHERE r.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Куда слать по этому каналу. Пустой адрес — канал пропускается молча:
 *  почты у клиента может не быть вовсе, и это не ошибка. */
const addressOf = (r: RequestRow, channel: Channel): string =>
  (channel === 'email' ? (r.email ?? '').trim() : (r.phone_norm ?? '').trim());

/**
 * Ставит сообщения события в очередь и возвращает, что поставлено.
 *
 * Повторный вызов на то же событие и ту же заявку ничего не добавляет: ключ
 * разбора (`dedup_key`) уникален, а планировщик ходит по кругу и обязан уметь
 * не отправить одно и то же дважды.
 */
export async function enqueue(
  db: Db, event: NotifyEvent, requestId: string,
  opts: EnqueueOptions = {}, cfg: NotifyConfig = notifyConfig(),
): Promise<{ id: number; channel: Channel }[]> {
  const r = await requestOf(db, requestId);
  if (!r) return [];
  // Единственная проверка согласия на всю систему.
  if (!r.notify_consent) return [];

  const { rows: templates } = await db.query<{ channel: Channel; subject: string; body: string }>(
    'SELECT channel, subject, body FROM notify_templates WHERE event = $1 AND active', [event]);
  const services = await servicesOf(db);
  const vars = varsFor(cfg, r, services, opts);
  const out: { id: number; channel: Channel }[] = [];

  for (const t of templates) {
    if (opts.channels && !opts.channels.includes(t.channel)) continue;
    const address = addressOf(r, t.channel);
    if (!address) continue;
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO notifications
         (event, channel, request_id, client_id, dedup_key, address, subject, body, send_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
         CASE
           WHEN $1 = 'напоминание' THEN (($9::date - 1) + time '18:00') AT TIME ZONE $10
           WHEN $1 = 'выезд'       THEN (($9::date)     + time '08:00') AT TIME ZONE $10
           ELSE now()
         END)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [event, t.channel, r.id, r.client_id, `${event}:${r.id}:${t.channel}:${r.date}`,
       address, render(t.subject, vars), render(t.body, vars), r.date, cfg.timezone]);
    if (rows[0]) out.push({ id: rows[0].id, channel: t.channel });
  }
  return out;
}

/** Постановка «в фоне»: ошибка не имеет права свалить действие оператора.
 *  Причина всё равно доедет до журнала приложения и до экрана руководителя —
 *  в очереди такого сообщения просто не будет, и это видно. */
export function enqueueQuietly(
  db: Db, event: NotifyEvent, requestId: string,
  opts: EnqueueOptions = {}, log?: { error(o: unknown, m: string): void },
): void {
  enqueue(db, event, requestId, opts).catch((err: Error) => {
    log?.error({ err, event, requestId }, 'уведомление не поставлено в очередь');
  });
}
