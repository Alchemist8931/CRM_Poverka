/* Сценарий 7. Лист ожидания и необслуженные адреса: оператор видит адрес,
 * который поверитель не обслужил, и ставит его в маршрут заново. */
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, fakePhone, go, isoToday, must, signIn, until, watchConsole } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });

const C = context();

test('оператор видит необслуженный адрес и переносит его в маршрут', async ({ page }) => {
  const errors = watchConsole(page);
  const sv = await apiAs(BOT.login, BOT.password);
  const { waits } = (await sv.get('/api/wait-list?state=' + encodeURIComponent('не обработана'))).body;
  const w = waits.find((x) => x.reason === 'Нет дома' && x.city === C.city);
  expect(w, 'в листе ожидания есть адрес «нет дома» из сценария 5').toBeTruthy();
  // Адрес переезжает в другой маршрут — на завтра: в прежнем остаётся след
  // неудачного выезда, и второй раз в тот же маршрут точку не поставить.
  const tomorrow = isoToday(1);
  const ids = [];
  for (const [i, street] of ['Мира', 'Победы'].entries()) {
    const r = must(await sv.post('/api/requests', {
      date: tomorrow, name: `Завтрашний ${i + 1} З. З.`, phone: fakePhone(), city: C.city,
      street, house: String(40 + i), svcs: ['wv'], time_slot: 11 + i,
    }), 'заявка на завтра');
    ids.push(r.request.id);
  }
  const target = must(await sv.post('/api/routes', {
    date: tomorrow, city: C.city, request_ids: ids, verifier_id: C.ver.id,
  }), 'маршрут на завтра').route;
  await sv.close();

  await signIn(page, C.op.login, C.op.password);
  await go(page, 'support');
  await expect(page.locator('.hd .ttl')).toContainText('Поддержка маршрутов');
  await until(page, (id) => (window.S.waits || []).some((x) => x.id === id), w.id);
  await expect(page.locator('.wtr').first()).toBeVisible();

  await page.evaluate(({ wid, rt }) => window.waitToRoute(wid, rt), { wid: w.id, rt: target.id });
  await until(page, (id) => (window.S.waits || []).find((x) => x.id === id)?.state === 'перенесена', w.id, 40_000);

  const check = await apiAs(BOT.login, BOT.password);
  const { request } = (await check.get(`/api/requests/${w.request_id}`)).body;
  expect(request.status).toBe('в маршруте');
  expect(request.route_id).toBe(target.id);
  expect(request.date, 'заявка переехала на дату нового маршрута').toBe(tomorrow);
  const { stops } = (await check.get(`/api/routes/${target.id}`)).body;
  expect(stops.map((s) => s.request_id)).toContain(w.request_id);
  await check.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});
