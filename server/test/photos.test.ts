/* Фотографии акта: подписанные ссылки, лимиты, миниатюры, удаление (be-photos).
 *
 * Хранилище здесь — карта в памяти с тем же интерфейсом, что и Object Storage:
 * телефон в этих проверках изображает тест, кладя байты прямо в неё. Так
 * проверяется всё, что решает сервер, — право, лимиты, ключи, миниатюра,
 * журнал, — и ни один из этих ответов не зависит от сети.
 *
 * Настоящий круг «загрузить → миниатюра → открыть оригинал» против живого
 * S3-совместимого хранилища проверяет `scripts/check-photo-roundtrip.mts`.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { AFTER, as, draft, login, makeStand } from './helpers.ts';
import {
  PHOTO_MAX_BYTES, PHOTO_MAX_PER_DEVICE, THUMB_PX, photoKey, photoStorage, thumbKey,
  type PhotoStorage,
} from '../src/storage.ts';

const body = (res: { body: string }) => JSON.parse(res.body);

/** Хранилище в памяти: те же действия, что у бакета, без сети. */
function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage: PhotoStorage = {
    bucket: 'uchetkin-test-acts',
    uploadUrl: async (key) =>
      `https://s3.test/uchetkin-test-acts/${key}?X-Amz-Expires=900&X-Amz-Signature=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    viewUrl: async (key, ttl = 900) =>
      `https://s3.test/uchetkin-test-acts/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    head: async (key) => {
      const obj = objects.get(key);
      return obj ? { size: obj.length, contentType: 'image/jpeg' } : null;
    },
    read: async (key) => {
      const obj = objects.get(key);
      if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return obj;
    },
    write: async (key, buf) => { objects.set(key, buf); },
    remove: async (key) => { objects.delete(key); },
  };
  return { storage, objects };
}

/** Кадр, какой отдаёт телефон после сжатия: JPEG нужного размера. */
const frame = (w = 1600, h = 1200) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#7a7a7a' } })
    .jpeg({ quality: 82 }).toBuffer();

/** Акт с одним прибором: заявка, маршрут на поверителя v1, строка прибора. */
async function actWith(app: FastifyInstance) {
  const op = as(app, await login(app, 'o1'));
  const sv = as(app, await login(app, 'sv'));
  const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120009001' }))).request;
  const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120009002' }))).request;
  // Маршрут собирается минимум из двух точек — это правило прототипа.
  const route = await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' });
  assert.equal(route.statusCode, 200, route.body);
  const vf = as(app, await login(app, 'v1'));
  const made = await vf.post(`/api/requests/${a.id}/devices`, {
    service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', serial: '77-123456',
  });
  assert.equal(made.statusCode, 200, made.body);
  return { op, sv, vf, request: a, device: body(made).device };
}

