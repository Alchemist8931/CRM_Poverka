/* Кадр в акте поверителя: снять, сжать, отправить в хранилище, увидеть в акте
 * и открыть на весь экран. Проверка идёт в настоящем браузере против настоящего
 * S3-совместимого хранилища (пункт be-photos).
 *
 *   docker compose up -d minio minio-init
 *   npm run build && node scripts/check-photo-ui.mjs
 *
 * Чем отличается от server/scripts/check-photo-roundtrip.mts: тот проверяет
 * круг со стороны сервера, ходя в хранилище из Node. Здесь кадр кладёт сам
 * браузер, и этим проверяется то, чего с сервера не видно:
 *
 *   — сжатие в canvas: в хранилище уезжает 1600 px по длинной стороне, а не
 *     то, что отдала камера;
 *   — запрос PUT на чужой адрес: бакет — не наш источник, и без разрешения
 *     CORS браузер не начнёт загрузку вовсе (infra/storage.tf, cors_rule);
 *   — миниатюра в акте и оригинал в лайтбоксе действительно рисуются, а не
 *     висят битой картинкой.
 *
 * Хранилище берётся из окружения, по умолчанию — MinIO из docker-compose.yml.
 * Сервер поднимается свой, на встроенном PostgreSQL, как и в scripts/e2e.mjs.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const API = process.env.API_ORIGIN || 'http://127.0.0.1:3100';
const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const PASSWORD = process.env.SEED_PASSWORD || '1234';

/* Настройки хранилища по умолчанию — MinIO из docker-compose.yml. Их же
   получает поднятый ниже API: storageConfig() читает ровно эти имена. */
const STORAGE = {
  S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://127.0.0.1:9000',
  ACTS_BUCKET: process.env.ACTS_BUCKET || 'uchetkin-acts',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || 'uchetkin',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || 'uchetkin-secret',
};

let failures = 0;
const ok = (what) => console.log(`  ок   ${what}`);
const bad = (what, why) => { failures++; console.error(`  ПЛОХО ${what}${why ? ' — ' + why : ''}`); };
const check = (what, cond, why) => (cond ? ok(what) : bad(what, why));

/* ── кадр, какой отдаёт камера телефона ──────────────────── */
/* sharp живёт в зависимостях сервера: фронту он не нужен, а здесь им делается
   подопытный снимок — нарочно крупнее того, что уходит в хранилище. */
const sharp = createRequire(join(serverDir, 'package.json'))('sharp');
const SHOT_W = 2400, SHOT_H = 1800;
const shot = await sharp({
  create: { width: SHOT_W, height: SHOT_H, channels: 3, background: '#6a6a6a' },
}).jpeg({ quality: 92 }).toBuffer();

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
      env: { ...process.env, ...STORAGE } });
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
        // Ответ 302 на подписанную ссылку хранилища должен доехать до браузера
        // как есть: именно он и есть выдача снимка.
        redirect: 'manual',
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

console.log(`Хранилище: ${STORAGE.S3_ENDPOINT}, бакет ${STORAGE.ACTS_BUCKET}`);

