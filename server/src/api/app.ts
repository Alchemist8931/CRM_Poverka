/* Сборка приложения.
 *
 * Приложение собирается вокруг переданного соединения с базой и ничего не знает
 * о том, как оно устроено: в работе это пул `pg`, в тестах — PostgreSQL,
 * собранный в WebAssembly. Из-за этого весь API проверяется без Docker и без
 * сети (`test/api.test.ts` ходит через `app.inject()`).
 */
import fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import type { Db } from './db.ts';
import { ApiError } from './errors.ts';
import { SESSION_COOKIE, readSession, sessionSecret, type User } from './auth.ts';
import authRoutes from './routes/auth.ts';
import refRoutes from './routes/refs.ts';
import planRoutes from './routes/plan.ts';
import requestRoutes from './routes/requests.ts';
import routeRoutes from './routes/routes.ts';
import actRoutes from './routes/act.ts';
import moneyRoutes from './routes/money.ts';
import callRoutes from './routes/calls.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** Ключ подписи сессий: один на приложение, чтобы вход и проверка cookie
     *  не разъехались (в тестах он свой, в облаке приходит из Lockbox). */
    sessionSecret: string;
  }
  interface FastifyRequest {
    /** Тело запроса как оно пришло. Нужно вебхуку телефонии: подпись считается
     *  по байтам, а не по пересобранному JSON. */
    rawBody?: string;
  }
}

export interface AppOptions {
  db: Db;
  secret?: string;
  logger?: boolean;
}

/** Открытые входы: до них сессия не спрашивается. */
const PUBLIC = new Set(['/health', '/docs', '/api/auth/login', '/api/webhooks/novofon']);

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: opts.logger ?? false,
    // Тело запроса приходит с формы: числа в строках, пустые поля строками.
    // Приведение типов включено, иначе половина полей отваливалась бы на схеме.
    ajv: { customOptions: { coerceTypes: true, allErrors: false, removeAdditional: false } },
  });
  const secret = opts.secret ?? sessionSecret();

  app.decorate('db', opts.db);
  app.decorate('sessionSecret', secret);

  // Разбор JSON с сохранением сырого тела: по нему вебхук телефонии проверяет подпись.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = String(body);
    try {
      done(null, body ? JSON.parse(String(body)) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'CRM «Учёткин» — API',
        description:
          'Серверная часть CRM поверки счётчиков. Бизнес-правила перенесены из прототипа без ' +
          'изменения смысла и лежат в `src/rules.ts`. Вход — логин и пароль, сессия хранится ' +
          'в httpOnly-cookie `uchetkin_session`, роль берётся из карточки сотрудника на каждый запрос.',
        version: '1.0.0',
      },
      tags: [
        { name: 'служебное', description: 'состояние сервера и описание API' },
        { name: 'вход', description: 'сессия и роль' },
        { name: 'справочники', description: 'города, услуги, приборы, сотрудники' },
        { name: 'планирование', description: 'день: города, план, смены; отсутствия' },
        { name: 'заявки', description: 'приём, правка, перенос, подсказка дат' },
        { name: 'маршруты', description: 'сборка, обзвон, точки, чат' },
        { name: 'акт', description: 'приборы, закрытие и возврат позиции, лист ожидания' },
        { name: 'деньги', description: 'оплата на месте, заработок, сдельная, подотчёт' },
        { name: 'связь', description: 'вебхуки телефонии' },
      ],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        },
      },
    },
  });

  // Кто пришёл: подпись cookie проверяется без базы, роль и блокировка — из базы.
  // Из-за этого заблокированная учётка перестаёт работать сразу, а не по сроку cookie.
  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    const staffId = readSession(token, secret);
    if (!staffId) return;
    const { rows } = await app.db.query<User & { blocked_at: string | null }>(
      'SELECT id, role, full_name, must_change_password, blocked_at FROM staff WHERE id = $1', [staffId]);
    const row = rows[0];
    if (!row || row.blocked_at) return;
    req.user = { id: row.id, role: row.role, full_name: row.full_name, must_change_password: row.must_change_password };
  });

  // Один охранник на весь API вместо проверки в каждом обработчике: забыть
  // его в одном маршруте — значит открыть данные клиентов наружу.
  app.addHook('preHandler', async (req) => {
    const path = req.routeOptions?.url ?? req.url.split('?')[0]!;
    if (PUBLIC.has(path) || !path.startsWith('/api/')) return;
    if (!req.user) throw new ApiError(401, 'Нужен вход в систему.');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: err.message, reason: err.reason });
    }
    // Схема не пропустила тело или параметры: человеку нужна причина, а не «400».
    const fail = err as { validation?: unknown; message?: string };
    if (fail.validation) {
      return reply.code(400).send({ error: 'Запрос заполнен неверно: ' + (fail.message ?? '') });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Внутренняя ошибка сервера.' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `Нет такого адреса: ${req.method} ${req.url}` });
  });

  app.get('/health', {
    schema: {
      tags: ['служебное'],
      summary: 'Живо ли приложение и отвечает ли база',
      response: {
        200: {
          type: 'object',
          properties: { status: { type: 'string' }, db: { type: 'string' }, version: { type: 'string' } },
        },
      },
    },
  }, async () => {
    await app.db.query('SELECT 1');
    return { status: 'ok', db: 'ok', version: '1.0.0' };
  });

  app.get('/docs', {
    schema: { tags: ['служебное'], summary: 'Описание API в формате OpenAPI 3' },
  }, async () => app.swagger());

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(refRoutes, { prefix: '/api' });
  await app.register(planRoutes, { prefix: '/api' });
  await app.register(requestRoutes, { prefix: '/api' });
  await app.register(routeRoutes, { prefix: '/api' });
  await app.register(actRoutes, { prefix: '/api' });
  await app.register(moneyRoutes, { prefix: '/api' });
  await app.register(callRoutes, { prefix: '/api' });

  return app;
}