describe('фото акта: загрузка в хранилище', () => {
  it('круг целиком: ссылка на загрузку, подтверждение, миниатюра, выдача оригинала', async () => {
    const { storage, objects } = memoryStorage();
    const st = await makeStand({ storage });
    const { vf, request, device } = await actWith(st.app);

    const ask = await vf.post(`/api/devices/${device.id}/photos/upload`, { size: 420_000 });
    assert.equal(ask.statusCode, 200, ask.body);
    const slot = body(ask);
    assert.match(slot.key, new RegExp(`^acts/\\d{4}/\\d{2}/${request.id}/${device.id}/[0-9a-f-]{36}\\.jpg$`),
      'ключ вида acts/год/месяц/заявка/прибор/кадр.jpg');
    assert.match(slot.url, /X-Amz-Signature=/, 'ссылка на загрузку подписана');
    assert.equal(slot.expires_in, 900, 'подписанная ссылка живёт пятнадцать минут');
    assert.equal(slot.left, PHOTO_MAX_PER_DEVICE);

    // Телефон кладёт кадр в хранилище сам — сервер его не видит.
    objects.set(slot.key, await frame());

    const done = await vf.post(`/api/devices/${device.id}/photos`,
      { key: slot.key, name: 'IMG_0042.jpg', taken_at: '12:30' });
    assert.equal(done.statusCode, 200, done.body);
    const photo = body(done).photo;
    assert.equal(photo.width, 1600, 'размеры кадра сервер берёт из самого снимка');
    assert.equal(photo.height, 1200);
    assert.ok(photo.size_bytes > 0, 'размер записан');
    assert.equal(photo.taken_at, '12:30:00');

    const thumb = objects.get(thumbKey(slot.key));
    assert.ok(thumb, 'миниатюра сложена в свою ветку ключей');
    const size = await sharp(thumb!).metadata();
    assert.equal(size.width, THUMB_PX, 'миниатюра 320 px по длинной стороне');
    assert.ok(thumb!.length < objects.get(slot.key)!.length, 'миниатюра легче оригинала');

    // Кадр виден в акте, и ссылки в нём — наши, подписанные.
    const card = body(await vf.get(`/api/requests/${request.id}`));
    const inAct = card.devices[0].photos[0];
    assert.match(inAct.url, /^\/api\/photos\/\d+\/file\?v=full&exp=\d+&sig=/);
    assert.match(inAct.thumb_url, /^\/api\/photos\/\d+\/file\?v=thumb&exp=\d+&sig=/);

    // Тег <img> не носит cookie и не умеет показывать 401 — ссылка работает без сессии.
    const open = await st.app.inject({ method: 'GET', url: inAct.url });
    assert.equal(open.statusCode, 302, open.body);
    assert.match(String(open.headers.location), new RegExp(`/${slot.key}\\?`), 'ведёт на оригинал в хранилище');
    assert.match(String(open.headers.location), /X-Amz-Signature=/, 'ссылка хранилища подписана');

    const small = await st.app.inject({ method: 'GET', url: inAct.thumb_url });
    assert.equal(small.statusCode, 302, small.body);
    assert.match(String(small.headers.location), /\/thumbs\//, 'миниатюра отдаётся из своей ветки');
    await st.close();
  });

  it('без хранилища загрузка отвечает 503, а выдача рисует заглушку с номером прибора', async () => {
    const st = await makeStand();
    const { vf, request, device } = await actWith(st.app);

    const ask = await vf.post(`/api/devices/${device.id}/photos/upload`, { size: 100_000 });
    assert.equal(ask.statusCode, 503, ask.body);
    assert.equal(body(ask).reason, 'storage');

    await st.db.query(
      `INSERT INTO photos (device_id, storage_key, name, taken_at) VALUES ($1, $2, 'IMG_1.jpg', '12:30')`,
      [device.id, photoKey(request.id, device.id)]);
    const card = body(await vf.get(`/api/requests/${request.id}`));
    const photo = card.devices[0].photos[0];
    const open = await st.app.inject({ method: 'GET', url: photo.url });
    assert.equal(open.statusCode, 200, open.body);
    assert.match(String(open.headers['content-type']), /image\//);
    assert.match(open.body, /77-123456/, 'на заглушке виден заводской номер прибора');
    await st.close();
  });
});

describe('фото акта: лимиты', () => {
  it('кадр больше пяти мегабайт не принимается ни по заявке, ни по факту', async () => {
    const { storage, objects } = memoryStorage();
    const st = await makeStand({ storage });
    const { vf, device } = await actWith(st.app);

    const big = await vf.post(`/api/devices/${device.id}/photos/upload`, { size: PHOTO_MAX_BYTES + 1 });
    assert.equal(big.statusCode, 422, big.body);
    assert.equal(body(big).reason, 'photo-size');
    assert.match(body(big).error, /5 МБ/);

    // Сказал «полмегабайта», а положил больше лимита: сервер смотрит на объект,
    // а не на слова, и в акт такой кадр не пишет.
    const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: 500_000 }));
    objects.set(slot.key, Buffer.alloc(PHOTO_MAX_BYTES + 1, 7));
    const done = await vf.post(`/api/devices/${device.id}/photos`, { key: slot.key });
    assert.equal(done.statusCode, 422, done.body);
    assert.equal(body(done).reason, 'photo-size');

    const card = body(await vf.get(`/api/requests/${slot.key.split('/')[3]}`));
    assert.equal(card.devices[0].photos.length, 0, 'в акте такого кадра нет');
    await st.close();
  });

  it('десять кадров на прибор — потолок', async () => {
    const { storage, objects } = memoryStorage();
    const st = await makeStand({ storage });
    const { vf, device } = await actWith(st.app);
    const small = await frame(200, 150);

    for (let n = 0; n < PHOTO_MAX_PER_DEVICE; n++) {
      const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: small.length }));
      objects.set(slot.key, small);
      const done = await vf.post(`/api/devices/${device.id}/photos`, { key: slot.key });
      assert.equal(done.statusCode, 200, done.body);
    }
    const over = await vf.post(`/api/devices/${device.id}/photos/upload`, { size: small.length });
    assert.equal(over.statusCode, 422, over.body);
    assert.equal(body(over).reason, 'photo-count');
    await st.close();
  });

  it('не JPEG, не тот ключ, не долетело — в акт не пишется', async () => {
    const { storage, objects } = memoryStorage();
    const st = await makeStand({ storage });
    const { vf, device } = await actWith(st.app);

    const png = await vf.post(`/api/devices/${device.id}/photos/upload`,
      { size: 100_000, content_type: 'application/pdf' });
    assert.equal(png.statusCode, 422, png.body);
    assert.equal(body(png).reason, 'photo-type');

    const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: 100_000 }));
    const missing = await vf.post(`/api/devices/${device.id}/photos`, { key: slot.key });
    assert.equal(missing.statusCode, 422, missing.body);
    assert.equal(body(missing).reason, 'photo-missing');

    const alien = await vf.post(`/api/devices/${device.id}/photos`,
      { key: 'acts/2026/09/R999/1/00000000-0000-0000-0000-000000000000.jpg' });
    assert.equal(alien.statusCode, 422, alien.body);
    assert.equal(body(alien).reason, 'photo-key');

    // Под видом кадра приехал не снимок: миниатюру из него не сделать.
    objects.set(slot.key, Buffer.from('это не фотография, а текст'));
    const junk = await vf.post(`/api/devices/${device.id}/photos`, { key: slot.key });
    assert.equal(junk.statusCode, 422, junk.body);
    assert.equal(body(junk).reason, 'photo-type');
    await st.close();
  });
});

