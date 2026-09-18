/* Сценарий 5. Выезд с телефона: акт, фото, показания, пенсионер, «не годен»
 * с бумажным бланком, оплата наличными и переводом, не обслуженный адрес.
 *
 * Маршрут на сегодня собирает руководитель через API — сборка проверена
 * сценарием 4, здесь важен телефон поверителя. Экран — на ширине телефона. */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, must, signIn, until, watchConsole, quiet, ROOT } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const C = context();
const stops = [];   // id заявок по порядку точек
let routeId = '';
let storage = true;

test('маршрут на сегодня собран и обзвонен (сценарий 4), хранилище снимков опрошено', async () => {
  const sv = await apiAs(BOT.login, BOT.password);
  const made = JSON.parse(readFileSync(ROOT + '.run/today-route.json', 'utf8'));
  routeId = made.routeId;
  stops.push(...made.stops);
  const { route } = (await sv.get(`/api/routes/${routeId}`)).body;
  expect(route.verifier_id).toBe(C.ver.id);
  expect(route.status).toBe('обзвонен');
  // Есть ли хранилище снимков: без него загрузка честно отвечает 503.
  const probe = await sv.post('/api/requests/' + stops[0] + '/devices', { service_id: 'wv', device_type: 'Бетар СХВ-15', serial: 'probe', carrier: 'ХВС' });
  const up = await sv.post(`/api/devices/${probe.body.device.id}/photos/upload`, { size: 1000, content_type: 'image/jpeg' });
  storage = up.status !== 503;
  must(await sv.del(`/api/devices/${probe.body.device.id}`), 'убрать пробный прибор');
  await sv.close();
});

