/* Телефония Новофон, часть 2: линия, звонок из карточки, записи, кабинет
 * (int-novofon). Первая часть — приёмник и карточка — в `novofon.test.ts`;
 * разделено по числу стендов на процесс, а не по смыслу.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { as, login, makeStand, type Stand } from './helpers.ts';
import { novofonConfig } from '../src/novofon/config.ts';
import { v1EventSignature } from '../src/novofon/signature.ts';
import type { NovofonApi } from '../src/novofon/api.ts';
import type { PhotoStorage } from '../src/storage.ts';

const body = (res: { body: string }) => JSON.parse(res.body);

const SECRET = 'секрет-кабинета-новофон';

const v1Stand = () => makeStand({
  novofon: novofonConfig({ NOVOFON_PLATFORM: 'v1', NOVOFON_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv),
});
const v2Stand = (over: Record<string, string> = {}, extra: Parameters<typeof makeStand>[0] = {}) => makeStand({
  ...extra,
  novofon: novofonConfig({ NOVOFON_PLATFORM: 'v2', NOVOFON_WEBHOOK_SECRET: SECRET, ...over } as NodeJS.ProcessEnv),
});

/** Уведомление API 1.0 так, как его шлёт АТС: форма и подпись в заголовке. */
function v1Post(app: FastifyInstance, payload: Record<string, string>, signature?: string) {
  const sign = signature ?? v1EventSignature(payload, SECRET)!;
  return app.inject({
    method: 'POST',
    url: '/api/webhooks/novofon',
    headers: { 'content-type': 'application/x-www-form-urlencoded', signature: sign },
    payload: new URLSearchParams(payload).toString(),
  });
}

const START = {
  event: 'NOTIFY_START',
  call_start: '2026-09-17 10:15:00',
  pbx_call_id: 'in-0001',
  caller_id: '79123456789',
  called_did: '73432000000',
};

describe('Новофон: линия оператора и распределение вызовов', () => {
  it('АТС спрашивает, кому звонить, и получает номера тех, кто на линии', async (t) => {
    const st = await v2Stand();
    t.after(() => st.close());
    const op = as(st.app, await login(st.app, 'o1'));
    const url = `/api/webhooks/novofon/routing/${encodeURIComponent(SECRET)}?call_session_id=cs-10&numa=79123456789&numb=73432000000`;

    // Никто не на смене — звонок идёт всем операторам, как в АТС сейчас.
    const idle = body(await st.app.inject({ method: 'GET', url }));
    assert.deepEqual(idle.phones.sort(), ['101', '102']);

    assert.equal((await op.post('/api/calls/line', { on_shift: true })).statusCode, 200);
    const onShift = body(await st.app.inject({ method: 'GET', url }));
    assert.deepEqual(onShift.phones, ['102']);

    // Разговор и постобработка — это пауза: новые вызовы не приходят.
    await op.post('/api/calls/line', { on_shift: true, paused: true });
    const paused = body(await st.app.inject({ method: 'GET', url }));
    assert.deepEqual(paused.phones.sort(), ['101', '102']);
  });

  it('отметка линии без настроенной АТС остаётся только в CRM', async (t) => {
    const st = await v2Stand();
    t.after(() => st.close());
    const op = as(st.app, await login(st.app, 'o1'));
    const out = body(await op.post('/api/calls/line', { on_shift: true }));
    assert.equal(out.synced, false);
    const mine = body(await op.get('/api/calls/line'));
    assert.equal(mine.on_shift, true);
  });

  it('отметка линии уходит в АТС, когда сотрудник с ней связан', async (t) => {
    const calls: { group: number; numberId: number; available: boolean }[] = [];
    const api = {
      setAvailable: async (group: number, numberId: number, available: boolean) => {
        calls.push({ group, numberId, available });
      },
    } as unknown as NovofonApi;
    const st = await v2Stand({ NOVOFON_GROUP_ID: '77' }, { novofonClient: api });
    t.after(() => st.close());
    await st.db.query('UPDATE staff SET novofon_phone_number_id = 5001 WHERE id = $1', ['o1']);
    const op = as(st.app, await login(st.app, 'o1'));
    const out = body(await op.post('/api/calls/line', { on_shift: true, paused: false }));
    assert.equal(out.synced, true);
    assert.deepEqual(calls, [{ group: 77, numberId: 5001, available: true }]);
  });
});

