/* Снимки всех страниц на ширине 1600 — ими сверяется компоновка «до» и «после»
 * разбора прототипа на модули (пункт be-fe-wire).
 *
 *   node scripts/shots.mjs <адрес> <каталог> [роль]
 *
 * Без роли открывается демо-режим: там в меню лежат все двенадцать страниц
 * подряд, как в прототипе. С ролью (`sv`, `o2`, `v0`) снимаются только страницы
 * этой роли — вход идёт через API.
 *
 * Браузер берётся из PLAYWRIGHT_CHROME или из кэша playwright.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { chromePath } from './chrome.mjs';

const [url, out, role] = process.argv.slice(2);
if (!url || !out) {
  console.error('нужны адрес и каталог: node scripts/shots.mjs http://127.0.0.1:8080/?demo=1 ../docs/screens/before');
  process.exit(2);
}

/** Тот же список, что собирает GROUPS в справочниках: порядок страниц в меню. */
const DEMO_VIEWS = ['intake', 'support', 'me', 'plan', 'routes', 'schedule', 'absence', 'payroll', 'services',
  'myroute', 'absence', 'me'];
const BY_ROLE = {
  sv: ['plan', 'routes', 'schedule', 'absence', 'payroll', 'services'],
  o0: ['intake', 'support', 'me'],
  o2: ['intake', 'support', 'me'],
  v0: ['myroute', 'absence', 'me'],
};


mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath() });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
// Значка сайта у прототипа нет, и его 404 — единственная запись, которую браузер
// пишет в консоль сам. Всё остальное — наше.
const noise = (t) => /favicon/.test(t);
page.on('console', (m) => {
  if (m.type() === 'error' && !noise(m.location()?.url || '') && !noise(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => {
  const why = r.failure()?.errorText || '';
  // Оборванный при закрытии страницы опрос связи — не ошибка экрана.
  if (noise(r.url()) || why.includes('ERR_ABORTED')) return;
  errors.push(`запрос не удался: ${r.url()} — ${why}`);
});

/* Часы в шапке идут — без остановленного времени снимки «до» и «после»
   расходятся на минуту и сравнивать их попиксельно нельзя. Дата остаётся
   сегодняшней: от неё считается весь демо-набор. */
const noon = new Date(); noon.setHours(12, 34, 0, 0);
await page.clock.setFixedTime(noon);

await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('form.login', { timeout: 20000 });
// Заставка рисуется четыре секунды и всё это время перехватывает нажатия.
await page.waitForSelector('#intro', { state: 'hidden', timeout: 20000 }).catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/00-login.png`, fullPage: true });

if (role) {
  await page.fill('form.login input[name=login]', role);
  await page.fill('form.login input[name=pw]', process.env.SEED_PASSWORD || '1234');
}
await page.click('form.login button');
await page.waitForSelector('.app', { timeout: 20000 });

const views = role ? BY_ROLE[role] : DEMO_VIEWS;
for (const [i, v] of views.entries()) {
  await page.evaluate((n) => window.goPage(n), i);
  // Экран догружается из API: ждём, пока загрузка кончится. Пауза перед
  // ожиданием нужна, чтобы не поймать состояние «ещё не началась».
  await page.waitForTimeout(300);
  await page.waitForFunction(() => (window.S?.loading || 0) === 0, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  // Всплывающая подсказка живёт три секунды и на снимке оказывается случайно —
  // от прогона к прогону то есть, то нет. Снимаем её руками.
  await page.evaluate(() => { if (typeof S !== "undefined" && S.toast) { S.toast = null; render(); } });
  await page.screenshot({ path: `${out}/${String(i + 1).padStart(2, '0')}-${v}.png`, fullPage: true });
}
await browser.close();
console.log(errors.length ? 'ОШИБКИ КОНСОЛИ:\n' + errors.join('\n') : `Снимков: ${views.length + 1}, ошибок консоли нет.`);
process.exit(errors.length ? 1 : 0);
