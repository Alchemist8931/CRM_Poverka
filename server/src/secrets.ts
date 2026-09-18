/* Секреты приложения: Lockbox при старте.
 *
 * Правило одно (arch, раздел 2): ни пароля, ни ключа ни в репозитории, ни в
 * образе, ни в переменных выкладки. На ВМ лежит только конфигурация без
 * секретов (`/etc/uchetkin/app.env`, её пишет cloud-init) и идентификаторы
 * секретов в Lockbox. Значения приложение берёт само при старте: сначала
 * IAM-токен из метаданных ВМ — по её сервисному аккаунту, без ключа на диске, —
 * затем содержимое секретов.
 *
 * На машине разработчика ничего этого нет: там DATABASE_URL и SESSION_SECRET
 * заданы в окружении (docker-compose.yml, server/env.example), и загрузчик
 * молча ничего не делает. Правило простое: что уже задано в окружении,
 * из Lockbox не тянется и не перетирается.
 *
 * Адреса вынесены в переменные не ради гибкости, а ради проверки: тест
 * (`test/secrets.test.ts`) поднимает на них свой сервер и смотрит, что
 * собралось в окружении.
 */

/** Метаданные ВМ: IAM-токен её сервисного аккаунта. */
const TOKEN_URL = process.env.YC_METADATA_TOKEN_URL
  || 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token';

/** Содержимое секрета Lockbox: .../secrets/<id>/payload */
const PAYLOAD_URL = process.env.YC_LOCKBOX_PAYLOAD_URL
  || 'https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets';

export type Entries = Record<string, string>;

interface PayloadResponse {
  entries?: { key: string; textValue?: string; binaryValue?: string }[];
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`Не удалось обратиться к ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`${url} ответил ${res.status} ${res.statusText}`);
  return res.json();
}

/** IAM-токен сервисного аккаунта ВМ. Заголовок обязателен: без него метаданные
 *  не отдаются — так сервис защищён от случайного запроса из браузера. */
export async function iamToken(): Promise<string> {
  const body = await fetchJson(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } }) as { access_token?: string };
  const token = body.access_token;
  if (!token) throw new Error('Метаданные ВМ не отдали IAM-токен: у машины не назначен сервисный аккаунт?');
  return token;
}

/** Содержимое секрета в виде «ключ → значение». Двоичные записи не
 *  используются: всё, что нужно приложению, — строки. */
export async function readSecret(id: string, token: string): Promise<Entries> {
  const body = await fetchJson(`${PAYLOAD_URL}/${encodeURIComponent(id)}/payload`, {
    headers: { Authorization: `Bearer ${token}` },
  }) as PayloadResponse;
  const out: Entries = {};
  for (const entry of body.entries ?? []) {
    if (typeof entry.textValue === 'string') out[entry.key] = entry.textValue;
  }
  return out;
}

/** Как шифровать соединение с базой. Значения приходят из `/etc/uchetkin/app.env`
 *  (cloud-init пишет их только при Managed PostgreSQL): `PGSSLMODE=verify-full`
 *  и путь к корневому сертификату облака, который лежит в образе
 *  (`server/certs/yandex-cloud-ca.pem`, Dockerfile). Без них — как раньше:
 *  контейнер базы в dev шифрования не держит. */
export interface DbSsl {
  sslmode?: string;
  sslrootcert?: string;
}

export function dbSslFrom(env: NodeJS.ProcessEnv): DbSsl {
  return { sslmode: env.PGSSLMODE || undefined, sslrootcert: env.PGSSLROOTCERT || undefined };
}

/** Строка подключения из записей секрета базы (infra/lockbox.tf, секрет `db`).
 *  Пароль и имя экранируются: в них попадаются знаки, ломающие разбор адреса.
 *
 *  Managed PostgreSQL принимает только TLS: с голым `sslmode=require` драйвер
 *  сертификат облака не признаёт (учения cloud-ops, 18.09.2026), поэтому режим
 *  и корневой сертификат передаются в строке явно — `pg-connection-string`
 *  читает `sslrootcert` с диска и проверяет имя хоста при `verify-full`. */
export function databaseUrlFrom(e: Entries, ssl: DbSsl = {}): string {
  const missing = ['host', 'port', 'database', 'username', 'password'].filter((k) => !e[k]);
  if (missing.length) throw new Error(`В секрете базы нет записей: ${missing.join(', ')}`);
  const user = encodeURIComponent(e.username!);
  const password = encodeURIComponent(e.password!);
  const url = `postgres://${user}:${password}@${e.host}:${e.port}/${e.database}`;
  const params = new URLSearchParams();
  if (ssl.sslmode) params.set('sslmode', ssl.sslmode);
  if (ssl.sslrootcert) params.set('sslrootcert', ssl.sslrootcert);
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}

