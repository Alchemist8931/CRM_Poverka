/* Вход, сессия и доступ по ролям.
 *
 * Пароль хранится хешем scrypt (он есть в самом Node, отдельной библиотеки для
 * этого заводить незачем). Сессия — подписанная cookie: в ней идентификатор
 * сотрудника и срок, подпись HMAC поверх. Состояния на сервере сессия не держит,
 * поэтому её переживает перезапуск и не ломает второй экземпляр за балансировщиком.
 *
 * Блокировка при этом работает мгновенно: роль и `blocked_at` читаются из базы на
 * каждый запрос, а не берутся из cookie. Цена решения — выход с одного устройства
 * не гасит сессии на других; полноценный список сессий и второй фактор — пункт
 * cloud-sec, выдача и сброс паролей — be-users.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '../rules.ts';
import { ApiError } from './errors.ts';

export { hashPassword, verifyPassword } from '../password.ts';

export const SESSION_COOKIE = 'uchetkin_session';
/** Смена длиннее рабочего дня не бывает, но оператор открывает CRM утром и
 *  закрывает вечером — двенадцати часов хватает, чтобы не перелогиниваться среди дня. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Ключ подписи сессий. В облаке лежит в Lockbox и приходит переменной окружения;
 *  на машине разработчика — значение по умолчанию, и о нём сервер говорит вслух. */
export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET не задан или короче 16 знаков — в рабочем контуре сервер так не поднимается.');
  }
  return 'dev-secret-uchetkin-не-для-рабочего-контура';
}

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** `идентификатор.срок.подпись` — всё, что нужно, чтобы узнать человека. */
export function makeSession(staffId: string, secret: string, now = Date.now()): string {
  const payload = `${staffId}.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function readSession(token: string | undefined, secret: string, now = Date.now()): string | null {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expected = sign(payload, secret);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const [staffId, expires] = payload.split('.');
  if (!staffId || !expires || Number(expires) < now) return null;
  return staffId;
}

/** Кто пришёл. Роль и имя берутся из базы на каждый запрос. */
export interface User {
  id: string;
  role: Role;
  full_name: string;
  must_change_password: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

/** Сессия обязательна. Без неё — 401 и понятный текст, а не пустой отказ. */
export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new ApiError(401, 'Нужен вход в систему.');
  return req.user;
}

/** Роль из списка. Тексты отказов такие, чтобы человек понял, что делать дальше. */
export function requireRole(req: FastifyRequest, ...roles: Role[]): User {
  const user = requireUser(req);
  if (!roles.includes(user.role)) {
    throw new ApiError(403, `Действие доступно ролям: ${roles.join(', ')}. Ваша роль — ${user.role}.`);
  }
  return user;
}

/** Cookie сессии: httpOnly, чтобы её не достал скрипт со страницы, и Secure за
 *  балансировщиком — по HTTP CRM работает только на машине разработчика. */
export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
