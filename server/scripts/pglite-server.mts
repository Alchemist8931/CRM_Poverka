/* Настоящий PostgreSQL, собранный в WebAssembly, выставленный наружу по
   протоколу PostgreSQL. Нужен там, где нет Docker: для node-pg-migrate и
   загрузчика это обычная база на порту.

     npx tsx scripts/pglite-server.mts [порт]

   Файлы базы кладутся во временный каталог и стираются при остановке. На диск,
   а не в память: без каталога PGlite держит всю базу в куче WebAssembly, и на
   демо-наборе — десять с лишним тысяч строк вместе с карточками фотографий —
   куча кончается прямо посреди загрузки. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2] || process.env.CHECK_PORT || 55432);
const dataDir = mkdtempSync(join(tmpdir(), 'uchetkin-pglite-'));
const db = await PGlite.create({ dataDir });
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();

const { rows } = await db.query<{ v: string }>('SELECT version() AS v');
console.log(String(rows[0]?.v).split(' on ')[0]);
console.log(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

const stop = async () => {
  await server.stop();
  await db.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// Оборванное соединение — это упавший клиент, а не повод ронять базу:
// иначе вместо ошибки клиента видно только «connection terminated».
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  throw err;
});
