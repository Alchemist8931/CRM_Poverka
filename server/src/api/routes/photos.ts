/* Фотографии акта: загрузка в Object Storage, миниатюра, выдача и удаление.
 *
 * Круг такой. Телефон поверителя жмёт кадр до 1600 px по длинной стороне и
 * просит ссылку на загрузку; сервер проверяет право, лимиты и выдаёт
 * подписанную ссылку на PUT в хранилище. Снимок идёт туда напрямую, минуя
 * приложение. Дальше телефон подтверждает загрузку, и только тут сервер
 * записывает кадр в акт: смотрит, что объект действительно лежит и весит
 * сколько сказано, делает миниатюру 320 px и сохраняет ключ, размер и время.
 *
 * Показ — в два шага: наша подписанная ссылка `/api/photos/12/file` (сессия для
 * неё не нужна, `<img>` её и не носит) отвечает 302 на подписанную ссылку
 * хранилища с тем же сроком в пятнадцать минут. Адрес бакета не лежит ни в
 * базе, ни в разметке, а утёкшая ссылка живёт четверть часа.
 *
 * Удаление — только руководителю и только пометкой: файл в хранилище остаётся
 * (срок хранения не меньше шести лет, и права удалять у приложения нет), а в
 * журнал действий идёт запись, кто и какой кадр убрал из акта.
 *
 * Пока хранилище не подключено (машина разработчика без MinIO, тестовый стенд),
 * выдача рисует заглушку с заводским номером прибора, а загрузка честно
 * отвечает 503: экран поверителя должен работать целиком, а не наполовину.
 */
import type { FastifyPluginAsync } from 'fastify';
import sharp from 'sharp';
import { requireRole } from '../auth.ts';
import { ApiError, notFound, ruleError } from '../errors.ts';
import { actorOr403 } from '../store.ts';
import {
  PHOTO_CONTENT_TYPE, PHOTO_MAX_BYTES, PHOTO_MAX_PER_DEVICE, PHOTO_URL_TTL_S, THUMB_PX,
  keyBelongsTo, photoKey, thumbKey,
} from '../../storage.ts';
import { linkValid, photoLink, withLinks, type PhotoView } from '../photo-links.ts';

export { PHOTO_LINK_TTL_MS, photoLink, linkValid, withLinks } from '../photo-links.ts';

const DEVICE_ID = {
  type: 'object', required: ['id'], properties: { id: { type: 'integer' } },
} as const;

/** Строка прибора вместе с заявкой: без заявки не проверить право на акт. */
async function deviceOr404(app: { db: import('../db.ts').Db }, id: number) {
  const { rows } = await app.db.query<{ id: string; request_id: string; serial: string }>(
    'SELECT id, request_id, serial FROM devices WHERE id = $1', [id]);
  const device = rows[0];
  if (!device) throw notFound(`Нет строки прибора №${id}.`);
  return device;
}

/** Сколько кадров уже висит на приборе. Удалённые не в счёт: иначе руководитель,
 *  убравший смазанный кадр, не дал бы поверителю переснять. */
