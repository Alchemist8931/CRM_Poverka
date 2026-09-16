/* Вход, выход и «кто я». */
import type { FastifyPluginAsync } from 'fastify';
import { ApiError } from '../errors.ts';
import {
  clearSessionCookie, makeSession, requireUser, setSessionCookie, verifyPassword,
} from '../auth.ts';

const plugin: FastifyPluginAsync = async (app) => {
  const secret = app.sessionSecret;

  app.post('/auth/login', {
    schema: {
      tags: ['вход'],
      summary: 'Вход по логину и паролю, сессия кладётся в httpOnly-cookie',
      body: {
        type: 'object',
        required: ['login', 'password'],
        properties: { login: { type: 'string' }, password: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { login, password } = req.body as { login: string; password: string };
    const { rows } = await app.db.query<{
      id: string; role: string; full_name: string; password_hash: string | null;
      must_change_password: boolean; blocked_at: string | null;
    }>('SELECT id, role, full_name, password_hash, must_change_password, blocked_at FROM staff WHERE lower(login) = lower($1)',
      [login]);
    const row = rows[0];
    // Один и тот же текст на «нет такого логина» и «пароль не тот»: иначе по
    // ответу можно перебором узнать, какие учётки в компании есть.
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new ApiError(401, 'Неверный логин или пароль.');
    }
    // Про блокировку говорим только тому, кто пароль всё-таки знает.
    if (row.blocked_at) throw new ApiError(403, 'Учётная запись заблокирована — обратитесь к руководителю.');

    setSessionCookie(reply, makeSession(row.id, secret));
    await app.db.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, ip, user_agent)
       VALUES ($1, $2, 'вход', 'staff', $1, $3, $4)`,
      [row.id, row.role, req.ip, req.headers['user-agent'] ?? null]);

    return {
      user: {
        id: row.id, role: row.role, full_name: row.full_name,
        must_change_password: row.must_change_password,
      },
    };
  });

  app.post('/auth/logout', {
    schema: { tags: ['вход'], summary: 'Выход: cookie сессии снимается' },
  }, async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', {
    schema: { tags: ['вход'], summary: 'Текущий сотрудник и его роль', security: [{ session: [] }] },
  }, async (req) => ({ user: requireUser(req) }));
};

export default plugin;
