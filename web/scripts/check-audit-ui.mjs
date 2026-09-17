/* Экран «Журнал действий» против настоящего API (пункт be-audit).
 *
 *   npm run build && node scripts/check-audit-ui.mjs
 *
 * Что проверяется — ровно то, чего не видно ни из тестов сервера, ни из
 * демо-режима:
 *
 *   — журнал приходит на экран руководителя и рисуется строками;
 *   — правка прайса через API появляется в журнале с разницей «900 → 950»;
 *   — отбор по сущности сокращает таблицу, а не только состояние вкладки;
 *   — строка раскрывается в разницу по полям;
 *   — выгрузка CSV отдаёт файл и сама попадает в журнал;
 *   — оператору страницы журнала в меню нет вовсе.
 *
 * Сервер поднимается свой, на встроенном PostgreSQL (server/scripts/dev-pglite.mts),
 * фронт раздаётся отсюда же с проксированием /api — как в scripts/e2e.mjs:
 * cookie сессии помечена SameSite=Lax и на чужой адрес не поедет.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:3200';
const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const PASSWORD = process.env.SEED_PASSWORD || '1234';

let failures = 0;
const ok = (what) => console.log(`  ок   ${what}`);
const bad = (what, why) => { failures++; console.error(`  ПЛОХО ${what}${why ? ' — ' + why : ''}`); };
const check = (what, cond, why) => (cond ? ok(what) : bad(what, why));

/* ── сервер API ──────────────────────────────────────────── */

