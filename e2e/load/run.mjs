/* Нагрузочный прогон против контура (пункт test-uat).
 *
 *   node load/run.mjs --minutes 60 --users 10 --requests 200 --photos 300
 *   node load/run.mjs --minutes 5            # укороченный: та же работа за пять минут
 *
 * Что он делает. Десять «сотрудников» (сессии технической учётки, у каждой
 * своя cookie) работают одновременно: каждый раз в несколько секунд открывает
 * один из основных экранов — те же запросы, которые делает фронт для экрана
 * приёма, поддержки маршрутов, сборки, сотрудников, маршрута поверителя и
 * поиска клиента по номеру. Между экранами сотрудники делают дела: за прогон
 * принимаются `--requests` заявок и в акты кладутся `--photos` снимков — через
 * тот же круг, что у телефона: ссылка → PUT в хранилище → подтверждение с
 * миниатюрой на сервере. Работа распределена по времени равномерно: 200 заявок
 * и 300 фото за час — это заявка каждые 18 секунд и кадр каждые 12.
 *
 * Что меряется. Время сборки каждого экрана — от первого запроса до последнего
 * ответа (запросы экрана идут параллельно, как в браузере). Порог — p95 не
 * хуже `--threshold` мс (1000). Отдельно — время приёма заявки и полного круга
 * снимка, без порога: они здесь, чтобы было видно, чем занята машина.
 *
 * Итог печатается таблицей и кладётся в load/out/<дата>.json. Код возврата 1,
 * если хоть один экран не уложился в порог.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) =>
  a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : []).filter((x) => x.length));
const BASE = (process.env.UAT_BASE_URL || args.base || 'https://84-201-139-101.sslip.io').replace(/\/$/, '');
const LOGIN = process.env.UAT_LOGIN || 'autotest';
const PASSWORD = process.env.UAT_PASSWORD || '';
const MINUTES = Number(args.minutes || 60);
const USERS = Number(args.users || 10);
const REQUESTS = Number(args.requests || 200);
const PHOTOS = Number(args.photos || 300);
const THRESHOLD = Number(args.threshold || 1000);
const SCREEN_EVERY_MS = Number(args['screen-every'] || 8000);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PHOTO = readFileSync(ROOT + 'fixtures/meter-big.jpg');

if (!PASSWORD) { console.error('Нет UAT_PASSWORD.'); process.exit(2); }

/* ── сессия ───────────────────────────────────────────────────── */
class Session {
  constructor(n) { this.n = n; this.cookie = ''; }
  async login() {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: LOGIN, password: PASSWORD }),
    });
    if (!r.ok) throw new Error(`вход: ${r.status} ${await r.text()}`);
    this.cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    this.me = (await r.json()).user;
  }
  async call(method, path, body) {
    const t0 = performance.now();
    const r = await fetch(BASE + path, {
      method, headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const ms = performance.now() - t0;
    let json = null;
    try { json = JSON.parse(text); } catch { /* файл */ }
    return { ok: r.ok, status: r.status, body: json, ms };
  }
}

/* ── замеры ───────────────────────────────────────────────────── */
const samples = {};           // имя → [мс]
const errors = {};            // имя → число ошибок
const add = (name, ms, ok = true) => { (samples[name] ||= []).push(ms); if (!ok) errors[name] = (errors[name] || 0) + 1; };
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Экран — несколько запросов параллельно, время экрана — до последнего ответа. */
async function screen(s, name, paths) {
  const t0 = performance.now();
  const rs = await Promise.all(paths.map((p) => s.call('GET', p)));
  add('экран: ' + name, performance.now() - t0, rs.every((r) => r.ok));
  return rs;
}

const today = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
const plus = (d) => new Date(Date.now() + 5 * 3600 * 1000 + d * 86400 * 1000).toISOString().slice(0, 10);
const enc = encodeURIComponent;

let seq = 0;
const stamp = Date.now() % 100000000;
const fakePhone = () => { const d = String(stamp).padStart(8, '0') + String(++seq % 100).padStart(2, '0'); return `+7 (9${d.slice(0, 2)}) ${d.slice(2, 5)}-${d.slice(5, 7)}-${d.slice(7, 9)}`; };

/* ── подготовка ───────────────────────────────────────────────── */
const boss = new Session(0);
await boss.login();
if (boss.me.role !== 'supervisor') throw new Error('нужна учётка руководителя');
const { body: { cities } } = await boss.call('GET', '/api/cities');
const city = process.env.UAT_CITY || cities.find((c) => c.name === 'Асбест')?.name || cities[0].name;
const DAY = plus(5);
// Дата для приёма: бригада в городе, план с запасом на весь прогон.
{
  const { body: { day } } = await boss.call('GET', `/api/days/${DAY}`);
  const list = [city, ...(day.cities || []).filter((c) => c !== city)].slice(0, 5);
  const plan = { ...(day.plan || {}), [city]: Math.max(REQUESTS + 50, Number(day.plan?.[city] || 0)) };
  for (const c of Object.keys(plan)) if (!list.includes(c)) delete plan[c];
  const r = await boss.call('PUT', `/api/days/${DAY}`, { cities: list, plan });
  if (!r.ok) throw new Error(`день ${DAY}: ${r.status} ${JSON.stringify(r.body)}`);
}
// Приборы под снимки: на прибор не больше десяти кадров.
const devices = [];
{
  const need = Math.ceil(PHOTOS / 10);
  for (let i = 0; i < need; i++) {
    const req = await boss.call('POST', '/api/requests', {
      date: today(), name: `Нагрузка ${i + 1} Н. Н.`, phone: fakePhone(), city, street: 'Мира', house: String(100 + i), svcs: ['wv'],
    });
    if (!req.ok) throw new Error(`заявка под снимки: ${req.status} ${JSON.stringify(req.body)}`);
    const dev = await boss.call('POST', `/api/requests/${req.body.request.id}/devices`,
      { service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', serial: `L${i}` });
    if (!dev.ok) throw new Error(`прибор: ${dev.status} ${JSON.stringify(dev.body)}`);
    devices.push(dev.body.device.id);
  }
  const probe = await boss.call('POST', `/api/devices/${devices[0]}/photos/upload`, { size: PHOTO.length, content_type: 'image/jpeg' });
  if (probe.status === 503) { console.error('Хранилище снимков не подключено (503) — нагрузка снимками невозможна.'); process.exit(2); }
}
const phones = (await boss.call('GET', '/api/requests?limit=50')).body.requests.map((r) => r.phone).filter(Boolean);
const routesToday = (await boss.call('GET', `/api/routes?date=${today()}`)).body.routes.map((r) => r.id);
const someRoute = routesToday[0] || null;

/* ── дела ─────────────────────────────────────────────────────── */
async function takeRequest(s, i) {
  const r = await s.call('POST', '/api/requests', {
    date: DAY, name: `Нагрузочный ${i} Клиент`, phone: fakePhone(), city, street: 'Ленина', house: String(1 + (i % 90)),
    flat: String(1 + (i % 60)), svcs: ['wv'], time_slot: 10 + (i % 10),
  });
  add('приём заявки (POST)', r.ms, r.ok);
  if (!r.ok) console.error(`  заявка ${i}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
}
async function takePhoto(s, i) {
  const dev = devices[i % devices.length];
  const t0 = performance.now();
  const slot = await s.call('POST', `/api/devices/${dev}/photos/upload`, { size: PHOTO.length, content_type: 'image/jpeg' });
  if (!slot.ok) { add('снимок: круг целиком', performance.now() - t0, false); console.error(`  снимок ${i}: ссылка ${slot.status} ${JSON.stringify(slot.body).slice(0, 120)}`); return; }
  const put = await fetch(slot.body.url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: PHOTO });
  if (!put.ok) { add('снимок: круг целиком', performance.now() - t0, false); console.error(`  снимок ${i}: PUT ${put.status}`); return; }
  const done = await s.call('POST', `/api/devices/${dev}/photos`, { key: slot.body.key, name: `load-${i}.jpg` });
  add('снимок: подтверждение (миниатюра)', done.ms, done.ok);
  add('снимок: круг целиком', performance.now() - t0, done.ok);
  if (!done.ok) console.error(`  снимок ${i}: подтверждение ${done.status} ${JSON.stringify(done.body).slice(0, 120)}`);
}

const SCREENS = [
  ['приём заявки', () => [`/api/days?from=${today()}&to=${plus(45)}`, `/api/requests?date=${today()}&limit=500`]],
  ['поддержка маршрутов', () => [`/api/days?from=${today()}&to=${today()}`, '/api/wait-list', `/api/routes?date=${today()}`, `/api/requests?date=${today()}&free=true&limit=500`]],
  ['сборка маршрутов', () => [`/api/days?from=${plus(-3)}&to=${plus(45)}`, `/api/routes?date_from=${plus(-3)}`]],
  ['сотрудники', () => ['/api/cities', '/api/services', '/api/device-types', '/api/staff']],
  ['карточка клиента', () => [`/api/clients?phone=${enc(phones[Math.floor(Math.random() * phones.length)] || '9000000000')}`]],
  ['маршрут поверителя', () => someRoute
    ? [`/api/routes?date=${today()}`, `/api/routes/${someRoute}`, `/api/requests?route_id=${someRoute}&with=devices,payment&limit=500`]
    : [`/api/routes?date=${today()}`]],
  ['мой заработок', () => [`/api/requests?date_from=${today().slice(0, 7)}-01&date_to=${plus(30)}&own=true&with=devices,payment&limit=500`, `/api/handovers?month=${today().slice(0, 7)}`]],
];

/* ── расписание ───────────────────────────────────────────────── */
const total = REQUESTS + PHOTOS;
const durationMs = MINUTES * 60 * 1000;
const jobs = [];
for (let i = 0; i < REQUESTS; i++) jobs.push({ kind: 'request', i });
for (let i = 0; i < PHOTOS; i++) jobs.push({ kind: 'photo', i });
// Перемешать, чтобы заявки и снимки шли вперемешку, как в жизни.
for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
jobs.forEach((j, k) => { j.at = Math.floor((k / total) * durationMs); });
let next = 0;
const start = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function worker(n) {
  const s = new Session(n);
  await s.login();
  let lastScreen = 0;
  while (true) {
    const now = Date.now() - start;
    if (next < jobs.length && jobs[next].at <= now) {
      const job = jobs[next++];
      if (job.kind === 'request') await takeRequest(s, job.i); else await takePhoto(s, job.i);
      continue;
    }
    if (next >= jobs.length && now >= durationMs) break;
    if (Date.now() - lastScreen >= SCREEN_EVERY_MS) {
      const [name, paths] = SCREENS[Math.floor(Math.random() * SCREENS.length)];
      await screen(s, name, paths());
      lastScreen = Date.now();
      continue;
    }
    await sleep(250);
  }
}

console.log(`Контур ${BASE}: ${USERS} пользователей, ${REQUESTS} заявок и ${PHOTOS} снимков за ${MINUTES} мин, порог p95 ${THRESHOLD} мс.`);
const ticker = setInterval(() => {
  const done = next;
  const screens = Object.entries(samples).filter(([k]) => k.startsWith('экран')).reduce((a, [, v]) => a + v.length, 0);
  console.log(`  ${Math.round((Date.now() - start) / 60000)} мин: дел ${done}/${total}, экранов ${screens}`);
}, 60_000);
await Promise.all(Array.from({ length: USERS }, (_, n) => worker(n + 1)));
clearInterval(ticker);

/* ── итог ─────────────────────────────────────────────────────── */
const rows = Object.entries(samples).sort(([a], [b]) => a.localeCompare(b)).map(([name, arr]) => ({
  name, n: arr.length, errors: errors[name] || 0,
  p50: Math.round(pct(arr, 0.5)), p95: Math.round(pct(arr, 0.95)), max: Math.round(Math.max(...arr)),
}));
const bad = rows.filter((r) => r.name.startsWith('экран') && (r.p95 > THRESHOLD || r.errors));
console.log('\n| Что | Замеров | Ошибок | p50, мс | p95, мс | max, мс |\n|---|---:|---:|---:|---:|---:|');
for (const r of rows) console.log(`| ${r.name} | ${r.n} | ${r.errors} | ${r.p50} | ${r.p95} | ${r.max} |`);
const out = {
  base: BASE, started: new Date(start).toISOString(), minutes: MINUTES, users: USERS,
  requests: REQUESTS, photos: PHOTOS, threshold_ms: THRESHOLD, rows, passed: !bad.length,
};
mkdirSync(ROOT + 'load/out', { recursive: true });
const file = ROOT + `load/out/${new Date(start).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(bad.length
  ? `\nНЕ УЛОЖИЛИСЬ: ${bad.map((r) => `${r.name} (p95 ${r.p95} мс, ошибок ${r.errors})`).join('; ')}`
  : `\nВсе экраны уложились в ${THRESHOLD} мс по p95.`);
console.log(`Итог: ${file}`);
process.exit(bad.length ? 1 : 0);
