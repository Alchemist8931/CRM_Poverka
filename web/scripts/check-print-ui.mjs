/* Печатные формы против настоящего API (пункт fe-forms).
 *
 *   npm run build && node scripts/check-print-ui.mjs
 *
 * Что проверяется — то, чего не видно ни из тестов сервера, ни из демо-режима:
 *
 *   — у поверителя на закрытой позиции есть «Печать акта» и «Свидетельство»,
 *     у незакрытой — нет;
 *   — в карточке выполненной заявки у руководителя те же кнопки;
 *   — акт и свидетельство открываются слоем, в акте — реквизиты исполнителя,
 *     номер заявки, все приборы и итог;
 *   — на бумаге каждый лист умещается в одну страницу А4 без обрезки:
 *     браузер печатает в PDF, и в файле ровно одна страница, а в печатном
 *     представлении лист не шире полосы набора;
 *   — «действительно до» в свидетельстве — дата поверки плюс межповерочный
 *     интервал типа прибора из справочника сервера (device_types.interval_years);
 *   — номер записи, принятый «Аршином», попадает в свидетельство;
 *   — в консоли браузера пусто.
 *
 * Устройство то же, что у scripts/check-notify-ui.mjs: свой сервер на встроенном
 * PostgreSQL, фронт раздаётся отсюда же с проксированием /api — cookie сессии
 * помечена SameSite=Lax и на чужой адрес не поедет.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:3202';
const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
/* PDF складываются во временный каталог: это доказательство для прогона, не артефакт репозитория. */
const outDir = process.env.PRINT_OUT || join(tmpdir(), 'uchetkin-print');
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
        method: req.method, body, redirect: 'manual',
        headers: { 'content-type': req.headers['content-type'] || 'application/json', cookie: req.headers.cookie || '' },
      });
      const out = {};
      for (const h of ['content-type', 'location']) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      const jar = upstream.headers.getSetCookie?.() ?? [];
      if (jar.length) out['set-cookie'] = jar;
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      /* Браузер закрылся посреди ответа — заголовки уже ушли, второй раз их не отправить. */
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

/* ── API напрямую, от имени руководителя ─────────────────── */

let jar = '';
async function apiCall(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', cookie: jar },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) jar = set.map((c) => c.split(';')[0]).join('; ');
  let out = null;
  try { out = await r.json(); } catch (e) { /* пустой ответ */ }
  return { status: r.status, body: out };
}

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
const wait = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout });
const quiet = async () => {
  await page.waitForTimeout(300);
  await wait(() => (window.S?.loading || 0) === 0, null, 60000);
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

/* Страниц в PDF: у Chromium словари страниц лежат в файле открытым текстом,
   сжаты только потоки содержимого. */
const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;

/** Лист на бумаге: печатное представление, PDF в файл, число страниц и ширина. */
async function printed(name) {
  await page.emulateMedia({ media: 'print' });
  const box = await state(() => {
    const sheet = document.querySelector('.prt .sheet');
    if (!sheet) return null;
    const r = sheet.getBoundingClientRect();
    /* Спрятанное не занимает места: у него нет ни одного прямоугольника —
       в отличие от display у потомка, который родительский none не наследует. */
    const shown = [...document.querySelectorAll('.app, .mask, .prt .bar')]
      .filter((el) => el.getClientRects().length > 0).length;
    return { w: r.width, h: r.height, sw: sheet.scrollWidth, cw: sheet.clientWidth, shown };
  });
  const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  await page.emulateMedia({ media: 'screen' });
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, name);
  writeFileSync(file, pdf);
  return { box, pages: pdfPages(pdf), file, bytes: pdf.length };
}

/* Тот же счёт, что у сервера: год прибавляется календарно. */
function addYears(from, years) {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCDate() !== Number(from.slice(8, 10))) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
const ru = (s) => s.split('-').reverse().join('.');

