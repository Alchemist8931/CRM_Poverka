/* Сценарий 2. Оператор принимает заявку: подбор даты под услуги и город,
 * карточка известного клиента по номеру, защита от дубля.
 *
 * Входящий звонок с карточкой при входящем здесь не воспроизводится: его даёт
 * АТС Новофон, и в программе испытаний это ручной шаг с настоящим звонком. */
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, fakePhone, go, signIn, until, watchConsole, quiet } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });

const C = context();
const client = { name: 'Приёмова Т. Т.', phone: fakePhone(), street: 'Ленина', house: '7', flat: '12' };

test('подсказка дат: под услугу и город предлагаются дни со сменой и открытым приёмом', async () => {
  const op = await apiAs(C.op.login, C.op.password);
  const slots = await op.get(`/api/slots?svcs=wv&city=${encodeURIComponent(C.city)}&from=${C.today}&days=60`);
  expect(slots.ok).toBe(true);
  const dates = slots.body.slots.map((s) => s.ds);
  expect(dates, 'подготовленная дата приёма есть в подсказке').toContain(C.planDate);
  for (const s of slots.body.slots) expect(s.crew).toBeGreaterThan(0);
  await op.close();
});

test('оператор записывает клиента на дату из подсказки', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, C.op.login, C.op.password);
  await expect(page.locator('.hd .ttl')).toContainText('Приём заявки');

  // Дата выбирается на ленте ёмкости; здесь — той же функцией, что и клик по плитке.
  await page.evaluate((ds) => window.pickDay(ds), C.planDate);
  await quiet(page);
  expect(await page.evaluate(() => window.S.day)).toBe(C.planDate);

  await page.fill('#inName', client.name);
  await page.fill('#inPhone', client.phone);
  await page.fill('#inHouse', client.house);
  await page.fill('#inFlat', client.flat);
  await page.evaluate(({ city, street }) => {
    Object.assign(window.S.intake, { city, street, svcs: ['wv'], time: 12 });
    window.render();
  }, { city: C.city, street: client.street });
  await page.click('button[onclick="createReq()"]');
  await until(page, () => window.S.intake.name === '', null, 30_000);
  await quiet(page);

  const sv = await apiAs(BOT.login, BOT.password);
  const { requests } = (await sv.get(`/api/requests?phone=${encodeURIComponent(client.phone)}`)).body;
  expect(requests.length, 'заявка записана в базу').toBe(1);
  expect(requests[0].date).toBe(C.planDate);
  expect(requests[0].city).toBe(C.city);
  expect(requests[0].svcs).toEqual(['wv']);
  expect(requests[0].operator_id).toBe(C.op.id);
  expect(requests[0].status).toBe('создана');
  await sv.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('повторная заявка на тот же адрес и дату: система предупреждает о дубле, вторая запись не появляется', async ({ page }) => {
  await signIn(page, C.op.login, C.op.password);
  await page.evaluate((ds) => window.pickDay(ds), C.planDate);
  await quiet(page);
  // По известному номеру экран поднимает карточку клиента и историю.
  await page.fill('#inPhone', client.phone);
  await page.waitForSelector('.known', { timeout: 20_000 });
  await page.fill('#inName', client.name);
  await page.fill('#inHouse', client.house);
  await page.fill('#inFlat', client.flat);
  await page.evaluate(({ city, street }) => {
    Object.assign(window.S.intake, { city, street, svcs: ['wv'], time: 12 });
    window.render();
  }, { city: C.city, street: client.street });
  await page.click('button[onclick="createReq()"]');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => !!window.S.dupAsk), 'первое нажатие — предупреждение о дубле').toBe(true);

  const sv = await apiAs(BOT.login, BOT.password);
  const { requests } = (await sv.get(`/api/requests?phone=${encodeURIComponent(client.phone)}`)).body;
  expect(requests.length, 'заявка по-прежнему одна').toBe(1);
  await sv.close();
});

test('дата, ушедшая под маршруты, оператору закрыта, а руководителю открыта', async () => {
  const op = await apiAs(C.op.login, C.op.password);
  const sv = await apiAs(BOT.login, BOT.password);
  const day = (await op.get(`/api/days/${C.today}`)).body;
  const body = {
    date: C.today, name: 'Замок Д. Д.', phone: fakePhone(), city: C.city, street: 'Мира', house: '1', svcs: ['wv'],
  };
  if (day.lock) {
    const denied = await op.post('/api/requests', body);
    expect(denied.status, 'оператору приём по закрытой дате запрещён').toBe(422);
    expect(denied.body.reason).toBe('lock');
  }
  const allowed = await sv.post('/api/requests', body);
  expect(allowed.ok, 'руководитель ставит адрес и в закрытую дату').toBe(true);
  await op.close();
  await sv.close();
});