try {
  if (await healthy(1000)) {
    console.error(`На ${API} уже кто-то отвечает. Остановите его: проверка поднимает API сама.`);
    process.exit(2);
  }
  console.log('Поднимаем API…');
  await startApi();

  console.log('\nКадр в акте поверителя');

  /* Поверитель берётся не наугад: нужен тот, у кого на сегодня есть маршрут с
     незакрытой точкой — акт закрытой точки не правят. Кто сегодня в поле, видно
     руководителю; саму точку ищем уже глазами поверителя, в его собственном
     экране: заявку, которой в его состоянии нет, он и открыть не сможет. */
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
        for (const s of rt.stops) {
          if (s.done || s.unserved) continue;
          if (S.requests.some((x) => x.id === s.req)) return { route: rt.id, stop: s.req };
        }
      }
      return null;
    });
    if (target) { target.verifier = who; break; }
  }
  check('у поверителя есть точка в работе на сегодня', !!target,
    `просмотрены поверители: ${verifiers.join(', ') || 'ни одного'}`);
  if (!target) throw new Error('без точки в работе акт не открыть');
  console.log(`  поверитель ${target.verifier}, маршрут ${target.route}, точка ${target.stop}`);

  await page.evaluate((t) => { S.openRoute = t.route; S.openStop = t.stop; window.render(); }, target);
  await quiet();

  /* В акте нужна строка прибора: к ней и прикладываются кадры. Если поверитель
     её ещё не завёл, заводим — кнопкой «Добавить прибор», как он и делает. */
  const devices = (rid) => state((id) => S.requests.find((x) => x.id === id)?.devices?.length || 0, rid);
  if (!await devices(target.stop)) {
    await page.evaluate((rid) => window.addDev(rid), target.stop).catch(() => {});
    await wait((id) => (S.requests.find((x) => x.id === id)?.devices?.length || 0) > 0,
      target.stop, 30000).catch(() => {});
  }
  await quiet();
  const dev = await state((rid) => {
    const r = S.requests.find((x) => x.id === rid);
    const d = r?.devices?.[0];
    return d ? { rid, i: 0, id: d.id, photos: d.photos.length } : null;
  }, target.stop);
  check('в акте есть строка прибора', !!dev,
    `строка не появилась; на экране: ${await state(() => S.toast?.text || S.toast || '—')}`);
  if (!dev) throw new Error('без прибора кадр прикладывать некуда');

  const input = `#ph${dev.rid}_${dev.i}`;
  await page.waitForSelector(input, { state: 'attached', timeout: 20000 });

  /* Дальше в консоли должно быть пусто. До этой строки — не обязательно:
     форма входа показывается после того, как вкладка спросила «кто я» и
     получила 401, и этот отказ браузер пишет в консоль сам. */
  errors.length = 0;

  /* Загрузка идёт на чужой адрес — запомним, чем ответило хранилище: без
     разрешения CORS браузер сюда даже не дойдёт, и по одному «кадра нет в
     акте» причину не отличить. */
  const puts = [];
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(STORAGE.S3_ENDPOINT)) puts.push(`${r.method()} отказ: ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.url().startsWith(STORAGE.S3_ENDPOINT)) puts.push(`${r.request().method()} ${r.status()}`);
  });

  await page.setInputFiles(input, { name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: shot });
  const landed = await wait(
    ({ rid, i }) => (S.requests.find((x) => x.id === rid)?.devices?.[i]?.photos?.length || 0) > 0,
    { rid: dev.rid, i: dev.i }, 60000).then(() => true).catch(() => false);
  check('кадр из браузера уехал в хранилище и записан в акт', landed,
    `в акте кадра нет; хранилище: ${puts.join(', ') || 'запросов не было'}`);
  check('хранилище приняло запрос браузера на чужой адрес (CORS)',
    puts.some((p) => p === 'PUT 200'), `ответы хранилища: ${puts.join(', ') || 'запросов не было'}`);
  if (!landed) throw new Error('без загруженного кадра дальше проверять нечего');
  await quiet();

  const photo = await state(({ rid, i }) => {
    const p = S.requests.find((x) => x.id === rid).devices[i].photos[0];
    return { id: p.id, src: p.src, thumb: p.thumb, w: p.w, h: p.h, name: p.name };
  }, dev);

  check('кадр сжат браузером до 1600 px по длинной стороне', photo.w === 1600 && photo.h === 1200,
    `в хранилище лёг кадр ${photo.w}×${photo.h}, снимали ${SHOT_W}×${SHOT_H}`);
  check('в акте показана миниатюра, оригинал — отдельной ссылкой',
    /v=thumb/.test(photo.thumb || '') && /v=full/.test(photo.src || ''),
    `миниатюра ${photo.thumb}, оригинал ${photo.src}`);

  const thumbShown = await state((sel) => {
    const img = document.querySelector(sel);
    return img ? { src: img.getAttribute('src'), w: img.naturalWidth } : null;
  }, `.wrow .phw img`);
  check('миниатюра в акте нарисовалась, а не осталась битой картинкой',
    thumbShown && thumbShown.w > 0 && /v=thumb/.test(thumbShown.src),
    JSON.stringify(thumbShown));

  /* Лайтбокс: кадр на весь экран — это уже оригинал из хранилища. */
  await page.click('.wrow .phw img');
  await page.waitForSelector('.lb img', { timeout: 20000 });
  await wait(() => document.querySelector('.lb img')?.naturalWidth > 0, null, 30000)
    .then(() => {}).catch(() => {});
  const big = await state(() => {
    const img = document.querySelector('.lb img');
    return { src: img.getAttribute('src'), w: img.naturalWidth, bar: document.querySelector('.lb .bar')?.textContent || '' };
  });
  check('лайтбокс открыл оригинал из хранилища', /v=full/.test(big.src) && big.w === 1600,
    `${big.src} · ${big.w} px`);
  check('в лайтбоксе подписаны имя кадра и размер',
    big.bar.includes('IMG_0042.jpg') && big.bar.includes('1600×1200'), big.bar);

  /* Убрать кадр из акта может только руководитель — поверителю крестика нет. */
  await page.evaluate(() => { S.lb = null; window.render(); });
  await page.waitForTimeout(300);
  const crossForVerifier = await state(() => document.querySelectorAll('.wrow .phw button.x').length);
  check('поверителю кнопки «убрать кадр» не показывают', crossForVerifier === 0,
    `крестиков ${crossForVerifier}`);

  check('консоль браузера чистая', errors.length === 0, errors.join(' | '));
} finally {
  stopApi();
  await browser.close().catch(() => {});
  web.close();
}

if (failures) {
  console.error(`\nКадр в акте: не сошлось проверок — ${failures}.`);
  process.exit(1);
}
console.log('\nКадр в акте прошёл целиком: сжатие, загрузка из браузера, миниатюра, оригинал в лайтбоксе.');
process.exit(0);
