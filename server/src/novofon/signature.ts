/* Подпись: чем подтверждается, что уведомление пришло от АТС, а не от прохожего.
 *
 * У двух линий интерфейсов Новофона это устроено по-разному, и разница не в
 * мелочах, а в том, есть подпись вообще или нет.
 *
 * API 1.0 (novofon.com/instructions/api/). Уведомление приходит с заголовком
 * `Signature` — это base64 от HMAC-SHA1 по строке, склеенной из полей самого
 * события, ключом Secret. Состав строки у каждого события свой, и он приведён
 * в таблице ниже: подписывается не тело целиком, а именно эти поля.
 *
 * Платформа 2.0 (novofon.com/instructions/integration/own-crm/). Уведомления
 * настраиваются в кабинете, состав параметров выбирает сам администратор —
 * подписи у них нет. Значит, подтверждать подлинность приходится двумя другими
 * способами, и оба включены: секрет в адресе приёмника (кабинет хранит адрес
 * целиком, поэтому секрет не виден в интерфейсе CRM и не попадает в наши
 * журналы — в лог пишется путь без него) и список адресов, с которых АТС шлёт
 * уведомления (по инструкции это 37.139.38.215).
 *
 * Обе проверки постоянны по времени: сравнение строк «по первому различию»
 * на секрете — это подсказка тому, кто его подбирает.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Какие поля события склеиваются в подписываемую строку (API 1.0).
 *  Порядок важен: это строка, а не набор. */
const SIGNED_FIELDS: Record<string, string[]> = {
  NOTIFY_START: ['caller_id', 'called_did', 'call_start'],
  NOTIFY_INTERNAL: ['caller_id', 'called_did', 'call_start'],
  NOTIFY_ANSWER: ['caller_id', 'destination', 'call_start'],
  NOTIFY_END: ['caller_id', 'called_did', 'call_start'],
  NOTIFY_OUT_START: ['internal', 'destination', 'call_start'],
  NOTIFY_OUT_END: ['internal', 'destination', 'call_start'],
  NOTIFY_IVR: ['caller_id', 'called_did', 'call_start'],
  NOTIFY_RECORD: ['pbx_call_id', 'call_id_with_rec'],
};

/** Событие 1.0, для которого подпись не описана, принимать нельзя: «подписи нет,
 *  значит сойдёт» — это открытый вебхук с лишним шагом. */
export const isKnownV1Event = (event: string): boolean => event in SIGNED_FIELDS;

/** Строка, которую подписывает АТС для этого события. */
export function v1SignedString(payload: Record<string, unknown>): string | null {
  const event = String(payload.event ?? '');
  const fields = SIGNED_FIELDS[event];
  if (!fields) return null;
  return fields.map((f) => String(payload[f] ?? '')).join('');
}

/** Подпись уведомления 1.0 так, как её считает АТС. Та же функция подписывает
 *  события в эмуляторе — иначе проверка проверяла бы сама себя. */
export function v1EventSignature(payload: Record<string, unknown>, secret: string): string | null {
  const signed = v1SignedString(payload);
  if (signed === null) return null;
  return createHmac('sha1', secret).update(signed).digest('base64');
}

/** Сравнение секретов и подписей за постоянное время. Разная длина —
 *  сразу нет: timingSafeEqual на разных длинах бросает исключение. */
export function sameSecret(got: string | undefined | null, want: string | undefined | null): boolean {
  if (!got || !want) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Сошлась ли подпись уведомления 1.0. */
export function checkV1Event(
  payload: Record<string, unknown>, header: string | undefined, secret: string,
): boolean {
  const want = v1EventSignature(payload, secret);
  return want !== null && sameSecret(header?.trim(), want);
}

/* ─── подпись наших запросов к API 1.0 ───────────────────────────────────── */

/** Строка параметров так, как её собирает PHP `http_build_query(..., RFC1738)`:
 *  ключи отсортированы, пробел кодируется плюсом. Подпись считается по ней же,
 *  поэтому собираем строку один раз и её же отправляем. */
export function v1QueryString(params: Record<string, string | number | undefined>): string {
  const usable = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return usable
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');
}

/** Заголовок Authorization для API 1.0: `ключ:base64(hmac_sha1(метод + строка +
 *  md5(строка)))`. Метод — путь запроса вместе со слэшами, как в примере
 *  документации (`/v1/request/callback/`). */
export function v1AuthHeader(method: string, query: string, key: string, secret: string): string {
  const md5 = createHash('md5').update(query).digest('hex');
  const sign = createHmac('sha1', secret).update(method + query + md5).digest('base64');
  return `${key}:${sign}`;
}
