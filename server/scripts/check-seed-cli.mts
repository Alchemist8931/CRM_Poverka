/* Проверка запуска наполнения из командной строки.
 *
 * check-schema.ts зовёт раскладку по таблицам напрямую и потому не трогает сам
 * `npm run seed`: соединение, разбор ключей, отказ по непустой базе. Эти три
 * вещи и проверяются здесь — на временной базе, выставленной по сети.
 *
 * Три шага: наполнить пустую базу (код 0) → повторить без ключа (код 1, отказ)
 * → повторить с --reset (код 0).
 *
 *   npx tsx scripts/check-seed-cli.mts
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.CHECK_PORT || 55460);

/** Ждём, пока база в соседнем процессе назовёт свой адрес.
 *
 *  Своей группой процессов (`detached`) — потому что `npx` разворачивается в
 *  цепочку из четырёх процессов, и сигнал одному только головному оставил бы
 *  базу работать, а проверку — висеть на незакрытом канале. */
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
      resolve({
        url,
        stop: () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* уже умерла */ } },
      });
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`база завершилась с кодом ${code}`)); });
  });
}

const { url, stop } = await startDatabase();
const env = { ...process.env, DATABASE_URL: url };
let failed = 0;

/** Запуск с ожидаемым кодом возврата: сам код и есть предмет проверки. */
function run(title: string, args: string[], expected: number): string {
  const res = spawnSync('npm', args, { cwd: serverDir, env, encoding: 'utf8' });
  const got = res.status ?? -1;
  if (got === expected) {
    console.log(`  ${title}: код ${got}, как и ожидалось`);
  } else {
    console.error(`  ${title}: код ${got}, ожидался ${expected}`);
    console.error((res.stdout || '') + (res.stderr || ''));
    failed++;
  }
  return (res.stdout || '') + (res.stderr || '');
}

try {
  const migrate = spawnSync('npx', ['node-pg-migrate', 'up'],
    { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (migrate.status !== 0) throw new Error(`миграции не применились, код ${migrate.status}`);
  console.log('Миграции применены.');

  console.log('\nЗапуск наполнения из командной строки:');
  const first = run('пустая база', ['run', 'seed'], 0);
  if (!/requests\s+\d+/.test(first)) {
    console.error('  в выводе нет числа строк по таблицам');
    failed++;
  } else {
    console.log('  число строк по таблицам напечатано');
  }

  run('повтор по непустой базе', ['run', 'seed'], 1);
  run('повтор с --reset', ['run', 'seed', '--', '--reset'], 0);
} finally {
  stop();
}

if (failed) {
  console.error(`\nПроверка не пройдена: расхождений ${failed}.`);
  process.exit(1);
}
console.log('\nЗапуск наполнения из командной строки работает.');
process.exit(0);
