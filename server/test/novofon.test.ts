/* Телефония Новофон, часть 1: приёмник событий и карточка (int-novofon).
 *
 * Проверяется то, что решает сервер, и без сети: подпись уведомления, отказ
 * чужой подписи, повторная доставка, карточка клиента на шине событий.
 * Линия, звонок из карточки, записи и настройка кабинета — в
 * `novofon-line.test.ts`: каждый тест поднимает свой стенд PGlite, и два
 * десятка стендов в одном процессе на машине с четырьмя гигабайтами вязнут.
 * Настоящий круг «входящий → карточка → заявка → запись в бакете» против
 * эмулятора АТС и живого хранилища проверяет `scripts/check-novofon-flow.mts`.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { as, draft, login, makeStand, type Stand } from './helpers.ts';
import { canCall, canReceive, novofonConfig } from '../src/novofon/config.ts';
import { novofonEnvFrom } from '../src/secrets.ts';
import { v1AuthHeader, v1EventSignature, v1QueryString } from '../src/novofon/signature.ts';
import { atsTime, fromV1, fromV2 } from '../src/novofon/events.ts';
import type { LineEvent } from '../src/novofon/bus.ts';
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

/** Ловушка на шину: события пульта, не поднимая SSE. */
function catcher(app: FastifyInstance, staffId: string): LineEvent[] {
  const seen: LineEvent[] = [];
  app.calls.subscribe(staffId, (e) => seen.push(e));
  return seen;
}