describe('Новофон: звонок клиенту из карточки', () => {
  it('звонок уходит в АТС от имени оператора', async (t) => {
    const asked: Record<string, unknown>[] = [];
    const api = {
      startEmployeeCall: async (a: Record<string, unknown>) => { asked.push(a); return { sessionId: 'cs-100' }; },
    } as unknown as NovofonApi;
    const st = await v2Stand(
      { NOVOFON_ACCESS_TOKEN: 'токен', NOVOFON_VIRTUAL_NUMBER: '73432000000' }, { novofonClient: api });
    t.after(() => st.close());
    await st.db.query('UPDATE staff SET novofon_employee_id = 4242 WHERE id = $1', ['o1']);
    const op = as(st.app, await login(st.app, 'o1'));
    const out = body(await op.post('/api/calls/dial', { phone: '+7 (912) 345-67-89', request_id: 'R1' }));
    assert.equal(out.session_id, 'cs-100');
    // Номер уходит в международном виде и без плюса, как просит АТС.
    assert.deepEqual(asked, [{ contact: '79123456789', employeeId: 4242, employeePhone: '102', externalId: 'R1' }]);
  });

  it('без связи учётной записи с сотрудником АТС звонок отклоняется понятным отказом', async (t) => {
    const api = { startEmployeeCall: async () => ({ sessionId: null }) } as unknown as NovofonApi;
    const st = await v2Stand(
      { NOVOFON_ACCESS_TOKEN: 'токен', NOVOFON_VIRTUAL_NUMBER: '73432000000' }, { novofonClient: api });
    t.after(() => st.close());
    const op = as(st.app, await login(st.app, 'o1'));
    const res = await op.post('/api/calls/dial', { phone: '9123456789' });
    assert.equal(res.statusCode, 422);
    assert.equal(body(res).reason, 'novofon-employee');
  });

  it('без ключей АТС кнопка звонка отвечает, что звонить надо из софтфона', async (t) => {
    const st = await v2Stand();
    t.after(() => st.close());
    const op = as(st.app, await login(st.app, 'o1'));
    const res = await op.post('/api/calls/dial', { phone: '9123456789' });
    assert.equal(res.statusCode, 503);
  });

  it('поверителю телефония не положена', async (t) => {
    const st = await v2Stand();
    t.after(() => st.close());
    const vf = as(st.app, await login(st.app, 'v1'));
    assert.equal((await vf.get('/api/calls')).statusCode, 403);
    assert.equal((await vf.post('/api/calls/dial', { phone: '9123456789' })).statusCode, 403);
    assert.equal((await vf.get('/api/calls/stream')).statusCode, 403);
  });
});

