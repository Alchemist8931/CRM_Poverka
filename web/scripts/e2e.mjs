/* Сквозная проверка рабочего режима против настоящего API.
 *
 *   node scripts/e2e.mjs                 # все разделы подряд
 *   node scripts/e2e.mjs --only=roles    # экраны трёх ролей
 *   node scripts/e2e.mjs --only=flow     # сквозной сценарий и перезагрузка
 *   node scripts/e2e.mjs --only=offline  # слой «нет связи»
 *
 * Что проверяется:
 *   roles   — вход тремя ролями и все их экраны без ошибок консоли;
 *   flow    — цепочка «заявка → маршрут → акт → отметка оплаты → подотчёт»
 *             и то, что она легла в базу: страница перезагружается, данные на месте;
 *   offline — сервер останавливают, слой «нет связи» поднимается; поднимают
 *             обратно — слой уходит сам, без единого нажатия.
 *
 * Снаружи поднимать нечего: сценарий сам запускает API (server/scripts/dev-pglite.mts
 * — то же приложение на встроенном PostgreSQL) и сам раздаёт собранный фронт,
 * проксируя /api и /health на тот же адрес. Один адрес обязателен: сессионная
 * cookie помечена SameSite=Lax и на чужой адрес не поедет.
 *
 * Перед запуском нужна сборка: `npm run build`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const wanted = (part) => !only.length || only.includes(part);
const API = process.env.API_ORIGIN || 'http://127.0.0.1:3000';
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
  /* Своей группой процессов: tsx запускает настоящий node отдельным процессом,
     и убить нужно обоих — иначе «остановленный» сервер продолжает слушать порт,
     и проверять слой «нет связи» будет не на чем. */
  api = spawn(join(serverDir, 'node_modules/.bin/tsx'), ['scripts/dev-pglite.mts', '3000'],
    { cwd: serverDir, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  if (!await healthy(180000)) throw new Error('API не поднялся');
}

async function stopApi() {
  if (!api) return;
  const dying = api;
  api = null;
  try { process.kill(-dying.pid, 'SIGKILL'); } catch (e) { dying.kill('SIGKILL'); }
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    try { await fetch(`${API}/health`); } catch (e) { return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('API не остановился');
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
  // Запросы к API уходят на сервер: браузер должен видеть один адрес.
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
      const type = upstream.headers.get('content-type');
      if (type) out['content-type'] = type;
      const jar = upstream.headers.getSetCookie?.() ?? [];
      if (jar.length) out['set-cookie'] = jar;
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      // Сервер остановлен — именно так это и должно выглядеть для браузера.
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
const wait = (fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout });
/* Экран считается собранным, когда загрузка не идёт. Просто «нет полосы
   загрузки» не годится: она появляется через такт после перехода, и проверка
   успела бы посмотреть на пустой экран. */
const quiet = async () => {
  await page.waitForTimeout(300);
  await wait(() => (window.S?.loading || 0) === 0, null, 60000);
  await page.waitForTimeout(200);
};

async function signIn(who) {
  // Сессия живёт в cookie, а метка «уже входили» — в localStorage: без обеих
  // вкладка откроется прежним сотрудником и формы входа не покажет.
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
  /* Порт должен быть свободен: иначе сценарий проверит чужой сервер, а на
     остановке связи упрётся в то, что «остановленный» API продолжает отвечать. */
  if (await healthy(1000)) {
    console.error(`На ${API} уже кто-то отвечает. Остановите его: сценарий поднимает API сам.`);
    process.exit(2);
  }
  console.log('Поднимаем API…');
  await startApi();

  /* 1. Роли и их экраны ---------------------------------------------------- */
  if (wanted('roles')) {
    console.log('\n1. Экраны трёх ролей');
    for (const [who, role, views] of [
      ['sv', 'supervisor', ['plan', 'routes', 'schedule', 'absence', 'payroll', 'services']],
      ['o2', 'operator', ['intake', 'support', 'me']],
      ['v0', 'verifier', ['myroute', 'absence', 'me']],
    ]) {
      await signIn(who);
      const seen = await state(() => ({ role: S.role, pages: PAGES.map((p) => p.v) }));
      check(`${who}: роль ${role}`, seen.role === role, `пришла ${seen.role}`);
      check(`${who}: страницы ${views.join(', ')}`, seen.pages.join() === views.join(), seen.pages.join());
      for (const v of views) {
        await go(v);
        const err = await state(() => S.loadError);
        check(`${who}: экран «${v}»`, !err, err);
      }
    }
  }

  /* 2. Сквозной сценарий --------------------------------------------------- */
  if (wanted('flow')) {
    console.log('\n2. Заявка → маршрут → акт → оплата → подотчёт');
    await signIn('sv');
    await go('routes');

    // Заявка на сегодня сразу в маршрут поверителя v0: такую ставит руководитель —
    // дата уже ушла под маршруты, и оператору она закрыта.
    const route = await state(() => {
      const rt = S.routes.find((r) => r.date === TODAY && r.verifier === 'v0');
      return rt ? { id: rt.id, city: rt.city, stops: rt.stops.length } : null;
    });
    check('маршрут поверителя v0 на сегодня найден', !!route, 'маршрутов v0 на сегодня нет');
    if (!route) throw new Error('без маршрута сценарий не имеет смысла');

    await page.evaluate(({ id, city }) => {
      window.openSupReq(TODAY);
      Object.assign(S.supReq, {
        ctype: 'Физлицо', name: 'Сквозная Т. Т.', phone: '+7 (900) 111-22-33', city,
        street: 'Ленина', house: '7', entrance: '1', floor: '2', flat: '12',
        time: 12, svcs: ['wv'], route: id,
      });
      window.createSupReq();
    }, { id: route.id, city: route.city });
    await wait((n) => S.routes.some((r) => r.stops.length === n + 1), route.stops, 30000)
      .then(() => ok('заявка принята и поставлена в маршрут'))
      .catch(() => bad('заявка принята и поставлена в маршрут', 'точка в маршруте не появилась'));

    // Перезагрузка страницы: если заявка живёт только в памяти вкладки, она исчезнет.
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.app', { timeout: 20000 });
    await quiet();
    // После перезагрузки вкладка открывается на первой странице роли — вернёмся к маршрутам.
    await go('routes');
    const stillThere = await state(() => {
      const rt = S.routes.find((r) => r.date === TODAY && r.verifier === 'v0');
      return rt ? rt.stops.length : 0;
    });
    check('точка в маршруте пережила перезагрузку страницы', stillThere === route.stops + 1,
      `точек ${stillThere}, было ${route.stops}`);

    // Акт заполняет поверитель — вход его учётной записью.
    await signIn('v0');
    await go('myroute');
    const made = await state(() => {
      const r = S.requests.filter((x) => x.name === 'Сквозная Т. Т.').sort((a, b) => b.id.localeCompare(a.id))[0];
      return r ? { id: r.id, routeId: r.routeId, status: r.status } : null;
    });
    check('заявка видна поверителю в его маршруте', made && made.routeId === route.id, JSON.stringify(made));
    if (!made) throw new Error('заявка до маршрута не доехала');

    const stopIndex = await state((id) => {
      const rt = S.routes.find((r) => r.date === TODAY && (r.stops || []).some((s) => s.req === id));
      if (!rt) return null;
      S.openRoute = rt.id;
      S.openStop = rt.stops.findIndex((s) => s.req === id);
      window.render();
      return { route: rt.id, i: S.openStop };
    }, made.id);
    check('точка открыта в акте', !!stopIndex, 'точки нет в маршруте поверителя');

    await page.evaluate((id) => window.addDev(id), made.id);
    await wait((id) => (S.requests.find((r) => r.id === id)?.devices || []).length === 1, made.id, 20000)
      .then(() => ok('прибор добавлен в акт'))
      .catch(() => bad('прибор добавлен в акт'));

    await page.evaluate((id) => {
      window.setDev(id, 0, 'serial', '77-123456');
      window.setDev(id, 0, 'reading', '00123,456');
      window.setPay(id, 'method', 'наличные');
    }, made.id);
    await page.waitForTimeout(1200);           // задержка отправки полей строки прибора

    await page.evaluate(({ rt, i }) => window.closeStop(rt, i), { rt: stopIndex.route, i: stopIndex.i });
    await wait((id) => S.requests.find((r) => r.id === id)?.status === 'выполнена', made.id, 30000)
      .then(() => ok('позиция закрыта, акт записан'))
      .catch(() => bad('позиция закрыта, акт записан'));

    const paid = await state((id) => {
      const r = S.requests.find((x) => x.id === id);
      return { status: r?.status, pay: r?.pay?.method, amount: r?.pay?.amount, serial: r?.devices?.[0]?.serial };
    }, made.id);
    check('заводской номер сохранён', paid.serial === '77-123456', paid.serial);
    check('оплата отмечена наличными', paid.pay === 'наличные', JSON.stringify(paid));

    // Подотчёт: собранное на адресе попадает в отчёт поверителя за месяц.
    await go('me');
    const report = await state(() => {
      const R = window.subReport(S.me, S.mMonth || CUR_M);
      return { cash: R.cash, wage: R.wage, left: R.left, done: R.done.length };
    });
    check('деньги попали в подотчёт поверителя', report.cash >= paid.amount && report.done > 0,
      JSON.stringify(report));

    // Ещё одна перезагрузка: акт и оплата должны быть в базе, а не в памяти.
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.app', { timeout: 20000 });
    await quiet();
    await go('myroute');
    const survived = await state((id) => {
      const r = S.requests.find((x) => x.id === id);
      return r ? { status: r.status, devices: r.devices.length, serial: r.devices[0]?.serial, pay: r.pay?.method } : null;
    }, made.id);
    check('акт и оплата пережили перезагрузку',
      survived && survived.status === 'выполнена' && survived.serial === '77-123456' && survived.pay === 'наличные',
      JSON.stringify(survived));
  }

  /* 3. Слой «нет связи» ---------------------------------------------------- */
  if (wanted('offline')) {
    // Слою нужна открытая страница: если сценарий шёл только этим разделом,
    // вкладку сначала надо куда-то привести.
    if (!wanted('flow')) await signIn('sv');
    console.log('\n3. Слой «нет связи»');
    await stopApi();
    // Слой поднимает либо неудавшийся запрос, либо опрос /health раз в десять секунд.
    await page.evaluate(() => window.reload()).catch(() => {});
    await page.waitForFunction(() => !document.getElementById('offline').hidden, null, { timeout: 30000 })
      .then(() => ok('сервер остановлен — слой «нет связи» поднялся'))
      .catch(() => bad('сервер остановлен — слой «нет связи» поднялся'));

    console.log('  поднимаем API обратно…');
    await startApi();
    await page.waitForFunction(() => document.getElementById('offline').hidden, null, { timeout: 40000 })
      .then(() => ok('сервер вернулся — слой снялся сам'))
      .catch(() => bad('сервер вернулся — слой снялся сам'));
  }

  /* 4. Ошибки консоли ------------------------------------------------------ */
  console.log('\n4. Консоль');
  // Пока сервера не было, запросы честно падали — эти записи браузера не в счёт.
  const real = errors.filter((e) => !/Failed to (load resource|fetch)/i.test(e));
  check('ошибок консоли нет', real.length === 0, real.join(' | '));
} catch (err) {
  bad('сценарий', err?.message || String(err));
} finally {
  await browser.close();
  web.close();
  await stopApi().catch(() => {});
}

console.log(failures ? `\nПроверок не сошлось: ${failures}.` : '\nВсе проверки сошлись.');
process.exit(failures ? 1 : 0);
