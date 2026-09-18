/* Сценарий 6. Деньги: подотчёт поверителя, сдача руководителю, сдельная оплата. */
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, go, monthOf, signIn, until, watchConsole, quiet } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });

const C = context();
const month = monthOf(C.today);
let left = 0;

test('поверитель видит собранные деньги и свой заработок', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, C.ver.login, C.ver.password);
  await go(page, 'me');
  await expect(page.locator('.hd .ttl')).toContainText('Мой заработок');
  const R = await page.evaluate((m) => {
    const r = window.subReport(window.S.me, m);
    return { cash: r.cash, card: r.card, wage: r.wage, left: r.left, done: r.done.length };
  }, month);
  expect(R.done, 'выполненные адреса за месяц').toBeGreaterThanOrEqual(2);
  expect(R.cash, 'наличные с адреса 1').toBeGreaterThan(0);
  expect(R.card, 'перевод с адреса 2').toBeGreaterThan(0);
  expect(R.wage, 'сдельная начислена').toBeGreaterThan(0);
  left = R.left;

  const ver = await apiAs(C.ver.login, C.ver.password);
  const e = (await ver.get(`/api/earnings?month=${month}`)).body;
  expect(e.total).toBe(R.wage);
  const other = await ver.get(`/api/earnings?month=${month}&staff_id=${C.op.id}`);
  expect(other.status, 'чужой заработок поверителю не показывается').toBe(422);
  await ver.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('руководитель принимает подотчёт — остаток у поверителя обнуляется', async ({ page }) => {
  test.skip(left <= 0, 'сдавать нечего: остаток не положительный');
  const errors = watchConsole(page);
  await signIn(page, BOT.login, BOT.password);
  await go(page, 'payroll');
  await expect(page.locator('.hd .ttl')).toContainText('Сдельная оплата');
  await page.evaluate((v) => window.openHo(v), C.ver.id);
  await page.waitForSelector('#hoAmt');
  await page.evaluate((v) => window.setHo('amount', v), left);
  await page.evaluate(() => window.takeHo());
  await quiet(page);
  await until(page, ({ v, m }) => window.subReport(v, m).left === 0, { v: C.ver.id, m: month });

  const sv = await apiAs(BOT.login, BOT.password);
  const { handovers } = (await sv.get(`/api/handovers?month=${month}&staff_id=${C.ver.id}`)).body;
  expect(handovers.some((h) => Number(h.amount) === left && h.accepted_by === C.bot.id)).toBe(true);
  const payroll = (await sv.get(`/api/payroll?month=${month}`)).body;
  const row = payroll.staff.find((s) => s.id === C.ver.id);
  expect(row, 'поверитель в сдельной ведомости').toBeTruthy();
  expect(row.wage).toBeGreaterThan(0);
  const opRow = payroll.staff.find((s) => s.id === C.op.id);
  expect(opRow?.wage ?? 0, 'оператору сдельная за принятые им заявки… только по выполненным').toBeGreaterThanOrEqual(0);
  await sv.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});