describe('Новофон: запись разговора', () => {
  /** Бакет записей в памяти: те же действия, что у Object Storage, без сети. */
  function memoryRecords() {
    const objects = new Map<string, Buffer>();
    const storage: PhotoStorage = {
      bucket: 'uchetkin-test-records',
      uploadUrl: async (key) => `https://s3.test/records/${key}`,
      viewUrl: async (key, ttl = 900) => `https://s3.test/records/${key}?X-Amz-Expires=${ttl}`,
      head: async (key) => (objects.has(key) ? { size: objects.get(key)!.length, contentType: 'audio/mpeg' } : null),
      read: async (key) => objects.get(key)!,
      write: async (key, buf) => { objects.set(key, buf); },
      remove: async (key) => { objects.delete(key); },
    };
    return { storage, objects };
  }

  async function withRecord(st: Stand): Promise<string> {
    await v1Post(st.app, START);
    await st.db.query(
      `UPDATE calls SET record_key = 'calls/2026/09/1.mp3', record_status = 'сохранена' WHERE pbx_id = $1`, ['in-0001']);
    const { rows } = await st.db.query<{ id: string }>('SELECT id::text FROM calls WHERE pbx_id = $1', ['in-0001']);
    return rows[0]!.id;
  }

  it('ссылку на запись получает руководитель, оператор — нет', async (t) => {
    const { storage } = memoryRecords();
    const st = await makeStand({
      records: storage,
      novofon: novofonConfig({ NOVOFON_PLATFORM: 'v1', NOVOFON_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv),
    });
    t.after(() => st.close());
    const id = await withRecord(st);
    const sv = as(st.app, await login(st.app, 'sv'));
    const out = body(await sv.get(`/api/calls/${id}/record`));
    assert.match(out.url, /calls\/2026\/09\/1\.mp3/);
    const op = as(st.app, await login(st.app, 'o1'));
    assert.equal((await op.get(`/api/calls/${id}/record`)).statusCode, 403);
  });

  it('обращение к записи попадает в журнал действий', async (t) => {
    const { storage } = memoryRecords();
    const st = await makeStand({
      records: storage,
      novofon: novofonConfig({ NOVOFON_PLATFORM: 'v1', NOVOFON_WEBHOOK_SECRET: SECRET } as NodeJS.ProcessEnv),
    });
    t.after(() => st.close());
    const id = await withRecord(st);
    const sv = as(st.app, await login(st.app, 'sv'));
    await sv.get(`/api/calls/${id}/record`);
    const { rows } = await st.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'calls' AND action = 'прослушивание'`);
    assert.equal(rows.length, 1);
  });

  it('пока запись не забрана, ссылки нет и это видно по состоянию', async (t) => {
    const st = await v1Stand();
    t.after(() => st.close());
    await v1Post(st.app, START);
    await v1Post(st.app, { event: 'NOTIFY_RECORD', pbx_call_id: 'in-0001', call_id_with_rec: 'rec-1' });
    const { rows } = await st.db.query<{ id: string; record_status: string; record_ref: string }>(
      'SELECT id::text, record_status, record_ref FROM calls WHERE pbx_id = $1', ['in-0001']);
    assert.equal(rows[0]!.record_ref, 'rec-1');
    // Бакета в этом стенде нет, поэтому запись остаётся ждать, а не теряется.
    assert.ok(['ждёт', 'ошибка'].includes(rows[0]!.record_status));
    const sv = as(st.app, await login(st.app, 'sv'));
    assert.equal((await sv.get(`/api/calls/${rows[0]!.id}/record`)).statusCode, 404);
  });
});

describe('Новофон: настройка кабинета', () => {
  it('адреса приёмников считаются от PUBLIC_BASE_URL, а не зашиты в коде', async (t) => {
    const st = await v2Stand({ PUBLIC_BASE_URL: 'https://crm-temp.example.net' });
    t.after(() => st.close());
    const sv = as(st.app, await login(st.app, 'sv'));
    const out = body(await sv.get('/api/calls/settings'));
    assert.equal(out.public_base_url, 'https://crm-temp.example.net');
    assert.deepEqual(out.urls.map((u: { url: string }) => u.url), [
      `https://crm-temp.example.net/api/webhooks/novofon/${encodeURIComponent(SECRET)}`,
      `https://crm-temp.example.net/api/webhooks/novofon/routing/${encodeURIComponent(SECRET)}`,
    ]);
    // Оператору настройки телефонии не показываются.
    const op = as(st.app, await login(st.app, 'o1'));
    assert.equal((await op.get('/api/calls/settings')).statusCode, 403);
  });
});
