/* Общее для скриншотов и видео инструкций: браузер, вход, ожидание экрана. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export const here = fileURLToPath(new URL('.', import.meta.url));
export const root = join(here, '..', '..');
const require = createRequire(join(root, 'e2e', 'package.json'));
export const { chromium } = require('playwright');

/** Адрес стенда — из .stand.json, который пишет stand.mjs. */
export function standBase() {
  if (process.env.STAND_BASE) return process.env.STAND_BASE;
  try { return JSON.parse(readFileSync(join(here, '.stand.json'), 'utf8')).base; }
  catch { throw new Error('Стенд не поднят: cd docs/train && node stand.mjs'); }
}

export const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25 };
export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

export async function newContext(browser, base, opts = {}) {
  return browser.newContext({ baseURL: base, locale: 'ru-RU', timezoneId: 'Asia/Yekaterinburg', ...opts });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Экран собран, когда загрузка не идёт. */
export async function quiet(page) {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => (window.S?.loading || 0) === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(250);
}

/** Открыть форму входа чистой вкладкой, без сессии. */
export async function openLogin(page) {
  await page.context().clearCookies();
  await page.goto('/', { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* приватный режим */ } });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('form.login');
  await page.waitForTimeout(300);
}

/** Вход через форму — теми же полями, что нажимает человек. */
export async function signIn(page, login, password, { slow = 0 } = {}) {
  await openLogin(page);
  await page.fill('form.login input[name=login]', login);
  if (slow) await sleep(slow);
  await page.fill('form.login input[name=pw]', password);
  if (slow) await sleep(slow);
  await page.click('form.login button');
  await page.waitForFunction(() => window.S?.auth === true, null, { timeout: 30_000 });
  await quiet(page);
}

/** Перейти на экран роли по имени страницы. */
export async function go(page, view) {
  await page.evaluate((v) => window.go(v), view);
  await quiet(page);
}

/** Нажать кнопку меню (рельса слева или панель снизу) по её подсказке. */
export async function nav(page, title) {
  await page.locator(`.rail button.nb[title^="${title}"]`).first().click();
  await quiet(page);
}

/** Карточка (.c), в которой лежит заголовок h3 с этим текстом. */
export const card = (page, h3) => page.locator('.c', { has: page.locator(`h3:has-text("${h3}")`) }).first();

/** Запрос к API от имени сотрудника (cookie сессии — в контексте страницы). */
export async function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch { /* не JSON */ }
    return { status: r.status, ok: r.ok, body: j, text: t };
  }, { method, path, body });
}

/** Сегодня по Екатеринбургу — как считает сервер и вкладка. */
export function isoToday(offsetDays = 0) {
  const now = new Date(Date.now() + 5 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}
