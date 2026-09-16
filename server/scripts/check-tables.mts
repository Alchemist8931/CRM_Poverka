/* Сверка схемы с перечнем пункта be-schema.
 *
 * Применяет секции «Up» всех миграций на временной базе и проверяет, что на
 * месте каждая названная в задании таблица и каждый названный индекс. Проверка
 * структурная и намеренно не пользуется node-pg-migrate: сам запуск миграций
 * и их откат проверяет check-schema.ts, здесь важен только результат.
 *
 *   npx tsx scripts/check-tables.mts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

/** Таблицы, названные в пункте плана поимённо. */
const REQUIRED_TABLES = [
  'staff', 'staff_skills', 'services', 'device_types', 'cities', 'days', 'absences',
  'clients', 'requests', 'routes', 'stops', 'devices', 'photos', 'payments',
  'calls', 'route_chat', 'audit_log',
];

/** Индексы, названные в пункте плана: таблица и столбцы, которые они обязаны накрывать. */
const REQUIRED_INDEXES: { table: string; columns: string[] }[] = [
  { table: 'requests', columns: ['date', 'city'] },
  { table: 'requests', columns: ['phone_norm'] },   // телефон хранится нормализованным
  { table: 'stops', columns: ['route_id'] },
  { table: 'calls', columns: ['started'] },
];

const dataDir = mkdtempSync(join(tmpdir(), 'uchetkin-tables-'));
const db = await PGlite.create({ dataDir });
let failed = 0;

try {
  // Применяем только секции «Up», по порядку имён файлов — тот же порядок, что у миграций.
  const dir = join(serverDir, 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const up = sql.split('-- Down Migration')[0]!.split('-- Up Migration')[1];
    if (!up) throw new Error(`в миграции ${file} нет секции «-- Up Migration»`);
    await db.exec(up);
  }

  const { rows: tables } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
  const present = new Set(tables.map((t) => t.table_name));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length) {
    console.error('Нет таблиц из перечня задания: ' + missing.join(', '));
    failed++;
  } else {
    console.log(`Таблицы из перечня задания на месте: ${REQUIRED_TABLES.length} из ${REQUIRED_TABLES.length}.`);
  }

  const { rows: indexes } = await db.query<{ tablename: string; indexdef: string }>(
    `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`);
  for (const want of REQUIRED_INDEXES) {
    // Сравниваем по определению, а не по имени: важно, что индекс накрывает
    // нужные столбцы в нужном порядке, а как его назвали — дело десятое.
    const wanted = `(${want.columns.join(', ')})`;
    const found = indexes.some((i) => i.tablename === want.table && i.indexdef.includes(wanted));
    if (found) {
      console.log(`Индекс ${want.table}${wanted} на месте.`);
    } else {
      console.error(`Нет индекса ${want.table}${wanted}.`);
      failed++;
    }
  }

  console.log(`\nВсего таблиц в схеме: ${present.size}.`);
} finally {
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nСверка со схемой не сошлась: расхождений ${failed}.`);
  process.exit(1);
}
console.log('Схема соответствует перечню задания.');
