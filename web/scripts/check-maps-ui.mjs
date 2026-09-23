/* Конструктор маршрутов на настоящей карте (пункт int-maps).
 *
 *   npm run build && node scripts/check-maps-ui.mjs
 *
 * Что здесь проверяется — то, чего не видно ни из тестов сервера, ни из
 * проверки геокодирования:
 *
 *   — принятая заявка получает координаты и приезжает на экран с ними;
 *   — конструктор с ключом рисует точки дня на карте, а не схему области;
 *   — клики задают порядок объезда, между точками ложится линия, показывается
 *     оценка длины;
 *   — «Упорядочить» раскладывает точки по окнам приезда;
 *   — маршрут из этих точек создаётся и уходит на сервер;
 *   — у поверителя на точке есть «Навигатор» с deep link на этот адрес;
 *   — без ключа (демо-режим) остаётся прежняя схематичная карта области.
 *
 * Двух настоящих служб Яндекса здесь нет и быть не должно: ключа у проверки
 * нет, а зависеть от чужой службы и суточного лимита она не имеет права.
 * Поэтому Геокодеру подставлен свой приёмник (тот же, что в
 * server/scripts/check-maps.mts), а библиотека карты заменена заглушкой,
 * которая отвечает тем же набором классов, что JS API 3.0. Проверяется при
 * этом наш код: и загрузчик, и конструктор, и порядок координат — настоящие.
 *
 * Чего эта проверка не проверяет: как настоящая карта Яндекса выглядит и
 * ведёт себя в браузере. Это видно только с ключом, вживую.
 *
 * Устройство стенда то же, что у scripts/check-notify-ui.mjs: свой сервер на
 * встроенном PostgreSQL, фронт раздаётся отсюда же с проксированием /api.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:3203';
const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const PASSWORD = process.env.SEED_PASSWORD || '1234';
const JS_KEY = 'ключ-jsapi-для-проверки';

let failures = 0;
const ok = (what) => console.log(`  ок   ${what}`);
const bad = (what, why) => { failures++; console.error(`  ПЛОХО ${what}${why ? ' — ' + why : ''}`); };
const check = (what, cond, why) => (cond ? ok(what) : bad(what, why));

/* ── приёмник вместо Геокодера ───────────────────────────── */

/* Координаты выдуманные, но устроены как настоящие: около Асбеста, у каждого
   адреса свои. Разброс нужен, чтобы «Упорядочить» и оценка длины считали по
   разным точкам, а не по одной и той же. */
const point = (street, house) => {
  const n = [...`${street}${house}`].reduce((a, c) => a + c.codePointAt(0), 0);
  return { lat: 57.0 + (n % 37) / 1000, lon: 61.45 + (n % 53) / 1000 };
};

const geocoderHits = [];
const geocoder = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.searchParams.get('apikey')) return res.writeHead(403).end('{"error":"apikey is required"}');
  const asked = url.searchParams.get('geocode') ?? '';
  geocoderHits.push(asked);
  const [, , street, house] = asked.split(',').map((s) => s.trim());
  const p = point(street ?? '', house ?? '');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    response: {
      GeoObjectCollection: {
        featureMember: [{
          GeoObject: {
            Point: { pos: `${p.lon} ${p.lat}` },
            metaDataProperty: { GeocoderMetaData: { precision: 'exact', kind: 'house', text: asked } },
          },
        }],
      },
    },
  }));
});
await new Promise((done) => geocoder.listen(0, '127.0.0.1', done));
const GEOCODER = `http://127.0.0.1:${geocoder.address().port}/1.x/`;

/* ── заглушка библиотеки Яндекс Карт ─────────────────────── */

/* Тот же набор классов, что у JS API 3.0, и тот же порядок координат
   [долгота, широта]. Всё, что приходит в карту, складывается в window.__ymaps —
   по этому следу и сверяется, что на карту уехали настоящие координаты заявок
   в настоящем порядке объезда. */
