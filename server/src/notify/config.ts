/* Настройки уведомлений: адрес отправителя, почта, СМС-шлюз.
 *
 * Почему письма уходят с рабочего ящика заказчика, а не с технического домена.
 * Боевого домена у системы ещё нет — он появляется только после запуска (пункт
 * cloud-domain), а до тех пор система живёт на временном адресе Яндекс Облака.
 * Письмо, отправленное с чужого технического имени, у которого нет ни SPF, ни
 * DKIM на домене отправителя, отправляется прямиком в спам, и это не
 * настраивается с нашей стороны никак. Поэтому отправитель — обычный рабочий
 * ящик конторы в Яндекс 360: его домен уже подписан, и письмо от него для
 * почтовых служб ничем не отличается от письма, написанного руками.
 *
 * В день переезда на свой домен меняется одна строка — NOTIFY_FROM (и пароль
 * ящика в Lockbox). Ни в шаблонах, ни в коде адреса отправителя нет: он
 * подставляется отсюда, и проверка `scripts/check-notify.mts` смотрит именно
 * на то, что в письме стоит адрес из настроек.
 *
 * Ключи и пароли в окружении — это машина разработчика и проверки. В облаке те
 * же переменные приезжают из Lockbox по сервисному аккаунту ВМ (src/secrets.ts).
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS с первого байта (465). На 587 и на локальном приёмнике — нет. */
  secure: boolean;
  user: string | null;
  password: string | null;
}

export interface SmsConfig {
  /** Пока один: SMSC.ru. Выбор и сравнение — в docs/notify.md. */
  provider: 'smsc';
  apiUrl: string;
  login: string | null;
  password: string | null;
  /** Имя отправителя, зарегистрированное у оператора. Пустое — придёт с номера. */
  sender: string | null;
  /** Виртуальная отправка: шлюз отвечает как при настоящей, но ничего никому не
   *  шлёт и не списывает. Тестовый контур провайдера, параметр `virtsms=1`. */
  testMode: boolean;
}

export interface NotifyConfig {
  /** Адрес рабочего ящика конторы: с него уходят письма. */
  from: string | null;
  /** Имя отправителя в письме: «Учёткин» выглядит как спам, «ИП Бердинских» — нет. */
  fromName: string;
  /** Куда клиент попадёт, нажав «Ответить». По умолчанию — сам ящик отправителя. */
  replyTo: string | null;
  /** Подпись под письмом, подстановка {подпись}. */
  signature: string;
  /** Короткое имя конторы для СМС, подстановка {контора}. */
  office: string;
  /** Телефон конторы, подстановка {телефон_конторы}. */
  officePhone: string;
  /** Часовой пояс контуров работы: по нему считаются «накануне в 18:00» и «утром». */
  timezone: string;
  smtp: SmtpConfig;
  sms: SmsConfig;
  /** Сколько раз пробовать отправить, прежде чем признать сообщение непрошедшим. */
  maxAttempts: number;
  /** Пауза перед повтором в минутах: n-я попытка ждёт retryMinutes × 2^(n-1). */
  retryMinutes: number;
  /** Подключён ли эквайринг (ключи провайдера в окружении): от этого зависит,
   *  обещать ли клиенту в письме оплату по QR и ссылке (пункт int-pay). */
  online: boolean;
}

const str = (v: string | undefined): string | null => {
  const s = v?.trim();
  return s ? s : null;
};

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Асбест и Екатеринбург живут по Екатеринбургу: «накануне в 18:00» — это
 *  18:00 у клиента, а не на машине, которая может стоять где угодно. */
const TZ = 'Asia/Yekaterinburg';

export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  const from = str(env.NOTIFY_FROM);
  return {
    from,
    fromName: str(env.NOTIFY_FROM_NAME) ?? 'ИП Бердинских А. А.',
    replyTo: str(env.NOTIFY_REPLY_TO) ?? from,
    signature: str(env.NOTIFY_SIGNATURE)
      ?? 'С уважением, ИП Бердинских А. А. — поверка счётчиков.',
    office: str(env.NOTIFY_OFFICE) ?? 'ИП Бердинских',
    officePhone: str(env.NOTIFY_OFFICE_PHONE) ?? '',
    timezone: str(env.NOTIFY_TZ) ?? TZ,
    smtp: {
      host: str(env.SMTP_HOST) ?? 'smtp.yandex.ru',
      port: num(env.SMTP_PORT, 465),
      // Ящик Яндекс 360 — это 465 и TLS сразу. Выключается только для локального
      // приёмника в проверке: SMTP_SECURE=0.
      secure: env.SMTP_SECURE === undefined ? true : !/^(0|нет|no|off|false)$/i.test(env.SMTP_SECURE.trim()),
      user: str(env.SMTP_USER) ?? from,
      password: str(env.SMTP_PASSWORD),
    },
    sms: {
      provider: 'smsc',
      apiUrl: str(env.SMS_API_URL) ?? 'https://smsc.ru/sys/send.php',
      login: str(env.SMS_LOGIN),
      password: str(env.SMS_PASSWORD),
      sender: str(env.SMS_SENDER),
      testMode: /^(1|да|yes|on|true)$/i.test((env.SMS_TEST ?? '').trim()),
    },
    maxAttempts: num(env.NOTIFY_MAX_ATTEMPTS, 5),
    retryMinutes: num(env.NOTIFY_RETRY_MINUTES, 10),
    online: !!(str(env.PAYMENT_SHOP_ID) && str(env.PAYMENT_SECRET_KEY)),
  };
}

/** Есть ли чем отправить письмо. Без ящика и пароля почта молчит, а система
 *  работает: уведомления — второй канал, первый остаётся за обзвоном. */
export const canSendEmail = (cfg: NotifyConfig): boolean =>
  !!(cfg.from && cfg.smtp.host && (cfg.smtp.user && cfg.smtp.password || !cfg.smtp.secure));

/** Есть ли чем отправить СМС. */
export const canSendSms = (cfg: NotifyConfig): boolean => !!(cfg.sms.login && cfg.sms.password);
