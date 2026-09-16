/* Сквозная проверка рабочего режима против настоящего API.
 *
 *   node scripts/e2e.mjs [адрес]        # по умолчанию http://127.0.0.1:4173/
 *
 * Что проверяется:
 *   1. вход тремя ролями и все их экраны без ошибок консоли;
 *   2. цепочка «заявка → маршрут → акт → отметка оплаты → подотчёт»;
 *   3. что она записана в базу — страница перезагружается, данные на месте;
 *   4. слой «нет связи»: сервер останавливают — слой поднимается, поднимают
 *      обратно — слой уходит сам, без единого нажатия.
 *
 * Сервер API поднимает и роняет сам этот сценарий (scripts/dev-pglite.mts в
 * server/): иначе четвёртый пункт нечем проверить. Веб-часть должна быть уже
 * поднята и проксировать /api и /health на тот же порт — это делает
 * `npm run preview` или контейнер web из docker-compose.yml.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const WEB = process.argv[2] || 'http://127.0.0.1:4173/';
const API = process.env.API_ORIGIN || 'http://127.0.0.1:3000';
const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
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

  /* 2. Сквозной сценарий --------------------------------------------------- */
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

  const phone = '+7 (900) 111-22-33';
  await page.evaluate(({ id, city, tel }) => {
    window.openSupReq(TODAY);
    Object.assign(S.supReq, {
      ctype: 'Физлицо', name: 'Сквозная Т. Т.', phone: tel, city,
      street: 'Ленина', house: '7', entrance: '1', floor: '2', flat: '12',
      time: 12, svcs: ['wv'], route: id,
    });
    window.createSupReq();
  }, { id: route.id, city: route.city, tel: phone });
  await wait((n) => S.routes.some((r) => r.stops.length === n + 1), route.stops, 30000)
    .then(() => ok('заявка принята и поставлена в маршрут'))
    .catch(() => bad('заявка принята и поставлена в маршрут', 'точка в маршруте не появилась'));

  // Перезагрузка страницы: если заявка живёт только в памяти вкладки, она исчезнет.
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.app', { timeout: 20000 });
  await quiet();
  // После перезагрузки вкладка открывается на первой странице роли — вернёмся к маршрутам.
  await go('routes');
  const stillThere = await state((n) => {
    const rt = S.routes.find((r) => r.date === TODAY && r.verifier === 'v0');
    return rt ? rt.stops.length : 0;
  }, route.stops);
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
    const r = S.requests.find((x) => x.id === id);
    window.setDev(id, 0, 'serial', '77-123456');
    window.setDev(id, 0, 'reading', '00123,456');
    window.setPay(id, 'method', 'наличные');
    return r.devices[0].id;
  }, made.id);
  await page.waitForTimeout(1200);           // задержка отправки полей строки прибора

  await page.evaluate(({ id, rt, i }) => window.closeStop(rt, i), { id: made.id, rt: stopIndex.route, i: stopIndex.i });
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

  /* 3. Слой «нет связи» ---------------------------------------------------- */
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

  /* 4. Ошибки консоли ------------------------------------------------------ */
  console.log('\n4. Консоль');
  // Пока сервера не было, запросы честно падали — эти записи браузера не в счёт.
  const real = errors.filter((e) => !/Failed to (load resource|fetch)/i.test(e));
  check('ошибок консоли нет', real.length === 0, real.join(' | '));
} catch (err) {
  bad('сценарий', err?.message || String(err));
} finally {
  await browser.close();
  await stopApi().catch(() => {});
}

console.log(failures ? `\nПроверок не сошлось: ${failures}.` : '\nВсе проверки сошлись.');
process.exit(failures ? 1 : 0);
