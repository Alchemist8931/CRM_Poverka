/* Локальный стенд для тех же сценариев — без облака и без Docker.
 *
 *   cd web && npm run build && cd ../e2e && node stand.mjs [доводы playwright test]
 *
 * Поднимает то же приложение на встроенном PostgreSQL (server/scripts/dev-pglite.mts:
 * миграции, демо-набор, API) и раздаёт собранный фронт с проксированием /api —
 * один адрес обязателен, сессионная cookie на чужой не поедет. Потом гоняет
 * сценарии с учёткой демо-руководителя. Хранилища снимков здесь нет: шаг с фото
 * сценарии пропускают и говорят об этом в отчёте. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverDir = join(root, 'server');
const distDir = join(root, 'web', 'dist');
const API_PORT = Number(process.env.STAND_API_PORT || 3300);
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

const api = spawn(join(serverDir, 'node_modules/.bin/tsx'), ['scripts/dev-pglite.mts', String(API_PORT)],
  { cwd: serverDir, stdio: ['ignore', 'ignore', 'inherit'], detached: true, env: { ...process.env, SEED_PASSWORD: '1234' } });
const stopApi = () => { try { process.kill(-api.pid, 'SIGKILL'); } catch { api.kill('SIGKILL'); } };
process.on('exit', stopApi);
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
await new Promise((done) => web.listen(0, '127.0.0.1', done));
const BASE = `http://127.0.0.1:${web.address().port}`;
console.log(`Стенд: ${BASE} → API ${API}`);

const run = spawn(process.execPath, [join(root, 'e2e/node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)], {
  cwd: join(root, 'e2e'), stdio: 'inherit',
  env: { ...process.env, UAT_BASE_URL: BASE, UAT_LOGIN: 'sv', UAT_PASSWORD: '1234', UAT_CITY: process.env.UAT_CITY || 'Асбест' },
});
run.on('exit', (code) => { web.close(); stopApi(); process.exit(code ?? 1); });
