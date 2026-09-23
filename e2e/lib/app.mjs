/* Общее для сценариев: вход, ожидание экрана, доступ к API от имени сотрудника,
 * контекст прогона из global-setup.
 *
 * Сценарии ходят в приложение двумя путями. Через браузер — там, где важно,
 * что видит и нажимает человек. Через API — чтобы подготовить данные и сверить,
 * что легло в базу: экран показывает срез, а проверять надо факт. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request as pwRequest } from '@playwright/test';

export const BASE = (process.env.UAT_BASE_URL || 'https://uchetkin.ru').replace(/\/$/, '');
export const BOT = {
  login: process.env.UAT_LOGIN || 'autotest',
  password: process.env.UAT_PASSWORD || '',
};
/** Пароль, который получают учётки uat.op и uat.ver после смены временного. */
export const STAFF_PASSWORD = process.env.UAT_STAFF_PASSWORD || 'Ispytaniya-2026!';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CONTEXT_FILE = ROOT + '.run/context.json';

/** Что подготовил global-setup: учётки, город, даты, услуги. */
export const context = () => JSON.parse(readFileSync(CONTEXT_FILE, 'utf8'));

/* ── даты ─────────────────────────────────────────────────────── */

/** Даты считаем по Екатеринбургу — так же, как сервер (TZ контура). */
export function isoToday(offsetDays = 0) {
  const now = new Date(Date.now() + 5 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);
}
export const monthOf = (iso) => iso.slice(0, 7);

/* ── уникальные значения прогона ─────────────────────────────── */

const seed = Date.now();
let n = 0;
/** Вымышленный номер: 9 плюс девять цифр из времени и счётчика — дважды не повторится. */
export function fakePhone() {
  const digits = String(seed % 1_000_000_00).padStart(8, '0') + String(++n % 10);
  return '+7 (9' + digits.slice(0, 2) + ') ' + digits.slice(2, 5) + '-' + digits.slice(5, 7) + '-' + digits.slice(7, 9);
}
export const runTag = () => seed.toString(36);

/* ── API ──────────────────────────────────────────────────────── */

/** Сессия сотрудника для запросов к API: cookie хранится в контексте Playwright. */
export async function apiAs(login, password) {
  const ctx = await pwRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const res = await ctx.post('/api/auth/login', { data: { login, password } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`Вход ${login} в ${BASE}: ${res.status()} ${text}`);
  const call = (method) => async (path, data) => {
    const r = await ctx.fetch(path, { method, data, headers: data === undefined ? {} : { 'content-type': 'application/json' } });
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* не JSON — файл или пусто */ }
    return { status: r.status(), ok: r.ok(), body: json, text: body, headers: r.headers() };
  };
  return {
    me: JSON.parse(text).user,
    get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH'), del: call('DELETE'),
    ctx,
    close: () => ctx.dispose(),
  };
}

/** Ответ обязан быть успешным — иначе сценарий падает с телом ответа в тексте. */
export function must(res, what) {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${res.text.slice(0, 300)}`);
  return res.body;
}

/* ── браузер ──────────────────────────────────────────────────── */

/** Экран собран, когда загрузка не идёт: полоса появляется через такт после
 *  перехода, и без паузы проверка увидела бы прежний экран. */
export async function quiet(page) {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => (window.S?.loading || 0) === 0, null, { timeout: 60_000 });
  await page.waitForTimeout(200);
}

/** Вход через форму. Сессия живёт в cookie, метка «уже входили» — в localStorage:
 *  без чистки обеих вкладка откроется прежним сотрудником. */
export async function signIn(page, login, password) {
  await page.context().clearCookies();
  await page.goto('/', { waitUntil: 'load' });
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* приватный режим */ } });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('form.login');
  await page.fill('form.login input[name=login]', login);
  await page.fill('form.login input[name=pw]', password);
  await page.click('form.login button');
  await page.waitForFunction(() => window.S?.auth === true, null, { timeout: 30_000 });
  await quiet(page);
}

export async function go(page, view) {
  await page.evaluate((v) => window.go(v), view);
  await quiet(page);
}

/** Ошибки консоли: их не должно быть ни на одном экране. Неудавшиеся запросы
 *  при потере связи — не в счёт, их браузер пишет сам. */
export function watchConsole(page) {
  const errors = [];
  const noise = (t) => /favicon|Failed to (load resource|fetch)|net::ERR_/i.test(t);
  page.on('console', (m) => {
    if (m.type() === 'error' && !noise(m.text()) && !noise(m.location()?.url || '')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

/** Ждать, пока состояние вкладки не станет таким, как нужно. */
export const until = (page, fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout });
