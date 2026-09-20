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
import { photoStorage, recordsConfig, storageConfig, type PhotoStorage } from '../storage.ts';
import { canCall, novofonConfig, type NovofonConfig } from '../novofon/config.ts';
import { novofonApi, type NovofonApi } from '../novofon/api.ts';
import { callBus, type CallBus } from '../novofon/bus.ts';
import { canPay, paymentConfig, type PaymentConfig } from '../payment/config.ts';
import { yookassa } from '../payment/yookassa.ts';
import type { PaymentProvider } from '../payment/provider.ts';
import { SESSION_COOKIE, readSession, sessionFresh, sessionSecret, type User } from './auth.ts';
import authRoutes from './routes/auth.ts';
import userRoutes from './routes/users.ts';
import refRoutes from './routes/refs.ts';
import planRoutes from './routes/plan.ts';
import requestRoutes from './routes/requests.ts';
import routeRoutes from './routes/routes.ts';
import actRoutes from './routes/act.ts';
import moneyRoutes from './routes/money.ts';
import callRoutes from './routes/calls.ts';
import photoRoutes from './routes/photos.ts';
import auditRoutes from './routes/audit.ts';
import arshinRoutes from './routes/arshin.ts';
import notifyRoutes from './routes/notify.ts';
import paymentRoutes from './routes/payment.ts';
import { installAudit } from './audit.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** Ключ подписи сессий: один на приложение, чтобы вход и проверка cookie
     *  не разъехались (в тестах он свой, в облаке приходит из Lockbox). */
    sessionSecret: string;
    /** Хранилище снимков акта или `null`, если оно к контуру не подключено:
     *  тогда акт работает целиком, а вместо кадра рисуется заглушка. */
    photos: PhotoStorage | null;
    /** Бакет записей разговоров. Отдельный от снимков: у записей свои права и
     *  свой срок хранения. `null` — записи не сохраняются, звонки работают. */
    records: PhotoStorage | null;
    /** Настройки телефонии: платформа кабинета, ключи, адрес приёмника. */
    novofonConfig: NovofonConfig;
    /** Обращения к АТС или `null`, если ключей нет: тогда система только
     *  принимает события и показывает карточку, но сама в АТС не ходит. */
    novofon: NovofonApi | null;
    /** Шина событий телефонии: из вебхука на пульт оператора. */
    calls: CallBus;
    /** Настройки эквайринга: провайдер, ключи, коды чека, секрет приёмника. */
    paymentConfig: PaymentConfig;
    /** Платёжный провайдер или `null`, если ключей нет: тогда безналичные
     *  способы в акте не показываются, а наличные и перевод работают как прежде. */
    payments: PaymentProvider | null;
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
  /** Хранилище снимков. По умолчанию собирается из окружения; передаётся руками
   *  в проверке круга загрузки (`scripts/check-photo-roundtrip.mts`). */
  storage?: PhotoStorage | null;
  /** Бакет записей разговоров: так же, как и снимки, — по умолчанию из
   *  окружения, руками в сквозной проверке телефонии. */
  records?: PhotoStorage | null;
  /** Настройки телефонии. По умолчанию из окружения; в проверках подменяются
   *  целиком, чтобы приёмник смотрел на эмулятор, а не на настоящую АТС. */
  novofon?: NovofonConfig;
  /** Клиент АТС. `null` — обращений к АТС нет вовсе (так в тестах API). */
  novofonClient?: NovofonApi | null;
  /** Настройки эквайринга. По умолчанию из окружения; в проверках — на
   *  эмулятор провайдера (src/payment/emulator.ts). */
  payment?: PaymentConfig;
  /** Платёжный провайдер. `null` — эквайринг выключен (так в тестах API по умолчанию). */
  paymentProvider?: PaymentProvider | null;
}

/** Открытые входы: до них сессия не спрашивается. */
/* Выдача снимка открыта нарочно: тег <img> не носит cookie на чужой адрес и не
   умеет показывать 401, поэтому доступ там даёт подписанная ссылка с коротким
   сроком (`routes/photos.ts`), а не сессия. */
/* Приёмники телефонии открыты для сессии нарочно: их зовёт АТС, у которой
   cookie нет и быть не может. Подлинность там подтверждается иначе — подписью
   события (API 1.0) или секретом в адресе и списком адресов (платформа 2.0),
   см. `src/novofon/signature.ts`. */
/* Приёмник платёжного провайдера открыт по той же причине: его зовёт провайдер,
   секрет стоит в адресе, а событие подтверждается повторным чтением платежа
   из API провайдера (`src/payment/yookassa.ts`, verifyWebhook). */
const PUBLIC = new Set(['/health', '/docs', '/api/auth/login',
  '/api/webhooks/novofon', '/api/webhooks/novofon/:secret',
  '/api/webhooks/novofon/routing', '/api/webhooks/novofon/routing/:secret',
  '/api/webhooks/payment/:secret',
  '/api/photos/:id/file']);

/* Что открыто, пока временный пароль не сменён: узнать, кто я, сменить пароль
   и выйти. Всё остальное ждёт смены. */
