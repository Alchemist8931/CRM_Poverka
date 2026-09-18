/* Сценарий заведения сотрудника — по инструкции администратора, раздел 1,
 * от начала до конца и только теми нажатиями, что в ней описаны.
 *
 *   node with-stand.mjs check-admin-flow.mjs     # код 0 — сценарий пройден
 *
 * Ни одного вызова внутренних функций интерфейса: только кнопки и поля с теми
 * подписями, что названы в инструкции. Если подпись изменится — сценарий
 * упадёт, и инструкцию придётся править вместе с экраном. */
import { DESKTOP, chromium, newContext, openLogin, quiet, standBase } from './lib.mjs';

const base = standBase();
const browser = await chromium.launch();
const step = (n, what) => console.log(`  шаг ${n}: ${what}`);
const fail = (what) => { throw new Error('Не по инструкции: ' + what); };

try {
  const ctx = await newContext(browser, base, DESKTOP);
  const page = await ctx.newPage();

  step(1, 'вход руководителя, экран «Сотрудники»');
  await openLogin(page);
  await page.fill('form.login input[name=login]', 'sv');
  await page.fill('form.login input[name=pw]', '1234');
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForFunction(() => window.S?.auth === true, null, { timeout: 30_000 });
  await quiet(page);
  await page.locator('.rail button.nb[title^="Сотрудники"]').click();
  await quiet(page);
  if (!(await page.locator('.hd .ttl b', { hasText: 'Сотрудники' }).count())) fail('экран «Сотрудники» не открылся');

  step(2, '«Новый сотрудник»');
  await page.getByRole('button', { name: 'Новый сотрудник' }).click();
  await page.waitForSelector('#us-name');

  const tag = Date.now().toString(36).slice(-5);
  const login = `novichok.${tag}`;
  step(3, 'ФИО');
  await page.fill('#us-name', 'Новичкова Е. П.');
  step(4, 'роль — из выпадающего списка');
  await page.locator('.sel:has(button[onclick*="us-crole"]) button.fld').click();
  await page.locator('.pop .o', { hasText: 'поверитель' }).click();
  await quiet(page);
  step(5, 'телефон');
  await page.fill('#us-phone', '+7 (912) 555-66-77');
  step(6, 'почта и логин');
  await page.fill('#us-email', `${login}@example.ru`);
  await page.fill('#us-login', login);
  step(7, 'график — оставлен 5/2, отсчёт — сегодня');
  step(8, 'компетенции поверителя');
  await page.locator('.tgls.sk .tgl', { hasText: 'Поверка воды' }).click();
  await page.locator('.tgls.sk .tgl', { hasText: 'Поверка тепла' }).click();
  await quiet(page);

  step(9, '«Выдать учётную запись» → блок «Учётная запись выдана»');
  await page.getByRole('button', { name: 'Выдать учётную запись' }).click();
  await page.waitForSelector('#us-pw', { timeout: 30_000 });
  if (!(await page.locator('h3', { hasText: 'Учётная запись выдана' }).count())) fail('нет блока «Учётная запись выдана»');
  const temp = await page.inputValue('#us-pw');
  if (temp.length < 8) fail('временный пароль короче 8 знаков');

  step(10, '«Скопировать»');
  await page.getByRole('button', { name: 'Скопировать' }).click();
  step(11, '«Пароль передан, закрыть» → отметка «временный пароль» в списке');
  await page.getByRole('button', { name: 'Пароль передан, закрыть' }).click();
  await quiet(page);
  if (await page.locator('#us-pw').count()) fail('пароль остался на экране после закрытия');
  const row = page.locator('tr.ln', { hasText: 'Новичкова Е. П.' }).first();
  if (!(await row.locator('.tg', { hasText: 'временный пароль' }).count())) fail('в строке нет отметки «временный пароль»');
  await ctx.close();

  step(12, 'первый вход сотрудника: временный пароль → «Придумайте свой пароль» → свой пароль → экраны роли');
  const ctx2 = await newContext(browser, base, DESKTOP);
  const p2 = await ctx2.newPage();
  await openLogin(p2);
  await p2.fill('form.login input[name=login]', login);
  await p2.fill('form.login input[name=pw]', temp);
  await p2.getByRole('button', { name: 'Войти' }).click();
  await p2.waitForSelector('form.login h1:has-text("Придумайте свой пароль")', { timeout: 30_000 });
  await p2.fill('input[name=cur]', temp);
  await p2.fill('input[name=pw]', 'Svoj-parol-2026!');
  await p2.fill('input[name=pw2]', 'Svoj-parol-2026!');
  await p2.getByRole('button', { name: 'Сменить пароль' }).click();
  await p2.waitForSelector('.app', { timeout: 30_000 });
  await quiet(p2);
  const title = await p2.locator('.hd .ttl b').textContent();
  if (title.trim() !== 'Мой маршрут') fail(`после смены пароля открылся «${title}», а не экран поверителя`);
  await ctx2.close();

  step(13, 'проверка: в списке «Сотрудники» состояние «в работе»');
  const ctx3 = await newContext(browser, base, DESKTOP);
  const p3 = await ctx3.newPage();
  await openLogin(p3);
  await p3.fill('form.login input[name=login]', 'sv');
  await p3.fill('form.login input[name=pw]', '1234');
  await p3.getByRole('button', { name: 'Войти' }).click();
  await p3.waitForFunction(() => window.S?.auth === true, null, { timeout: 30_000 });
  await quiet(p3);
  await p3.locator('.rail button.nb[title^="Сотрудники"]').click();
  await quiet(p3);
  const row3 = p3.locator('tr.ln', { hasText: 'Новичкова Е. П.' }).first();
  if (!(await row3.locator('.tg', { hasText: 'в работе' }).count())) fail('после первого входа состояние не «в работе»');
  await ctx3.close();
  console.log('Сценарий заведения сотрудника пройден по инструкции: 13 шагов, логин ' + login);
} finally {
  await browser.close();
}
