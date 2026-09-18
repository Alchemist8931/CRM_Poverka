/* Поднять стенд на свободных портах, выполнить скрипт против него и погасить.
 *
 *   node with-stand.mjs check-admin-flow.mjs
 *
 * Для сверок, которые запускает шлюз: стенд не должен зависеть от того, что
 * кто-то уже держит порты 3300/3301. Адрес передаётся скрипту переменной
 * STAND_BASE. Код возврата — код скрипта. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { here } from './lib.mjs';

const script = process.argv[2];
if (!script) { console.error('Укажите скрипт: node with-stand.mjs <скрипт.mjs>'); process.exit(2); }

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const apiPort = await freePort(), webPort = await freePort();
const stand = spawn(process.execPath, [join(here, 'stand.mjs')], {
  cwd: here, stdio: ['ignore', 'pipe', 'inherit'], detached: true,
  env: { ...process.env, STAND_API_PORT: String(apiPort), STAND_WEB_PORT: String(webPort), STAND_NO_FILE: '1' },
});
/* API стенд запускает в своей группе процессов и гасит его в обработчике выхода,
   поэтому стенду шлём SIGTERM, а не SIGKILL группе: убитый сразу стенд оставляет
   PGlite сиротой, а тот держит порт. SIGKILL — только если стенд не вышел сам. */
const stop = () => {
  try { process.kill(stand.pid, 'SIGTERM'); } catch { /* уже нет */ }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { try { process.kill(stand.pid, 0); } catch { return; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  try { process.kill(-stand.pid, 'SIGKILL'); } catch { /* уже нет */ }
};
process.on('exit', stop);

const base = `http://127.0.0.1:${webPort}`;
const up = await new Promise((res) => {
  const until = Date.now() + 180_000;
  const tick = async () => {
    try { if ((await fetch(base + '/health')).ok) return res(true); } catch { /* ещё нет */ }
    if (Date.now() > until) return res(false);
    setTimeout(tick, 1000);
  };
  stand.stdout.on('data', (d) => process.stdout.write(d));
  tick();
});
if (!up) { console.error('Стенд не поднялся'); stop(); process.exit(2); }

const run = spawn(process.execPath, [join(here, script), ...process.argv.slice(3)], {
  cwd: here, stdio: 'inherit', env: { ...process.env, STAND_BASE: base },
});
run.on('exit', (code) => { stop(); process.exit(code ?? 1); });
