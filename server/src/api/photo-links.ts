/* Ссылка на снимок от нашего сервера: подпись и срок.
 *
 * Показать кадр в браузере нужно тегом `<img>`, а `<img>` не носит заголовков,
 * не отправляет cookie на чужой адрес и не умеет объяснять 401. Поэтому доступ
 * к снимку даёт не сессия, а подписанная ссылка: HMAC от идентификатора кадра,
 * вида (оригинал или миниатюра) и срока, тем же ключом, что подписывает сессию.
 *
 * Дальше эта ссылка ведёт в хранилище: сервер проверяет подпись и отвечает 302
 * на подписанную ссылку Object Storage с тем же сроком (`routes/photos.ts`).
 * Двух подписей достаточно: адрес бакета не попадает ни в базу, ни в разметку,
 * а срок короткий — ссылка, утёкшая из истории браузера, назавтра мертва.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PHOTO_URL_TTL_S } from '../storage.ts';

/** Срок нашей ссылки равен сроку ссылки в хранилище — пятнадцать минут.
 *  Страница акта перерисовывается и получает ссылки заново, так что дольше
 *  они и не нужны. */
export const PHOTO_LINK_TTL_MS = PHOTO_URL_TTL_S * 1000;

/** Что открывается по ссылке: сам кадр или миниатюра 320 px. */
export type PhotoView = 'full' | 'thumb';

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/** Ссылка на снимок: `/api/photos/12/file?v=full&exp=…&sig=…`. */
export function photoLink(
  id: number | string, secret: string, view: PhotoView = 'full', now = Date.now(),
): string {
  const exp = now + PHOTO_LINK_TTL_MS;
  return `/api/photos/${id}/file?v=${view}&exp=${exp}&sig=${sign(`${id}.${view}.${exp}`, secret)}`;
}

export function linkValid(
  id: string, view: string, exp: string, sig: string, secret: string, now = Date.now(),
): boolean {
  if (!exp || !sig || Number(exp) < now) return false;
  const want = Buffer.from(sign(`${id}.${view}.${exp}`, secret));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Строки фотографий прибора со свежими ссылками.
 *  Миниатюра отдаётся отдельной ссылкой: в акте показывается она, а оригинал
 *  тянется только когда кадр открыли в полный экран. */
export function withLinks(rows: Record<string, unknown>[], secret: string) {
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    taken_at: p.taken_at,
    size_bytes: p.size_bytes ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    url: photoLink(String(p.id), secret, 'full'),
    thumb_url: photoLink(String(p.id), secret, p.thumb_key ? 'thumb' : 'full'),
  }));
}