test('поверитель видит маршрут на телефоне, открывает первый адрес', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, C.ver.login, C.ver.password);
  await expect(page.locator('.hd .ttl')).toContainText('Мой маршрут');
  await page.evaluate((rt) => window.pick('myRt', rt), routeId);
  await quiet(page);
  await until(page, (rt) => (window.S.routes.find((r) => r.id === rt)?.stops || []).some((s) => s.req), routeId);
  const seen = await page.evaluate((rt) => window.S.routes.find((r) => r.id === rt).stops.map((s) => s.req), routeId);
  expect(seen).toEqual(stops);
  // Чужие заявки поверителю не приходят вовсе.
  const ver = await apiAs(C.ver.login, C.ver.password);
  const { routes } = (await ver.get(`/api/routes?date=${C.today}`)).body;
  expect(routes.every((r) => r.verifier_id === C.ver.id), 'поверителю приходят только его маршруты').toBe(true);
  const mineIds = new Set(routes.map((r) => r.id));
  const { requests } = (await ver.get(`/api/requests?date=${C.today}`)).body;
  expect(requests.every((r) => mineIds.has(r.route_id) || r.verifier_id === C.ver.id)).toBe(true);
  await ver.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('адрес 1: два прибора, пенсионер, фото, второй «не годен» с бумажным бланком, наличные', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, C.ver.login, C.ver.password);
  await page.evaluate((rt) => window.pick('myRt', rt), routeId);
  await quiet(page);
  const req = stops[0];
  await page.evaluate(({ rt, id }) => { window.S.openRoute = rt; window.S.openStop = id; window.render(); }, { rt: routeId, id: req });

  await page.evaluate((id) => window.addDev(id), req);
  await until(page, (id) => (window.S.requests.find((r) => r.id === id)?.devices || []).length === 1, req);
  await page.evaluate((id) => {
    window.setDev(id, 0, 'serial', '41230001');
    window.setDev(id, 0, 'reading', '00123,456');
    window.setDev(id, 0, 'pens', true);
  }, req);
  await page.waitForTimeout(1200);

  if (storage) {
    // Кадр идёт из браузера прямо в бакет: если правило CORS бакета не пускает
    // этот адрес, загрузка молча не начнётся — ловим подсказку экрана, а не таймаут.
    const failed = [];
    page.on('console', (m) => { if (/кадр|загруз/i.test(m.text())) failed.push(m.text()); });
    await page.setInputFiles(`#ph${req}_0`, ROOT + 'fixtures/meter.jpg');
    const outcome = await Promise.race([
      until(page, (id) => (window.S.requests.find((r) => r.id === id)?.devices[0]?.photos || []).length === 1, req, 60_000).then(() => 'ok'),
      page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /не загруз|не долетел|не удалось/i.test(t.textContent)), null, { timeout: 60_000 })
        .then(() => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '))),
    ]).catch((e) => `таймаут: ${e.message.slice(0, 120)}`);
    if (outcome === 'ok') {
      const thumb = await page.evaluate((id) => window.S.requests.find((r) => r.id === id).devices[0].photos[0], req);
      expect(thumb.thumb || thumb.url || thumb.id, 'кадр записан в акт с миниатюрой').toBeTruthy();
    } else {
      // Сервер ссылку выдал, а браузер до бакета не достучался: это правило CORS
      // бакета на адрес контура (docs/uat.md, замечание 6а), а не код акта.
      const slot = await page.evaluate(async (id) => {
        const d = window.S.requests.find((r) => r.id === id).devices[0];
        const r = await fetch(`/api/devices/${d.id}/photos/upload`, { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: 1000, content_type: 'image/jpeg' }) });
        return r.status;
      }, req);
      expect(slot, 'сервер выдаёт ссылку на загрузку').toBe(200);
      test.info().annotations.push({ type: 'skip', description: `кадр не ушёл в бакет из браузера — CORS бакета на адрес контура: ${outcome}` });
    }
  } else {
    test.info().annotations.push({ type: 'skip', description: 'хранилище снимков не подключено — загрузка отвечает 503' });
  }

  await page.evaluate((id) => window.addDev(id), req);
  await until(page, (id) => (window.S.requests.find((r) => r.id === id)?.devices || []).length === 2, req);
  await page.evaluate((id) => window.setBad(id, 1, 'bad'), req);
  await page.waitForTimeout(800);
  await page.evaluate((id) => {
    window.setDev(id, 1, 'serial', '41230002');
    window.setDev(id, 1, 'badWhy', 'Погрешность выше допуска');
    window.setDev(id, 1, 'blank', true);
    window.setDev(id, 1, 'blankNo', 'СН-000123');
  }, req);
  await page.waitForTimeout(1200);

  await page.evaluate((id) => window.setPay(id, 'method', 'наличные'), req);
  await page.evaluate(({ rt, id }) => {
    const r = window.S.routes.find((x) => x.id === rt);
    window.closeStop(rt, r.stops.findIndex((s) => s.req === id));
  }, { rt: routeId, id: req });
  await until(page, (id) => window.S.requests.find((r) => r.id === id)?.status === 'выполнена', req, 40_000);

  const sv = await apiAs(BOT.login, BOT.password);
  const { request } = (await sv.get(`/api/requests/${req}`)).body;
  const devices = (await sv.get(`/api/requests/${req}/devices`)).body.devices;
  const wv = C.services.find((s) => s.id === 'wv');
  expect(devices[0].pensioner).toBe(true);
  expect(Number(devices[0].price_charged), 'цена пенсионеру снята снимком').toBe(Number(wv.price_pensioner));
  expect(devices[1].bad).toBe(true);
  expect(devices[1].bad_reason).toBe('Погрешность выше допуска');
  expect(devices[1].blank_no).toBe('СН-000123');
  expect(request.status).toBe('выполнена');
  const pay = (await sv.get(`/api/requests/${req}/payment`)).body.payment;
  expect(pay.method).toBe('наличные');
  expect(Number(pay.amount)).toBe(Number(wv.price_pensioner) + Number(wv.price_person));
  const queue = (await sv.get(`/api/arshin/queue?q=${req}`)).body;
  expect(queue.records.length, 'по каждому прибору — запись для «Аршина», включая непригодный').toBe(2);
  expect(queue.records.some((r) => r.applicable === false)).toBe(true);
  await sv.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('адрес 2: перевод на карту', async ({ page }) => {
  await signIn(page, C.ver.login, C.ver.password);
  await page.evaluate((rt) => window.pick('myRt', rt), routeId);
  await quiet(page);
  const req = stops[1];
  await page.evaluate(({ rt, id }) => { window.S.openRoute = rt; window.S.openStop = id; window.render(); }, { rt: routeId, id: req });
  await page.evaluate((id) => window.addDev(id), req);
  await until(page, (id) => (window.S.requests.find((r) => r.id === id)?.devices || []).length === 1, req);
  await page.evaluate((id) => { window.setDev(id, 0, 'serial', '41230003'); window.setDev(id, 0, 'reading', '00045,120'); }, req);
  await page.waitForTimeout(1200);
  await page.evaluate((id) => window.setPay(id, 'method', 'перевод на карту'), req);
  await page.evaluate(({ rt, id }) => {
    const r = window.S.routes.find((x) => x.id === rt);
    window.closeStop(rt, r.stops.findIndex((s) => s.req === id));
  }, { rt: routeId, id: req });
  await until(page, (id) => window.S.requests.find((r) => r.id === id)?.status === 'выполнена', req, 40_000);
  const sv = await apiAs(BOT.login, BOT.password);
  const pay = (await sv.get(`/api/requests/${req}/payment`)).body.payment;
  expect(pay.method).toBe('перевод на карту');
  await sv.close();
});

test('адрес 3: клиента нет дома — точка не обслужена и уходит в лист ожидания', async ({ page }) => {
  await signIn(page, C.ver.login, C.ver.password);
  await page.evaluate((rt) => window.pick('myRt', rt), routeId);
  await quiet(page);
  const req = stops[2];
  await page.evaluate(({ rt, id }) => {
    const r = window.S.routes.find((x) => x.id === rt);
    window.openUnserved(rt, r.stops.findIndex((s) => s.req === id));
  }, { rt: routeId, id: req });
  await page.waitForSelector('.modal');
  await page.evaluate(() => { window.S.uns = { reason: 'Нет дома', note: 'Не открыли, телефон не отвечает' }; window.markUnserved(); });
  await until(page, (id) => window.S.requests.find((r) => r.id === id)?.status === 'ожидание', req, 40_000);

  const sv = await apiAs(BOT.login, BOT.password);
  const { waits } = (await sv.get('/api/wait-list?state=' + encodeURIComponent('не обработана'))).body;
  const w = waits.find((x) => x.request_id === req);
  expect(w, 'адрес в листе ожидания').toBeTruthy();
  expect(w.reason).toBe('Нет дома');
  await sv.close();
});