try {
  if (await healthy(1000)) {
    console.error(`На ${API} уже кто-то отвечает. Остановите его: проверка поднимает API сама.`);
    process.exit(2);
  }
  console.log('Поднимаем API…');
  await startApi();

  /* Справочник типов с сервера — по нему считаем ожидаемое «действительно до». */
  const login = await apiCall('POST', '/api/auth/login', { login: 'sv', password: PASSWORD });
  if (login.status !== 200) throw new Error(`вход руководителя по API: ${login.status}`);
  const { device_types: types } = (await apiCall('GET', '/api/device-types')).body;
  const mpiOf = (name) => types.find((t) => t.name === name)?.interval_years ?? null;
  check('справочник типов приборов отдаёт межповерочный интервал',
    types.length > 0 && types.every((t) => t.interval_years > 0),
    JSON.stringify(types.map((t) => [t.name, t.interval_years])));

  /* ── 1. поверитель: закрытая позиция сегодняшнего маршрута ── */
  console.log('\nАкт поверителя');
  await signIn('sv');
  await go('routes');
  const verifiers = await state(() =>
    [...new Set(S.routes.filter((r) => r.date === TODAY).map((r) => r.verifier))].filter(Boolean));

  let target = null;
  for (const who of verifiers) {
    await signIn(who);
    await go('myroute');
    target = await state(() => {
      for (const rt of S.routes.filter((r) => r.verifier === S.me && r.date === TODAY)) {
        const done = rt.stops.find((s) => s.done && S.requests.some((x) => x.id === s.req
          && x.status === 'выполнена' && x.devices.some((d) => (d.svc === 'wv' || d.svc === 'hv') && !d.bad)));
        const open = rt.stops.find((s) => !s.done && !s.unserved && S.requests.some((x) => x.id === s.req));
        if (done) return { route: rt.id, done: done.req, open: open?.req || null };
      }
      return null;
    });
    if (target) { target.verifier = who; break; }
  }
  check('у поверителя есть закрытая позиция с годным прибором на сегодня', !!target,
    `просмотрены поверители: ${verifiers.join(', ') || 'ни одного'}`);
  if (!target) throw new Error('без закрытой позиции печатать нечего');
  console.log(`  поверитель ${target.verifier}, маршрут ${target.route}, закрытая точка ${target.done}`);

  /* Дальше в консоли должно быть пусто: отказ 401 при первом «кто я» браузер
     пишет в консоль сам, к экранам он отношения не имеет. */
  errors.length = 0;

  if (target.open) {
    await page.evaluate((t) => { S.openRoute = t.route; S.openStop = t.open; window.render(); }, target);
    await page.waitForTimeout(200);
    const btns = await state(() => document.querySelectorAll('.prtb button').length);
    check('у незакрытой позиции кнопок печати нет', btns === 0, `кнопок ${btns}`);
  }

  await page.evaluate((t) => { S.openRoute = t.route; S.openStop = t.done; window.render(); }, target);
  await page.waitForTimeout(200);
  const rq = await state((id) => {
    const r = S.requests.find((x) => x.id === id);
    return { id: r.id, date: r.date, name: r.name, verifier: r.verifier, pay: r.pay,
      devices: r.devices.map((d) => ({ type: d.type, serial: d.serial, svc: d.svc, bad: d.bad, grsi: d.grsi, arshin: d.arshin })),
      labels: [...document.querySelectorAll('.prtb button')].map((b) => b.textContent.trim()) };
  }, target.done);
  const certs = rq.devices.filter((d) => (d.svc === 'wv' || d.svc === 'hv') && !d.bad).length;
  check('у закрытой позиции — «Печать акта» и по «Свидетельству» на каждый годный прибор',
    rq.labels[0] === 'Печать акта' && rq.labels.filter((l) => l.startsWith('Свидетельство')).length === certs,
    `кнопки: ${rq.labels.join(' | ')}; годных приборов ${certs}`);

  await page.click('.prtb button:first-child');
  await page.waitForSelector('.prt .sheet.act', { timeout: 10000 });
  const act = await state(() => document.querySelector('.prt .sheet.act').textContent.replace(/\s+/g, ' '));
  check('в акте — реквизиты исполнителя', /Бердинских Арина Андреевна/.test(act) && /660309757337/.test(act) && /321665800085370/.test(act) && /Асбест/.test(act));
  check('в акте — номер заявки, клиент и дата', act.includes(`№ ${rq.id}`) && act.includes(rq.name) && act.includes(ru(rq.date).slice(0, 2)));
  check('в акте — все приборы с заводскими номерами', rq.devices.every((d) => !d.serial || act.includes(d.serial)),
    rq.devices.map((d) => d.serial).join(', '));
  check('в акте — итог и оплата', /Итого к оплате/.test(act) && /Оплата/.test(act) && (rq.pay ? act.includes(rq.pay.method) : true));
  check('в акте — подписи исполнителя и заказчика', /Исполнитель/.test(act) && /Заказчик/.test(act) && /подпись/.test(act));

  const actPdf = await printed(`act-${rq.id}.pdf`);
  check('акт печатается на одной странице А4', actPdf.pages === 1, `страниц ${actPdf.pages}, ${actPdf.file}`);
  check('на бумаге только лист: экран и панель кнопок спрятаны', actPdf.box && actPdf.box.shown === 0,
    JSON.stringify(actPdf.box));
  check('лист акта не шире полосы набора', actPdf.box && actPdf.box.sw <= actPdf.box.cw + 1, JSON.stringify(actPdf.box));
  console.log(`  PDF акта: ${actPdf.bytes} байт, ${actPdf.file}`);

  await page.evaluate(() => window.closePrint());
  await page.waitForTimeout(150);
  check('слой печати закрывается', await state(() => !document.querySelector('.prt')));

  /* ── 2. свидетельство на первый годный прибор ── */
  console.log('\nСвидетельство о поверке');
  const ci = rq.devices.findIndex((d) => (d.svc === 'wv' || d.svc === 'hv') && !d.bad);
  const cd = rq.devices[ci];
  await page.evaluate(({ id, i }) => window.openPrint('cert', id, i), { id: rq.id, i: ci });
  await page.waitForSelector('.prt .sheet.cert', { timeout: 10000 });
  const cert = await state(() => ({
    text: document.querySelector('.prt .sheet.cert').textContent.replace(/\s+/g, ' '),
    till: document.querySelector('.prt .sheet.cert .till')?.textContent.trim(),
    arshin: document.querySelector('.prt .sheet.cert .arshin')?.textContent.trim(),
  }));
  const years = mpiOf(cd.type);
  const expectTill = years ? ru(addYears(rq.date, years)) : null;
  check(`«действительно до» = дата поверки плюс интервал типа «${cd.type}» (${years} г.)`,
    expectTill && cert.till === expectTill, `на листе ${cert.till}, ожидалось ${expectTill}`);
  check('в свидетельстве — ГРСИ, заводской номер, дата поверки, поверитель',
    cert.text.includes(cd.grsi) && cert.text.includes(cd.serial) && cert.text.includes(ru(rq.date)) && /Поверитель/.test(cert.text));
  check('без ответа реестра номер записи не выдуман', /будет присвоен/.test(cert.arshin || ''), cert.arshin);

  const certPdf = await printed(`cert-${rq.id}-${ci + 1}.pdf`);
  check('свидетельство печатается на одной странице А4', certPdf.pages === 1, `страниц ${certPdf.pages}`);
  check('лист свидетельства не шире полосы набора', certPdf.box && certPdf.box.sw <= certPdf.box.cw + 1, JSON.stringify(certPdf.box));
  console.log(`  PDF свидетельства: ${certPdf.bytes} байт, ${certPdf.file}`);
  await page.evaluate(() => window.closePrint());

  /* Счёт «действительно до» ещё и на границе: поверка 29 февраля. */
  const leap = await state(() => window.validTo('2028-02-29', 'ТСК-7 (тепло)'));
  check('29 февраля плюс 4 года — 29 февраля 2032, а не 1 марта', leap === '2032-02-29', leap);
  const leap2 = await state(() => window.validTo('2028-02-29', 'Бетар СХВ-15'));
  check('29 февраля плюс 6 лет упирается в 28 февраля 2034', leap2 === '2034-02-28', leap2);

  /* ── 3. номер реестра «Аршина» в свидетельстве ──
     Демо-набор закрывает акты мимо очереди «Аршина», а ответ реестра по
     настоящей выгрузке проверяет server/scripts/check-arshin.mts. Здесь —
     путь номера до бумаги: столбец devices.arshin_number приходит в строке
     прибора, экран переводит его в поле, свидетельство печатает. */
  console.log('\nНомер записи реестра');
  const card = (await apiCall('GET', `/api/requests/${rq.id}`)).body;
  const row = (card?.devices || [])[ci];
  check('строка прибора с сервера несёт arshin_number', !!row && 'arshin_number' in row, JSON.stringify(Object.keys(row || {})));
  const mapped = await state(({ id, i }) => S.requests.find((x) => x.id === id).devices[i].arshin, { id: rq.id, i: ci });
  check('экран переводит arshin_number в поле прибора', mapped === (row?.arshin_number || ''), `на экране ${JSON.stringify(mapped)}`);
  const number = '1-2026-00042';
  await page.evaluate(({ id, i, n }) => { S.requests.find((x) => x.id === id).devices[i].arshin = n; window.openPrint('cert', id, i); },
    { id: rq.id, i: ci, n: number });
  await page.waitForSelector('.prt .sheet.cert', { timeout: 10000 });
  const after = await state(() => ({
    arshin: document.querySelector('.prt .sheet.cert .arshin')?.textContent.trim(),
    sub: document.querySelector('.prt .sheet.cert .sub')?.textContent.replace(/\s+/g, ' ').trim(),
  }));
  check('принятый реестром номер — в свидетельстве и в его номере',
    after.arshin === number && after.sub.includes(`№ ${number}`) && !/внутренний/.test(after.sub), JSON.stringify(after));
  await page.evaluate(() => window.closePrint());

  /* ── 4. карточка выполненной заявки у руководителя ── */
  console.log('\nКарточка выполненной заявки');
  await signIn('sv');
  /* Смена сотрудника — снова форма входа и снова 401 на «кто я», записанный
     браузером; экранов это не касается. */
  errors.length = 0;
  await go('payroll');
  const has = await state((id) => !!S.requests.find((x) => x.id === id && x.status === 'выполнена' && x.devices.length), rq.id);
  const pick = has ? rq.id : await state(() => S.requests.find((x) => x.status === 'выполнена' && x.devices.length)?.id || null);
  check('в срезе руководителя есть выполненная заявка с приборами', !!pick);
  await page.evaluate((id) => window.openReq(id), pick);
  await page.waitForSelector('.modal', { timeout: 10000 });
  const labels = await state(() => [...document.querySelectorAll('.modal .prtb button')].map((b) => b.textContent.trim()));
  check('в карточке выполненной заявки — «Печать акта»', labels[0] === 'Печать акта', labels.join(' | '));
  await page.click('.modal .prtb button:first-child');
  await page.waitForSelector('.prt .sheet.act', { timeout: 10000 });
  const cardPdf = await printed(`act-card-${pick}.pdf`);
  check('акт из карточки — одна страница А4', cardPdf.pages === 1, `страниц ${cardPdf.pages}`);
  await page.evaluate(() => window.closePrint());
  await page.evaluate(() => window.closeModal());

  check('консоль браузера чистая', errors.length === 0, errors.join(' | '));
} finally {
  stopApi();
  await browser.close().catch(() => {});
  web.close();
}

if (failures) {
  console.error(`\nПечатные формы: не сошлось проверок — ${failures}.`);
  process.exit(1);
}
console.log('\nПечатные формы прошли целиком: акт и свидетельство, одна страница А4, «действительно до» по интервалу типа, номер реестра.');
process.exit(0);
