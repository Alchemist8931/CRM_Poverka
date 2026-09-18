/* Сценарий 4. Сборка маршрута и замок даты, обзвон точек.
 *
 * Три заявки на дату приёма ставит оператор (как в жизни), руководитель
 * открывает конструктор — с этого момента приём по дате закрыт, — собирает
 * маршрут, назначает поверителя, оператор обзванивает точки. */
import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, fakePhone, go, must, signIn, until, watchConsole, quiet, ROOT } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });

const C = context();
const ids = [];
let routeId = '';

test('оператор принимает три заявки на дату приёма', async () => {
  const op = await apiAs(C.op.login, C.op.password);
  for (const [i, street] of ['Ленина', 'Мира', 'Победы'].entries()) {
    const r = must(await op.post('/api/requests', {
      date: C.planDate, name: `Маршрутов ${i + 1} М. М.`, phone: fakePhone(), city: C.city,
      street, house: String(10 + i), flat: String(i + 1), svcs: ['wv'], time_slot: 11 + i,
    }), 'приём заявки');
    ids.push(r.request.id);
  }
  expect(ids.length).toBe(3);
  await op.close();
});

test('конструктор открыт — приём по дате закрыт для оператора', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, BOT.login, BOT.password);
  await go(page, 'routes');
  await page.evaluate((ds) => window.openRC(ds), C.planDate);
  await until(page, (ds) => window.S.rc?.date === ds && window.S.loading === 0, C.planDate);
  await page.waitForSelector('.modal.rcm');

  const op = await apiAs(C.op.login, C.op.password);
  const day = (await op.get(`/api/days/${C.planDate}`)).body;
  expect(day.lock, 'замок даты виден оператору').toBeTruthy();
  const denied = await op.post('/api/requests', {
    date: C.planDate, name: 'Опоздавший О. О.', phone: fakePhone(), city: C.city, street: 'Мира', house: '99', svcs: ['wv'],
  });
  expect(denied.status).toBe(422);
  expect(denied.body.reason).toBe('lock');
  await op.close();

  // Точки выбираются на карте; здесь — тем же обработчиком, что у точки.
  await until(page, (list) => list.every((id) => window.S.requests.some((r) => r.id === id)), ids);
  for (const id of ids) await page.evaluate((i) => window.rcPick(i), id);
  expect(await page.evaluate(() => window.S.rc.sel.length)).toBe(3);
  await page.evaluate(() => window.rcCreate());
  // Созданный маршрут встаёт первым в список «собрано в этой сессии».
  await until(page, () => (window.S.rc?.made || []).length > 0 && window.S.loading === 0, null, 40_000);
  routeId = await page.evaluate(() => window.S.rc.made[0]);
  expect(routeId).toMatch(/^M/);

  await page.evaluate(({ rt, ver }) => window.rcAssign(rt, ver), { rt: routeId, ver: C.ver.id });
  await until(page, ({ rt, ver }) => window.S.routes.find((r) => r.id === rt)?.verifier === ver, { rt: routeId, ver: C.ver.id });
  await page.evaluate(() => window.closeRC());
  await quiet(page);

  const sv = await apiAs(BOT.login, BOT.password);
  const route = (await sv.get(`/api/routes/${routeId}`)).body;
  expect(route.route.verifier_id).toBe(C.ver.id);
  expect(route.stops.map((s) => s.request_id).sort()).toEqual([...ids].sort());
  const after = (await sv.get(`/api/days/${C.planDate}`)).body;
  expect(after.lock, 'после сборки дата остаётся закрытой: маршруты уже собраны').toBeTruthy();
  const { requests } = (await sv.get(`/api/requests?route_id=${routeId}`)).body;
  expect(requests.every((r) => r.status === 'в маршруте')).toBe(true);
  await sv.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('обзвон накануне: оператор открывает день выезда на экране поддержки, две точки подтверждены, одна перенесена', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, C.op.login, C.op.password);
  await go(page, 'support');
  // Переключатель дня: сегодня и завтра. Дата приёма дальше, поэтому — той же
  // функцией, что зовёт переключатель.
  await page.evaluate((ds) => window.pickSupportDay(ds), C.planDate);
  await quiet(page);
  await page.evaluate((rt) => { window.S.openRoute = rt; window.reload(); }, routeId);
  await quiet(page);
  await until(page, (rt) => (window.S.routes.find((r) => r.id === rt)?.stops || []).every((s) => s.req), routeId);
  for (const [i, result] of ['подтверждена', 'подтверждена', 'перенос'].entries()) {
    await page.click(`button[onclick="callStop('${routeId}',${i},'${result}')"]`);
    await quiet(page);
  }
  expect(errors, 'ошибок консоли нет').toEqual([]);

  const op = await apiAs(C.op.login, C.op.password);
  const { route, stops } = (await op.get(`/api/routes/${routeId}`)).body;
  expect(stops.map((s) => s.called).sort()).toEqual(['перенос', 'подтверждена', 'подтверждена']);
  expect(route.status).toBe('обзвонен');
  const moved = stops.find((s) => s.called === 'перенос').request_id;
  expect((await op.get(`/api/requests/${moved}`)).body.request.status, 'перенос возвращает заявку оператору').toBe('перенос');
  await op.close();
});

test('маршрут на сегодня: руководитель ставит три адреса, оператор обзванивает их на экране поддержки', async ({ page }) => {
  const errors = watchConsole(page);
  const sv = await apiAs(BOT.login, BOT.password);
  const todayIds = [];
  for (const [i, street] of ['Ленина', 'Победы', 'Гагарина'].entries()) {
    const r = must(await sv.post('/api/requests', {
      date: C.today, name: `Выездов ${i + 1} В. В.`, phone: fakePhone(), city: C.city,
      street, house: String(20 + i), flat: String(i + 5), svcs: ['wv'], time_slot: 10 + i,
    }), 'заявка на сегодня');
    todayIds.push(r.request.id);
  }
  const made = must(await sv.post('/api/routes', {
    date: C.today, city: C.city, request_ids: todayIds, verifier_id: C.ver.id,
  }), 'маршрут на сегодня');
  const todayRoute = made.route.id;
  await sv.close();

  await signIn(page, C.op.login, C.op.password);
  await go(page, 'support');
  await expect(page.locator('.hd .ttl')).toContainText('Поддержка маршрутов');
  await page.evaluate((rt) => { window.S.openRoute = rt; window.reload(); }, todayRoute);
  await quiet(page);
  await until(page, (rt) => (window.S.routes.find((r) => r.id === rt)?.stops || []).every((s) => s.req), todayRoute);
  for (let i = 0; i < 3; i++) {
    await page.click(`button[onclick="callStop('${todayRoute}',${i},'подтверждена')"]`);
    await quiet(page);
  }
  await until(page, (rt) => window.S.routes.find((r) => r.id === rt)?.stops.every((s) => s.called === 'подтверждена'), todayRoute);

  const check = await apiAs(BOT.login, BOT.password);
  const { route } = (await check.get(`/api/routes/${todayRoute}`)).body;
  expect(route.status).toBe('обзвонен');
  await check.close();
  writeFileSync(ROOT + '.run/today-route.json', JSON.stringify({ routeId: todayRoute, stops: todayIds }));
  expect(errors, 'ошибок консоли нет').toEqual([]);
});
