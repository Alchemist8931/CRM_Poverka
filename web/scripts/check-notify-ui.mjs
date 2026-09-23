/* Экраны уведомлений против настоящего API (пункт int-notify).
 *
 *   npm run build && node scripts/check-notify-ui.mjs
 *
 * Что проверяется — то, чего не видно ни из тестов сервера, ни из демо-режима:
 *
 *   — галочка «Уведомления» есть в форме приёма и доезжает до базы;
 *   — заявка с галочкой ставит в очередь письмо и СМС, без галочки — ничего;
 *   — блок шаблонов на «Услугах и ставках» рисуется и сохраняет правку;
 *   — опечатка в подстановке отвергается с текстом от сервера;
 *   — правленый шаблон возвращается на экран после перезагрузки.
 *
 * Устройство то же, что у scripts/check-audit-ui.mjs: свой сервер на встроенном
 * PostgreSQL, фронт раздаётся отсюда же с проксированием /api — cookie сессии
 * помечена SameSite=Lax и на чужой адрес не поедет.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:3201';
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

/** Заявка со страницы приёма: заполняем форму и жмём «Принять» её же кнопкой.
 *  `createReq` на экране берёт данные из S.intake — как при работе руками. */
async function intake(consent) {
  await go('intake');
  await state(async (agree) => {
    const K = window.S.intake;
    K.name = agree ? 'Согласный К.' : 'Молчаливый М.';
    K.phone = agree ? '+79120000001' : '+79120000002';
    K.email = agree ? 'yes@example.org' : 'no@example.org';
    K.house = '7';
    K.flat = '3';
    K.svcs = ['wv'];
    K.notify = agree;
    window.render();
    await window.createReq();
  }, consent);
  await quiet();
  const made = await state(async (phone) => {
    const list = await (await fetch('/api/requests?phone=' + encodeURIComponent(phone),
      { credentials: 'same-origin' })).json();
    const r = (list.requests || [])[0] || null;
    return { id: r?.id ?? null, consent: r?.notify_consent ?? null, toast: window.S.toast?.text ?? null };
  }, consent ? '+79120000001' : '+79120000002');
  check(`заявка ${consent ? 'с согласием' : 'без согласия'} принята`, !!made.id, JSON.stringify(made));
  return made;
}

