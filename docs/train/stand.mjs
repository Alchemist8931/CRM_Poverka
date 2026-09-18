/* Стенд для скриншотов и видео инструкций (пункт docs-train).
 *
 *   cd web && npm run build && cd ../docs/train && node stand.mjs
 *
 * То же, что e2e/stand.mjs — приложение на встроенном PostgreSQL
 * (server/scripts/dev-pglite.mts) и собранный фронт с проксированием /api, —
 * но стенд не гоняет сценарии, а стоит, пока его не остановят: скриншоты
 * (shots.mjs) и видео (video.mjs) подключаются к нему отдельными запусками.
 * Адрес пишется в .stand.json рядом со скриптом.
 *
 * Учётные записи демо-набора: логин совпадает с идентификатором сотрудника
 * (sv — руководитель, o2 — оператор, v0 — поверитель), пароль 1234. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..', '..');
const serverDir = join(root, 'server');
const distDir = join(root, 'web', 'dist');
const API_PORT = Number(process.env.STAND_API_PORT || 3300);
const WEB_PORT = Number(process.env.STAND_WEB_PORT || 3301);
const API = `http://127.0.0.1:${API_PORT}`;

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('Нет сборки фронта: сначала `cd web && npm run build`.');
  process.exit(2);
}

async function healthy(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(`${API}/health`)).ok) return true; } catch { /* ещё нет */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
if (await healthy(500)) { console.error(`На ${API} уже кто-то отвечает.`); process.exit(2); }

const t0 = Date.now();
const api = spawn(join(serverDir, 'node_modules/.bin/tsx'), ['scripts/dev-pglite.mts', String(API_PORT)],
  { cwd: serverDir, stdio: ['ignore', 'ignore', 'inherit'], detached: true, env: { ...process.env, SEED_PASSWORD: '1234' } });
const stopApi = () => { try { process.kill(-api.pid, 'SIGKILL'); } catch { api.kill('SIGKILL'); } };
process.on('exit', stopApi);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
if (!await healthy(180_000)) { stopApi(); throw new Error('API не поднялся'); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const readBody = (req) => new Promise((done) => { const c = []; req.on('data', (b) => c.push(b)); req.on('end', () => done(Buffer.concat(c))); });
const web = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path.startsWith('/api/') || path === '/health' || path === '/docs') {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    try {
      const up = await fetch(API + req.url, {
        method: req.method, body, redirect: 'manual',
        headers: { 'content-type': req.headers['content-type'] || 'application/json', cookie: req.headers.cookie || '' },
      });
      const out = {};
      for (const h of ['content-type', 'content-disposition', 'location']) { const v = up.headers.get(h); if (v) out[h] = v; }
      const jar = up.headers.getSetCookie?.() ?? [];
      if (jar.length) out['set-cookie'] = jar;
      res.writeHead(up.status, out);
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
    return;
  }
  const full = join(distDir, path === '/' ? '/index.html' : path);
  if (!full.startsWith(distDir) || !existsSync(full)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream' });
  res.end(readFileSync(full));
});
await new Promise((done) => web.listen(WEB_PORT, '127.0.0.1', done));
const BASE = `http://127.0.0.1:${web.address().port}`;
// Стенд для сверки (with-stand.mjs) адрес в файл не пишет: он временный и не должен
// перебивать адрес стенда, который держат для скриншотов и видео.
if (!process.env.STAND_NO_FILE) writeFileSync(join(here, '.stand.json'), JSON.stringify({ base: BASE, api: API, pid: process.pid }));
console.log(`Стенд: ${BASE} → API ${API}, поднялся за ${Math.round((Date.now() - t0) / 1000)} с. Остановить: Ctrl+C или kill ${process.pid}.`);
