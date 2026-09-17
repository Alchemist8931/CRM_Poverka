/* Проверка схемы на пустой базе без Docker.
 *
 * Поднимает настоящий PostgreSQL, собранный в WebAssembly (PGlite), и прогоняет
 * по нему те же четыре шага, что делает разработчик на живой базе:
 * применить миграции → откатить последнюю → применить снова → наполнить.
 *
 * Зачем так. На машине разработчика есть `docker compose up -d`, и тогда те же
 * шаги идут по DATABASE_URL из окружения. Там, где Docker недоступен, проверять
 * схему всё равно надо, и лучше на настоящем движке, чем на его пересказе.
 *
 * Две тонкости, обе выяснены опытом:
 *   1. Миграции запускает node-pg-migrate — ему нужен сетевой адрес, поэтому
 *      база на время миграций выставляется наружу по протоколу PostgreSQL.
 *      Шаги при этом запускаются асинхронно: синхронный запуск заблокировал бы
 *      цикл событий, и сервер в этом же процессе не смог бы ответить.
 *   2. Наполнение идёт мимо сети, прямо в базу. Сетевой слой PGlite не собирает
 *      сообщение протокола обратно, если оно пришло несколькими пакетами, и на
 *      пачечных вставках демо-набора движок падает. Загрузчик умеет работать с
 *      любым соединением, поэтому здесь ему передаётся сама база.
 *
 *   npm run check
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { formatCounts, seedDemoData } from '../src/seed/load.ts';
import { freePort } from './free-port.mts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const PORT = await freePort();

/** Шаг проверки: запуск команды с показом только ошибок и разбором кода возврата. */
function step(title: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  console.log(`\n── ${title} ` + '─'.repeat(Math.max(3, 58 - title.length)));
  return new Promise((resolve, reject) => {
    // Миграции печатают весь применяемый SQL — на трёх шагах это простыня,
    // в которой не найти ни ошибки, ни итога. Оставляем только поток ошибок.
    const child = spawn('npx', args, { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) { console.log('   код возврата 0'); resolve(); }
      else reject(new Error(`шаг «${title}» завершился с кодом ${code}`));
    });
  });
}

async function main(): Promise<void> {
  // Файлы базы на диске, а не в памяти: без каталога PGlite держит всю базу в
  // куче WebAssembly, и на демо-наборе куча кончается посреди загрузки.
  const dataDir = mkdtempSync(join(tmpdir(), 'uchetkin-pglite-'));
  const db = await PGlite.create({ dataDir });
  const { rows } = await db.query<{ v: string }>('SELECT version() AS v');
  console.log('База для проверки: ' + String(rows[0]?.v).split(' on ')[0] + ' (PGlite, временный каталог)');

  const socket = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1' });
  await socket.start();
  const env = { ...process.env, DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres` };

  try {
    await step('миграции вверх на пустой базе', ['node-pg-migrate', 'up'], env);
    await step('откат последней миграции', ['node-pg-migrate', 'down', '1'], env);
    await step('миграции вверх после отката', ['node-pg-migrate', 'up'], env);
    await socket.stop();

    console.log('\n── наполнение демо-данными ' + '─'.repeat(35));
    const counts = await seedDemoData(db);
    console.log(formatCounts(counts));

    // Сверка с ожиданиями пункта плана: заявок порядка 2–3 тысяч, маршрутов около сотни.
    console.log('\n── объём набора ' + '─'.repeat(46));
    console.log(`   заявок ${counts.requests}, маршрутов ${counts.routes}`);
    if (counts.requests! < 2000 || counts.requests! > 3000) {
      throw new Error(`заявок ${counts.requests}, ожидалось 2000–3000`);
    }
    if (counts.routes! < 50 || counts.routes! > 200) {
      throw new Error(`маршрутов ${counts.routes}, ожидалось около сотни`);
    }

    console.log('\nПроверка пройдена.');
  } finally {
    await socket.stop().catch(() => {});
    await db.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nПроверка не пройдена:', err instanceof Error ? err.message : err);
  process.exit(1);
});