describe('Новофон: подпись уведомлений', () => {
  it('API 1.0: уведомление с верной подписью принято, звонок заведён', async (t) => {
    const st = await v1Stand();
    t.after(() => st.close());
    const res = await v1Post(st.app, START);
    assert.equal(res.statusCode, 200);
    const { rows } = await st.db.query('SELECT pbx_id, direction, from_number, client_phone, platform FROM calls');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      pbx_id: 'in-0001', direction: 'входящий', from_number: '79123456789',
      client_phone: '+79123456789', platform: 'v1',
    });
  });

  it('API 1.0: чужая подпись — 401, и звонок не заводится', async (t) => {
    const st = await v1Stand();
    t.after(() => st.close());
    const res = await v1Post(st.app, START, 'bm90LWEtc2lnbmF0dXJl');
    assert.equal(res.statusCode, 401);
    const { rows } = await st.db.query('SELECT id FROM calls');
    assert.equal(rows.length, 0);
    // Непринятое уведомление всё равно в журнале: по нему и видно, что кто-то
    // стучится с чужой подписью.
    const { rows: events } = await st.db.query<{ ok: boolean }>('SELECT ok FROM call_events');
    assert.deepEqual(events, [{ ok: false }]);
  });

  it('API 1.0: подпись считается по полям своего события', async () => {
    // Для NOTIFY_ANSWER подписывается destination, а не called_did: подпись,
    // посчитанная «как у NOTIFY_START», не сойдётся.
    const answer = {
      event: 'NOTIFY_ANSWER', call_start: '2026-09-17 10:15:04', pbx_call_id: 'in-0001',
      caller_id: '79123456789', destination: '102', internal: '102',
    };
    assert.notEqual(v1EventSignature(answer, SECRET), v1EventSignature({ ...answer, event: 'NOTIFY_START' }, SECRET));
    assert.equal(v1EventSignature({ event: 'NOTIFY_НЕТ_ТАКОГО' }, SECRET), null);
  });

  it('API 1.0: событие без описанной подписи не принимается', async (t) => {
    const st = await v1Stand();
    t.after(() => st.close());
    const res = await v1Post(st.app, { event: 'NOTIFY_НЕТ_ТАКОГО', pbx_call_id: 'x' }, 'подпись');
    assert.equal(res.statusCode, 400);
  });

  it('API 1.0: подпись запроса к АТС собрана по описанному правилу', () => {
    // Строка параметров и подпись считаются по одному и тому же тексту:
    // ключи по алфавиту, пробел плюсом.
    const query = v1QueryString({ to: '79123456789', from: '102', sip: '102' });
    assert.equal(query, 'from=102&sip=102&to=79123456789');
    const header = v1AuthHeader('/v1/request/callback/', query, 'ключ', SECRET);
    assert.match(header, /^ключ:[A-Za-z0-9+/]+=*$/);
  });

  it('Платформа 2.0: секрет в адресе пускает, чужой — нет', async (t) => {
    const st = await v2Stand();
    t.after(() => st.close());
    const event = {
      event: 'call_started', call_session_id: 'cs-1', numa: '79123456789',
      numb: '73432000000', start_time: '2026-09-17 10:15:00',
    };
    const ok = await st.app.inject({ method: 'POST', url: `/api/webhooks/novofon/${encodeURIComponent(SECRET)}`, payload: event });
    assert.equal(ok.statusCode, 200);
    const nope = await st.app.inject({ method: 'POST', url: '/api/webhooks/novofon/не-тот-секрет', payload: event });
    assert.equal(nope.statusCode, 401);
    const bare = await st.app.inject({ method: 'POST', url: '/api/webhooks/novofon', payload: event });
    assert.equal(bare.statusCode, 401);
  });

  it('Платформа 2.0: уведомление методом GET принимается так же', async (t) => {
    const st = await v2Stand();
    t.after(() => st.close());
    const query = new URLSearchParams({
      event: 'call_started', call_session_id: 'cs-2', numa: '79123456789',
      numb: '73432000000', start_time: '2026-09-17 10:20:00',
    });
    const res = await st.app.inject({
      method: 'GET', url: `/api/webhooks/novofon/${encodeURIComponent(SECRET)}?${query}`,
    });
    assert.equal(res.statusCode, 200);
    const { rows } = await st.db.query<{ pbx_id: string }>('SELECT pbx_id FROM calls');
    assert.deepEqual(rows, [{ pbx_id: 'cs-2' }]);
  });

  it('Уведомление с чужого адреса не принимается, если список адресов задан', async (t) => {
    const st = await v2Stand({ NOVOFON_ALLOWED_IPS: '37.139.38.215' });
    t.after(() => st.close());
    const res = await st.app.inject({
      method: 'POST', url: `/api/webhooks/novofon/${encodeURIComponent(SECRET)}`,
      payload: { event: 'call_started', call_session_id: 'cs-3', numa: '79123456789', numb: '73432000000' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('Без секрета приёмник закрыт', async (t) => {
    const st = await makeStand({ novofon: novofonConfig({} as NodeJS.ProcessEnv) });
    t.after(() => st.close());
    const res = await st.app.inject({ method: 'POST', url: '/api/webhooks/novofon', payload: { event: 'call_started' } });
    assert.equal(res.statusCode, 503);
  });
});

describe('Новофон: разбор событий', () => {
  it('время АТС читается как московское', () => {
    assert.equal(atsTime('2026-09-17 10:15:00'), '2026-09-17T07:15:00.000Z');
  });

  it('итог звонка переводится в слова системы', () => {
    const end = fromV1({ ...START, event: 'NOTIFY_END', disposition: 'no answer', duration: '0' })!;
    assert.equal(end.kind, 'пропущен');
    assert.equal(end.disposition, 'пропущен');
    const talk = fromV1({ ...START, event: 'NOTIFY_END', disposition: 'answered', duration: '95' })!;
    assert.equal(talk.kind, 'завершение');
    assert.equal(talk.durationSec, 95);
  });

  it('уведомление 2.0 о записи несёт ссылку на файл', () => {
    const ev = fromV2({
      event: 'call_recorded', call_session_id: 'cs-9', communication_id: '555',
      file_link: 'https://app.novofon.ru/system/media/talk/555/abc/',
    })!;
    assert.equal(ev.kind, 'запись');
    assert.equal(ev.recordUrl, 'https://app.novofon.ru/system/media/talk/555/abc/');
  });
});

describe('Новофон: ключи кабинета из секрета Lockbox', () => {
  it('из секрета разбираются все записи кабинета, а не один секрет приёмника', () => {
    // Записи заводит человек в кабинете Новофон и кладёт в Lockbox; имена здесь
    // те же, что в docs/ops.md, «Включение телефонии».
    assert.deepEqual(novofonEnvFrom({
      webhook_secret: 'секрет-приёмника',
      access_token: 'ключ-api',
      virtual_number: '73432269924',
      group_id: '77',
      allowed_ips: '37.139.38.215',
    }), {
      NOVOFON_WEBHOOK_SECRET: 'секрет-приёмника',
      NOVOFON_ACCESS_TOKEN: 'ключ-api',
      NOVOFON_VIRTUAL_NUMBER: '73432269924',
      NOVOFON_GROUP_ID: '77',
      NOVOFON_ALLOWED_IPS: '37.139.38.215',
    });
  });

  it('пустой секрет — рабочее состояние, чужая запись под приёмник не уходит', () => {
    assert.deepEqual(novofonEnvFrom({}), {});
    // Раньше под секрет приёмника бралась «первая попавшаяся» запись: с живым
    // кабинетом это значило бы ключ API в роли пароля приёмника.
    assert.deepEqual(novofonEnvFrom({ пароль_от_чего_то: 'x' }), {});
    assert.deepEqual(novofonEnvFrom({ webhook_secret: '  ' }), {});
  });

  it('половина записей — половина возможностей: приём есть, звонка нет', () => {
    const env = novofonEnvFrom({ webhook_secret: 'секрет-приёмника' }) as NodeJS.ProcessEnv;
    const cfg = novofonConfig(env);
    assert.equal(canReceive(cfg), true);
    assert.equal(canCall(cfg), false, 'без access_token и номера звонить нечем');
    const full = novofonConfig(novofonEnvFrom({
      webhook_secret: 'секрет-приёмника', access_token: 'ключ-api', virtual_number: '73432269924',
    }) as NodeJS.ProcessEnv);
    assert.equal(canCall(full), true);
  });
});

describe('Новофон: связь учётной записи с сотрудником АТС', () => {
  const atsWith = (employees: unknown[]) => ({ employees: async () => employees } as unknown as NovofonApi);

  it('расхождение показывается, а правит его руководитель', async (t) => {
    const st = await v2Stand(
      { NOVOFON_ACCESS_TOKEN: 'токен', NOVOFON_VIRTUAL_NUMBER: '73432269924' },
      {
        novofonClient: atsWith([
          { id: 4242, full_name: 'Ефимова О.', extension: '102', phone_numbers: [{ id: 5001 }] },
          { id: 4300, full_name: 'Кто-то из кабинета', extension: '109', phone_numbers: [{ id: 5009 }] },
        ]),
      });
    t.after(() => st.close());
    const sv = as(st.app, await login(st.app, 'sv'));

    const before = body(await sv.get('/api/calls/employees'));
    const o1 = before.staff.find((r: { staff_id: string }) => r.staff_id === 'o1');
    assert.equal(o1.state, 'не связан');
    assert.equal(o1.ats_employee_id, 4242);
    assert.equal(o1.ats_phone_number_id, 5001);
    // Руководителя в АТС нет — это видно, а не молчится.
    assert.equal(before.staff.find((r: { staff_id: string }) => r.staff_id === 'sv').state, 'нет в АТС');
    assert.deepEqual(before.extra, [{ id: 4300, full_name: 'Кто-то из кабинета', ext: '109' }]);

    const saved = await sv.patch('/api/staff/o1', { novofon_employee_id: 4242, novofon_phone_number_id: 5001 });
    assert.equal(saved.statusCode, 200);
    const { rows } = await st.db.query<{ novofon_employee_id: number; novofon_phone_number_id: number }>(
      'SELECT novofon_employee_id, novofon_phone_number_id FROM staff WHERE id = $1', ['o1']);
    assert.deepEqual(rows[0], { novofon_employee_id: 4242, novofon_phone_number_id: 5001 });

    const after = body(await sv.get('/api/calls/employees'));
    assert.equal(after.staff.find((r: { staff_id: string }) => r.staff_id === 'o1').state, 'совпало');

    // Правка связи — действие руководителя, и оно попадает в журнал вместе с тем,
    // что именно поменялось.
    const { rows: log } = await st.db.query<{ action: string; changed: string }>(
      `SELECT action, after::text AS changed FROM audit_log WHERE entity = 'staff' AND entity_id = 'o1'
        ORDER BY id DESC LIMIT 1`);
    assert.equal(log[0]?.action, 'изменение');
    assert.match(log[0]!.changed, /novofon_employee_id/);
  });

  it('связь снимается тем же способом, а оператору список АТС не положен', async (t) => {
    const st = await v2Stand(
      { NOVOFON_ACCESS_TOKEN: 'токен', NOVOFON_VIRTUAL_NUMBER: '73432269924' },
      { novofonClient: atsWith([{ id: 4242, full_name: 'Ефимова О.', extension: '102', phone_numbers: [{ id: 5001 }] }]) });
    t.after(() => st.close());
    const sv = as(st.app, await login(st.app, 'sv'));
    await sv.patch('/api/staff/o1', { novofon_employee_id: 4242, novofon_phone_number_id: 5001 });
    assert.equal((await sv.patch('/api/staff/o1', { novofon_employee_id: null, novofon_phone_number_id: null })).statusCode, 200);
    const { rows } = await st.db.query<{ novofon_employee_id: number | null }>(
      'SELECT novofon_employee_id FROM staff WHERE id = $1', ['o1']);
    assert.equal(rows[0]!.novofon_employee_id, null);

    const op = as(st.app, await login(st.app, 'o1'));
    assert.equal((await op.get('/api/calls/employees')).statusCode, 403);
    assert.equal((await op.patch('/api/staff/o1', { novofon_employee_id: 4242 })).statusCode, 403);
  });

  it('без ключей АТС список сотрудников не спрашивается, а отвечает отказом', async (t) => {
    const st = await v2Stand();
    t.after(() => st.close());
    const sv = as(st.app, await login(st.app, 'sv'));
    assert.equal((await sv.get('/api/calls/employees')).statusCode, 503);
  });
});

describe('Новофон: карточка у оператора', () => {
  it('входящий поднимает карточку известного клиента у оператора линии', async (t) => {
    const st = await v1Stand();
    t.after(() => st.close());
    const op = as(st.app, await login(st.app, 'o1'));
    // Клиент заводится обычным приёмом заявки: карточка потом ищется по номеру.
    await op.post('/api/requests', draft({ phone: '+7 (912) 345-67-89' }));
    const seen = catcher(st.app, 'o1');
    await v1Post(st.app, START);
    await v1Post(st.app, {
      event: 'NOTIFY_ANSWER', call_start: '2026-09-17 10:15:04', pbx_call_id: 'in-0001',
      caller_id: '79123456789', destination: '102', internal: '102',
    });
    const answer = seen.find((e) => e.kind === 'ответ');
    assert.ok(answer, 'событие ответа не дошло до оператора');
    assert.equal((answer.client as { name?: string } | null)?.name, 'Иванов И.И.');
    assert.equal((answer.history as unknown[]).length, 1);
    // Оператор определяется по внутреннему номеру из события.
    const { rows } = await st.db.query<{ operator_id: string }>('SELECT operator_id FROM calls WHERE pbx_id = $1', ['in-0001']);
    assert.equal(rows[0]?.operator_id, 'o1');
  });

  it('повторная доставка того же события не заводит второй звонок', async (t) => {
    const st = await v1Stand();
    t.after(() => st.close());
    await v1Post(st.app, START);
    await v1Post(st.app, START);
    await v1Post(st.app, { ...START, event: 'NOTIFY_END', disposition: 'answered', duration: '42' });
    const { rows } = await st.db.query<{ n: string | number; duration_sec: number }>(
      'SELECT count(*) AS n, max(duration_sec) AS duration_sec FROM calls');
    // count(*) — bigint: pg отдаёт его строкой, PGlite в стенде — числом.
    assert.equal(Number(rows[0]!.n), 1);
    assert.equal(rows[0]!.duration_sec, 42);
  });

  it('неизвестный номер поднимает полосу без карточки', async (t) => {
    const st = await v1Stand();
    t.after(() => st.close());
    const seen = catcher(st.app, 'o1');
    await v1Post(st.app, { ...START, caller_id: '79990001122' });
    const ring = seen.find((e) => e.kind === 'входящий');
    assert.ok(ring);
    assert.equal(ring.client, null);
    assert.equal(ring.phone, '+79990001122');
  });
});
