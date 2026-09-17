/* Уведомления: шаблоны и журнал доставки.
 *
 * Тексты правит руководитель — тем же правилом, что и прайс (`canEditPrices`):
 * это обещание клиенту от имени конторы, и раздавать его оператору незачем.
 * Читать шаблоны может любой вошедший: экран приёма показывает оператору, что
 * именно уйдёт клиенту, когда тот ставит галочку согласия.
 *
 * Журнал доставки открыт руководителю: в нём адреса и телефоны клиентов —
 * те же персональные данные, что и в карточке, и смотреть их всем подряд
 * незачем (docs/security.md, раздел о доступах).
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireRole, requireUser } from '../auth.ts';
import { notFound, ruleError } from '../errors.ts';
import { canEditPrices, type Role } from '../../rules.ts';
import {
  CHANNELS, EVENTS, PLACEHOLDERS, allowedFor, templateProblem,
  type Channel, type NotifyEvent,
} from '../../notify/templates.ts';
import { notifyConfig } from '../../notify/config.ts';

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/notify/templates', {
    schema: {
      tags: ['уведомления'],
      summary: 'Шаблоны сообщений и перечень подстановок',
      security: [{ session: [] }],
    },
  }, async (req) => {
    requireUser(req);
    const { rows } = await app.db.query(
      `SELECT event, channel, subject, body, active, updated_by, updated_at
         FROM notify_templates ORDER BY event, channel`);
    const cfg = notifyConfig();
    return {
      templates: rows,
      // Перечень показывается рядом с полем ввода: без него шаблон правят наугад.
      placeholders: PLACEHOLDERS,
      allowed: Object.fromEntries(EVENTS.map((e) => [e, allowedFor(e)])),
      // Отправитель — не поле формы, а настройка контура: руководитель должен
      // видеть, с какого ящика уходят письма, но менять его выкладкой, а не
      // мышкой (см. src/notify/config.ts).
      sender: { from: cfg.from, name: cfg.fromName, signature: cfg.signature, office_phone: cfg.officePhone },
    };
  });

  app.put('/notify/templates/:event/:channel', {
    schema: {
      tags: ['уведомления'],
      summary: 'Правка шаблона — только руководитель',
      security: [{ session: [] }],
      params: {
        type: 'object', required: ['event', 'channel'],
        properties: { event: { type: 'string', enum: EVENTS }, channel: { type: 'string', enum: CHANNELS } },
      },
      body: {
        type: 'object', required: ['body'], additionalProperties: false,
        properties: {
          subject: { type: 'string', maxLength: 200 },
          body: { type: 'string', maxLength: 2000 },
          active: { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    if (!canEditPrices(user.role as Role)) {
      throw ruleError('Шаблоны уведомлений меняет только руководитель.', 'role');
    }
    const { event, channel } = req.params as { event: NotifyEvent; channel: Channel };
    const b = req.body as { subject?: string; body: string; active?: boolean };
    const subject = channel === 'sms' ? '' : (b.subject ?? '');
    // Опечатку в подстановке ловим здесь: дальше текст уже уходит клиенту,
    // и «{имя_поверителя}» посреди письма увидит он, а не мы.
    const bad = templateProblem(event, channel, subject, b.body);
    if (bad) throw ruleError(bad, 'template');

    const { rows } = await app.db.query(
      `UPDATE notify_templates
          SET subject = $3, body = $4, active = COALESCE($5, active), updated_by = $6, updated_at = now()
        WHERE event = $1 AND channel = $2
        RETURNING event, channel, subject, body, active, updated_by, updated_at`,
      [event, channel, subject, b.body, b.active ?? null, user.id]);
    if (!rows[0]) throw notFound(`Нет шаблона «${event}» для канала «${channel}».`);
    // Уже поставленные в очередь сообщения не переписываются: клиенту уходит
    // то, что было обещано в момент события (см. src/notify/events.ts).
    return { template: rows[0] };
  });

  app.get('/notify/queue', {
    schema: {
      tags: ['уведомления'],
      summary: 'Журнал доставки: что ушло, что ждёт, что не прошло',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          event: { type: 'string' },
          channel: { type: 'string' },
          request_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const q = req.query as Record<string, string | number | undefined>;
    const { rows } = await app.db.query(
      `SELECT n.id, n.event, n.channel, n.request_id, n.address, n.subject, n.body, n.status,
              n.attempts, n.send_after, n.sent_at, n.last_error, n.provider_id, n.created_at,
              (SELECT count(*)::int FROM notification_attempts a WHERE a.notification_id = n.id) AS tries
         FROM notifications n
        WHERE ($1::text IS NULL OR n.status = $1)
          AND ($2::text IS NULL OR n.event = $2)
          AND ($3::text IS NULL OR n.channel = $3)
          AND ($4::text IS NULL OR n.request_id = $4)
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT $5 OFFSET $6`,
      [q.status ?? null, q.event ?? null, q.channel ?? null, q.request_id ?? null,
       q.limit ?? 100, q.offset ?? 0]);
    return { notifications: rows };
  });

  app.get('/notify/queue/:id/attempts', {
    schema: {
      tags: ['уведомления'],
      summary: 'Попытки отправки одного сообщения: когда и чем ответил шлюз',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { id } = req.params as { id: number };
    const { rows } = await app.db.query(
      'SELECT id, at, ok, response FROM notification_attempts WHERE notification_id = $1 ORDER BY at, id', [id]);
    return { attempts: rows };
  });
};

export default plugin;
