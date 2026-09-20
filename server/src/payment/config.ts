/* Настройки эквайринга и кассы: всё из окружения, ничего из кода.
 *
 * Схема выбрана в пункте req-pay («Учёткин — эквайринг и фискализация,
 * решение»): основная — QR СБП, резерв — платёжная ссылка, чек — облачная касса
 * с отправкой клиенту. Банк заказчика (УБРиР) на момент этого пункта ответа об
 * API не дал, поэтому первая реализация — платёжный сервис, у которого СБП,
 * ссылки и чеки через партнёрскую кассу лежат в одном договоре: ЮKassa. Другой
 * провайдер добавляется своей реализацией интерфейса `PaymentProvider`
 * (provider.ts), без правки обработчиков и экранов.
 *
 * Ключи в окружении — это машина разработчика и эмулятор. В облаке те же
 * значения приходят из Lockbox по сервисному аккаунту ВМ (src/secrets.ts,
 * секрет `payment`): ни в репозитории, ни в образе, ни в переменных выкладки
 * их нет. Без ключей эквайринг выключен: отметка оплаты работает как раньше,
 * наличными и переводом, а безналичные способы на экране не показываются.
 */

/** Кто проводит платежи. Пока один; место под банк оставлено. */
export type ProviderName = 'yookassa';

export interface PaymentConfig {
  provider: ProviderName | null;
  /** Идентификатор магазина и секретный ключ из кабинета провайдера. */
  shopId: string | null;
  secretKey: string | null;
  /** Адрес API. Меняется только в проверках: check-payment.mts поднимает
   *  эмулятор вместо настоящего провайдера. */
  apiUrl: string;
  /** Секрет в адресе приёмника уведомлений: у ЮKassa подписи у уведомлений
   *  нет, подлинность подтверждается адресом отправителя и повторным чтением
   *  платежа из API, а секрет в пути закрывает приёмник от случайных гостей. */
  webhookSecret: string | null;
  /** Адреса, с которых провайдер шлёт уведомления. Пустой список — проверки нет. */
  allowedIps: string[];
  /** Система налогообложения в чеке (код 54-ФЗ): 1 — ОСН, 2 — УСН доходы,
   *  3 — УСН доходы минус расходы, 4 — ЕНВД, 5 — ЕСХН, 6 — патент. Заказчик на
   *  УСН; объект налогообложения — вопрос 1 опросного листа № 2, по умолчанию
   *  «доходы». */
  taxSystem: number;
  /** Ставка НДС по позициям: 1 — без НДС (УСН без НДС), 2 — 0 %, 3 — 10 %,
   *  4 — 20 %, 5 — 10/110, 6 — 20/120, 7 — 5 %, 8 — 7 %. */
  vatCode: number;
  /** Адрес системы снаружи: от него считается адрес приёмника и страница,
   *  куда провайдер вернёт клиента после оплаты по ссылке. */
  publicBaseUrl: string | null;
  /** Сколько минут живёт QR или ссылка, пока их не оплатили. По истечении
   *  платёж считается отменённым на нашей стороне. */
  ttlMinutes: number;
}

/** Адрес API ЮKassa (yookassa.ru/developers/api). */
export const YOOKASSA_API = 'https://api.yookassa.ru/v3';

/** Адреса, с которых ЮKassa шлёт уведомления (раздел «Входящие уведомления»
 *  документации). Список меняется редко, но меняется — поэтому его можно
 *  переопределить переменной PAYMENT_ALLOWED_IPS. */
export const YOOKASSA_IPS = [
  '185.71.76.0/27', '185.71.77.0/27', '77.75.153.0/25', '77.75.156.11', '77.75.156.35',
  '77.75.154.128/25', '2a02:5180::/32',
];

const str = (v: string | undefined): string | null => {
  const s = v?.trim();
  return s ? s : null;
};

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export function paymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const shopId = str(env.PAYMENT_SHOP_ID);
  const secretKey = str(env.PAYMENT_SECRET_KEY);
  const named = str(env.PAYMENT_PROVIDER);
  // Провайдер не назван — считаем ЮKassa, если есть ключи. Названный без
  // ключей остаётся выключенным: обещать QR, который нечем создать, нельзя.
  const provider: ProviderName | null = named === 'yookassa' || (!named && shopId && secretKey) ? 'yookassa' : null;
  return {
    provider,
    shopId,
    secretKey,
    apiUrl: str(env.PAYMENT_API_URL)?.replace(/\/+$/, '') ?? YOOKASSA_API,
    webhookSecret: str(env.PAYMENT_WEBHOOK_SECRET),
    // Переменная задана (пусть и пустой) — верим ей; не задана — список провайдера.
    allowedIps: env.PAYMENT_ALLOWED_IPS !== undefined
      ? env.PAYMENT_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean)
      : YOOKASSA_IPS,
    taxSystem: num(env.PAYMENT_TAX_SYSTEM, 2),
    vatCode: num(env.PAYMENT_VAT_CODE, 1),
    publicBaseUrl: str(env.PUBLIC_BASE_URL)?.replace(/\/+$/, '') ?? null,
    ttlMinutes: num(env.PAYMENT_TTL_MINUTES, 60),
  };
}

/** Можно ли создавать платежи: провайдер назван и ключи есть. */
export const canPay = (cfg: PaymentConfig): boolean => !!(cfg.provider && cfg.shopId && cfg.secretKey);

/** Можно ли принимать уведомления. Без секрета приёмник закрыт. */
export const canReceive = (cfg: PaymentConfig): boolean => !!cfg.webhookSecret;

/** Путь приёмника; секрет идёт в пути, как у телефонии (novofon/config.ts). */
export const WEBHOOK_PATH = '/api/webhooks/payment';

/** Что вписать в кабинет провайдера как адрес уведомлений. */
export function webhookUrl(cfg: PaymentConfig): string | null {
  if (!cfg.publicBaseUrl || !cfg.webhookSecret) return null;
  return `${cfg.publicBaseUrl}${WEBHOOK_PATH}/${encodeURIComponent(cfg.webhookSecret)}`;
}

/** Адрес IPv4 в диапазоне вида `185.71.76.0/27` или равен одиночному адресу.
 *  IPv6 сверяется по префиксу записи: у провайдера он один (`2a02:5180::/32`). */
export function ipAllowed(ip: string, list: string[]): boolean {
  if (!list.length) return true;
  const bare = ip.replace(/^::ffff:/, '');
  const asNum = (s: string): number | null => {
    const p = s.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
  };
  const me = asNum(bare);
  for (const entry of list) {
    if (entry === bare || entry === ip) return true;
    const [net, bits] = entry.split('/');
    if (!net || bits === undefined) continue;
    if (net.includes(':')) {
      if (bare.includes(':') && bare.toLowerCase().startsWith(net.toLowerCase().replace(/::$/, ':'))) return true;
      continue;
    }
    const n = asNum(net);
    const b = Number(bits);
    if (me === null || n === null || !Number.isInteger(b) || b < 0 || b > 32) continue;
    const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
    if (((me & mask) >>> 0) === ((n & mask) >>> 0)) return true;
  }
  return false;
}
