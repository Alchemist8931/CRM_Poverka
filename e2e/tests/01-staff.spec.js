/* Сценарий 1. Руководитель заводит сотрудника, сотрудник входит первый раз и
 * меняет пароль. Плюс замок входа после пяти неудачных попыток и сброс пароля.
 *
 * Учётка одноразовая, с меткой прогона: уволить её нельзя (учётки не удаляются),
 * поэтому в конце она блокируется — как уволенный сотрудник. */
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, go, signIn, until, watchConsole, quiet } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });

const C = context();
const login = `uat.new-${C.run}`;
const name = `Новичок ${C.run.toUpperCase()}`;
let temp = '';
let staffId = '';
const fresh = 'Novyj-parol-2026!';

test('руководитель заводит оператора на экране «Сотрудники» и получает временный пароль', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, BOT.login, BOT.password);
  await go(page, 'staff');
  await expect(page.locator('.hd .ttl')).toContainText('Сотрудники');

  await page.getByRole('button', { name: 'Новый сотрудник' }).click();
  await page.fill('#us-name', name);
  await page.evaluate(() => window.pick('us-crole', 'operator'));
  await page.fill('#us-login', login);
  await page.fill('#us-email', `${login}@uchetkin.local`);
  await page.fill('#us-phone', '+7 (900) 000-00-01');
  await page.getByRole('button', { name: 'Выдать учётную запись' }).click();

  // Временный пароль показывается один раз — в этом блоке.
  await page.waitForSelector('#us-pw', { timeout: 30_000 });
  temp = await page.inputValue('#us-pw');
  expect(temp.length).toBeGreaterThanOrEqual(8);
  await page.evaluate(() => window.usPwOk());
  await quiet(page);

  const row = await page.evaluate((l) => window.S.staff.find((p) => (p.login || '') === l), login);
  expect(row, 'карточка появилась в справочнике').toBeTruthy();
  staffId = row.id;
  await expect(page.locator(`tr.ln[onclick="usOpen('${staffId}')"]`)).toContainText('временный пароль');
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('первый вход: система требует сменить пароль, после смены открывается приём заявок', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, login, temp);
  // Форма смены пароля показана принудительно: кнопки «Назад» нет.
  await expect(page.locator('form.login h1')).toContainText('Придумайте свой пароль');
  await expect(page.locator('button[onclick="pwBack()"]')).toHaveCount(0);

  // Короткий пароль не принимается ещё в браузере.
  await page.fill('input[name=cur]', temp);
  await page.fill('input[name=pw]', 'korotkij');
  await page.fill('input[name=pw2]', 'korotkij');
  await page.click('form.login button.b.wide');
  await expect(page.locator('form.login h1')).toContainText('Придумайте свой пароль');

  await page.fill('input[name=pw]', fresh);
  await page.fill('input[name=pw2]', fresh);
  await page.click('form.login button.b.wide');
  await page.waitForSelector('.app', { timeout: 30_000 });
  await until(page, () => window.S.mustChange === false && window.S.role === 'operator');
  await quiet(page);
  await expect(page.locator('.hd .ttl')).toContainText('Приём заявки');
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('временный пароль больше не работает, новый — работает', async () => {
  await expect(apiAs(login, temp)).rejects.toThrow(/401/);
  const me = await apiAs(login, fresh);
  expect(me.me.must_change_password).toBe(false);
  await me.close();
});

test('пять неверных паролей подряд закрывают вход, сброс руководителем открывает его', async () => {
  const bad = [];
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${C.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password: 'ne-tot-parol-' + i }),
    });
    bad.push(r.status);
  }
  expect(bad.slice(0, 4)).toEqual([401, 401, 401, 401]);
  expect(bad[4], 'пятая попытка отвечает про замок').toBe(403);
  // И верный пароль теперь не пускает.
  await expect(apiAs(login, fresh)).rejects.toThrow(/403/);

  const sv = await apiAs(BOT.login, BOT.password);
  const reset = await sv.post(`/api/staff/${staffId}/password/reset`);
  expect(reset.ok).toBe(true);
  const again = await apiAs(login, reset.body.temporary_password);
  expect(again.me.must_change_password).toBe(true);
  await again.close();

  // Увольнение — блокировка: вход закрыт, карточка остаётся в истории.
  const blocked = await sv.patch(`/api/staff/${staffId}`, { blocked: true });
  expect(blocked.ok).toBe(true);
  await expect(apiAs(login, reset.body.temporary_password)).rejects.toThrow(/403/);
  await sv.close();
});
