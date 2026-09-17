/* Круг снимка против живого хранилища: загрузить → миниатюра → открыть оригинал.
 *
 * Проверки из `test/photos.test.ts` обходятся картой в памяти: они про то, что
 * решает сервер. Здесь наоборот — важно, что подпись принимает настоящее
 * S3-совместимое хранилище, а не наша заглушка. Поэтому кадр действительно
 * уезжает по подписанной ссылке, миниатюра действительно ложится в бакет, а
 * оригинал действительно скачивается обратно и сверяется побайтно.
 *
 * Хранилище берётся из окружения, по умолчанию — MinIO из docker-compose.yml:
 *
 *   docker compose up -d minio minio-init
 *   npm run check:photos
 *
 * Против другого адреса (Yandex Object Storage, dev-контур) — тем же запуском
 * с S3_ENDPOINT, ACTS_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY в окружении.
 * База при этом не нужна настоящая: под приложением тот же PGlite, что и в тестах.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { as, draft, login, makeStand, AFTER } from '../test/helpers.ts';
import {
  PHOTO_MAX_BYTES, THUMB_PX, photoStorage, storageConfig, thumbKey,
} from '../src/storage.ts';

/** Настройки по умолчанию — MinIO из docker-compose.yml. */
const env: NodeJS.ProcessEnv = {
  S3_ENDPOINT: process.env.S3_ENDPOINT || 'http://127.0.0.1:9000',
  ACTS_BUCKET: process.env.ACTS_BUCKET || 'uchetkin-acts',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || 'uchetkin',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || 'uchetkin-secret',
  S3_REGION: process.env.S3_REGION,
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
};

const cfg = storageConfig(env);
if (!cfg) throw new Error('Не сложились настройки хранилища: нужны S3_ENDPOINT, ACTS_BUCKET и ключ.');
const storage = photoStorage(cfg);
const body = (res: { body: string }) => JSON.parse(res.body);
const sha = (buf: Buffer | Uint8Array) => createHash('sha256').update(buf).digest('hex');

console.log(`Хранилище: ${cfg.endpoint}, бакет ${cfg.bucket}`);

// Бакет в облаке заводит Terraform, на машине разработчика — minio-init.
// Если его почему-то нет, заводим сами: проверка не должна падать на этом.
const s3 = new S3Client({
  endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
});
await s3.send(new CreateBucketCommand({ Bucket: cfg.bucket })).catch((err: { name?: string }) => {
  if (!String(err.name).includes('Exists') && err.name !== 'BucketAlreadyOwnedByYou') {
    console.log(`  бакет не создан (${err.name}) — считаем, что он уже есть`);
  }
});

const st = await makeStand({ storage });
let failed = 0;
const step = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`  ok · ${name}`);
  } catch (err) {
    console.error(`  НЕ ПРОШЛО · ${name}: ${(err as Error).message}`);
    failed++;
  }
};