const YMAPS_STUB = `
window.__ymaps = { markers: [], features: [], locations: [], created: 0 };
class Layer {}
class YMapMarker {
  constructor(props, element) { this.props = props; this.element = element; }
  update(props) { Object.assign(this.props, props); }
}
class YMapFeature {
  constructor(props) { this.props = props; }
  update(props) { Object.assign(this.props, props); }
}
class YMap {
  constructor(container, props) {
    this.container = container;
    this.children = [];
    container.style.cssText += ';display:flex;flex-wrap:wrap;gap:10px;padding:10px;position:relative';
    window.__ymaps.created++;
    window.__ymaps.locations.push(props && props.location);
  }
  addChild(child) {
    this.children.push(child);
    if (child instanceof YMapMarker) {
      this.container.appendChild(child.element);
      window.__ymaps.markers.push(child.props.coordinates);
    }
    if (child instanceof YMapFeature) window.__ymaps.features.push(child.props);
    return this;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    if (child instanceof YMapMarker) {
      child.element.remove();
      window.__ymaps.markers = window.__ymaps.markers.filter((c) => c !== child.props.coordinates);
    }
    if (child instanceof YMapFeature) {
      window.__ymaps.features = window.__ymaps.features.filter((f) => f !== child.props);
    }
    return this;
  }
  setLocation(loc) { window.__ymaps.locations.push(loc); }
}
window.ymaps3 = {
  ready: Promise.resolve(),
  YMap, YMapMarker, YMapFeature,
  YMapDefaultSchemeLayer: Layer, YMapDefaultFeaturesLayer: Layer,
};
`;

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
    { cwd: serverDir, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
      env: { ...process.env,
        // Ключи «есть»: настоящий Яндекс при этом не нужен ни серверу
        // (Геокодер подменён), ни браузеру (библиотека подменена).
        YANDEX_GEOCODER_KEY: 'ключ-геокодера-для-проверки',
        YANDEX_JSAPI_KEY: JS_KEY,
        YANDEX_GEOCODER_URL: GEOCODER } });
  if (!await healthy(180000)) throw new Error('API не поднялся');
}

function stopApi() {
  if (!api) return;
  const dying = api;
  api = null;
  try { process.kill(-dying.pid, 'SIGKILL'); } catch (e) { dying.kill('SIGKILL'); }
}

/* ── раздача собранного фронта с проксированием на API ───── */

/** Собранный фронт целиком: ни ключа, ни следа от него в нём быть не должно. */
function builtBundle() {
  const assets = join(distDir, 'assets');
  return readFileSync(join(distDir, 'index.html'), 'utf8')
    + (existsSync(assets) ? readdirSync(assets).map((f) => readFileSync(join(assets, f), 'utf8')).join('') : '');
}

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
const asked = [];
const noise = (t) => /favicon/.test(t);
page.on('console', (m) => {
  if (m.type() === 'error' && !noise(m.location()?.url || '') && !noise(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// Обращение за библиотекой карты перехватываем: наружу проверка не ходит.
await page.route('https://api-maps.yandex.ru/**', async (route) => {
  asked.push(route.request().url());
  await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: YMAPS_STUB });
});

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

/** Четыре заявки на один день в одном городе — материал для маршрута.
 *  Ставит их сервер обычным приёмом, то есть с геокодированием адреса. */
async function makeRequests() {
  return state(async () => {
    const days = await (await fetch('/api/days?from=' + new Date().toISOString().slice(0, 10)
      + '&to=' + new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
      { credentials: 'same-origin' })).json();
    const streets = [['Уральская', '77', 10], ['Ленинградская', '12', 16],
      ['Чапаева', '30', 10], ['Победы', '7', 14]];
    for (const day of (days.days || []).filter((d) => (d.cities || []).includes('Асбест'))) {
      const made = [];
      for (const [street, house, time] of streets) {
        const res = await fetch('/api/requests', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            date: day.date, city: 'Асбест', client_type: 'Физлицо', name: 'Проверкин П. П.',
            phone: '+7912000' + (1000 + made.length), street, house, time_slot: time, svcs: ['wv'],
          }),
        });
        if (res.ok) made.push((await res.json()).request.id);
      }
      if (made.length === streets.length) return { date: day.date, ids: made };
    }
    return { date: null, ids: [] };
  });
}

