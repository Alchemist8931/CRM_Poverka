/* Демо-режим обязан открываться без сервера.
 *
 *   node scripts/check-demo.mjs [файл]     # по умолчанию корневой index.html
 *
 * Поднимает раздачу статики на свободном порту, открывает страницу и смотрит
 * три вещи: экраны рисуются, в консоли пусто и в сеть за данными никто не ходил
 * — ни одного обращения к /api или /health. Именно в таком виде прототип лежит
 * на GitHub Pages, где никакого сервера нет и не будет.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromePath } from './chrome.mjs';

const file = process.argv[2] || fileURLToPath(new URL('../../index.html', import.meta.url));
const html = readFileSync(file);

const server = createServer((req, res) => {
  // Раздаём ровно один файл: всё остальное — 404, как на статике.
  if ((req.url || '/').split('?')[0] !== '/') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: chromePath() });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [];
const toServer = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('request', (r) => { if (/\/(api|health)\b/.test(new URL(r.url()).pathname)) toServer.push(r.url()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('form.login', { timeout: 20000 });
await page.click('form.login button');
await page.waitForSelector('.app', { timeout: 20000 });

// Пройдём все страницы: наполнение в памяти должно хватать каждой.
const pages = await page.evaluate(() => window.PAGES.length);
for (let i = 0; i < pages; i++) {
  await page.evaluate((n) => window.goPage(n), i);
  await page.waitForTimeout(150);
}
// Последняя страница обхода — экран поверителя; журнал смотрим на его же
// странице, иначе в разметке его просто нет.
await page.evaluate(() => window.go('audit'));
await page.waitForTimeout(250);
/* Печатные формы (fe-forms) обязаны собираться и без сервера: акт по
   выполненной заявке из наполнения в памяти. */
const printed = await page.evaluate(() => {
  const r = S.requests.find((x) => x.status === 'выполнена' && (x.devices || []).length);
  if (!r) return { act: false, cert: false, why: 'нет выполненной заявки с приборами' };
  window.openPrint('act', r.id);
  const act = !!document.querySelector('.prt .sheet.act');
  const i = r.devices.findIndex((d) => (d.svc === 'wv' || d.svc === 'hv') && !d.bad);
  let cert = i < 0;
  if (i >= 0) { window.openPrint('cert', r.id, i); cert = !!document.querySelector('.prt .sheet.cert .till'); }
  window.closePrint();
  return { act, cert, why: r.id };
});
await page.waitForTimeout(150);
const seen = await page.evaluate(() => ({
  expectedPages: GROUPS.reduce((n, g) => n + g.views.length, 0),
  requests: S.requests.length, routes: S.routes.length, staff: S.staff.length, page: S.page,
  audit: (S.audit || []).length, auditRows: document.querySelectorAll('table.audit tbody tr.ln').length,
}));

await browser.close();
server.close();

let bad = 0;
const check = (what, cond, why) => {
  if (cond) console.log(`  ок   ${what}`);
  else { bad++; console.error(`  ПЛОХО ${what}${why ? ' — ' + why : ''}`); }
};
// Страниц столько, сколько экранов у ролей: число не зашито, чтобы новый экран не ронял проверку.
check(`страниц пройдено: ${pages}`, pages === seen.expectedPages, `у ролей их ${seen.expectedPages}`);
check('акт и свидетельство о поверке печатаются из наполнения в памяти', printed.act && printed.cert, printed.why);
check('наполнение в памяти есть', seen.requests > 1000 && seen.routes > 10 && seen.staff === 17,
  JSON.stringify(seen));
// Журнал действий в демо делается по наполнению: пустой экран у руководителя —
// это не «журнал чист», а несобранное демо.
check('журнал действий наполнен и нарисован', seen.audit > 20 && seen.auditRows === seen.audit,
  JSON.stringify(seen));
check('в сеть за данными не ходили', toServer.length === 0, toServer.join(' '));
check('ошибок консоли нет', errors.length === 0, errors.join(' | '));
console.log(bad ? `\nДемо-режим: не сошлось ${bad}.` : '\nДемо-режим открывается без сервера.');
process.exit(bad ? 1 : 0);
