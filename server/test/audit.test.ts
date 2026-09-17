/* Журнал действий: что и как в нём оказывается (пункт be-audit).
 *
 * Проверяется не «есть ли строка в таблице», а то, ради чего журнал заводился:
 * по записи должно быть видно, кто, когда и что именно поменял — с точностью до
 * поля. Поэтому почти каждая проверка здесь смотрит в разницу «до/после», а не
 * в один только факт записи.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AFTER, TOMORROW, as, draft, login, makeStand, type Stand } from './helpers.ts';

const body = (res: { body: string }) => JSON.parse(res.body);

interface Entry {
  id: string; at: string; actor_id: string | null; actor_role: string | null;
  action: string; entity: string; entity_id: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  ip: string | null; user_agent: string | null;
}

/** Журнал прямо из базы: экран смотрит на него же, но через своё API. */
const journal = async (st: Stand, where = '', params: unknown[] = []): Promise<Entry[]> => {
  const { rows } = await st.db.query<Entry>(
    `SELECT * FROM audit_log ${where ? 'WHERE ' + where : ''} ORDER BY id`, params);
  return rows;
};

/** Записи по одной заявке — в том порядке, в котором они случились. */
const forRequest = (st: Stand, id: string) =>
  journal(st, `entity = 'requests' AND entity_id = $1`, [id]);

