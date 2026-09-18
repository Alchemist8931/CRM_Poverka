/* Вход, выход и «кто я». */
import type { FastifyPluginAsync } from 'fastify';
import { ApiError } from '../errors.ts';
import {
  clearSessionCookie, makeSession, requireUser, setSessionCookie, verifyPassword,
  LOGIN_FAIL_LIMIT, LOGIN_LOCK_MS, lockMinutesLeft,
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
      failed_logins: number; locked_until: string | null;
    }>(`SELECT id, role, full_name, password_hash, must_change_password, blocked_at,
               failed_logins, locked_until
          FROM staff WHERE lower(login) = lower($1)`, [login]);
    const row = rows[0];

    /* Подбор пароля упирается не в состав знаков, а в число попыток: пять подряд
       закрывают вход на четверть часа. Про сам замок говорим прямо — человек,
       который просто забыл пароль, должен понимать, почему верный пароль вдруг
       перестал пускать, и сколько ждать. Перебирающему это знание не помогает:
       ждать ему всё равно придётся. */
    if (row?.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      throw new ApiError(403,
        `Вход закрыт после ${LOGIN_FAIL_LIMIT} неудачных попыток подряд. `
        + `Попробуйте через ${lockMinutesLeft(row.locked_until)} мин или попросите руководителя сбросить пароль.`,
        'locked');
    }

    // Один и тот же текст на «нет такого логина» и «пароль не тот»: иначе по
    // ответу можно перебором узнать, какие учётки в компании есть.
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      if (row) {
        // Счётчик ведётся в базе, а не в памяти процесса: за балансировщиком
        // экземпляров два, и «пять попыток» должны быть общими на оба.
        const fails = (row.failed_logins ?? 0) + 1;
        const until = fails >= LOGIN_FAIL_LIMIT ? new Date(Date.now() + LOGIN_LOCK_MS).toISOString() : null;
        await app.db.query(
          `UPDATE staff SET failed_logins = $2, locked_until = $3, updated_at = now() WHERE id = $1`,
          [row.id, until ? 0 : fails, until]);
        // Попытка, которой замок и защёлкнулся, отвечает про замок: иначе
        // человек ещё трижды введёт верный пароль, прежде чем поймёт, что дело
        // уже не в пароле.
        if (until) {
          throw new ApiError(403,
            `Вход закрыт после ${LOGIN_FAIL_LIMIT} неудачных попыток подряд. `
            + `Попробуйте через ${lockMinutesLeft(until)} мин или попросите руководителя сбросить пароль.`,
            'locked');
        }
      }
      throw new ApiError(401, 'Неверный логин или пароль.');
    }
    // Про блокировку говорим только тому, кто пароль всё-таки знает.
    if (row.blocked_at) throw new ApiError(403, 'Учётная запись заблокирована — обратитесь к руководителю.');

    if (row.failed_logins || row.locked_until) {
      await app.db.query(
        'UPDATE staff SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [row.id]);
    }
    setSessionCookie(reply, makeSession(row.id, secret));
    // Вход, выход и неудачная попытка входа попадают в журнал сами: их пишет
    // промежуточный слой (`src/api/audit.ts`), и для этого ему нужен ответ —
    // на входе человек ещё не известен по сессии, его называет как раз он.
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
