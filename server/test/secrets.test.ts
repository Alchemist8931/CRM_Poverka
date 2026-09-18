/* Чтение секретов из Lockbox при старте (src/secrets.ts).
 *
 * Стенд — свой HTTP-сервер на localhost: он отвечает и за метаданные ВМ, и за
 * содержимое секретов. Проверяется то, ради чего загрузчик написан: заданное в
 * окружении не перетирается, недостающее собирается из записей секрета, а
 * заголовки запросов такие, какие ждёт облако.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

/** Записи секретов, которые отдаёт стенд, и след запросов к нему. */
const SECRETS: Record<string, Record<string, string>> = {
  'db-secret': {
    host: 'rc1a-xxx.mdb.yandexcloud.net', port: '6432', database: 'uchetkin',
    username: 'uchetkin', password: 'п@роль:с/знаками',
  },
  'app-secret': { jwt_secret: 'ключ-подписи-сессий-из-lockbox', password_pepper: 'перец' },
  'novofon-secret': { webhook_secret: 'ключ-вебхука' },
  'empty-secret': {},
};

const seen: { url: string; auth?: string; flavor?: string }[] = [];
let server: Server;
let origin: string;

/** Загрузчик запоминает адреса при первом обращении к модулю, поэтому модуль
 *  импортируется после того, как стенд поднят, и только один раз. */
let secrets: typeof import('../src/secrets.ts');

before(async () => {
  server = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      auth: req.headers.authorization,
      flavor: req.headers['metadata-flavor'] as string | undefined,
    });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      res.end(JSON.stringify({ access_token: 'iam-token', expires_in: 3600 }));
      return;
    }
    const id = decodeURIComponent((req.url ?? '').split('/')[2] ?? '');
    const entries = SECRETS[id];
    if (!entries) { res.statusCode = 404; res.end('{}'); return; }
    res.end(JSON.stringify({
      entries: Object.entries(entries).map(([key, textValue]) => ({ key, textValue })),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.YC_METADATA_TOKEN_URL = `${origin}/token`;
  process.env.YC_LOCKBOX_PAYLOAD_URL = `${origin}/secrets`;
  secrets = await import('../src/secrets.ts');
});

after(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('секреты приложения приходят из Lockbox', () => {
  it('на машине разработчика в сеть не ходит: всё уже в окружении', async () => {
    const before = seen.length;
    const env = { DATABASE_URL: 'postgres://localhost/uchetkin', SESSION_SECRET: 'dev-session-secret-uchetkin' };
    assert.deepEqual(await secrets.loadSecrets(env), []);
    assert.equal(seen.length, before, 'запросов быть не должно');
  });

  it('нечего читать без идентификаторов секретов', async () => {
    assert.deepEqual(await secrets.loadSecrets({}), []);
  });

  it('собирает строку подключения, ключ сессий и ключ вебхука', async () => {
    const env: NodeJS.ProcessEnv = {
      LOCKBOX_DB_SECRET_ID: 'db-secret',
      LOCKBOX_APP_SECRET_ID: 'app-secret',
      LOCKBOX_NOVOFON_SECRET_ID: 'novofon-secret',
    };
    const loaded = await secrets.loadSecrets(env);
    assert.deepEqual(loaded, ['DATABASE_URL', 'SESSION_SECRET', 'NOVOFON_WEBHOOK_SECRET']);
    assert.equal(
      env.DATABASE_URL,
      'postgres://uchetkin:%D0%BF%40%D1%80%D0%BE%D0%BB%D1%8C%3A%D1%81%2F%D0%B7%D0%BD%D0%B0%D0%BA%D0%B0%D0%BC%D0%B8'
        + '@rc1a-xxx.mdb.yandexcloud.net:6432/uchetkin',
      'знаки пароля экранируются, иначе адрес не разберётся',
    );
    assert.equal(env.SESSION_SECRET, 'ключ-подписи-сессий-из-lockbox');
    assert.equal(env.NOVOFON_WEBHOOK_SECRET, 'ключ-вебхука');
  });

  it('заданное в окружении сильнее Lockbox: перетирания нет', async () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://свой/адрес',
      LOCKBOX_DB_SECRET_ID: 'db-secret',
      LOCKBOX_APP_SECRET_ID: 'app-secret',
    };
    assert.deepEqual(await secrets.loadSecrets(env), ['SESSION_SECRET']);
    assert.equal(env.DATABASE_URL, 'postgres://свой/адрес');
  });

  it('пустой секрет внешней службы старту не мешает', async () => {
    const env: NodeJS.ProcessEnv = { LOCKBOX_NOVOFON_SECRET_ID: 'empty-secret' };
    assert.deepEqual(await secrets.loadSecrets(env), []);
    assert.equal(env.NOVOFON_WEBHOOK_SECRET, undefined);
  });

  it('токен запрашивается с заголовком метаданных, секрет — с токеном', async () => {
    seen.length = 0;
    await secrets.loadSecrets({ LOCKBOX_DB_SECRET_ID: 'db-secret' });
    const token = seen.find((r) => r.url === '/token');
    const payload = seen.find((r) => r.url.startsWith('/secrets/'));
    assert.equal(token?.flavor, 'Google');
    assert.equal(payload?.auth, 'Bearer iam-token');
    assert.equal(payload?.url, '/secrets/db-secret/payload');
  });

  it('недоступный Lockbox — это ошибка старта, а не тихий пропуск', async () => {
    await assert.rejects(
      secrets.loadSecrets({ LOCKBOX_DB_SECRET_ID: 'нет-такого' }),
      /404/,
    );
  });

  it('Managed PostgreSQL: режим TLS и корневой сертификат уходят в строку подключения', async () => {
    const env: NodeJS.ProcessEnv = {
      LOCKBOX_DB_SECRET_ID: 'db-secret',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/app/certs/yandex-cloud-ca.pem',
    };
    await secrets.loadSecrets(env);
    assert.equal(
      env.DATABASE_URL,
      'postgres://uchetkin:%D0%BF%40%D1%80%D0%BE%D0%BB%D1%8C%3A%D1%81%2F%D0%B7%D0%BD%D0%B0%D0%BA%D0%B0%D0%BC%D0%B8'
      + '@rc1a-xxx.mdb.yandexcloud.net:6432/uchetkin?sslmode=verify-full&sslrootcert=%2Fapp%2Fcerts%2Fyandex-cloud-ca.pem',
    );
    // Без PGSSLMODE (база контейнером в dev) строка остаётся без параметров.
    assert.equal(
      secrets.databaseUrlFrom({ host: 'h', port: '5432', database: 'd', username: 'u', password: 'p' }),
      'postgres://u:p@h:5432/d',
    );
  });

  it('в секрете базы не хватает записи — видно, какой', () => {
    assert.throws(
      () => secrets.databaseUrlFrom({ host: 'h', port: '5432', database: 'd' }),
      /username, password/,
    );
  });
});