try {
  if (await healthy(1000)) {
    console.error(`На ${API} уже кто-то отвечает. Остановите его: проверка поднимает API сама.`);
    process.exit(2);
  }
  console.log('Поднимаем API…');
  await startApi();

  console.log('\nСогласие на уведомления в форме приёма');
  // Приём — работа оператора: у руководителя этой страницы в меню нет.
  await signIn('o2');
  await go('intake');
  const box = await page.locator('.f', { hasText: 'Уведомления' }).first();
  check('галочка «Уведомления» есть в форме приёма', await box.count() > 0);

  const yes = await intake(true);
  const no = await intake(false);
  check('заявка с галочкой сохранила согласие', yes.consent === true, JSON.stringify(yes));
  check('заявка без галочки согласия не получила', no.consent === false, JSON.stringify(no));

  console.log('\nОчередь отправки');
  // Журнал доставки открыт руководителю: в нём адреса и телефоны клиентов.
  await signIn('sv');
  const queue = await state(async () => {
    const res = await (await fetch('/api/notify/queue?limit=200', { credentials: 'same-origin' })).json();
    return (res.notifications || []).map((n) => ({ id: n.request_id, ch: n.channel, ev: n.event, to: n.address }));
  });
  const mine = queue.filter((n) => n.id === yes.id);
  const theirs = queue.filter((n) => n.id === no.id);
  check('по согласившемуся в очереди письмо и СМС',
    mine.length === 2 && mine.every((n) => n.ev === 'заявка')
    && mine.some((n) => n.ch === 'email' && n.to === 'yes@example.org')
    && mine.some((n) => n.ch === 'sms' && n.to === '+79120000001'),
    JSON.stringify(mine));
  check('по отказавшемуся в очереди пусто', theirs.length === 0, JSON.stringify(theirs));

  console.log('\nШаблоны на экране «Услуги и ставки»');
  // Тексты клиенту правит руководитель — тем же правилом, что и прайс.
  await go('services');
  const shown = await state(() => ({
    fields: document.querySelectorAll('textarea[id^=tplB]').length,
    subjects: document.querySelectorAll('input[id^=tplS]').length,
    marks: [...document.querySelectorAll('span.tg.mono')].filter((s) => /^\{.+\}$/.test(s.textContent)).length,
  }));
  check('блок шаблонов нарисован: восемь текстов и четыре темы',
    shown.fields === 8 && shown.subjects === 4, JSON.stringify(shown));
  check('перечень подстановок виден рядом с полями', shown.marks >= 10, JSON.stringify(shown));

  // Правка: меняем текст СМС о заявке прямо в поле и отпускаем фокус.
  const at = await state(() => [...document.querySelectorAll('textarea[id^=tplB]')]
    .findIndex((t) => t.value.startsWith('Заявка принята')));
  check('шаблон СМС о заявке найден в блоке', at >= 0, `индекс ${at}`);
  const NEW = 'Записали на {дата}, ждите с {окно_с} до {окно_до}. {контора}';
  await page.fill(`#tplB${at}`, NEW);
  await page.locator(`#tplB${at}`).blur();
  await quiet();

  const saved = await state(async () => {
    const res = await (await fetch('/api/notify/templates', { credentials: 'same-origin' })).json();
    return res.templates.find((t) => t.event === 'заявка' && t.channel === 'sms');
  });
  check('правка ушла на сервер', saved?.body === NEW, JSON.stringify(saved?.body));
  check('в шаблоне записан автор правки', saved?.updated_by === 'sv', JSON.stringify(saved?.updated_by));

  await go('intake');
  await go('services');
  const back = await state((want) => [...document.querySelectorAll('textarea[id^=tplB]')]
    .some((t) => t.value === want), NEW);
  check('после перезагрузки экрана на месте правленый текст', back);

  // Опечатка: сервер обязан отказать, а экран — показать причину.
  const refused = await state(async () => {
    const res = await fetch('/api/notify/templates/заявка/sms', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Ждём вас {мастера} в {дата}' }),
    });
    return { status: res.status, error: (await res.json()).error };
  });
  check('опечатка в подстановке отвергнута сервером',
    refused.status === 422 && /Неизвестная подстановка \{мастера\}/.test(refused.error || ''),
    JSON.stringify(refused));

  // Оператору шаблоны видны (он показывает клиенту, что тому придёт), но не правятся.
  await signIn('o2');
  const asOperator = await state(async () => {
    const read = await fetch('/api/notify/templates', { credentials: 'same-origin' });
    const write = await fetch('/api/notify/templates/заявка/sms', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Что угодно {дата}' }),
    });
    const queue = await fetch('/api/notify/queue', { credentials: 'same-origin' });
    return { read: read.status, write: write.status, queue: queue.status };
  });
  check('оператор шаблоны читает', asOperator.read === 200, `ответ ${asOperator.read}`);
  check('оператор шаблоны не правит', asOperator.write === 422, `ответ ${asOperator.write}`);
  check('журнал доставки оператору не отдаётся', asOperator.queue === 403, `ответ ${asOperator.queue}`);

  /* Отказы, которые браузер пишет в консоль по делу: «кто я» до входа (401) и
     два нарочных отказа оператору. Всё остальное в консоли — ошибка. */
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
  console.error(`\nУведомления на экранах: не сошлось проверок — ${failures}.`);
  process.exit(1);
}
console.log('\nУведомления на экранах прошли целиком: согласие, очередь, шаблоны, отказы по ролям.');
process.exit(0);
