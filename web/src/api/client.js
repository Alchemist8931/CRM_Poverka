/* Разговор с сервером.
 *
 * Единственное место, где фронт ходит в сеть. Отсюда же поднимается и снимается
 * слой «нет связи»: запрос, не доехавший до сервера, — это и есть потеря связи,
 * а любой ответ (пусть даже 422) означает, что связь есть. Отдельный опрос
 * /health в net.js нужен только чтобы заметить восстановление, когда никто
 * ничего не нажимает.
 */

import { API_BASE } from './mode.js';
import { NET } from '../net.js';

/** Ответ сервера с человеческим текстом: его же прототип показывал подсказкой. */
export class ApiError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
  /** Сетевой обрыв: сервер не ответил вовсе. */
  get offline() { return this.status === 0; }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    NET.down();
    throw new ApiError(0, 'net', 'Нет связи с сервером.');
  }
  NET.up();
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  // 422 — это отказ правила: текст писался для оператора, его и показываем.
  throw new ApiError(res.status, data?.reason ?? null,
    data?.error || data?.message || `Сервер ответил ${res.status}.`);
}

/** Путь с параметрами: `q('/requests', {date, city})`. Пустые значения выбрасываются. */
export function q(path, params = {}) {
  const usable = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!usable.length) return path;
  return `${path}?${new URLSearchParams(usable).toString()}`;
}

export const api = {
  get: (path) => call('GET', path),
  post: (path, body) => call('POST', path, body ?? {}),
  put: (path, body) => call('PUT', path, body ?? {}),
  patch: (path, body) => call('PATCH', path, body ?? {}),
  del: (path) => call('DELETE', path),
};