/** Чего не хватает окружению и из какого секрета это берётся. */
function plan(env: NodeJS.ProcessEnv): { name: string; secretId: string }[] {
  const wanted: [string, string | undefined, string | undefined][] = [
    ['DATABASE_URL', env.DATABASE_URL, env.LOCKBOX_DB_SECRET_ID],
    ['SESSION_SECRET', env.SESSION_SECRET, env.LOCKBOX_APP_SECRET_ID],
    ['S3_ACCESS_KEY_ID', env.S3_ACCESS_KEY_ID, env.LOCKBOX_STORAGE_SECRET_ID],
    ['NOVOFON_WEBHOOK_SECRET', env.NOVOFON_WEBHOOK_SECRET, env.LOCKBOX_NOVOFON_SECRET_ID],
    ['SMTP_PASSWORD', env.SMTP_PASSWORD, env.LOCKBOX_NOTIFY_SECRET_ID],
    ['YANDEX_GEOCODER_KEY', env.YANDEX_GEOCODER_KEY, env.LOCKBOX_MAPS_SECRET_ID],
  ];
  return wanted
    .filter(([, value, secretId]) => !value && secretId)
    .map(([name, , secretId]) => ({ name, secretId: secretId! }));
}

/**
 * Дочитывает окружение из Lockbox и возвращает имена заполненных переменных.
 *
 * Вызывается один раз при старте — до того, как приложение возьмётся за базу.
 * Если брать нечего (машина разработчика, тесты) — возвращает пустой список и
 * не ходит в сеть. Если брать есть откуда, но не получилось, — бросает ошибку:
 * подняться без пароля к базе всё равно нельзя, и лучше упасть с внятной
 * причиной, чем отвечать пятисотыми.
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const needed = plan(env);
  if (!needed.length) return [];

  const token = await iamToken();
  const loaded: string[] = [];
  for (const { name, secretId } of needed) {
    const entries = await readSecret(secretId, token);
    if (name === 'DATABASE_URL') {
      env.DATABASE_URL = databaseUrlFrom(entries, dbSslFrom(env));
    } else if (name === 'SESSION_SECRET') {
      // Ключ подписи сессий лежит в секрете приложения. Отдельной записи под
      // него нет — берётся jwt_secret, тот же по смыслу и той же длины.
      const value = entries.session_secret || entries.jwt_secret;
      if (!value) throw new Error('В секрете приложения нет ни session_secret, ни jwt_secret');
      env.SESSION_SECRET = value;
    } else if (name === 'S3_ACCESS_KEY_ID') {
      // Статический ключ сервисного аккаунта: им подписываются ссылки на
      // загрузку и просмотр снимков. Записи в секрет кладёт сам Terraform
      // (infra/iam.tf), поэтому имена здесь и там обязаны совпадать.
      const id = entries.access_key_id;
      const key = entries.secret_access_key;
      if (!id || !key) {
        throw new Error('В секрете хранилища нет записей access_key_id и secret_access_key');
      }
      env.S3_ACCESS_KEY_ID = id;
      env.S3_SECRET_ACCESS_KEY = key;
    } else if (name === 'SMTP_PASSWORD') {
      // Пароль почтового ящика и ключи СМС-шлюза лежат в одном секрете: это
      // доступы к чужим службам, которые заводит человек в консоли, и у них
      // общая судьба. Пустой секрет — рабочее состояние: канал молчит,
      // сообщения ждут в очереди (src/notify/outbox.ts).
      if (entries.smtp_password) env.SMTP_PASSWORD = entries.smtp_password;
      if (entries.sms_login) env.SMS_LOGIN = entries.sms_login;
      if (entries.sms_password) env.SMS_PASSWORD = entries.sms_password;
      if (!entries.smtp_password) continue;
    } else if (name === 'YANDEX_GEOCODER_KEY') {
      // Два ключа Яндекс Карт лежат в одном секрете: их заводит человек в
      // кабинете разработчика, и живут они одной судьбой. Ключ JS API отсюда
      // уходит в браузер (routes/refs.ts) — это нормально, его защищает
      // ограничение по домену, а не секретность. Пустой секрет — рабочее
      // состояние: конструктор рисует схематичную карту области.
      if (entries.geocoder_key) env.YANDEX_GEOCODER_KEY = entries.geocoder_key;
      if (entries.jsapi_key) env.YANDEX_JSAPI_KEY = entries.jsapi_key;
      if (!entries.geocoder_key) continue;
    } else {
      // Секреты внешних служб заводятся человеком в консоли: до этого момента
      // секрет существует, но пуст. Пустой ключ вебхука — это рабочее
      // состояние («приёмник отвечает 503»), а не повод не подняться.
      const value = entries.webhook_secret || Object.values(entries)[0];
      if (!value) continue;
      env.NOVOFON_WEBHOOK_SECRET = value;
    }
    loaded.push(name);
  }
  return loaded;
}