/** Геокодирование идёт после ответа на приём: ждём, пока координаты доедут. */
async function waitGeocoded(ids) {
  return state(async (wanted) => {
    for (let i = 0; i < 40; i++) {
      const out = [];
      for (const id of wanted) {
        const { request } = await (await fetch('/api/requests/' + id, { credentials: 'same-origin' })).json();
        out.push({ id, lat: request.lat, lon: request.lon, precision: request.geo_precision });
      }
      if (out.every((r) => r.lat !== null)) return out;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }, ids);
}

try {
  if (await healthy(1000)) {
    console.error(`На ${API} уже кто-то отвечает. Остановите его: проверка поднимает API сама.`);
    process.exit(2);
  }
  console.log('Поднимаем API…');
  await startApi();

  console.log('\nАдрес заявки становится точкой');
  await signIn('sv');
  const cfg = await state(async () => (await fetch('/api/maps/config', { credentials: 'same-origin' })).json());
  check('сервер отдаёт ключ JS API справочником', cfg.js_api_key === 'ключ-jsapi-для-проверки', JSON.stringify(cfg));
  check('ключа JS API в сборке фронта нет',
    !builtBundle().includes('ключ-jsapi'), 'ключ обязан приходить с сервера, а не из сборки');

  const { date, ids } = await makeRequests();
  check('четыре заявки на один день приняты', ids.length === 4, `дата ${date}`);
  const placed = await waitGeocoded(ids);
  check('у всех заявок появились координаты', !!placed,
    placed ? JSON.stringify(placed[0]) : 'координаты не доехали');
  check('точность — до дома', !!placed && placed.every((r) => r.precision === 'exact'));
  check('сервер спрашивал Геокодер по каждому адресу', geocoderHits.length >= 4, `запросов ${geocoderHits.length}`);

  console.log('\nКонструктор на настоящей карте');
  await state((d) => window.openRC(d), date);
  await quiet();
  await page.waitForSelector('.rcnest', { timeout: 20000 });
  check('обращение за библиотекой карты ушло с ключом',
    asked.some((u) => u.includes(encodeURIComponent(JS_KEY))), asked.join(' '));
  check('схематичной карты области на экране нет', await page.locator('.rcm .rcmap svg').count() === 0);
  await page.waitForFunction(() => (window.__ymaps?.markers.length || 0) >= 4, null, { timeout: 20000 });
  const marks = await state(() => window.__ymaps.markers);
  check('точки дня уехали на карту', marks.length >= 4, `маркеров ${marks.length}`);
  check('координаты идут долготой вперёд, как у Яндекса',
    marks.every(([lon, lat]) => lon > 61 && lon < 62 && lat > 56.9 && lat < 57.1), JSON.stringify(marks[0]));
  check('карту подогнали под точки', await state(() => window.__ymaps.locations.some((l) => l && l.bounds)));

  const dots = page.locator('.ympt:not(.taken)');
  const n = await dots.count();
  check('на карте столько точек, сколько свободных заявок', n >= 4, `точек ${n}`);
  await dots.nth(1).click();
  await dots.nth(0).click();
  const picked = await state(() => ({ sel: window.S.rc.sel.slice(), line: window.__ymaps.features.slice(-1)[0] }));
  check('клик по точке ставит её в очередь объезда', picked.sel.length === 2, JSON.stringify(picked.sel));
  check('между выбранными точками легла линия',
    picked.line?.geometry?.type === 'LineString' && picked.line.geometry.coordinates.length === 2,
    JSON.stringify(picked.line?.geometry));
  check('линия идёт в порядке нажатия',
    JSON.stringify(picked.line.geometry.coordinates[0]) !== JSON.stringify(picked.line.geometry.coordinates[1]));
  const head = await page.locator('.rcst .who').last().textContent();
  check('показана оценка длины объезда', /объезд ≈ \d/.test(head || ''), head || '');

  console.log('\nКнопка «Упорядочить»');
  await dots.nth(3).click();
  await dots.nth(2).click();
  const before = await state(() => window.S.rc.sel.slice());
  await page.locator('.rchd button', { hasText: 'Упорядочить' }).click();
  await page.waitForTimeout(300);
  const after = await state(() => ({
    sel: window.S.rc.sel.slice(),
    slots: window.S.rc.sel.map((id) => window.S.requests.find((r) => r.id === id).time),
    toast: window.S.toast,
  }));
  check('порядок пересобран', JSON.stringify(before) !== JSON.stringify(after.sel),
    `${before.join(',')} → ${after.sel.join(',')}`);
  check('окна приезда идут по возрастанию',
    after.slots.every((t, i) => i === 0 || t >= after.slots[i - 1]), after.slots.join(','));
  check('в подсказке названа длина маршрута', /км/.test(String(after.toast || '')), String(after.toast || ''));

  console.log('\nМаршрут из точек на карте');
  await page.locator('.rchd button', { hasText: 'Создать маршрут' }).click();
  await quiet();
  const made = await state(() => ({ made: window.S.rc.made.slice(), routes: window.S.routes.length }));
  check('маршрут создан и виден в сессии конструктора', made.made.length === 1, JSON.stringify(made));
  const card = await page.locator('.rcr .rch .note').first().textContent();
  check('у собранного маршрута показана оценка длины', /≈ \d+(\.\d)? км/.test(card || ''), card || '');
  const routeId = made.made[0];
  await state(() => window.closeRC());
  await quiet();

  console.log('\nНавигатор у поверителя');
  /* Экран поверителя работает по сегодняшнему дню (api/load.js, LOADERS.myroute),
     а собранный маршрут стоит на ближайшей свободной дате. Поэтому Навигатор
     сверяется на сегодняшнем маршруте демо-набора: его адресам правится дом, а
     правка адреса — это и есть повод геокодировать заново. */
  const verifier = await state(async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { routes } = await (await fetch('/api/routes?date=' + day, { credentials: 'same-origin' })).json();
    return ((routes || []).find((r) => r.verifier_id) || {}).verifier_id || null;
  });
  check('в демо-наборе есть сегодняшний маршрут с поверителем', !!verifier, String(verifier));

  // Какой маршрут откроет экран поверителя, решает он сам (LOADERS.myroute):
  // берём тот, что он загрузил целиком, и правим адреса именно у его точек.
  await signIn(verifier);
  await state(() => window.go('myroute'));
  await quiet();
  const mine = await state(() => {
    const rt = window.S.routes.find((r) => r.full && r.verifier === window.S.me);
    return rt ? { route: rt.id, ids: rt.stops.map((st) => st.req).filter(Boolean).slice(0, 3) } : null;
  });
  check('поверитель открыл свой маршрут целиком', !!mine && mine.ids.length === 3, JSON.stringify(mine));

  await signIn('sv');
  await state(async (ids) => {
    for (const [i, id] of ids.entries()) {
      await fetch('/api/requests/' + id, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ street: 'Уральская', house: String(70 + i) }),
      });
    }
  }, mine.ids);
  const placedToday = await waitGeocoded(mine.ids);
  check('правка адреса геокодируется заново', !!placedToday,
    placedToday ? JSON.stringify(placedToday[0]) : 'координаты не доехали');

  await signIn(verifier);
  await state(() => window.go('myroute'));
  await quiet();
  await state((id) => { window.S.openRoute = id; window.render(); }, mine.route);
  await page.waitForTimeout(300);
  const navi = page.locator('.stops button', { hasText: 'Навигатор' });
  check('на точке маршрута есть кнопка «Навигатор»', await navi.count() >= 1, `кнопок ${await navi.count()}`);
  check('у адресов без координат кнопки нет', await navi.count() === mine.ids.length,
    `кнопок ${await navi.count()}, адресов с точкой ${mine.ids.length}`);
  const link = await state((id) => {
    const r = window.S.requests.find((x) => x.id === id);
    return r ? { link: window.naviLink(r), maps: window.mapsLink(r), lat: r.lat, lon: r.lon } : null;
  }, mine.ids[0]);
  check('deep link ведёт в Навигатор на этот адрес',
    !!link && link.link === `yandexnavi://build_route_on_map?lat_to=${link.lat}&lon_to=${link.lon}`, link?.link);
  check('запасная ссылка ведёт на Яндекс Карты',
    !!link && /^https:\/\/yandex\.ru\/maps\/\?rtext=~[\d.]+,[\d.]+&rtt=auto$/.test(link.maps), link?.maps);

  console.log('\nДемо-режим без ключа');
  const demoAsked = asked.length;
  await page.goto(WEB + '?demo=1', { waitUntil: 'load' });
  // В демо вход без пароля: форма пускает по нажатию кнопки.
  await page.waitForSelector('form.login', { timeout: 20000 });
  await page.click('form.login button');
  await page.waitForSelector('.app', { timeout: 20000 });
  const demoDate = await state(() => {
    // День, на котором в демо-наборе есть хотя бы две заявки: конструктор
    // рисует точки этого дня.
    const byDate = {};
    for (const r of window.S.requests) {
      if (r.status !== 'отменена' && !r.routeId) byDate[r.date] = (byDate[r.date] || 0) + 1;
    }
    const day = Object.keys(byDate).sort().find((d) => byDate[d] >= 2);
    window.openRC(day);
    return day;
  });
  await page.waitForTimeout(500);
  check('в демо нашёлся день с заявками', !!demoDate, String(demoDate));
  check('в демо рисуется схематичная карта области', await page.locator('.rcm .rcmap svg').count() === 1);
  check('живой карты в демо нет', await page.locator('.rcnest').count() === 0);
  check('за библиотекой Яндекса демо не ходило', asked.length === demoAsked, `обращений ${asked.length - demoAsked}`);
  const demoPicked = await state(async () => {
    const dot = document.querySelector('.mp:not(.taken)');
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return window.S.rc.sel.length;
  });
  check('точки в демо по-прежнему выбираются', demoPicked === 1, `выбрано ${demoPicked}`);

  const real = errors.filter((e) => !/Failed to (load resource|fetch)/i.test(e));
  check('консоль браузера чистая', real.length === 0, real.join(' | '));
} catch (err) {
  bad('проверка', err?.stack || err?.message || String(err));
} finally {
  stopApi();
  await browser.close().catch(() => {});
  web.close();
  geocoder.close();
}

if (failures) {
  console.error(`\nКарта в конструкторе: не сошлось проверок — ${failures}.`);
  process.exit(1);
}
console.log('\nКарта прошла целиком: координаты, точки, порядок, длина, маршрут, Навигатор, демо без ключа.');
process.exit(0);
