/* Object Storage: снимки актов.
 *
 * Один код на два хранилища. На машине разработчика это MinIO из
 * docker-compose.yml, в облаке — Yandex Object Storage (infra/storage.tf).
 * Разница только в адресе и ключе, а они приходят из окружения: S3_ENDPOINT,
 * ACTS_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (в облаке ключ забирается
 * из Lockbox при старте, см. src/secrets.ts). Имена переменных те же, что пишет
 * на ВМ cloud-init (infra/cloud-init.yaml.tftpl) — их нельзя переименовывать в
 * одном месте, не поправив другое.
 *
 * Через сервер файл не идёт ни при загрузке, ни при просмотре: телефон получает
 * подписанную ссылку и работает с хранилищем напрямую. Причина простая — кадров
 * около ста тысяч в год, и гонять их через приложение значит платить за трафик
 * дважды и держать под это память.
 *
 * Отдельно про подписи AWS SDK: начиная с версии 3.729 он по умолчанию считает
 * к каждому PUT контрольную сумму CRC32 и шлёт её заголовком. Object Storage,
 * который не Amazon, на этом спотыкается (проверено: MinIO/SeaweedFS отвечают
 * BadDigest, Yandex — тем же самым). Поэтому подсчёт включается только там, где
 * он обязателен: requestChecksumCalculation = WHEN_REQUIRED.
 */
import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Потолок на кадр. Клиент жмёт снимок до 1600 px и JPEG 0.82 — это 200–600 КБ,
 *  так что пять мегабайт означают «пришло что-то другое», а не фотографию акта. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Кадров на прибор. Заказчику на ответ хватает трёх (прибор и акт с двух
 *  сторон); десять — это запас на переснятое, а не рабочий объём. */
export const PHOTO_MAX_PER_DEVICE = 10;
/** Сколько живёт подписанная ссылка в хранилище — и на загрузку, и на просмотр. */
export const PHOTO_URL_TTL_S = 15 * 60;
/** Длинная сторона миниатюры: в акте кадр показывается квадратиком 84 px,
 *  на экране с двойной плотностью этого хватает с запасом. */
export const THUMB_PX = 320;
/** Кадр в акте всегда JPEG: его делает браузер поверителя из того, что снял телефон. */
export const PHOTO_CONTENT_TYPE = 'image/jpeg';

/** Префикс оригиналов. Правила жизненного цикла в бакете работают по префиксу
 *  (infra/storage.tf): оригиналы уезжают в холодное хранилище, миниатюры — нет,
 *  поэтому они лежат не рядом с оригиналом, а в своей ветке. */
export const ACTS_PREFIX = 'acts';
export const THUMBS_PREFIX = 'thumbs';

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Адрес вида endpoint/бакет/ключ. MinIO по-другому и не умеет без DNS,
   *  Yandex Object Storage так тоже работает — держим один вид на оба. */
  forcePathStyle: boolean;
}

/** Настройки хранилища из окружения или `null`, если хранилище не подключено.
 *  Второе — рабочее состояние машины разработчика без MinIO и тестового стенда:
 *  акт при этом заполняется целиком, а вместо снимка рисуется заглушка. */
export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig | null {
  const endpoint = env.S3_ENDPOINT?.trim();
  const bucket = env.ACTS_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const pathStyle = env.S3_FORCE_PATH_STYLE?.trim();
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.S3_REGION?.trim() || 'ru-central1',
    forcePathStyle: pathStyle ? pathStyle === 'true' : true,
  };
}

/** В ключ идут только латиница, цифры, дефис и подчёркивание: номер заявки и
 *  идентификатор прибора у нас такие и есть, а всё остальное — признак ошибки. */
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** Ключ кадра: `acts/год/месяц/заявка/прибор/кадр.jpg`.
 *
 *  Год и месяц стоят в начале нарочно: правило жизненного цикла в бакете умеет
 *  только префикс, и «всё, что старше такого-то месяца» выражается через него.
 *  Заявка и прибор дальше — чтобы по ключу было видно, чей это кадр, а имя
 *  файла с телефона в ключ не идёт: оно неуникально и приходит с кириллицей. */
export function photoKey(
  requestId: string, deviceId: number | string, at: Date = new Date(), id: string = randomUUID(),
): string {
  const yyyy = at.getFullYear();
  const mm = String(at.getMonth() + 1).padStart(2, '0');
  return `${ACTS_PREFIX}/${yyyy}/${mm}/${safe(requestId)}/${safe(String(deviceId))}/${id}.jpg`;
}

/** Ключ миниатюры для ключа оригинала: та же дорожка, другая ветка. */
export function thumbKey(key: string): string {
  return `${THUMBS_PREFIX}/${key.slice(ACTS_PREFIX.length + 1)}`;
}

/** Ключ, выданный сервером, возвращается с телефона — и должен быть тем же самым.
 *  Проверка нужна, чтобы подтверждением загрузки нельзя было записать в акт
 *  чужой объект: ключ обязан вести в заявку и прибор, к которым идёт кадр. */
export function keyBelongsTo(key: string, requestId: string, deviceId: number | string): boolean {
  const parts = key.split('/');
  return parts.length === 6 && parts[0] === ACTS_PREFIX
    && /^\d{4}$/.test(parts[1]!) && /^\d{2}$/.test(parts[2]!)
    && parts[3] === safe(requestId) && parts[4] === safe(String(deviceId))
    && /^[0-9a-f-]{36}\.jpg$/.test(parts[5]!);
}

export interface ObjectInfo {
  size: number;
  contentType: string | undefined;
}

export interface PhotoStorage {
  readonly bucket: string;
  /** Ссылка на загрузку кадра прямо в хранилище. */
  uploadUrl(key: string): Promise<string>;
  /** Ссылка на просмотр: её сервер отдаёт браузеру ответом 302. */
  viewUrl(key: string, ttlSeconds?: number): Promise<string>;
  head(key: string): Promise<ObjectInfo | null>;
  read(key: string): Promise<Buffer>;
  write(key: string, body: Buffer, contentType?: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function photoStorage(cfg: StorageConfig): PhotoStorage {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const Bucket = cfg.bucket;

  return {
    bucket: Bucket,

    uploadUrl: (key) => getSignedUrl(
      s3, new PutObjectCommand({ Bucket, Key: key, ContentType: PHOTO_CONTENT_TYPE }),
      { expiresIn: PHOTO_URL_TTL_S },
    ),

    viewUrl: (key, ttlSeconds = PHOTO_URL_TTL_S) => getSignedUrl(
      s3, new GetObjectCommand({
        Bucket, Key: key,
        ResponseContentType: PHOTO_CONTENT_TYPE,
        // Снимок акта — персональные данные: промежуточным узлам его не кэшировать.
        ResponseCacheControl: `private, max-age=${ttlSeconds}`,
      }),
      { expiresIn: ttlSeconds },
    ),

    async head(key) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(out.ContentLength ?? 0), contentType: out.ContentType };
      } catch (err) {
        // «Нет объекта» — обычный ответ на вопрос «долетел ли кадр», а не сбой.
        const name = (err as { name?: string }).name;
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return null;
        throw err;
      }
    },

    async read(key) {
      const out = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await out.Body!.transformToByteArray());
    },

    async write(key, body, contentType = PHOTO_CONTENT_TYPE) {
      await s3.send(new PutObjectCommand({
        Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length,
      }));
    },

    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
