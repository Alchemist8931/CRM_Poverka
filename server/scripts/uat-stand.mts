/* Тестовый контур для приёмочных испытаний (пункт test-uat).
 *
 *   npm run uat:stand                       # DATABASE_URL — как у остальных скриптов
 *   UAT_BOT_PASSWORD=… npm run uat:stand    # пароль технической учётки автотестов
 *
 * Что получается в базе после прогона — ровно то, на чём идут испытания:
 *
 *   1. обезличенный набор прототипа: клиенты с вымышленными телефонами, заявки,
 *      маршруты, акты и деньги за несколько недель (`src/seed/load.ts`);
 *   2. справочники — через тот же импорт, которым поедут данные заказчика
 *      (`scripts/import`, книга пункта req-refs). Повторный импорт ничего не
 *      меняет, поэтому стенд можно перезаливать сколько угодно;
 *   3. ни одной учётной записи сотрудника: у людей из демо-набора логины и
 *      пароли сняты. Операторов и поверителей заказчица заводит сама на экране
 *      «Сотрудники» — это отдельный проверяемый сценарий (пункт be-users);
 *   4. две учётки полного доступа — владельцу проекта и заказчице
 *      (`scripts/init-accounts.mts`), с временными паролями, которые печатаются
 *      один раз;
 *   5. техническая учётка автотестов (`UAT_BOT_LOGIN`, по умолчанию `autotest`) —
 *      ей ходят сквозные проверки из CI и нагрузочный прогон. Только на тестовом
 *      контуре: в развёртывание prod этот скрипт не входит, и там её нет.
 *
 * Скрипт разрушительный — он вычищает таблицы. Поэтому без `--yes` он лишь
 * показывает, что сделает, и выходит.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pgDb } from '../src/api/db.ts';
import { seedDemoData, formatCounts } from '../src/seed/load.ts';
import { hashPassword, temporaryPassword } from '../src/password.ts';
import { nextStaffId } from '../src/api/routes/users.ts';
import { importRefs } from './import/refs.mts';
import { format } from './import/result.mts';
import { initAccounts, report } from './init-accounts.mts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const REFS_BOOK = process.env.UAT_REFS_BOOK || join(serverDir, 'test/fixtures/refs-template.xlsx');
const BOT_LOGIN = (process.env.UAT_BOT_LOGIN || 'autotest').toLowerCase();

if (!process.argv.includes('--yes')) {
  console.log(`Стенд испытаний: будут очищены все таблицы, залит демо-набор, импортированы справочники
из ${REFS_BOOK}, сняты логины у всех сотрудников, заведены две учётки полного доступа
и техническая учётка «${BOT_LOGIN}». Чтобы выполнить — добавьте --yes.`);
  process.exit(2);
}

const db = pgDb();
try {
  // 1. Демо-набор: телефоны в нём случайные, имена из генератора — ничего настоящего.
  console.log('1. Демо-набор прототипа (--reset)…');
  const counts = await seedDemoData(db, { reset: true });
  console.log(formatCounts(counts));

  // 2. Справочники тем же импортом, что поедут данные заказчика.
  console.log(`\n2. Справочники из книги: ${REFS_BOOK}`);
  const res = await db.tx(async (tx) => importRefs(tx, REFS_BOOK));
  console.log(format(res, false));

  // 3. Учётных записей у сотрудников демо-набора нет: заказчица заводит их сама.
  console.log('\n3. Снимаем логины и пароли у сотрудников демо-набора…');
  const { rows: stripped } = await db.query<{ n: string }>(
    `WITH u AS (UPDATE staff SET login = NULL, password_hash = NULL, must_change_password = true,
                    failed_logins = 0, locked_until = NULL, sessions_from = now(), updated_at = now()
                RETURNING 1)
     SELECT count(*)::text AS n FROM u`);
  console.log(`   сотрудников без учётной записи: ${stripped[0]!.n}`);

  // 4. Две учётки полного доступа.
  console.log('\n4. Учётные записи полного доступа:');
  for (const line of report(await initAccounts(db))) console.log(line);

  // 5. Техническая учётка автотестов. Пароль постоянный: ей входит CI, а не человек.
  console.log('\n5. Техническая учётка автотестов:');
  const botPassword = process.env.UAT_BOT_PASSWORD || temporaryPassword(16);
  const hash = await hashPassword(botPassword);
  const { rows: bot } = await db.query<{ id: string }>(
    'SELECT id FROM staff WHERE lower(login) = $1', [BOT_LOGIN]);
  let botId = bot[0]?.id;
  if (botId) {
    await db.query(
      `UPDATE staff SET password_hash = $2, must_change_password = false, role = 'supervisor',
              blocked_at = NULL, failed_logins = 0, locked_until = NULL, sessions_from = now(), updated_at = now()
        WHERE id = $1`, [botId, hash]);
  } else {
    botId = await nextStaffId(db, 'supervisor');
    await db.query(
      `INSERT INTO staff (id, full_name, role, login, email, password_hash, must_change_password)
       VALUES ($1, 'Автотесты (техническая)', 'supervisor', $2, $3, $4, false)`,
      [botId, BOT_LOGIN, `${BOT_LOGIN}@uchetkin.local`, hash]);
  }
  console.log(`   ${botId} · логин ${BOT_LOGIN}` + (process.env.UAT_BOT_PASSWORD
    ? ' · пароль из UAT_BOT_PASSWORD'
    : ` · пароль: ${botPassword} (сохраните: в базе только хеш)`));

  const { rows: who } = await db.query<{ role: string; total: string; with_login: string }>(
    `SELECT role, count(*)::text AS total, count(login)::text AS with_login FROM staff GROUP BY role ORDER BY role`);
  console.log('\nИтог по сотрудникам (всего / с учётной записью):');
  for (const r of who) console.log(`   ${r.role.padEnd(11)} ${r.total.padStart(3)} / ${r.with_login}`);
} finally {
  await db.close();
}