try {
  // Акт: заявка, маршрут на поверителя, строка прибора.
  const op = as(st.app, await login(st.app, 'o1'));
  const sv = as(st.app, await login(st.app, 'sv'));
  const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120009001' }))).request;
  const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120009002' }))).request;
  await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' });
  const vf = as(st.app, await login(st.app, 'v1'));
  const device = body(await vf.post(`/api/requests/${a.id}/devices`, {
    service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', serial: '77-123456',
  })).device;

  // Кадр, какой отдаёт телефон после сжатия: 1600 px по длинной стороне, JPEG.
  const frame = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#6a6a6a' } })
    .jpeg({ quality: 82 }).toBuffer();
  let key = '';

  await step('сервер выдал подписанную ссылку на загрузку', async () => {
    const res = await vf.post(`/api/devices/${device.id}/photos/upload`, { size: frame.length });
    assert.equal(res.statusCode, 200, res.body);
    const slot = body(res);
    key = slot.key;
    assert.match(key, new RegExp(`^acts/\\d{4}/\\d{2}/${a.id}/${device.id}/[0-9a-f-]{36}\\.jpg$`));
    assert.equal(slot.expires_in, 900);
    assert.match(slot.url, /X-Amz-Signature=[0-9a-f]{64}/);
  });

  await step('кадр уехал в хранилище напрямую по этой ссылке', async () => {
    const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: frame.length }));
    key = slot.key;
    const put = await fetch(slot.url, {
      method: 'PUT', body: frame, headers: { 'content-type': slot.content_type },
    });
    assert.equal(put.status, 200, `хранилище ответило ${put.status}: ${await put.text()}`);
    const info = await storage.head(key);
    assert.equal(info?.size, frame.length, 'в бакете лежит кадр целиком');
  });

  await step('подделанная подпись хранилищем не принимается', async () => {
    const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: frame.length }));
    const forged = slot.url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`);
    const put = await fetch(forged, { method: 'PUT', body: frame, headers: { 'content-type': 'image/jpeg' } });
    assert.equal(put.status, 403, `ожидался отказ, пришло ${put.status}`);
  });

  let photo: Record<string, string> = {};
  await step('подтверждение: кадр записан в акт, миниатюра 320 px сложена в бакет', async () => {
    const res = await vf.post(`/api/devices/${device.id}/photos`,
      { key, name: 'IMG_0042.jpg', taken_at: '12:30' });
    assert.equal(res.statusCode, 200, res.body);
    photo = body(res).photo;
    assert.equal(Number(photo.width), 1600);
    assert.equal(Number(photo.height), 1200);
    assert.equal(Number(photo.size_bytes), frame.length);

    const thumb = await storage.read(thumbKey(key));
    const meta = await sharp(thumb).metadata();
    assert.equal(meta.width, THUMB_PX, `миниатюра ${meta.width} px вместо ${THUMB_PX}`);
    assert.ok(thumb.length < frame.length, 'миниатюра легче оригинала');
  });

  await step('оригинал открывается по нашей ссылке и совпадает побайтно', async () => {
    const open = await st.app.inject({ method: 'GET', url: photo.url! });
    assert.equal(open.statusCode, 302, open.body);
    const at = String(open.headers.location);
    assert.match(at, /X-Amz-Signature=/, 'сервер ведёт на подписанную ссылку хранилища');
    const got = await fetch(at);
    assert.equal(got.status, 200, `хранилище ответило ${got.status}`);
    const back = Buffer.from(await got.arrayBuffer());
    assert.equal(sha(back), sha(frame), 'скачанный кадр не тот, что загружали');
  });

  await step('миниатюра открывается своей ссылкой', async () => {
    const small = await st.app.inject({ method: 'GET', url: photo.thumb_url! });
    assert.equal(small.statusCode, 302, small.body);
    const at = String(small.headers.location);
    assert.match(at, /\/thumbs\//);
    const got = await fetch(at);
    assert.equal(got.status, 200, `хранилище ответило ${got.status}`);
    const meta = await sharp(Buffer.from(await got.arrayBuffer())).metadata();
    assert.equal(meta.width, THUMB_PX);
  });

  await step('кадр больше пяти мегабайт в акт не проходит', async () => {
    const over = await vf.post(`/api/devices/${device.id}/photos/upload`, { size: PHOTO_MAX_BYTES + 1 });
    assert.equal(over.statusCode, 422, over.body);
    assert.equal(body(over).reason, 'photo-size');

    // Соврал про размер и залил больше лимита: сервер смотрит на сам объект.
    const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: 300_000 }));
    const big = await sharp({ create: { width: 5200, height: 4000, channels: 3, background: '#111' } })
      .png({ compressionLevel: 0 }).toBuffer();
    assert.ok(big.length > PHOTO_MAX_BYTES, `подопытный файл вышел ${big.length} байт`);
    const put = await fetch(slot.url, {
      method: 'PUT', body: big, headers: { 'content-type': 'image/jpeg' },
    });
    assert.equal(put.status, 200, 'хранилище кадр приняло — решать серверу');
    const res = await vf.post(`/api/devices/${device.id}/photos`, { key: slot.key });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(body(res).reason, 'photo-size');
  });

  await step('удаление руководителем: кадр ушёл из акта, файл в бакете остался', async () => {
    const gone = await sv.del(`/api/photos/${photo.id}`);
    assert.equal(gone.statusCode, 200, gone.body);
    const card = body(await vf.get(`/api/requests/${a.id}`));
    assert.equal(card.devices[0].photos.length, 0, 'кадр ушёл из акта');
    assert.ok(await storage.head(key), 'файл в хранилище остался: срок хранения не меньше шести лет');
  });
} finally {
  await st.close();
}

if (failed) {
  console.error(`\nКруг снимка не прошёл: ${failed} проверок.`);
  process.exit(1);
}
console.log('\nКруг снимка прошёл целиком: загрузка, миниатюра, выдача оригинала, лимиты, удаление.');