describe('фото акта: кому можно', () => {
  it('чужой акт поверителю закрыт', async () => {
    const { storage } = memoryStorage();
    const st = await makeStand({ storage });
    const { device } = await actWith(st.app);
    const other = as(st.app, await login(st.app, 'v2'));
    const ask = await other.post(`/api/devices/${device.id}/photos/upload`, { size: 100_000 });
    assert.equal(ask.statusCode, 422, ask.body);
    assert.equal(body(ask).reason, 'role');
    await st.close();
  });

  it('удаляет только руководитель, кадр уходит из акта, файл остаётся, в журнале — запись', async () => {
    const { storage, objects } = memoryStorage();
    const st = await makeStand({ storage });
    const { vf, sv, request, device } = await actWith(st.app);

    const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: 300_000 }));
    objects.set(slot.key, await frame(800, 600));
    const photo = body(await vf.post(`/api/devices/${device.id}/photos`,
      { key: slot.key, name: 'IMG_7.jpg' })).photo;

    const byVerifier = await vf.del(`/api/photos/${photo.id}`);
    assert.equal(byVerifier.statusCode, 403, 'поверитель снимки не удаляет');

    const gone = await sv.del(`/api/photos/${photo.id}`);
    assert.equal(gone.statusCode, 200, gone.body);

    const card = body(await vf.get(`/api/requests/${request.id}`));
    assert.equal(card.devices[0].photos.length, 0, 'кадр ушёл из акта');
    assert.ok(objects.has(slot.key), 'файл в хранилище остался: срок хранения не меньше шести лет');

    const { rows } = await st.db.query<Record<string, unknown>>(
      `SELECT actor_id, actor_role, action, entity, entity_id, before FROM audit_log
        WHERE entity = 'photos' ORDER BY id DESC`);
    assert.equal(rows.length, 1, 'удаление попало в журнал действий');
    assert.equal(rows[0]!.actor_id, 'sv');
    assert.equal(rows[0]!.action, 'удаление');
    assert.equal(rows[0]!.entity_id, String(photo.id));
    assert.equal((rows[0]!.before as { storage_key: string }).storage_key, slot.key,
      'в журнале виден ключ убранного кадра');

    const again = await sv.del(`/api/photos/${photo.id}`);
    assert.equal(again.statusCode, 422, 'второй раз тот же кадр не убрать');

    const open = await st.app.inject({ method: 'GET', url: photo.url });
    assert.equal(open.statusCode, 404, 'убранный кадр по старой ссылке не открывается');
    await st.close();
  });
});

