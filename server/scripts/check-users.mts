/* Сверка первичной инициализации доступа (пункт be-users).
 *
 *   npx tsx scripts/check-users.mts
 *
 * Проверяется ровно то, на чём держится запуск контура: на пустой базе
 * появляются две учётные записи полного доступа с временными паролями, а
 * повторный запуск ничего не меняет. Второе важнее первого: скрипт стоит в
 * развёртывании, и если он при каждой выкладке сбрасывает пароль руководителю,
 * заметят это в самый неподходящий момент.
 *
 * База — PostgreSQL в WebAssembly, в памяти процесса: ни Docker, ни сети, ни
 * следов на машине (см. `docs/schema.md`, раздел «Проверка»).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { singleConnectionDb } from '../src/api/db.ts';
import { verifyPassword, passwordProblem, temporaryPassword, MIN_PASSWORD } from '../src/password.ts';
import { accountsFrom, initAccounts, report } from './init-accounts.mts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const fail = (msg: string) => { console.error('  ✗ ' + msg); failed++; };
const ok = (msg: string) => console.log('  ✓ ' + msg);

const pg = new PGlite();
const db = singleConnectionDb({
  query: (text, params) => pg.query(text, params as never[]) as never,
  close: () => pg.close(),
});

try {
  const dir = join(serverDir, 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await pg.exec(sql.split('-- Down Migration')[0]!.split('-- Up Migration')[1] ?? '');
  }

  // ── 1. пустая база: заводятся ровно две учётки полного доступа ──
  console.log('Первый запуск на пустой базе:');
  const first = await initAccounts(db);
  for (const line of report(first)) console.log(line);

  const accounts = accountsFrom();
  if (first.length !== 2) fail(`создано записей: ${first.length}, ожидалось 2`);
  if (first.some((c) => !c.password)) fail('на пустой базе учётка нашлась готовой — так не бывает');

  const { rows: all } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM staff');
  if (Number(all[0]!.n) !== 2) fail(`в staff строк: ${all[0]!.n}, ожидалось 2`);
  else ok('в базе ровно две учётные записи');

  const { rows: people } = await db.query<{
    id: string; login: string; email: string; role: string;
    must_change_password: boolean; blocked_at: string | null; password_hash: string;
  }>('SELECT id, login, email, role, must_change_password, blocked_at, password_hash FROM staff ORDER BY id');

  if (people.some((p) => p.role !== 'supervisor')) fail('не у всех заведённых роль «руководитель»');
  else ok('обе учётные записи — с полным доступом (роль supervisor)');

  if (people.some((p) => !p.must_change_password)) fail('пароль заведён не как временный');
  else ok('пароль у обеих помечен как временный: при первом входе система потребует сменить');

  if (people.some((p) => p.blocked_at)) fail('заведённая учётка сразу заблокирована');
  if (people.some((p) => p.password_hash.startsWith('scrypt$') === false)) fail('пароль хранится не хешем scrypt');
  else ok('пароли лежат хешем scrypt — тем же способом, что и у остальных учёток');

  for (const c of first) {
    const row = people.find((p) => p.id === c.id)!;
    if (!(await verifyPassword(c.password!, row.password_hash))) fail(`пароль ${row.login} не сходится с хешем`);
    if (c.password!.length < MIN_PASSWORD) fail(`временный пароль ${row.login} короче ${MIN_PASSWORD} знаков`);
  }
  ok(`напечатанные пароли подходят к учёткам и не короче ${MIN_PASSWORD} знаков`);

  const logins = new Set(people.map((p) => p.login));
  if (accounts.some((a) => !logins.has(a.login))) fail('логины в базе разошлись с заданными окружением');
  else ok(`логины: ${[...logins].join(', ')}`);

  // ── 2. повторный запуск ничего не меняет ──
  console.log('\nПовторный запуск на той же базе:');
  const before = JSON.stringify(people);
  const second = await initAccounts(db);
  for (const line of report(second)) console.log(line);

  if (second.some((c) => c.password)) fail('повторный запуск выдал новый пароль — учётку пересоздали');
  else ok('повторный запуск не выдал ни одного нового пароля');

  const { rows: after } = await db.query<{ id: string }>(
    `SELECT id, login, email, role, must_change_password, blocked_at, password_hash
       FROM staff ORDER BY id`);
  if (JSON.stringify(after) !== before) fail('строки staff после повторного запуска изменились');
  else ok('строки в staff не изменились ни в одном поле — прогон идемпотентен');

  // ── 3. требования к паролю ──
  if (passwordProblem('коротк') === null) fail(`пароль короче ${MIN_PASSWORD} знаков принят`);
  if (passwordProblem(temporaryPassword()) !== null) fail('выданный временный пароль не проходит собственную проверку');
  else ok(`требование длины (${MIN_PASSWORD} знаков) выполняется и проверяется`);
} finally {
  await db.close();
}

if (failed) {
  console.error(`\nСверка учётных записей не сошлась: расхождений ${failed}.`);
  process.exit(1);
}
console.log('\nПервичная инициализация доступа: две учётки полного доступа, повтор ничего не меняет.');
