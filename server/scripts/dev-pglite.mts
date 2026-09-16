/* Настоящий API на встроенном PostgreSQL — для машины, где нет Docker.
 *
 *   npx tsx scripts/dev-pglite.mts [порт]
 *
 * Поднимает PGlite в том же процессе, применяет миграции, наполняет базу
 * демо-набором прототипа и запускает то же самое приложение, что уходит в
 * контейнер. Данные лежат во временном каталоге и стираются при остановке:
 * это стенд для проверок фронта (пункт be-fe-wire), а не замена базе.
 *
 * Чем отличается от scripts/pglite-server.mts: тот выставляет базу наружу по
 * протоколу PostgreSQL, а этот поднимает поверх неё API. Наполнение идёт внутри
 * процесса — сетевой слой PGlite на пачечных вставках демо-набора рвётся.
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/api/app.ts';
import { singleConnectionDb } from '../src/api/db.ts';
import { formatCounts, seedDemoData } from '../src/seed/load.ts';

const port = Number(process.argv[2] || process.env.PORT || 3000);
const serverDir = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'uchetkin-api-'));

const pg = await PGlite.create({ dataDir });
const dir = join(serverDir, 'migrations');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(dir, file), 'utf8');
  await pg.exec(sql.split('-- Down Migration')[0]!.split('-- Up Migration')[1] ?? '');
}
console.log('Миграции применены.');

const db = singleConnectionDb({
  query: (text, params) => pg.query(text, params as never[]) as never,
  close: () => pg.close(),
});
console.log(formatCounts(await seedDemoData(db, {})));

const app = await buildApp({ db, secret: process.env.SESSION_SECRET || 'dev-session-secret-uchetkin' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.close().then(() => pg.close()).finally(() => {
      rmSync(dataDir, { recursive: true, force: true });
      process.exit(0);
    });
  });
}
await app.listen({ port, host: '127.0.0.1' });
console.log(`API на http://127.0.0.1:${port} — вход sv / o2 / v0, пароль 1234`);