const PASSWORD_CHANGE = new Set(['/api/auth/me', '/api/auth/logout', '/api/staff/:id/password']);

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: opts.logger ?? false,
    // Тело запроса приходит с формы: числа в строках, пустые поля строками.
    // Приведение типов включено, иначе половина полей отваливалась бы на схеме.
    ajv: { customOptions: { coerceTypes: true, allErrors: false, removeAdditional: false } },
  });
  const secret = opts.secret ?? sessionSecret();

  const cfg = storageConfig();
  const recCfg = recordsConfig();
  const novofon = opts.novofon ?? novofonConfig();
  app.decorate('db', opts.db);
  app.decorate('sessionSecret', secret);
  app.decorate('photos', opts.storage !== undefined ? opts.storage : (cfg ? photoStorage(cfg) : null));
  app.decorate('records', opts.records !== undefined ? opts.records : (recCfg ? photoStorage(recCfg) : null));
  app.decorate('novofonConfig', novofon);
  app.decorate('novofon', opts.novofonClient !== undefined
    ? opts.novofonClient
    : (canCall(novofon) ? novofonApi(novofon) : null));
  app.decorate('calls', callBus());
  const pay = opts.payment ?? paymentConfig();
  app.decorate('paymentConfig', pay);
  app.decorate('payments', opts.paymentProvider !== undefined
    ? opts.paymentProvider
    : (canPay(pay) ? yookassa(pay) : null));

  // Разбор JSON с сохранением сырого тела: по нему вебхук телефонии проверяет подпись.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = String(body);
    try {
      done(null, body ? JSON.parse(String(body)) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Уведомления API 1.0 приходят формой, а не JSON. Без своего разборщика
  // fastify отвечает на них 415, и в кабинете это выглядит как «CRM не
  // принимает события» — без единой строчки о причине.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = String(body);
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
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
        { name: 'деньги', description: 'оплата на месте и по QR/ссылке, чеки, заработок, сдельная, подотчёт, сверка эквайринга' },
        { name: 'связь', description: 'вебхуки телефонии' },
        { name: 'журнал', description: 'журнал действий: кто что менял и смотрел' },
        { name: 'аршин', description: 'записи о поверке для ФГИС «Аршин»: очередь, выгрузка, номера реестра' },
        { name: 'уведомления', description: 'шаблоны сообщений клиенту, очередь отправки и журнал доставки' },
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
    const session = readSession(token, secret);
    if (!session) return;
    const { rows } = await app.db.query<User & { blocked_at: string | null; sessions_from: string | null }>(
      `SELECT id, role, full_name, must_change_password, blocked_at, sessions_from
         FROM staff WHERE id = $1`, [session.staffId]);
    const row = rows[0];
    if (!row || row.blocked_at) return;
    // Выход со всех устройств (пункт be-users): сессия, выданная до отметки,
    // больше не сессия. Так гасятся чужие открытые вкладки при увольнении и
    // при смене пароля — без списка сессий на сервере.
    if (!sessionFresh(session.issuedAt, row.sessions_from)) return;
    req.user = { id: row.id, role: row.role, full_name: row.full_name, must_change_password: row.must_change_password };
  });

  // Один охранник на весь API вместо проверки в каждом обработчике: забыть
  // его в одном маршруте — значит открыть данные клиентов наружу.
  app.addHook('preHandler', async (req) => {
    const path = req.routeOptions?.url ?? req.url.split('?')[0]!;
    if (PUBLIC.has(path) || !path.startsWith('/api/')) return;
    if (!req.user) throw new ApiError(401, 'Нужен вход в систему.');
    // Первый вход по временному паролю (пункт be-users): дальше смены пароля
    // человек не проходит. Охрана стоит здесь, а не в экранах, — иначе учётка
    // с паролем, который знает ещё и руководитель, работала бы полноценно.
    if (req.user.must_change_password && !PASSWORD_CHANGE.has(path)) {
      throw new ApiError(403, 'Сначала смените временный пароль.', 'password');
    }
  });

  // Журнал действий ставится до маршрутов и поверх всех сразу: обработчик,
  // который забыли бы в него вписать, — это дыра в следе по персональным данным.
  installAudit(app);

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
  await app.register(userRoutes, { prefix: '/api' });
  await app.register(refRoutes, { prefix: '/api' });
  await app.register(planRoutes, { prefix: '/api' });
  await app.register(requestRoutes, { prefix: '/api' });
  await app.register(routeRoutes, { prefix: '/api' });
  await app.register(actRoutes, { prefix: '/api' });
  await app.register(moneyRoutes, { prefix: '/api' });
  await app.register(callRoutes, { prefix: '/api' });
  await app.register(photoRoutes, { prefix: '/api' });
  await app.register(auditRoutes, { prefix: '/api' });
  await app.register(arshinRoutes, { prefix: '/api' });
  await app.register(notifyRoutes, { prefix: '/api' });
  await app.register(paymentRoutes, { prefix: '/api' });

  return app;
}
