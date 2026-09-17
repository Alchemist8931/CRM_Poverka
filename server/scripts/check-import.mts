/* Сквозная проверка импорта из командной строки. Пункт плана be-import.
 *
 * Тесты (`test/import.test.ts`) проверяют разбор и раскладку по таблицам, вызывая
 * загрузчик напрямую. Здесь проверяется то, чего тестом не увидеть: сам запуск
 * `npm run import`, соединение с базой, коды возврата и — главное — что пробный
 * прогон и правда ничего не пишет, а боевой при повторе ничего не меняет.
 *
 * База поднимается временная и выставляется по сети, как в check-seed-cli.
 *
 *   npx tsx scripts/check-import.mts
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { REFS_TEMPLATE, writeClientBase, writeClientMap } from '../test/import-fixtures.ts';
import { freePort } from './free-port.mts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const PORT = await freePort();
const work = mkdtempSync(join(tmpdir(), 'uchetkin-check-import-'));

/** База в соседнем процессе своей группой: `npx` разворачивается в цепочку,
 *  и сигнал одному головному процессу оставил бы её работать. */
function startDatabase(): Promise<{ url: string; stop: () => void }> {
  const child = spawn('npx', ['tsx', 'scripts/pglite-server.mts', String(PORT)],
    { cwd: serverDir, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('база не поднялась за 90 секунд')), 90_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const url = out.match(/postgres:\/\/\S+/)?.[0];
      if (!url) return;
      clearTimeout(timer);
      resolve({ url, stop: () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* уже умерла */ } } });
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`база завершилась с кодом ${code}`)); });
  });
}

const { url, stop } = await startDatabase();
const env = { ...process.env, DATABASE_URL: url };
let failed = 0;

const say = (ok: boolean, text: string): void => {
  if (ok) console.log(`  ${text}`);
  else { console.error(`  НЕ СОШЛОСЬ: ${text}`); failed++; }
};

/** Запуск импорта с ожидаемым кодом возврата: код и есть предмет проверки.
 *  С потолком по времени: зависший запуск должен стать провалом проверки,
 *  а не молчаливым ожиданием до конца рабочего дня. */
function run(title: string, args: string[], expected: number): string {
  const res = spawnSync('npm', ['run', 'import', '--', ...args],
    { cwd: serverDir, env, encoding: 'utf8', timeout: 180_000 });
  const got = res.status ?? -1;
  const out = (res.stdout || '') + (res.stderr || '');
  if (got === expected) console.log(`  ${title}: код ${got}, как и ожидалось`);
  else { console.error(`  ${title}: код ${got}, ожидался ${expected}\n${out}`); failed++; }
  return out;
}

/* Соединение открывается на один вопрос и сразу закрывается: встроенный
   PostgreSQL выставлен наружу одним сокетом и держать на нём постоянного
   слушателя, пока рядом ходит в базу запущенный импорт, незачем. */
async function ask<T = Record<string, string>>(sql: string): Promise<T> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try { return (await db.query(sql)).rows[0] as T; } finally { await db.end(); }
}

try {
  const migrate = spawnSync('npx', ['node-pg-migrate', 'up'],
    { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (migrate.status !== 0) throw new Error(`миграции не применились, код ${migrate.status}`);
  console.log('Миграции применены.');

  const count = async (table: string): Promise<number> =>
    Number((await ask<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).n);
  const stamps = async (): Promise<string> => JSON.stringify(await ask(
    `SELECT (SELECT count(*) FROM cities) AS cities, (SELECT count(*) FROM services) AS services,
            (SELECT count(*) FROM clients) AS clients, (SELECT count(*) FROM client_history) AS history,
            (SELECT max(updated_at) FROM services) AS s_at,
            (SELECT max(updated_at) FROM client_history) AS h_at`));

  const base = join(work, 'clients.xlsx');
  const map = join(work, 'client-map.json');
  await writeClientBase(base);
  await writeClientMap(map);
  const report = join(work, 'otvergnutye.xlsx');

  console.log('\nСправочники:');
  run('пробный прогон', ['refs', REFS_TEMPLATE, '--dry-run', '--report', report], 0);
  say(await count('cities') === 0, 'пробный прогон не записал в базу ни одного города');
  say(existsSync(report), 'отчёт об отвергнутых строках создан и в пробном прогоне');

  run('боевой прогон', ['refs', REFS_TEMPLATE], 0);
  say(await count('cities') === 1 && await count('services') === 1 && await count('device_types') === 1,
    'справочники из шаблона легли в базу');

  const before = await stamps();
  const again = run('повтор', ['refs', REFS_TEMPLATE], 0);
  say(await stamps() === before, 'повторный прогон не изменил в базе ничего');
  say(/без изменений/.test(again), 'в сводке повтора есть столбец «без изменений»');

  console.log('\nКлиентская база:');
  run('пробный прогон', ['clients', base, '--map', map, '--dry-run'], 0);
  say(await count('clients') === 0, 'пробный прогон не завёл ни одного клиента');

  run('боевой прогон', ['clients', base, '--map', map, '--report', report], 0);
  say(await count('clients') === 4, `дубли склеены: клиентов ${await count('clients')}, строк в выгрузке 8`);
  say(await count('client_history') === 6, `история перенесена: строк ${await count('client_history')}`);

  const beforeClients = await stamps();
  run('повтор', ['clients', base, '--map', map], 0);
  say(await stamps() === beforeClients, 'повторный прогон клиентской базы ничего не изменил');

  console.log('\nОтказы и учётные записи:');
  run('файла нет', ['clients', join(work, 'нет-такого.xlsx')], 1);
  run('команда не та', ['людей', base], 1);
  say(await count('staff') === 1, 'сотрудник из шаблона загружен');
  const creds = Number((await ask<{ n: string }>(
    `SELECT count(*) AS n FROM staff
      WHERE login IS NOT NULL OR password_hash IS NOT NULL OR otp_hash IS NOT NULL`)).n);
  say(creds === 0, 'импорт не создал ни одной учётной записи с логином или паролем');
} catch (err) {
  console.error('\nПроверка сорвалась: ' + (err instanceof Error ? err.message : String(err)));
  failed++;
} finally {
  stop();
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nПроверка импорта не пройдена: расхождений ${failed}.`);
  process.exit(1);
}
console.log('\nИмпорт из командной строки работает: пробный прогон ничего не пишет, повтор ничего не меняет.');
process.exit(0);