let api = null;
async function healthy(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${API}/health`);
      if (r.ok) return true;
    } catch (e) { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function startApi() {
  api = spawn(join(serverDir, 'node_modules/.bin/tsx'),
    ['scripts/dev-pglite.mts', String(new URL(API).port)],
    { cwd: serverDir, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  if (!await healthy(180000)) throw new Error('API не поднялся');
}

function stopApi() {
  if (!api) return;
  const dying = api;
  api = null;
  try { process.kill(-dying.pid, 'SIGKILL'); } catch (e) { dying.kill('SIGKILL'); }
}

/* ── раздача собранного фронта с проксированием на API ───── */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const readBody = (req) => new Promise((done) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => done(body));
});

const web = createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path.startsWith('/api/') || path === '/health' || path === '/docs') {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
    try {
      const upstream = await fetch(API + req.url, {
        method: req.method,
        body,
        redirect: 'manual',
        headers: { 'content-type': req.headers['content-type'] || 'application/json', cookie: req.headers.cookie || '' },
      });
      const out = {};
      for (const h of ['content-type', 'content-disposition', 'location']) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      const jar = upstream.headers.getSetCookie?.() ?? [];
      if (jar.length) out['set-cookie'] = jar;
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.writeHead(502).end();
    }
    return;
  }
  const full = join(distDir, path === '/' ? '/index.html' : path);
  if (!full.startsWith(distDir) || !existsSync(full)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream' });
  res.end(readFileSync(full));
});

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('Нет сборки: сначала `npm run build`.');
  process.exit(2);
}
await new Promise((done) => web.listen(0, '127.0.0.1', done));
const WEB = `http://127.0.0.1:${web.address().port}/`;

/* ── браузер ─────────────────────────────────────────────── */

const browser = await chromium.launch({ executablePath: chromePath() });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
const noise = (t) => /favicon/.test(t);
page.on('console', (m) => {
  if (m.type() === 'error' && !noise(m.location()?.url || '') && !noise(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const state = (fn, arg) => page.evaluate(fn, arg);
const quiet = async () => {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => (window.S?.loading || 0) === 0, null, { timeout: 60000 });
  await page.waitForTimeout(200);
};

async function signIn(who) {
  await ctx.clearCookies();
  await page.goto(WEB, { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* приватный режим */ } });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('form.login');
  await page.waitForSelector('#intro', { state: 'hidden', timeout: 20000 }).catch(() => {});
  await page.fill('form.login input[name=login]', who);
  await page.fill('form.login input[name=pw]', PASSWORD);
  await page.click('form.login button');
  await page.waitForSelector('.app', { timeout: 20000 });
  await quiet();
}

const go = async (view) => {
  await page.evaluate((v) => window.go(v), view);
  await quiet();
};

try {
  if (await healthy(1000)) {
    console.error(`На ${API} уже кто-то отвечает. Остановите его: проверка поднимает API сама.`);
    process.exit(2);
  }
  console.log('Поднимаем API…');
  await startApi();

  console.log('\nЖурнал действий на экране руководителя');
  await signIn('sv');

  // Правка прайса — то самое изменение денег, след которого журнал обязан хранить.
  const priced = await state(async () => {
    const was = await (await fetch('/api/services', { credentials: 'same-origin' })).json();
    const price = was.services.find((s) => s.id === 'wv').price_person;
    const res = await fetch('/api/services/wv', {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ price_person: price + 50 }),
    });
    return { ok: res.ok, was: price, now: price + 50 };
  });
  check('прайс изменён через API', priced.ok, JSON.stringify(priced));

  // И правка заявки: по её номеру потом ищется след в журнале.
  const edited = await state(async () => {
    const list = await (await fetch('/api/requests?limit=1', { credentials: 'same-origin' })).json();
    const id = list.requests[0]?.id;
    if (!id) return null;
    const res = await fetch(`/api/requests/${id}`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment_operator: 'Проверка журнала: звонить после 18:00' }),
    });
    return { id, ok: res.ok };
  });
  check('заявка поправлена через API', edited?.ok, JSON.stringify(edited));

  await go('audit');
  const first = await state(() => ({
    rows: S.audit.length, total: S.auditTotal,
    shown: document.querySelectorAll('table.audit tbody tr.ln').length,
    err: S.loadError,
  }));
  check('журнал пришёл на экран и нарисован строками',
    !first.err && first.rows > 0 && first.shown === first.rows, JSON.stringify(first));

  const priceEntry = await state(() => {
    const e = S.audit.find((x) => x.entity === 'services' && x.entity_id === 'wv');
    return e ? { action: e.action, actor: e.actor_id, name: e.actor_name, before: e.before, after: e.after } : null;
  });
  check('правка прайса лежит в журнале с разницей по полям',
    priceEntry && priceEntry.action === 'изменение' && priceEntry.actor === 'sv'
    && priceEntry.before?.price_person === priced.was && priceEntry.after?.price_person === priced.now,
    JSON.stringify(priceEntry));

  // Отбор по сущности: он уезжает на сервер и должен сокращать саму таблицу.
  await page.evaluate(() => window.auditSet('entity', 'services'));
  await quiet();
  const filtered = await state(() => ({
    rows: S.audit.length,
    others: S.audit.filter((e) => e.entity !== 'services').length,
    shown: document.querySelectorAll('table.audit tbody tr.ln').length,
  }));
  check('отбор по сущности сократил таблицу',
    filtered.rows > 0 && filtered.others === 0 && filtered.shown === filtered.rows && filtered.rows < first.rows,
    `${JSON.stringify(filtered)}, было ${first.rows}`);

  // Поиск: по номеру заявки в журнале находятся её же записи.
  await page.evaluate(() => window.auditReset());
  await quiet();
  const request = await state(() => S.audit.find((e) => e.entity === 'requests')?.entity_id || null);
  if (request) {
    await page.evaluate((id) => window.auditSet('q', id), request);
    await quiet();
    const found = await state((id) => ({
      rows: S.audit.length,
      mine: S.audit.filter((e) => JSON.stringify(e).includes(id)).length,
    }), request);
    check(`поиск по номеру заявки ${request}`, found.rows > 0 && found.rows === found.mine,
      JSON.stringify(found));
    await page.evaluate(() => window.auditReset());
    await quiet();
  }

  // Раскрытие строки: ради разницы по полям журнал и заводился.
  await page.evaluate(() => window.auditSet('entity', 'services'));
  await quiet();
  await page.click('table.audit tbody tr.ln');
  await page.waitForSelector('table.audit tbody tr.dif', { timeout: 10000 });
  const diff = await state(() => {
    const cells = [...document.querySelectorAll('tr.dif .inner tbody tr')]
      .map((tr) => [...tr.children].map((td) => td.textContent.trim()));
    return cells;
  });
  check('строка раскрылась в разницу по полям',
    diff.some((r) => r[0] === 'Цена физлицу' && r[1] === String(priced.was) && r[2] === String(priced.now)),
    JSON.stringify(diff));

  // Выгрузка: файл отдаёт сервер, и она сама попадает в журнал.
  const csv = await state(async () => {
    const res = await fetch('/api/audit/export.csv?entity=services', { credentials: 'same-origin' });
    return { status: res.status, type: res.headers.get('content-type'), text: (await res.text()).slice(0, 400) };
  });
  check('выгрузка CSV отдаёт файл', csv.status === 200 && /text\/csv/.test(csv.type || '')
    && csv.text.includes('Время;Сотрудник;Роль;Действие'), JSON.stringify(csv).slice(0, 300));
  check('в выгрузке видна разница по полям',
    csv.text.includes(`price_person: ${priced.was} → ${priced.now}`), csv.text.slice(0, 300));

  await page.evaluate(() => window.auditReset());
  await quiet();
  await page.evaluate(() => window.auditSet('action', 'выгрузка'));
  await quiet();
  const exported = await state(() => S.audit.filter((e) => e.action === 'выгрузка').length);
  check('выгрузка записана в журнал', exported > 0, `записей о выгрузке ${exported}`);

  // Оператору журнала нет: ни страницы в меню, ни данных по адресу.
  await signIn('o2');
  const asOperator = await state(async () => {
    const res = await fetch('/api/audit', { credentials: 'same-origin' });
    return { pages: PAGES.map((p) => p.v), status: res.status };
  });
  check('оператору страницы журнала нет', !asOperator.pages.includes('audit'), asOperator.pages.join(', '));
  check('оператору журнал по адресу не отдаётся', asOperator.status === 403, `ответ ${asOperator.status}`);

  /* Два отказа браузер пишет в консоль по делу: «кто я» до входа отвечает 401,
     а запрос журнала от оператора — 403, и он здесь нарочный. Всё остальное в
     консоли — ошибка. */
  const real = errors.filter((e) => !/Failed to (load resource|fetch)/i.test(e));
  check('консоль браузера чистая', real.length === 0, real.join(' | '));
} catch (err) {
  bad('проверка', err?.message || String(err));
} finally {
  stopApi();
  await browser.close().catch(() => {});
  web.close();
}

if (failures) {
  console.error(`\nЖурнал действий: не сошлось проверок — ${failures}.`);
  process.exit(1);
}
console.log('\nЖурнал действий прошёл целиком: строки, отбор, поиск, разница по полям, выгрузка, роли.');
process.exit(0);