describe('фото акта: подписи ссылок', () => {
  it('подделанная, просроченная и переставленная на другой вид ссылка не пускают', async () => {
    const { storage, objects } = memoryStorage();
    const st = await makeStand({ storage });
    const { vf, request, device } = await actWith(st.app);
    const slot = body(await vf.post(`/api/devices/${device.id}/photos/upload`, { size: 300_000 }));
    objects.set(slot.key, await frame(800, 600));
    await vf.post(`/api/devices/${device.id}/photos`, { key: slot.key });
    const card = body(await vf.get(`/api/requests/${request.id}`));
    const photo = card.devices[0].photos[0];

    const forged = await st.app.inject({ method: 'GET', url: photo.url.replace(/sig=.*/, 'sig=подделка') });
    assert.equal(forged.statusCode, 403, 'подделанная подпись не пускает');

    const stale = await st.app.inject({ method: 'GET', url: photo.url.replace(/exp=\d+/, 'exp=1000') });
    assert.equal(stale.statusCode, 403, 'просроченная ссылка не пускает');

    const swapped = await st.app.inject({ method: 'GET', url: photo.url.replace('v=full', 'v=thumb') });
    assert.equal(swapped.statusCode, 403, 'подпись оригинала не открывает миниатюру: вид входит в подпись');

    // Ссылка в хранилище не переживает нашу: срок у неё тот же остаток.
    const open = await st.app.inject({ method: 'GET', url: photo.url });
    const ttl = Number(new URL(String(open.headers.location)).searchParams.get('X-Amz-Expires'));
    assert.ok(ttl > 0 && ttl <= 900, `срок ссылки хранилища ${ttl} — не больше пятнадцати минут`);
    await st.close();
  });

  it('ключ подписи Object Storage подписывает ссылку, а не ходит в сеть', async () => {
    const storage = photoStorage({
      endpoint: 'https://storage.yandexcloud.net', region: 'ru-central1',
      bucket: 'uchetkin-dev-acts', accessKeyId: 'YCAJE-проверочный',
      secretAccessKey: 'секрет', forcePathStyle: true,
    });
    const key = photoKey('R1042', 375, new Date('2026-09-16T10:00:00Z'), '00000000-0000-0000-0000-000000000001');
    assert.equal(key, 'acts/2026/09/R1042/375/00000000-0000-0000-0000-000000000001.jpg');
    assert.equal(thumbKey(key), 'thumbs/2026/09/R1042/375/00000000-0000-0000-0000-000000000001.jpg');

    const url = new URL(await storage.uploadUrl(key));
    assert.equal(url.host, 'storage.yandexcloud.net');
    assert.equal(url.pathname, `/uchetkin-dev-acts/${key}`);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.match(String(url.searchParams.get('X-Amz-Credential')), /^YCAJE-проверочный\/\d{8}\/ru-central1\/s3\//);
    assert.match(String(url.searchParams.get('X-Amz-Signature')), /^[0-9a-f]{64}$/);

    const other = new URL(await storage.uploadUrl(thumbKey(key)));
    assert.notEqual(url.searchParams.get('X-Amz-Signature'), other.searchParams.get('X-Amz-Signature'),
      'подпись считается по ключу: другой объект — другая подпись');
  });
});
