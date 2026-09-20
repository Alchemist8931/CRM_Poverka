/* Экраны эквайринга против настоящего API и эмулятора провайдера (пункт int-pay).
 *
 *   npm run build && node scripts/check-payment-ui.mjs
 *
 * Что проверяется — то, чего не видно ни из тестов сервера, ни из демо-режима:
 *
 *   — при подключённом провайдере в акте появляются «СБП по QR» и «платёжная ссылка»;
 *   — «Показать QR» создаёт платёж и открывает окно с настоящей картинкой QR;
 *   — оплата у провайдера (эмулятор шлёт уведомление по сети) доезжает до окна:
 *     «оплачено», номер чека, отметка в заявке — без действий поверителя;
 *   — позиция закрывается безналом, в подотчёт сумма не попадает;
 *   — у руководителя карточка сверки за день показывает платёж и чек, возврат
 *     проходит из окна с причиной, выгрузка CSV отдаётся.
 *
 * Устройство то же, что у scripts/check-notify-ui.mjs: свой API на встроенном
 * PostgreSQL, эмулятор провайдера отдельным процессом, фронт раздаётся отсюда же
 * с проксированием /api.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:3202';
const EMU = process.env.EMULATOR_ORIGIN || 'http://127.0.0.1:3211';
const SECRET = 'проверка-ui';
const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const PASSWORD = process.env.SEED_PASSWORD || '1234';

let failures = 0;
const ok = (what) => console.log(`  ок   ${what}`);
const bad = (what, why) => { failures++; console.error(`  ПЛОХО ${what}${why ? ' — ' + why : ''}`); };
const check = (what, cond, why) => (cond ? ok(what) : bad(what, why));

/* ── процессы: эмулятор и API ────────────────────────────── */