async function photoCount(db: import('../db.ts').Db, deviceId: string | number): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM photos WHERE device_id = $1 AND deleted_at IS NULL', [deviceId]);
  return Number(rows[0]?.n ?? 0);
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
  /** Хранилище не подключено — говорим об этом одинаково во всех местах. */
  const storageOr503 = () => {
    if (!app.photos) {
      throw new ApiError(503,
        'Хранилище снимков не подключено к этому контуру — акт закрывается и без фотографий.',
        'storage');
    }
    return app.photos;
  };

  app.post('/devices/:id/photos/upload', {
    schema: {
      tags: ['акт'],
      summary: 'Ссылка на загрузку кадра прямо в хранилище (подписанная, на 15 минут)',
      security: [{ session: [] }],
      params: DEVICE_ID,
      body: {
        type: 'object', required: ['size'],
        properties: {
          size: { type: 'integer' },
          content_type: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const user = requireRole(req, 'verifier', 'supervisor');
    const { id } = req.params as { id: number };
    const b = req.body as { size: number; content_type?: string };
    const storage = storageOr503();
    const device = await deviceOr404(app, id);
    await actorOr403(app.db, user, device.request_id);

    if (b.content_type && b.content_type !== PHOTO_CONTENT_TYPE) {
      throw ruleError('В акт идут только снимки JPEG — телефон готовит кадр сам.', 'photo-type');
    }
    if (b.size > PHOTO_MAX_BYTES) {
      throw ruleError(
        `Кадр весит ${Math.round(b.size / 1024 / 1024 * 10) / 10} МБ, а в акт принимается не больше ` +
        `${PHOTO_MAX_BYTES / 1024 / 1024} МБ. Снимите заново — телефон сожмёт кадр сам.`, 'photo-size');
    }
    if (b.size <= 0) throw ruleError('Пустой кадр в акт не идёт.', 'photo-size');

    const already = await photoCount(app.db, device.id);
    if (already >= PHOTO_MAX_PER_DEVICE) {
      throw ruleError(
        `На прибор в акте хватает трёх кадров, больше ${PHOTO_MAX_PER_DEVICE} не принимается. ` +
        'Уберите лишние и снимите заново.', 'photo-count');
    }

    const key = photoKey(device.request_id, device.id);
    return {
      key,
      url: await storage.uploadUrl(key),
      expires_in: PHOTO_URL_TTL_S,
      content_type: PHOTO_CONTENT_TYPE,
      max_bytes: PHOTO_MAX_BYTES,
      left: PHOTO_MAX_PER_DEVICE - already,
    };
  });

  app.post('/devices/:id/photos', {
    schema: {
      tags: ['акт'],
      summary: 'Подтвердить загрузку: сервер сверяет объект, делает миниатюру и пишет кадр в акт',
      security: [{ session: [] }],
      params: DEVICE_ID,
      body: {
        type: 'object', required: ['key'],
        properties: {
          key: { type: 'string' },
          name: { type: 'string' },
          taken_at: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
        },
      },
    },
  }, async (req) => {
    const user = requireRole(req, 'verifier', 'supervisor');
    const { id } = req.params as { id: number };
    const b = req.body as { key: string; name?: string; taken_at?: string };
    const storage = storageOr503();
    const device = await deviceOr404(app, id);
    await actorOr403(app.db, user, device.request_id);

    // Ключ выдавал сервер — он же и проверяет, что вернулся тот самый: иначе
    // подтверждением можно было бы записать в свой акт чужой объект.
    if (!keyBelongsTo(b.key, device.request_id, device.id)) {
      throw ruleError('Ключ снимка не из этого акта.', 'photo-key');
    }
    if (await photoCount(app.db, device.id) >= PHOTO_MAX_PER_DEVICE) {
      throw ruleError(`Больше ${PHOTO_MAX_PER_DEVICE} кадров на прибор не принимается.`, 'photo-count');
    }

    const info = await storage.head(b.key);
    if (!info) throw ruleError('Кадр не долетел до хранилища — попробуйте снять ещё раз.', 'photo-missing');
    if (info.size > PHOTO_MAX_BYTES) {
      // Объект больше лимита в акт не пойдёт. Стереть его приложение обычно не
      // может (права на бакет — чтение и запись без удаления), поэтому пробуем
      // и не считаем неудачу ошибкой: висящий объект уберёт правило бакета.
      await storage.remove(b.key).catch(() => {});
      throw ruleError(
        `Кадр весит ${Math.round(info.size / 1024 / 1024 * 10) / 10} МБ — больше ` +
        `${PHOTO_MAX_BYTES / 1024 / 1024} МБ в акт не принимается.`, 'photo-size');
    }

    // Миниатюра нужна списку кадров в акте: на телефоне их до десяти на прибор,
    // и тянуть ради ряда квадратиков десять оригиналов — это мегабайты трафика.
    let thumb: Buffer;
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      const original = await storage.read(b.key);
      meta = await sharp(original).metadata();
      thumb = await sharp(original)
        .rotate()                                    // повёрнутый телефоном кадр — по метке EXIF
        .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78 })
        .toBuffer();
    } catch {
      await storage.remove(b.key).catch(() => {});
      throw ruleError('Это не похоже на снимок: в акт идёт фотография, а не другой файл.', 'photo-type');
    }
    const thumbAt = thumbKey(b.key);
    await storage.write(thumbAt, thumb);

    const { rows } = await app.db.query<Record<string, unknown>>(
      `INSERT INTO photos (device_id, storage_key, thumb_key, name, taken_at, size_bytes, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, taken_at::text AS taken_at, size_bytes, width, height, thumb_key`,
      [device.id, b.key, thumbAt, (b.name ?? '').slice(0, 120), b.taken_at ?? null,
       info.size, meta.width ?? null, meta.height ?? null]);

    return { photo: withLinks(rows, app.sessionSecret)[0] };
  });

  app.get('/photos/:id/file', {
    schema: {
      tags: ['акт'],
      summary: 'Снимок по подписанной ссылке: сессия не нужна, срок ограничен',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object', required: ['exp', 'sig'],
        properties: {
          exp: { type: 'string' }, sig: { type: 'string' },
          v: { type: 'string', enum: ['full', 'thumb'] },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { exp, sig, v } = req.query as { exp: string; sig: string; v?: PhotoView };
    const view: PhotoView = v === 'thumb' ? 'thumb' : 'full';
    if (!linkValid(id, view, exp, sig, app.sessionSecret)) {
      // Просроченная ссылка — не повод рассказывать, есть ли такая фотография.
      return reply.code(403).send({ error: 'Ссылка на снимок просрочена или подделана.' });
    }
    const { rows } = await app.db.query<
      { storage_key: string; thumb_key: string | null; serial: string; deleted_at: string | null }>(
      `SELECT p.storage_key, p.thumb_key, p.deleted_at, d.serial
         FROM photos p JOIN devices d ON d.id = p.device_id WHERE p.id = $1`, [id]);
    const photo = rows[0];
    if (!photo) throw notFound('Нет такой фотографии.');
    if (photo.deleted_at) throw notFound('Кадр убран из акта руководителем.');

    // Хранилища нет: отдаём заглушку с номером прибора, чтобы акт читался целиком.
    if (!app.photos) {
      return reply.type('image/svg+xml').header('cache-control', 'private, max-age=300')
        .send(stub(photo.serial || 'без номера'));
    }
    // Ссылка в хранилище живёт ровно столько, сколько осталось нашей: перейти
    // по ней позже, чем истекла та, по которой пришли, нельзя.
    const left = Math.max(1, Math.min(PHOTO_URL_TTL_S, Math.ceil((Number(exp) - Date.now()) / 1000)));
    const key = view === 'thumb' && photo.thumb_key ? photo.thumb_key : photo.storage_key;
    return reply
      .header('cache-control', `private, max-age=${left}`)
      .redirect(await app.photos.viewUrl(key, left), 302);
  });

  app.delete('/photos/:id', {
    schema: {
      tags: ['акт'],
      summary: 'Убрать кадр из акта. Только руководитель, с записью в журнал',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const { id } = req.params as { id: number };
    const { rows } = await app.db.query<
      { id: string; device_id: string; request_id: string; storage_key: string;
        name: string; deleted_at: string | null }>(
      `SELECT p.id, p.device_id, p.storage_key, p.name, p.deleted_at, d.request_id
         FROM photos p JOIN devices d ON d.id = p.device_id WHERE p.id = $1`, [id]);
    const photo = rows[0];
    if (!photo) throw notFound(`Нет фотографии №${id}.`);
    if (photo.deleted_at) throw ruleError('Этот кадр уже убран из акта.', 'photo-deleted');

    // Журнал действий пишет промежуточный слой (`src/api/audit.ts`): по 152-ФЗ и
    // руководителю. На фотографии акта видны фамилия, адрес и подпись —
    // исчезновение кадра должно быть объяснимо, и в записи остаётся вся строка
    // кадра целиком, вместе с ключом в хранилище.
    await app.db.query('UPDATE photos SET deleted_at = now(), deleted_by = $2 WHERE id = $1',
      [id, user.id]);
    return { ok: true, id, kept_in_storage: true };
  });
};

export default plugin;