describe('журнал действий: изменения', () => {
  it('создание, правка и перенос заявки дают три записи с разницей по полям', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests',
        draft({ comment_operator: 'домофон не работает' }))).request;

      await op.patch(`/api/requests/${made.id}`, { comment_operator: 'звонить заранее', flat: '7' });
      const moved = await op.patch(`/api/requests/${made.id}`, { date: AFTER });
      assert.equal(moved.statusCode, 200, moved.body);

      const rows = await forRequest(st, made.id);
      assert.equal(rows.length, 3, `записей должно быть три, а их ${rows.length}`);
      assert.deepEqual(rows.map((r) => r.action), ['создание', 'изменение', 'изменение']);
      assert.ok(rows.every((r) => r.actor_id === 'o1' && r.actor_role === 'operator'),
        'в каждой записи виден оператор и его роль на тот момент');

      // 1. Приём: «до» нет, «после» — вся принятая заявка.
      assert.equal(rows[0]!.before, null);
      assert.equal(rows[0]!.after?.name, 'Иванов И.И.');
      assert.equal(rows[0]!.after?.comment_operator, 'домофон не работает');
      assert.equal(rows[0]!.after?.status, 'создана');

      // 2. Правка: только изменённые поля, и с обеих сторон.
      assert.deepEqual(Object.keys(rows[1]!.after ?? {}).sort(), ['comment_operator', 'flat']);
      assert.equal(rows[1]!.before?.comment_operator, 'домофон не работает');
      assert.equal(rows[1]!.after?.comment_operator, 'звонить заранее');
      assert.equal(rows[1]!.before?.flat, '5');
      assert.equal(rows[1]!.after?.flat, '7');

      // 3. Перенос: видно и старую дату, и новую.
      assert.equal(rows[2]!.before?.date, TOMORROW);
      assert.equal(rows[2]!.after?.date, AFTER);
    } finally {
      await st.close();
    }
  });

  it('правка прайса попадает в журнал с прежней и новой ценой', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const res = await sv.patch('/api/services/wv', { price_person: 950 });
      assert.equal(res.statusCode, 200, res.body);

      const rows = await journal(st, `entity = 'services'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.action, 'изменение');
      assert.equal(rows[0]!.entity_id, 'wv');
      assert.equal(rows[0]!.actor_id, 'sv');
      assert.equal(rows[0]!.before?.price_person, 900);
      assert.equal(rows[0]!.after?.price_person, 950);
      // Ставки не трогали — в разнице их быть не должно.
      assert.deepEqual(Object.keys(rows[0]!.after ?? {}), ['price_person']);
    } finally {
      await st.close();
    }
  });

  it('отказ правила в журнал не идёт: действия не было', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const denied = await op.patch('/api/services/wv', { price_person: 1 });
      assert.equal(denied.statusCode, 422, 'прайс оператору не отдан');
      assert.equal((await journal(st, `entity = 'services'`)).length, 0);
    } finally {
      await st.close();
    }
  });

  it('удаление пишется целиком: строки больше нет, и в журнале остаётся вся', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const op = as(st.app, await login(st.app, 'o1'));
      const a = body(await op.post('/api/requests', draft({ phone: '9120000001' }))).request;
      const b = body(await op.post('/api/requests', draft({ phone: '9120000002' }))).request;
      const route = body(await sv.post('/api/routes',
        { date: TOMORROW, city: 'Екатеринбург', request_ids: [a.id, b.id], verifier_id: 'v1' })).route;

      const dropped = await sv.del(`/api/routes/${route.id}`);
      assert.equal(dropped.statusCode, 200, dropped.body);

      const rows = await journal(st, `entity = 'routes' AND action = 'удаление'`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.entity_id, route.id);
      assert.equal(rows[0]!.before?.city, 'Екатеринбург');
      assert.equal(rows[0]!.before?.verifier_id, 'v1');
      assert.equal(rows[0]!.after, null, 'маршрута больше нет — «после» пустое');
    } finally {
      await st.close();
    }
  });

  it('действие без правки самой строки пишет то, с чем пришёл запрос', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', draft({ time_slot: 12 }))).request;
      const shifted = await op.post(`/api/requests/${made.id}/shift`, { delta: 1 });
      assert.equal(shifted.statusCode, 200, shifted.body);

      const rows = await forRequest(st, made.id);
      const last = rows.at(-1)!;
      assert.equal(last.action, 'изменение');
      assert.equal(last.before?.time_slot, 12);
      assert.equal(last.after?.time_slot, 13);
    } finally {
      await st.close();
    }
  });
});

describe('журнал действий: вход и обращение к данным', () => {
  it('вход, выход и неудачная попытка входа записываются каждый по-своему', async () => {
    const st = await makeStand();
    try {
      const bad = await st.app.inject({
        method: 'POST', url: '/api/auth/login', payload: { login: 'o1', password: 'не тот' },
      });
      assert.equal(bad.statusCode, 401);
      const cookie = await login(st.app, 'o1');
      await as(st.app, cookie).post('/api/auth/logout');

      const rows = await journal(st, `entity = 'staff'`);
      assert.deepEqual(rows.map((r) => r.action), ['неудачный вход', 'вход', 'выход']);
      assert.equal(rows[0]!.actor_id, null, 'кто стучался — неизвестно, известен только логин');
      assert.equal(rows[0]!.entity_id, 'o1');
      assert.equal(rows[1]!.actor_id, 'o1');
      assert.equal(rows[1]!.actor_role, 'operator');
      assert.equal(rows[2]!.actor_id, 'o1');
      assert.ok(rows.every((r) => !JSON.stringify(r.after ?? {}).includes('не тот')),
        'пароль в журнал не попадает ни при каких обстоятельствах');
    } finally {
      await st.close();
    }
  });

  it('просмотр карточки клиента и обращение к записи разговора — отдельные действия', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const seen = await op.get('/api/clients?phone=%2B7%20(912)%20345-67-89');
      assert.equal(seen.statusCode, 200, seen.body);

      const looks = await journal(st, `entity = 'clients'`);
      assert.equal(looks.length, 1);
      assert.equal(looks[0]!.action, 'просмотр');
      assert.equal(looks[0]!.actor_id, 'o1');

      // Записи разговора ещё нет (её докачивает worker, пункт int-novofon), но
      // обращение к ней — это обращение к персональным данным, и оно видно.
      await st.db.query(
        `INSERT INTO calls (pbx_id, direction, from_number, to_number, client_phone, started, record_key)
         VALUES ('pbx-1', 'входящий', '+79120000001', '+73432000000', '79120000001', now(), 'calls/2026/09/1.mp3')`);
      const { rows: calls } = await st.db.query<{ id: string }>('SELECT id FROM calls');
      const heard = await op.get(`/api/calls/${calls[0]!.id}/record`);
      assert.equal(heard.statusCode, 503, 'хранилище к стенду не подключено — отказ честный');

      const listened = await journal(st, `entity = 'calls' AND action = 'прослушивание'`);
      assert.equal(listened.length, 1, 'обращение к записи разговора видно даже без самой записи');
      assert.equal(listened[0]!.entity_id, String(calls[0]!.id));

      const verifier = as(st.app, await login(st.app, 'v1'));
      assert.equal((await verifier.get(`/api/calls/${calls[0]!.id}/record`)).statusCode, 403,
        'поверителю записи разговоров не положены');
    } finally {
      await st.close();
    }
  });
});

describe('экран руководителя: отбор, поиск и выгрузка', () => {
  /** Стенд с несколькими действиями разных людей — на нём и проверяется отбор. */
  async function stand(): Promise<{ st: Stand; sv: ReturnType<typeof as>; requestId: string }> {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const made = body(await op.post('/api/requests', draft())).request;
    await op.patch(`/api/requests/${made.id}`, { comment_operator: 'перезвонить' });
    await sv.patch('/api/services/wv', { price_person: 990 });
    return { st, sv, requestId: made.id };
  }

  it('список отдаётся руководителю и отбирается по сотруднику, сущности и датам', async () => {
    const { st, sv } = await stand();
    try {
      const all = body(await sv.get('/api/audit?limit=500'));
      assert.ok(all.total >= 5, `в журнале ${all.total} записей`);
      assert.ok(all.entries[0].at >= all.entries.at(-1).at, 'сверху — свежее');
      assert.ok(all.entries.some((e: Entry) => e.actor_id === 'o1'), 'виден и оператор');

      const byActor = body(await sv.get('/api/audit?actor_id=o1'));
      assert.ok(byActor.entries.length > 0);
      assert.ok(byActor.entries.every((e: Entry) => e.actor_id === 'o1'));

      const byEntity = body(await sv.get('/api/audit?entity=services'));
      assert.equal(byEntity.entries.length, 1);
      assert.equal(byEntity.entries[0].entity_id, 'wv');
      assert.equal(byEntity.entries[0].actor_name, 'Панченко И.', 'сотрудник назван по имени');

      const today = new Date().toISOString().slice(0, 10);
      assert.ok(body(await sv.get(`/api/audit?from=${today}&to=${today}`)).total >= 5,
        'сегодняшние записи попадают в отбор по датам');
      assert.equal(body(await sv.get('/api/audit?from=2000-01-01&to=2000-01-02')).total, 0,
        'в пустом промежутке записей нет');
    } finally {
      await st.close();
    }
  });

  it('поиск идёт по номеру заявки, а не только по столбцу', async () => {
    const { st, sv, requestId } = await stand();
    try {
      const found = body(await sv.get(`/api/audit?q=${requestId}`));
      assert.ok(found.total >= 2, `по номеру заявки нашлось ${found.total}`);
      assert.ok(found.entries.every((e: Entry) =>
        e.entity_id === requestId || JSON.stringify(e.after ?? {}).includes(requestId)
        || JSON.stringify(e.before ?? {}).includes(requestId)));
      assert.equal(body(await sv.get('/api/audit?q=R-НЕТ-ТАКОЙ')).total, 0);
    } finally {
      await st.close();
    }
  });

  it('оператору и поверителю журнал не показывают', async () => {
    const { st } = await stand();
    try {
      for (const who of ['o1', 'v1']) {
        const res = await as(st.app, await login(st.app, who)).get('/api/audit');
        assert.equal(res.statusCode, 403, `${who} не должен видеть журнал`);
      }
    } finally {
      await st.close();
    }
  });

  it('выгрузка отдаёт CSV по тому же отбору и сама попадает в журнал', async () => {
    const { st, sv } = await stand();
    try {
      const res = await sv.get('/api/audit/export.csv?entity=services');
      assert.equal(res.statusCode, 200, res.body);
      assert.match(String(res.headers['content-type']), /text\/csv/);
      assert.match(String(res.headers['content-disposition']), /attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"/);

      const lines = res.body.split('\r\n').filter(Boolean);
      assert.ok(res.body.startsWith('﻿'), 'метка порядка байтов — иначе Excel покажет кракозябры');
      assert.equal(lines.length, 2, 'заголовок и одна отобранная строка');
      assert.match(lines[0]!, /Время;Сотрудник;Роль;Действие;Сущность;Запись;Изменения;Адрес/);
      assert.match(lines[1]!, /Панченко И\.;supervisor;изменение;services;wv;price_person: 900 → 990/);

      const exports = await journal(st, `action = 'выгрузка'`);
      assert.equal(exports.length, 1, 'выгрузка журнала — тоже действие с персональными данными');
      assert.equal(exports[0]!.actor_id, 'sv');
    } finally {
      await st.close();
    }
  });
});

describe('журнал действий: неизменяемость и срок хранения', () => {
  it('через API журнал не правится и не удаляется', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const entry = body(await sv.get('/api/audit')).entries[0];
      assert.ok(entry, 'записи есть — иначе проверять нечего');
      for (const res of [
        await sv.del(`/api/audit/${entry.id}`),
        await sv.patch(`/api/audit/${entry.id}`, { action: 'ничего не было' }),
        await sv.post('/api/audit', { action: 'приписка' }),
      ]) {
        assert.equal(res.statusCode, 404, `такого адреса нет и не должно быть: ${res.body}`);
      }
    } finally {
      await st.close();
    }
  });

  it('база не даёт переписать запись, а удалить — раньше трёх лет', async () => {
    const st = await makeStand();
    try {
      await login(st.app, 'sv');
      const { rows } = await st.db.query<{ id: string }>('SELECT id FROM audit_log ORDER BY id LIMIT 1');
      const id = rows[0]!.id;

      await assert.rejects(() => st.db.query('UPDATE audit_log SET action = $2 WHERE id = $1', [id, 'ничего']),
        /не правится/, 'правка записи журнала невозможна и на уровне базы');
      await assert.rejects(() => st.db.query('DELETE FROM audit_log WHERE id = $1', [id]),
        /три года/, 'свежую запись не удалить даже напрямую');

      // Запись старше срока хранения убирается — этим и живёт `npm run audit:prune`.
      await st.db.query(
        `INSERT INTO audit_log (at, actor_id, action, entity, entity_id)
         VALUES (now() - interval '4 years', 'sv', 'вход', 'staff', 'sv')`);
      const { rows: old } = await st.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE at < now() - interval '3 years'`);
      assert.equal(Number(old[0]!.n), 1);
      await st.db.query(`DELETE FROM audit_log WHERE at < now() - interval '3 years'`);
      const { rows: left } = await st.db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE at < now() - interval '3 years'`);
      assert.equal(Number(left[0]!.n), 0, 'просроченные записи уходят чисткой');
    } finally {
      await st.close();
    }
  });
});