const children = [];
function spawnTsx(script, env) {
  const child = spawn(join(serverDir, 'node_modules/.bin/tsx'), [script],
    { cwd: serverDir, stdio: ['ignore', 'ignore', 'inherit'], detached: true, env: { ...process.env, ...env } });
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children.splice(0)) {
    try { process.kill(-c.pid, 'SIGKILL'); } catch (e) { c.kill('SIGKILL'); }
  }
}
async function waitUp(url, timeoutMs, okStatus = (s) => s < 500) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (okStatus(r.status)) return true;
    } catch (e) { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
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
        method: req.method, body, redirect: 'manual',
        headers: { 'content-type': req.headers['content-type'] || 'application/json', cookie: req.headers.cookie || '' },
      });
      const out = {};
      for (const h of ['content-type', 'content-disposition', 'location']) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      const jar = upstream.headers.getSetCookie?.() ?? [];
      if (jar.length) out['set-cookie'] = jar;
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!res.headersSent) res.writeHead(upstream.status, out);
      res.end(bytes);
    } catch (err) {
      if (!res.headersSent) res.writeHead(502);
      res.end();
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
/* Отказ 401 при первом «кто я» до входа браузер пишет в консоль сам — к экранам
   он отношения не имеет. */
const noise = (t) => /favicon|401 \(Unauthorized\)/.test(t);
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
const go = async (view) => { await page.evaluate((v) => window.go(v), view); await quiet(); };

try {
  if (await waitUp(`${API}/health`, 1000, (s) => s === 200)) {
    console.error(`На ${API} уже кто-то отвечает. Остановите его: проверка поднимает API сама.`);
    process.exit(2);
  }
  console.log('Поднимаем эмулятор провайдера и API…');
  spawnTsx('scripts/payment-emulator.mts', {
    PAYMENT_EMULATOR_PORT: String(new URL(EMU).port), PAYMENT_WEBHOOK_SECRET: SECRET,
    PAYMENT_EMULATOR_WEBHOOK: `${API}/api/webhooks/payment/${encodeURIComponent(SECRET)}`,
  });
  if (!await waitUp(`${EMU}/pay/none`, 30000)) throw new Error('эмулятор не поднялся');
  spawnTsx('scripts/dev-pglite.mts', {
    PORT: String(new URL(API).port),
    PAYMENT_PROVIDER: 'yookassa', PAYMENT_SHOP_ID: 'emu', PAYMENT_SECRET_KEY: 'emu',
    PAYMENT_API_URL: `${EMU}/v3`, PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENT_ALLOWED_IPS: '127.0.0.1',
    PUBLIC_BASE_URL: WEB.replace(/\/$/, ''),
  });
  if (!await waitUp(`${API}/health`, 180000, (s) => s === 200)) throw new Error('API не поднялся');

  /* ── 1. поверитель: открытая позиция сегодняшнего маршрута ── */
  console.log('\nАкт поверителя');
  // Открытая позиция с приборами — на ближайшей дате с маршрутами: в выходной
  // сегодняшних маршрутов в демо-наборе нет, а проверке нужен акт, а не дата.
  await signIn('sv');
  const target = await state(async () => {
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const api = async (path) => (await fetch('/api' + path, { credentials: 'same-origin' })).json();
    const { routes } = await api(`/routes?date_from=${day(-2)}&date_to=${day(10)}`);
    for (const rt of routes.filter((r) => r.verifier_id)) {
      const { stops } = await api(`/routes/${rt.id}`);
      const { requests } = await api(`/requests?route_id=${rt.id}&with=devices,payment`);
      for (const s of stops) {
        if (s.done || s.unserved_reason) continue;
        const r = requests.find((x) => x.id === s.request_id);
        if (r && r.status !== 'выполнена' && r.client_type === 'Физлицо') {
          return { route: rt.id, date: String(rt.date).slice(0, 10), verifier: rt.verifier_id, req: r.id, devices: r.devices.length };
        }
      }
    }
    return null;
  });
  check('в демо-наборе есть открытая позиция', !!target, 'маршрутов с открытыми точками не нашлось');
  if (!target) throw new Error('без открытой позиции показывать QR некому');
  console.log(`  поверитель ${target.verifier}, маршрут ${target.route} на ${target.date}, заявка ${target.req}`);

  await signIn(target.verifier);
  // Прибор в акт — как его внёс бы поверитель на адресе: без строки прибора
  // платить не за что, и сервер платёж не создаст.
  const dev = await state(async (t) => {
    const res = await fetch(`/api/requests/${t.req}/devices`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service_id: 'wv', device_type: 'Бетар СХВ-15', grsi: '32245-11', carrier: 'ХВС', serial: 'QR-000001', pensioner: true }),
    });
    return res.status;
  }, target);
  check('поверитель внёс прибор в акт', dev === 200, `ответ ${dev}`);
  await go('myroute');
  // Экран поверителя грузит сегодняшние маршруты; чужую дату подсказываем ему
  // так же, как это делает выбор маршрута в списке: S.openRoute и перечитывание.
  await page.evaluate(async (t) => {
    if (!S.routes.some((r) => r.id === t.route)) S.routes.push({ id: t.route, date: t.date, verifier: S.me, stops: [], chat: [] });
    S.openRoute = t.route; S.openStop = t.req;
    await window.reload();
  }, target);
  await quiet();
  errors.length = 0;
  await page.evaluate((t) => { S.openRoute = t.route; S.openStop = t.req; window.render(); }, target);
  await page.waitForTimeout(200);
  const shown = await state((id) => !!document.querySelector('#payA' + id), target.req);
  check('акт выбранной заявки открыт на экране поверителя', shown);
  const cfg = await state(() => S.payCfg);
  check('фронт узнал, что эквайринг подключён', cfg?.enabled === true, JSON.stringify(cfg));
  const methods = await state((id) => window.payMethods(S.requests.find((x) => x.id === id)), target.req);
  check('в акте есть «СБП по QR» и «платёжная ссылка»', methods.includes('СБП по QR') && methods.includes('платёжная ссылка'), methods.join(', '));

  await page.evaluate((id) => window.setPay(id, 'method', 'СБП по QR'), target.req);
  await page.waitForTimeout(200);
  const btn = page.locator('.payb button', { hasText: 'Показать QR' });
  check('кнопка «Показать QR» появилась', await btn.count() === 1);
  const sumField = await state((id) => document.getElementById('payA' + id)?.disabled, target.req);
  check('сумма безнала руками не правится', sumField === true);

  await btn.click();
  await page.waitForSelector('.qrbox img', { timeout: 20000 });
  await quiet();
  const qr = await state(() => {
    const img = document.querySelector('.qrbox img');
    return { w: img?.naturalWidth || 0, src: img?.getAttribute('src') || '', sum: document.querySelector('.qrsum')?.textContent || '' };
  });
  check('окно с QR открылось, картинка загрузилась', qr.w > 100 && /\/online-payments\/\d+\/qr\.svg$/.test(qr.src), JSON.stringify(qr));
  const online = await state((id) => S.requests.find((x) => x.id === id).online, target.req);
  check('платёж создан и ждёт оплаты', online && online.status === 'ожидает' && online.kind === 'qr', JSON.stringify(online));
  const price = await state((id) => window.priceOf(S.requests.find((x) => x.id === id)), target.req);
  check('сумма платежа — цена акта', online.amount === price && qr.sum.includes(String(price).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace(/ /g, ' ')),
    `${online.amount} против ${price}, в окне «${qr.sum}»`);

  /* ── 2. оплата у провайдера: эмулятор шлёт уведомление сам ── */
  console.log('\nОплата и чек');
  const external = await state(async (id) => (await (await fetch(`/api/online-payments/${id}`, { credentials: 'same-origin' })).json()).payment.external_id, online.id);
  const paid = await fetch(`${EMU}/pay/${external}`, { method: 'POST', redirect: 'manual' });
  check('эмулятор принял оплату', paid.status === 302, String(paid.status));
  // Окно опрашивает сервер само, раз в четыре секунды.
  await page.waitForFunction((id) => S.requests.find((x) => x.id === id)?.online?.status === 'оплачен', target.req, { timeout: 30000 })
    .catch(() => {});
  await quiet();
  const after = await state((id) => {
    const r = S.requests.find((x) => x.id === id);
    return { online: r.online, pay: r.pay, box: document.querySelector('.qrbox')?.className, tags: document.querySelector('.qrstate')?.textContent };
  }, target.req);
  check('окно показало «оплачено» без действий поверителя', after.online?.status === 'оплачен' && /paid/.test(after.box || ''), JSON.stringify(after.online));
  check('чек зарегистрирован, номер виден в окне и в заявке',
    !!after.online?.receipt && (after.tags || '').includes(after.online.receipt) && after.pay?.receipt === after.online.receipt,
    `чек «${after.online?.receipt}», в заявке «${after.pay?.receipt}»`);
  await page.evaluate(() => window.closePay());

  /* ── 3. закрытие позиции безналом ── */
  await page.evaluate((t) => { S.openRoute = t.route; S.openStop = t.req; window.render(); }, target);
  await page.evaluate((t) => window.closeStop(t.route, S.routes.find((r) => r.id === t.route).stops.findIndex((s) => s.req === t.req)), target);
  await quiet();
  const closed = await state((id) => {
    const r = S.requests.find((x) => x.id === id);
    return { status: r.status, pay: r.pay, hand: window.handCash(r), toast: S.toast };
  }, target.req);
  check('позиция закрыта безналом, отметка «оплачено» стоит', closed.status === 'выполнена' && closed.pay?.method === 'СБП по QR' && !!closed.pay?.at,
    JSON.stringify(closed));
  check('в подотчёт поверителя сумма не попала', closed.hand === 0, `на руках ${closed.hand}`);

  /* ── 4. руководитель: сверка за день, возврат, выгрузка ── */
  console.log('\nСверка у руководителя');
  await signIn('sv');
  await go('payroll');
  const card = await state((id) => {
    const rows = [...document.querySelectorAll('.c')].find((c) => c.querySelector('h3')?.textContent.includes('Безнал по эквайрингу'));
    const row = rows && [...rows.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(id));
    return { has: !!rows, row: row?.textContent || null, acq: S.acq?.totals || null };
  }, target.req);
  check('карточка сверки есть и показывает платёж по заявке', card.has && !!card.row, JSON.stringify(card.acq));
  check('в строке — «оплачен» и номер чека', (card.row || '').includes('оплачен') && (card.row || '').includes(after.online?.receipt || '—'), card.row);
  const inUnpaid = await state((id) => {
    const c = [...document.querySelectorAll('.c')].find((x) => x.querySelector('h3')?.textContent.includes('Выполнено без оплаты'));
    return c ? c.textContent.includes(id) : null;
  }, target.req);
  check('в «выполнено без оплаты» заявки нет', inUnpaid === false, String(inUnpaid));

  const csv = await state(async (day) => {
    const r = await fetch(`/api/online-payments/export.csv?date=${day}`, { credentials: 'same-origin' });
    return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
  }, await state(() => TODAY));
  check('выгрузка для бухгалтера отдаётся CSV с заявкой', csv.status === 200 && /text\/csv/.test(csv.type) && csv.text.includes(target.req), `${csv.status} ${csv.type}`);

  await page.evaluate((id) => window.openRefund(id), online.id);
  await page.waitForSelector('#refundReason', { timeout: 10000 });
  await page.fill('#refundReason', 'проверка возврата из окна руководителя');
  await page.evaluate(() => window.doRefund());
  await quiet();
  await page.waitForFunction((id) => (S.acq?.payments || []).find((p) => p.id === id)?.status === 'возвращён', online.id, { timeout: 20000 }).catch(() => {});
  const refunded = await state((id) => (S.acq?.payments || []).find((p) => p.id === id), online.id);
  check('возврат проведён из окна с причиной', refunded?.status === 'возвращён' && refunded?.refund_reason === 'проверка возврата из окна руководителя', JSON.stringify(refunded));
  const rowAfter = await state((id) => {
    const rows = [...document.querySelectorAll('.c')].find((c) => c.querySelector('h3')?.textContent.includes('Безнал по эквайрингу'));
    const row = rows && [...rows.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(id));
    return row?.textContent || '';
  }, target.req);
  check('строка сверки показывает возврат и причину', rowAfter.includes('возвращён') && rowAfter.includes('проверка возврата'), rowAfter.slice(0, 160));
  const journal = await state(async (id) => (await (await fetch(`/api/audit?entity=online_payments&q=${id}`, { credentials: 'same-origin' })).json()).entries.length, String(online.id));
  check('возврат записан в журнал действий', journal >= 1, `записей ${journal}`);

  check('ошибок в консоли браузера нет', errors.length === 0, errors.join(' | '));
} finally {
  stopAll();
  await browser.close().catch(() => {});
  web.close();
}

if (failures) {
  console.error(`\nПроверка экранов эквайринга не сошлась: расхождений ${failures}.`);
  process.exit(1);
}
console.log('\nЭкраны эквайринга: QR у поверителя, оплата и чек по сети, сверка и возврат у руководителя.');
process.exit(0);
