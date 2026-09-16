/* Фотографии акта: подписанная ссылка и выдача файла.
 *
 * Снимок в базе не лежит — там только ключ объекта (`photos.storage_key`).
 * Показать его в браузере нужно тегом `<img>`, а `<img>` не носит заголовков и
 * не умеет объяснять 401: поэтому ссылка подписывается отдельно и живёт недолго.
 * Подпись — HMAC от ключа фотографии и срока тем же секретом, что и сессия.
 *
 * Чего здесь намеренно нет: загрузки, миниатюр, срока хранения и самого
 * Object Storage — это пункт be-photos. Пока бакет не подключён, выдача рисует
 * заглушку с заводским номером прибора: экран поверителя должен работать
 * целиком, а не наполовину.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { notFound } from '../errors.ts';

/** Сколько живёт подписанная ссылка. Больше рабочего дня незачем: страница
 *  перерисовывается, ссылки выдаются заново. */
export const PHOTO_LINK_TTL_MS = 60 * 60 * 1000;

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/** Ссылка на снимок: `/api/photos/12/file?exp=…&sig=…`. */
export function photoLink(id: number | string, secret: string, now = Date.now()): string {
  const exp = now + PHOTO_LINK_TTL_MS;
  return `/api/photos/${id}/file?exp=${exp}&sig=${sign(`${id}.${exp}`, secret)}`;
}

export function linkValid(id: string, exp: string, sig: string, secret: string, now = Date.now()): boolean {
  if (!exp || !sig || Number(exp) < now) return false;
  const want = Buffer.from(sign(`${id}.${exp}`, secret));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Строки фотографий прибора со свежими ссылками. */
export function withLinks(rows: Record<string, unknown>[], secret: string) {
  return rows.map((p) => ({
    id: p.id, name: p.name, taken_at: p.taken_at, url: photoLink(String(p.id), secret),
  }));
}

/* Заглушка вместо снимка — тот же рисунок, что показывал прототип в демо-наборе. */
function stub(text: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">` +
    `<rect width="480" height="360" fill="#1d1d1d"/>` +
    `<g stroke="#6b6b6b" fill="none" stroke-width="3"><circle cx="240" cy="168" r="86"/>` +
    `<circle cx="240" cy="168" r="62"/><path d="M40 140h114M40 200h108M326 140h114M332 200h108"/></g>` +
    `<text x="240" y="176" font-family="monospace" font-size="30" fill="#c9c9c9" text-anchor="middle">${text}</text>` +
    `<text x="24" y="336" font-family="monospace" font-size="18" fill="#8d8d8d">снимок в хранилище · be-photos</text></svg>`;
}

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/photos/:id/file', {
    schema: {
      tags: ['акт'],
      summary: 'Снимок по подписанной ссылке: сессия не нужна, срок ограничен',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object', required: ['exp', 'sig'],
        properties: { exp: { type: 'string' }, sig: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig } = req.query as { exp: string; sig: string };
    if (!linkValid(id, exp, sig, app.sessionSecret)) {
      // Просроченная ссылка — не повод рассказывать, есть ли такая фотография.
      return reply.code(403).send({ error: 'Ссылка на снимок просрочена или подделана.' });
    }
    const { rows } = await app.db.query<{ storage_key: string; serial: string }>(
      `SELECT p.storage_key, d.serial FROM photos p JOIN devices d ON d.id = p.device_id WHERE p.id = $1`,
      [id]);
    const photo = rows[0];
    if (!photo) throw notFound('Нет такой фотографии.');
    // Бакета пока нет: отдаём заглушку с номером прибора, чтобы акт читался целиком.
    return reply.type('image/svg+xml').header('cache-control', 'private, max-age=300')
      .send(stub(photo.serial || 'без номера'));
  });
};

export default plugin;
