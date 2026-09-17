/* Настройки телефонии: всё из окружения, ничего из кода.
 *
 * Система живёт на временном домене Яндекс Облака и после запуска переезжает на
 * домен заказчика (пункты cloud-infra и cloud-domain). Адреса, на которые АТС
 * шлёт уведомления, прописываются руками в кабинете Новофон, и в день переезда
 * их придётся заменить. Поэтому собственный адрес система не знает и не
 * угадывает: он приходит переменной PUBLIC_BASE_URL, а функции ниже показывают,
 * что именно надо вписать в кабинет (их печатает `npm run novofon:urls`).
 *
 * Ключ и Secret в окружении — это машина разработчика и эмулятор. В облаке те же
 * переменные приходят из Lockbox по сервисному аккаунту ВМ (src/secrets.ts):
 * ни в репозитории, ни в образе, ни в переменных выкладки их нет.
 */

/** Какая линия интерфейсов у кабинета заказчика.
 *
 *  `v2` — платформа Novofon 2.0: уведомления настраиваются в кабинете, обращения
 *  идут JSON-RPC на dataapi/callapi. `v1` — старый личный кабинет (API 1.0):
 *  уведомления NOTIFY_* с подписью HMAC-SHA1 и методы /v1/....
 *
 *  Какая из них у заказчика — вопрос 5 опросного листа по телефонии, ответа на
 *  него пока нет, поэтому работают обе и выбор делается одной переменной. */
export type Platform = 'v1' | 'v2';

export interface NovofonConfig {
  platform: Platform;
  /** Адрес системы снаружи: от него считаются адреса приёмников для кабинета. */
  publicBaseUrl: string | null;
  /** API 1.0: ключ пользователя (`Authorization: ключ:подпись`). */
  apiKey: string | null;
  /** Общий секрет. В 1.0 им подписаны и уведомления, и наши запросы; в 2.0
   *  подписи у уведомлений нет вовсе, и он работает как пароль приёмника. */
  secret: string | null;
  /** Платформа 2.0: Secret из кабинета, параметр `access_token`. */
  accessToken: string | null;
  dataApiUrl: string;
  callApiUrl: string;
  apiUrl: string;
  /** Виртуальный номер, с которого АТС звонит клиенту (E.164, 74993720692). */
  virtualNumber: string | null;
  /** Группа операторов в АТС: в ней переключается доступность номеров. */
  groupId: number | null;
  /** Идентификатор клиента для агентских ключей. Обычному кабинету не нужен. */
  userId: number | null;
  /** Адреса, с которых АТС шлёт уведомления. Пустой список — проверки нет. */
  allowedIps: string[];
}

/** Адрес Data API. Версия в пути обязательна, действующая — v2.0
 *  (novofon.github.io/data_api/). */
const DATA_API = 'https://dataapi-jsonrpc.novofon.ru/v2.0';
/** Адрес Call API (novofon.github.io/call_api/). */
const CALL_API = 'https://callapi-jsonrpc.novofon.ru/v4.0';
/** Адрес API 1.0 (novofon.com/instructions/api/). */
const API_V1 = 'https://api.novofon.com';

/** Адрес, с которого Новофон шлёт уведомления. Указан в инструкции по интеграции
 *  с собственной CRM — его же кабинет предлагает внести в правила безопасности. */
export const NOVOFON_IP = '37.139.38.215';

const str = (v: string | undefined): string | null => {
  const s = v?.trim();
  return s ? s : null;
};

export function novofonConfig(env: NodeJS.ProcessEnv = process.env): NovofonConfig {
  return {
    platform: env.NOVOFON_PLATFORM?.trim() === 'v1' ? 'v1' : 'v2',
    publicBaseUrl: str(env.PUBLIC_BASE_URL)?.replace(/\/+$/, '') ?? null,
    apiKey: str(env.NOVOFON_API_KEY),
    secret: str(env.NOVOFON_WEBHOOK_SECRET),
    accessToken: str(env.NOVOFON_ACCESS_TOKEN),
    dataApiUrl: str(env.NOVOFON_DATA_API_URL) ?? DATA_API,
    callApiUrl: str(env.NOVOFON_CALL_API_URL) ?? CALL_API,
    apiUrl: str(env.NOVOFON_API_URL) ?? API_V1,
    virtualNumber: str(env.NOVOFON_VIRTUAL_NUMBER),
    groupId: Number(env.NOVOFON_GROUP_ID) > 0 ? Number(env.NOVOFON_GROUP_ID) : null,
    userId: Number(env.NOVOFON_USER_ID) > 0 ? Number(env.NOVOFON_USER_ID) : null,
    allowedIps: (env.NOVOFON_ALLOWED_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/** Можно ли принимать уведомления. Без секрета приёмник закрыт: открытый
 *  вебхук означает, что журнал звонков вправе писать кто угодно. */
export const canReceive = (cfg: NovofonConfig): boolean => !!cfg.secret;

/** Можно ли обращаться к АТС: звонить из карточки, менять доступность, брать
 *  записи. Без ключей система работает вполоборота — принимает события и
 *  показывает карточку, но сама в АТС не ходит. */
export function canCall(cfg: NovofonConfig): boolean {
  return cfg.platform === 'v2'
    ? !!(cfg.accessToken && cfg.virtualNumber)
    : !!(cfg.apiKey && cfg.secret);
}

/** Пути приёмников. Секрет платформы 2.0 идёт в пути, а не в параметре: в
 *  кабинете адрес вписывается целиком, а параметры там свои у каждого события. */
export const WEBHOOK_PATH = '/api/webhooks/novofon';
export const ROUTING_PATH = '/api/webhooks/novofon/routing';

/** Что вписать в кабинет Новофон. Печатается при старте сервера и командой
 *  `npm run novofon:urls`; при переезде на боевой домен меняются ровно эти
 *  адреса — список и есть перечень работ того дня. */
export function cabinetUrls(cfg: NovofonConfig): { what: string; url: string }[] {
  const base = cfg.publicBaseUrl;
  if (!base) return [];
  const tail = cfg.platform === 'v2' && cfg.secret ? `/${encodeURIComponent(cfg.secret)}` : '';
  return [
    { what: 'Уведомления о звонках (Настройки → Уведомления)', url: `${base}${WEBHOOK_PATH}${tail}` },
    { what: 'Интерактивная обработка вызова (сценарий входящего)', url: `${base}${ROUTING_PATH}${tail}` },
  ];
}
