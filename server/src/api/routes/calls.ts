/* Приёмник вебхуков телефонии (Новофон) и лента звонков.
 *
 * Это заглушка по существу, но не по поведению: подпись проверяется по-настоящему,
 * строка звонка заводится, ответ уходит сразу. АТС нас не ждёт — она повторит
 * доставку, если не получит 200 за пару секунд, поэтому в обработчике нет ни
 * похода за записью разговора, ни подъёма карточки клиента. Запись докачает
 * worker, карточку поднимет фронт (пункт int-novofon).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { requireUser } from '../auth.ts';
import { ApiError } from '../errors.ts';
import { normPhone } from '../../db.ts';

/** Подпись вебхука: HMAC-SHA256 по сырому телу общим ключом. Ключа нет —
 *  приёмник закрыт: открытый вебхук означает, что журнал звонков может написать
 *  кто угодно. */
function checkSignature(raw: string, got: string | undefined): void {
  const secret = process.env.NOVOFON_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(503, 'Приёмник звонков не настроен: не задан NOVOFON_WEBHOOK_SECRET.');
  if (!got) throw new ApiError(401, 'Нет подписи вебхука.');
  const want = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(got.trim().toLowerCase());
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(401, 'Подпись вебхука не сходится.');
}

const plugin: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/novofon', {
    schema: {
      tags: ['связь'],
      summary: 'Вебхук звонка от АТС. Подпись — HMAC-SHA256 по телу в заголовке X-Signature',
      body: {
        type: 'object',
        required: ['pbx_id', 'direction', 'from', 'to', 'started'],
        properties: {
          pbx_id: { type: 'string' },
          direction: { type: 'string', enum: ['входящий', 'исходящий'] },
          from: { type: 'string' }, to: { type: 'string' },
          started: { type: 'string' },
          duration_sec: { type: 'integer', minimum: 0 },
          disposition: { type: 'string', enum: ['отвечен', 'пропущен', 'занято', 'сброшен'] },
          operator_ext: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    // Подпись считается по сырому телу: пересборка JSON меняет байты, и HMAC
    // перестал бы сходиться на пробелах и порядке полей. Сырое тело сохраняет
    // разборщик содержимого в `app.ts`.
    checkSignature(req.rawBody ?? '', req.headers['x-signature'] as string | undefined);
    const b = req.body as {
      pbx_id: string; direction: string; from: string; to: string; started: string;
      duration_sec?: number; disposition?: string; operator_ext?: string;
    };
    const clientPhone = normPhone(b.direction === 'входящий' ? b.from : b.to);
    // Повторную доставку того же звонка АТС считает нормой, поэтому запись
    // обновляется по идентификатору на её стороне, а не заводится второй раз.
    const { rows } = await app.db.query(
      `INSERT INTO calls (pbx_id, direction, from_number, to_number, client_phone, started,
          duration_sec, disposition, operator_id, client_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               (SELECT id FROM staff WHERE ext = $9),
               (SELECT id FROM clients WHERE phone_norm = $5))
       ON CONFLICT (pbx_id) DO UPDATE SET duration_sec = EXCLUDED.duration_sec,
         disposition = EXCLUDED.disposition
       RETURNING id`,
      [b.pbx_id, b.direction, b.from, b.to, clientPhone, b.started,
       b.duration_sec ?? null, b.disposition ?? null, b.operator_ext ?? null]);
    return reply.code(200).send({ accepted: true, call_id: rows[0]?.id ?? null });
  });

  app.get('/calls', {
    schema: {
      tags: ['связь'], summary: 'Лента звонков', security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          phone: { type: 'string' }, operator_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (req) => {
    const user = requireUser(req);
    const q = req.query as { phone?: string; operator_id?: string; limit?: number };
    // Поверителю лента звонков не нужна и не положена: это персональные данные
    // клиентов и разговоры операторов.
    if (user.role === 'verifier') throw new ApiError(403, 'Лента звонков доступна операторам и руководителю.');
    const { rows } = await app.db.query(
      `SELECT * FROM calls
        WHERE ($1::text IS NULL OR client_phone = $1) AND ($2::text IS NULL OR operator_id = $2)
        ORDER BY started DESC LIMIT $3`,
      [q.phone ? normPhone(q.phone) : null, q.operator_id ?? null, q.limit ?? 50]);
    return { calls: rows };
  });
};

export default plugin;
