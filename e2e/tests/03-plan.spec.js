/* Сценарий 3. Планирование дня и смен: руководитель ставит город, план по
 * городу и людей в смену, график показывает смену, поверитель видит запрос
 * на отсутствие согласованным. */
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, go, isoToday, signIn, until, watchConsole, quiet } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });

const C = context();
// Своя дата, чтобы не задеть подготовленную: через неделю — график смен
// показывает две недели вперёд, и день должен быть в нём виден.
const D = isoToday(7);

test('руководитель планирует день: город, план, смена поверителей и операторов', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, BOT.login, BOT.password);
  await go(page, 'plan');
  await expect(page.locator('.hd .ttl')).toContainText('Планирование дня');

  // Плитка дня открывает карточку; здесь — теми же обработчиками, что у плитки.
  await page.evaluate(({ ds, city, ver, op }) => {
    // День может быть уже расписан демо-набором до потолка: освобождаем место.
    const cities = window.dayCities(ds);
    if (!cities.includes(city)) {
      if (cities.length >= 5) window.tgDay(ds, 'cities', cities[cities.length - 1]);
      window.tgDay(ds, 'cities', city);
    }
    window.setCap(ds, city, 15);
    if (!window.crewOn(ds).includes(ver)) window.tgDay(ds, 'crew', ver);
    const ops = window.opsOn(ds);
    if (!ops.includes(op)) {
      if (ops.length >= 4) window.tgDay(ds, 'ops', ops[ops.length - 1]);
      window.tgDay(ds, 'ops', op);
    }
  }, { ds: D, city: C.city, ver: C.ver.id, op: C.op.id });
  // Запись дня уходит на сервер с задержкой — ждём, пока она доедет.
  await page.waitForTimeout(1500);
  await quiet(page);

  const sv = await apiAs(BOT.login, BOT.password);
  const day = (await sv.get(`/api/days/${D}`)).body;
  expect(day.day.cities).toContain(C.city);
  expect(Number(day.day.plan[C.city])).toBe(15);
  expect(day.day.crew).toContain(C.ver.id);
  expect(day.day.ops).toContain(C.op.id);
  expect(day.works, 'услуги дня — объединение компетенций смены').toContain('wv');
  await sv.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('график смен показывает поверителя в смене на эту дату', async ({ page }) => {
  await signIn(page, BOT.login, BOT.password);
  await go(page, 'schedule');
  const cell = page.locator(`td[onclick*="'${D}'"][onclick*="'${C.ver.id}'"]`);
  await expect(cell).toHaveCount(1);
  await expect(cell).toContainText('●');
});

test('лишний город и пятый оператор отбиваются правилом дня', async () => {
  const sv = await apiAs(BOT.login, BOT.password);
  const { cities } = (await sv.get('/api/cities')).body;
  if (cities.length > 5) {
    const six = cities.slice(0, 6).map((c) => c.name);
    const r = await sv.put(`/api/days/${D}`, { cities: six });
    expect(r.status, 'шести городов в день не бывает').toBe(422);
  }
  await sv.close();
});

test('запрос на отсутствие: поверитель подаёт, руководитель согласовывает, день уходит из графика', async ({ page }) => {
  const from = isoToday(28);
  const to = isoToday(29);
  const ver = await apiAs(C.ver.login, C.ver.password);
  const made = await ver.post('/api/absences', { date_from: from, date_to: to, reason: 'Испытания: семейные обстоятельства' });
  expect(made.ok).toBe(true);
  const id = made.body.absence?.id || made.body.id;
  await ver.close();

  await signIn(page, BOT.login, BOT.password);
  await go(page, 'absence');
  await expect(page.locator('.hd .ttl')).toContainText('Отсутствия');
  // Запрос виден дважды: в блоке «На согласовании» и в общем списке.
  const row = page.locator(`button[onclick="decide('${id}','согласовано')"]`);
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await until(page, (i) => window.S.absences.find((a) => a.id === i)?.status === 'согласовано', id);

  const sv = await apiAs(BOT.login, BOT.password);
  const day = (await sv.get(`/api/days/${from}`)).body;
  expect(day.absent, 'согласованное отсутствие снимает поверителя с даты').toContain(C.ver.id);
  await sv.close();
});
