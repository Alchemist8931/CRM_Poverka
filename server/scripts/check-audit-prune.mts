/* Проверка чистки журнала по сроку хранения (пункт be-audit).
 *
 * Тест `test/audit.test.ts` зовёт базу напрямую и проверяет правило: запись
 * моложе трёх лет удалить нельзя. Здесь проверяется другое — сама команда
 * `npm run audit:prune`: соединение по DATABASE_URL, код возврата, и что она
 * убирает просроченное, не трогая свежее.
 *
 * База поднимается временная и выставляется по сети, как в check-seed-cli:
 * Docker в песочнице нет, а PGlite — настоящий PostgreSQL, и триггер срока
 * хранения на нём работает ровно так же.
 *
 *   npx tsx scripts/check-audit-prune.mts
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { freePort } from './free-port.mts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const PORT = await freePort();

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
  if (ok) console.log(`  ок   ${text}`);
  else { console.error(`  НЕ СОШЛОСЬ: ${text}`); failed++; }
};

/** Запуск чистки с ожидаемым кодом возврата: код и есть предмет проверки. */
function prune(title: string, args: string[], expected: number): string {
  const res = spawnSync('npm', ['run', 'audit:prune', '--', ...args],
    { cwd: serverDir, env, encoding: 'utf8', timeout: 120_000 });
  const got = res.status ?? -1;
  const out = (res.stdout || '') + (res.stderr || '');
  if (got === expected) console.log(`  ок   ${title}: код ${got}, как и ожидалось`);
  else { console.error(`  НЕ СОШЛОСЬ: ${title}: код ${got}, ожидался ${expected}\n${out}`); failed++; }
  return out;
}

/* Соединение открывается на один вопрос и сразу закрывается: встроенный
   PostgreSQL выставлен наружу одним сокетом, и постоянный слушатель на нём не
   дал бы соседнему процессу — самой чистке — вообще подключиться. */
async function ask<T extends object = Record<string, string>>(sql: string): Promise<T[]> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query<T>(sql);
    return rows;
  } finally {
    await db.end();
  }
}

try {
  const migrate = spawnSync('npx', ['node-pg-migrate', 'up'],
    { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (migrate.status !== 0) throw new Error(`миграции не применились, код ${migrate.status}`);
  console.log('Миграции применены.\n');

  /* Три записи: просроченная и две в пределах срока. Возраст задаётся при
     вставке — триггер сторожит правку и удаление, а вставку задним числом
     пишет сам слой журнала (в перенесённых данных даты тоже не сегодняшние). */
  await ask(`
    INSERT INTO audit_log (at, actor_role, action, entity, entity_id, after) VALUES
      (now() - interval '4 years', 'РУК', 'изменение', 'price', 'p1', '{"цена":"700"}'),
      (now() - interval '2 years', 'РУК', 'изменение', 'price', 'p2', '{"цена":"800"}'),
      (now(),                      'РУК', 'изменение', 'price', 'p3', '{"цена":"900"}')`);

  console.log('Чистка журнала по сроку хранения:');

  const dry = prune('пробный прогон', ['--dry'], 0);
  say(/—\s*1\s*запис/.test(dry), 'пробный прогон насчитал одну просроченную запись');
  const afterDry = await ask<{ n: string }>('SELECT count(*) AS n FROM audit_log');
  say(afterDry[0].n === '3', 'пробный прогон ничего не удалил');

  const real = prune('боевой прогон', [], 0);
  say(/удалено записей.*—\s*1/.test(real), 'боевой прогон отчитался об одной удалённой записи');

  const left = await ask<{ entity_id: string }>('SELECT entity_id FROM audit_log ORDER BY entity_id');
  const ids = left.map((r) => r.entity_id).join(',');
  say(ids === 'p2,p3', `просроченная запись удалена, записи моложе трёх лет остались (${ids})`);

  const again = prune('повтор', [], 0);
  say(/записей старше \d+ дней нет/.test(again), 'повтор нашёл пустоту и ничего не сделал');
} finally {
  stop();
}

if (failed) {
  console.error(`\nЧистка журнала: не сошлось проверок — ${failed}.`);
  process.exit(1);
}
console.log('\nЧистка журнала работает: просроченное удалено, записи моложе трёх лет на месте.');
