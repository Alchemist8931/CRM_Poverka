/* API целиком: вход, роли и те же правила, но уже через HTTP.
 *
 * Запросы идут через `app.inject()` — без сети и без порта, но по всему пути:
 * разбор тела, проверка схемы, сессия, обработчик, база. База — настоящий
 * PostgreSQL в WebAssembly, поэтому ограничения и транзакции проверяются тоже.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AFTER, TOMORROW, as, draft, login, makeStand } from './helpers.ts';

/** Ответ разбирается один раз: в проверках нужны и код, и тело. */
const body = (res: { body: string }) => JSON.parse(res.body);

describe('служебное', () => {
  it('/health отвечает 200 и говорит, что база жива', async () => {
    const st = await makeStand();
    const res = await st.app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(body(res).status, 'ok');
    assert.deepEqual(body(res).db, 'ok');
    await st.close();
  });

  it('/docs отдаёт описание OpenAPI со всеми разделами API', async () => {
    const st = await makeStand();
    const res = await st.app.inject({ method: 'GET', url: '/docs' });
    assert.equal(res.statusCode, 200);
    const doc = body(res);
    assert.match(String(doc.openapi), /^3\./);
    assert.equal(doc.info.title, 'CRM «Учёткин» — API');
    for (const path of ['/api/auth/login', '/api/requests', '/api/routes', '/api/slots',
                        '/api/days/{date}', '/api/wait-list', '/api/earnings', '/api/webhooks/novofon']) {
      assert.ok(doc.paths[path], `в описании нет ${path}`);
    }
    await st.close();
  });
});

describe('вход и сессия', () => {
  it('неверный пароль не пускает, верный выдаёт cookie и роль', async () => {
    const st = await makeStand();
    const bad = await st.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'o1', password: 'нет' } });
    assert.equal(bad.statusCode, 401);
    const ok = await st.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'o1', password: '1234' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(body(ok).user.role, 'operator');
    assert.match(String(ok.headers['set-cookie']), /uchetkin_session=.*HttpOnly/i);
    await st.close();
  });

  it('без сессии API закрыт, с сессией отвечает «кто я»', async () => {
    const st = await makeStand();
    const no = await st.app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(no.statusCode, 401);
    const cookie = await login(st.app, 'sv');
    const me = await as(st.app, cookie).get('/api/auth/me');
    assert.equal(me.statusCode, 200);
    assert.equal(body(me).user.id, 'sv');
    await st.close();
  });

  it('подделанная cookie не принимается', async () => {
    const st = await makeStand();
    const res = await st.app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: 'uchetkin_session=sv.99999999999999.подпись' },
    });
    assert.equal(res.statusCode, 401);
    await st.close();
  });
});

describe('замок даты через API', () => {
  it('оператор не запишет на дату, ушедшую под маршруты, а руководитель запишет', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));

    const first = await op.post('/api/requests', draft({ date: AFTER }));
    assert.equal(first.statusCode, 200, first.body);

    // Руководитель сел собирать маршруты — дата закрылась для приёма.
    const open = await sv.post(`/api/route-builder/${AFTER}`);
    assert.equal(open.statusCode, 200);

    const locked = await op.post('/api/requests', draft({ date: AFTER, phone: '9120000002' }));
    assert.equal(locked.statusCode, 422);
    assert.match(body(locked).error, /приём закрыт — идёт сборка маршрутов/);
    assert.equal(body(locked).reason, 'lock');

    // Руководителю замок не помеха: он ставит адрес и в готовый маршрут.
    const bySv = await sv.post('/api/requests', draft({ date: AFTER, phone: '9120000003' }));
    assert.equal(bySv.statusCode, 200, bySv.body);

    // Конструктор закрыли — приём по дате снова открыт.
    assert.equal((await sv.del(`/api/route-builder/${AFTER}`)).statusCode, 200);
    const again = await op.post('/api/requests', draft({ date: AFTER, phone: '9120000004' }));
    assert.equal(again.statusCode, 200, again.body);
    await st.close();
  });

  it('собранный маршрут закрывает дату так же, как открытый конструктор', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120000005' }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120000006' }))).request;
    const route = await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' });
    assert.equal(route.statusCode, 200, route.body);

    const locked = await op.post('/api/requests', draft({ date: AFTER, phone: '9120000007' }));
    assert.equal(locked.statusCode, 422);
    assert.match(body(locked).error, /маршруты на дату уже собраны/);
    await st.close();
  });
});

describe('потолок по городу через API', () => {
  it('до +10 % оператор записывает, дальше приём по городу закрыт', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    // План на завтра — две заявки по Екатеринбургу.
    for (const n of [1, 2]) {
      const res = await op.post('/api/requests', draft({ phone: `912000010${n}` }));
      assert.equal(res.statusCode, 200, res.body);
    }
    const over = await op.post('/api/requests', draft({ phone: '9120001103' }));
    assert.equal(over.statusCode, 422);
    assert.match(body(over).error, /Приём по городу закрыт/);
    assert.equal(body(over).reason, 'cap');

    // Руководитель дописывает адрес руками и отвечает за перебор сам.
    const bySv = await sv.post('/api/requests', draft({ phone: '9120001104' }));
    assert.equal(bySv.statusCode, 200, bySv.body);
    await st.close();
  });

  it('город без выезда в этот день не принимает заявку', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const res = await op.post('/api/requests', draft({ city: 'Нижний Тагил' }));
    assert.equal(res.statusCode, 422);
    assert.match(body(res).error, /не выезжает/);
    await st.close();
  });
});

describe('подсказка дат', () => {
  it('предлагает даты под услуги, которые закрывает смена, и молчит про остальные', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const water = body(await op.get(`/api/slots?svcs=wv&city=Екатеринбург&from=${TOMORROW}&days=3`)).slots;
    assert.deepEqual(water.map((s: { ds: string }) => s.ds), [TOMORROW, AFTER]);
    assert.equal(water[0].plan, 2);

    // Поверку тепла в смене не умеет никто — дат нет.
    const heat = body(await op.get(`/api/slots?svcs=hv&city=Екатеринбург&from=${TOMORROW}&days=3`)).slots;
    assert.deepEqual(heat, []);

    // Замену умеет только v1, и завтра он в смене, а послезавтра смена из него же.
    const swap = body(await op.get(`/api/slots?svcs=wv,wr&city=Екатеринбург&from=${TOMORROW}&days=3`)).slots;
    assert.equal(swap.length, 2);
    assert.equal(swap[0].crew, 1);
    await st.close();
  });

  it('дата под замком в подсказку не попадает', async () => {
    const st = await makeStand();
    const sv = as(st.app, await login(st.app, 'sv'));
    await sv.post(`/api/route-builder/${TOMORROW}`);
    const slots = body(await sv.get(`/api/slots?svcs=wv&city=Екатеринбург&from=${TOMORROW}&days=3`)).slots;
    assert.deepEqual(slots.map((s: { ds: string }) => s.ds), [AFTER]);
    await st.close();
  });
});

describe('доступ по ролям', () => {
  it('прайс и ставки меняет только руководитель', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const denied = await op.patch('/api/services/wv', { price_person: 1000 });
    assert.equal(denied.statusCode, 422);
    assert.match(body(denied).error, /только руководитель/);

    const ok = await sv.patch('/api/services/wv', { price_person: 1000, rate_verifier: 300 });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(body(ok).service.price_person, 1000);
    await st.close();
  });

  it('поверитель видит только свои маршруты', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120002001' }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120002002' }))).request;
    const route = body(await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' })).route;

    const mine = as(st.app, await login(st.app, 'v1'));
    const other = as(st.app, await login(st.app, 'v2'));
    assert.equal(body(await mine.get('/api/routes')).routes.length, 1);
    assert.equal(body(await other.get('/api/routes')).routes.length, 0, 'чужой маршрут в списке не показывается');

    const peek = await other.get(`/api/routes/${route.id}`);
    assert.equal(peek.statusCode, 422);
    assert.match(body(peek).error, /только свои маршруты/);
    assert.equal((await mine.get(`/api/routes/${route.id}`)).statusCode, 200);
    await st.close();
  });

  it('свой заработок видит каждый, чужой — только руководитель', async () => {
    const st = await makeStand();
    const v2 = as(st.app, await login(st.app, 'v2'));
    const sv = as(st.app, await login(st.app, 'sv'));
    assert.equal((await v2.get('/api/earnings')).statusCode, 200);
    const alien = await v2.get('/api/earnings?staff_id=v1');
    assert.equal(alien.statusCode, 422);
    assert.match(body(alien).error, /только руководитель/);
    assert.equal((await sv.get('/api/earnings?staff_id=v1')).statusCode, 200);
    // Сдельная по всем — экран руководителя.
    assert.equal((await v2.get('/api/payroll')).statusCode, 403);
    assert.equal((await sv.get('/api/payroll')).statusCode, 200);
    await st.close();
  });
});

describe('планирование дня через API', () => {
  it('больше пяти городов и больше четырёх операторов не записать', async () => {
    const st = await makeStand();
    const sv = as(st.app, await login(st.app, 'sv'));
    const ok = await sv.put(`/api/days/${AFTER}`, {
      cities: ['Екатеринбург', 'Нижний Тагил'],
      plan: { 'Екатеринбург': 10, 'Нижний Тагил': 5 }, crew: ['v1', 'v2'], ops: ['o1'],
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(body(ok).day.cities.length, 2);

    const many = await sv.put(`/api/days/${AFTER}`, {
      cities: ['Екатеринбург', 'Нижний Тагил', 'Екатеринбург', 'Нижний Тагил', 'Екатеринбург', 'Нижний Тагил'],
    });
    assert.equal(many.statusCode, 422);
    assert.match(body(many).error, /не больше 5 городов/);

    const crowd = await sv.put(`/api/days/${AFTER}`, { ops: ['o1', 'o1', 'o1', 'o1', 'o1'] });
    assert.equal(crowd.statusCode, 422);
    assert.match(body(crowd).error, /не больше 4 операторов/);
    await st.close();
  });

  it('день планирует руководитель, оператор его только читает', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const read = await op.get(`/api/days/${TOMORROW}`);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(body(read).works.sort(), ['wr', 'wv']);
    assert.equal(body(read).load.p, 2);
    const write = await op.put(`/api/days/${TOMORROW}`, { plan: { 'Екатеринбург': 99 } });
    assert.equal(write.statusCode, 403);
    await st.close();
  });
});

describe('акт: закрытие и возврат позиции', () => {
  it('без заводского номера позицию не закрыть, с номером — цена и ставки ложатся снимком', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120003001' }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120003002' }))).request;
    await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' });

    const vf = as(st.app, await login(st.app, 'v1'));
    const empty = await vf.post(`/api/requests/${a.id}/close`, {});
    assert.equal(empty.statusCode, 422);
    assert.match(body(empty).error, /нет приборов/);

    const dev = body(await vf.post(`/api/requests/${a.id}/devices`, {
      service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', pensioner: true,
    })).device;
    const noSerial = await vf.post(`/api/requests/${a.id}/close`, {});
    assert.equal(noSerial.statusCode, 422);
    assert.match(body(noSerial).error, /заводские номера/i);

    await vf.patch(`/api/devices/${dev.id}`, { serial: '12345678', reading: '00123' });
    const closed = await vf.post(`/api/requests/${a.id}/close`, { method: 'наличные' });
    assert.equal(closed.statusCode, 200, closed.body);
    // Пенсионерская цена — 760, сдельная поверителю от скидки не зависит — 280.
    assert.equal(body(closed).price, 760);
    assert.equal(body(closed).wage, 280);
    assert.equal(body(closed).payment.method, 'наличные');
    assert.equal(body(closed).payment.amount, 760);

    const card = body(await vf.get(`/api/requests/${a.id}`));
    assert.equal(card.request.status, 'выполнена');
    assert.equal(card.request.verifier_id, 'v1');
    assert.equal(card.devices[0].price_charged, 760);
    assert.equal(card.devices[0].rate_verifier, 280);

    // Переписанный прайс не трогает закрытый акт: там лежит снимок.
    await sv.patch('/api/services/wv', { price_pensioner: 5000, rate_verifier: 9000 });
    const after = body(await vf.get(`/api/requests/${a.id}`));
    assert.equal(after.devices[0].price_charged, 760);
    assert.equal(after.devices[0].rate_verifier, 280);

    // Возврат позиции снимает выполнение и отметку о принятии денег.
    const reopened = await vf.post(`/api/requests/${a.id}/reopen`, {});
    assert.equal(reopened.statusCode, 200);
    const back = body(await vf.get(`/api/requests/${a.id}`));
    assert.equal(back.request.status, 'в маршруте');
    assert.equal(back.payment.paid_at, null);
    await st.close();
  });

  it('чужой акт поверителю не открыть', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120004001' }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120004002' }))).request;
    await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' });
    const alien = as(st.app, await login(st.app, 'v2'));
    const res = await alien.post(`/api/requests/${a.id}/devices`, {
      service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС',
    });
    assert.equal(res.statusCode, 422);
    assert.match(body(res).error, /только по своим адресам/);
    await st.close();
  });
});

describe('не обслуженный адрес и лист ожидания', () => {
  it('причина «Другое» требует пояснения, а отметка отправляет адрес в лист ожидания', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120005001' }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120005002' }))).request;
    const route = body(await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' })).route;
    const vf = as(st.app, await login(st.app, 'v1'));

    const silent = await vf.post(`/api/routes/${route.id}/stops/${a.id}/unserved`, { reason: 'Другое', note: ' ' });
    assert.equal(silent.statusCode, 422);
    assert.match(body(silent).error, /опишите словами/);

    const marked = await vf.post(`/api/routes/${route.id}/stops/${a.id}/unserved`, {
      reason: 'Нет дома', note: 'не открыли',
    });
    assert.equal(marked.statusCode, 200, marked.body);
    const waits = body(await op.get('/api/wait-list?state=не обработана')).waits;
    assert.equal(waits.length, 1);
    assert.equal(waits[0].request_id, a.id);
    assert.equal(waits[0].kind, 'адрес');

    // Закрыть не обслуженную точку нельзя, пока её не вернули в работу.
    await vf.post(`/api/requests/${a.id}/devices`, { service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', serial: '1' });
    const close = await vf.post(`/api/requests/${a.id}/close`, {});
    assert.equal(close.statusCode, 422);
    assert.match(body(close).error, /не обслуженной/);

    const cleared = await vf.del(`/api/routes/${route.id}/stops/${a.id}/unserved`);
    assert.equal(cleared.statusCode, 200);
    assert.equal(body(await op.get('/api/wait-list?state=не обработана')).waits.length, 0);
    await st.close();
  });
});

describe('маршруты: точки, обзвон и перенос заявки', () => {
  it('адрес добавляется и исключается, точки переставляются, обзвон меняет статусы', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120006001', time_slot: 11 }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120006002', time_slot: 15 }))).request;
    const c = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120006003', time_slot: 13 }))).request;
    const route = body(await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id] })).route;
    assert.equal(route.status, 'черновик');

    // Порядок объезда выстраивается по окну приезда.
    const added = await sv.post(`/api/routes/${route.id}/stops`, { request_id: c.id });
    assert.equal(added.statusCode, 200, added.body);
    const stops = body(await sv.get(`/api/routes/${route.id}`)).stops;
    assert.deepEqual(stops.map((s: { request_id: string }) => s.request_id), [a.id, c.id, b.id]);

    // Точку можно переставить руками.
    assert.equal((await sv.post(`/api/routes/${route.id}/stops/${c.id}/move`, { delta: -1 })).statusCode, 200);
    const moved = body(await sv.get(`/api/routes/${route.id}`)).stops;
    assert.deepEqual(moved.map((s: { request_id: string }) => s.request_id), [c.id, a.id, b.id]);

    // Обзвон: отказ отменяет заявку, перенос возвращает её оператору.
    assert.equal((await op.post(`/api/routes/${route.id}/stops/${a.id}/call`, { result: 'подтверждена' })).statusCode, 200);
    await op.post(`/api/routes/${route.id}/stops/${b.id}/call`, { result: 'отказ' });
    await op.post(`/api/routes/${route.id}/stops/${c.id}/call`, { result: 'перенос' });
    assert.equal(body(await op.get(`/api/requests/${b.id}`)).request.status, 'отменена');
    assert.equal(body(await op.get(`/api/requests/${c.id}`)).request.status, 'перенос');
    // Все точки обзвонены — маршрут готов к выдаче.
    assert.equal(body(await sv.get(`/api/routes/${route.id}`)).route.status, 'обзвонен');

    // Исключённый адрес возвращается в свободные.
    assert.equal((await sv.del(`/api/routes/${route.id}/stops/${b.id}`)).statusCode, 200);
    const freed = body(await op.get(`/api/requests/${b.id}`)).request;
    assert.equal(freed.route_id, null);
    assert.equal(freed.status, 'создана');
    await st.close();
  });

  it('окно приезда сдвигается по часам и не выходит за рабочий день', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const r = body(await op.post('/api/requests', draft({ phone: '9120007001', time_slot: 20 }))).request;
    const late = await op.post(`/api/requests/${r.id}/shift`, { delta: 1 });
    assert.equal(late.statusCode, 422);
    const ok = await op.post(`/api/requests/${r.id}/shift`, { delta: -1 });
    assert.equal(ok.statusCode, 200);
    assert.equal(body(ok).request.time_slot, 19);
    await st.close();
  });

  it('перенос заявки на другую дату снимает её с маршрута', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120008001' }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120008002' }))).request;
    const route = body(await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id] })).route;

    const moved = await sv.patch(`/api/requests/${a.id}`, { date: TOMORROW });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(body(moved).moved, true);
    assert.equal(body(moved).request.route_id, null);
    assert.equal(body(moved).request.status, 'создана');
    assert.equal(body(await sv.get(`/api/routes/${route.id}`)).stops.length, 1);
    await st.close();
  });
});

describe('деньги', () => {
  it('по счёту платит только юрлицо, «не оплачено» — это долг на ноль рублей', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const r = body(await op.post('/api/requests', draft({ phone: '9120009001' }))).request;
    const denied = await op.put(`/api/requests/${r.id}/payment`, { method: 'по счёту', amount: 900 });
    assert.equal(denied.statusCode, 422);
    assert.match(body(denied).error, /только юрлицо/);

    const debt = await op.put(`/api/requests/${r.id}/payment`, { method: 'не оплачено', amount: 900 });
    assert.equal(debt.statusCode, 200, debt.body);
    assert.equal(body(debt).payment.amount, 0);

    const status = await op.get(`/api/payments/${body(debt).payment.id}/status`);
    assert.equal(status.statusCode, 200);
    assert.equal(body(status).provider, null, 'провайдера эквайринга пока нет');
    assert.equal(body(status).state, 'долг');
    await st.close();
  });

  it('подотчёт поверителя: собрано минус сдельная минус сданное', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const sv = as(st.app, await login(st.app, 'sv'));
    const a = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120010001' }))).request;
    const b = body(await op.post('/api/requests', draft({ date: AFTER, phone: '9120010002' }))).request;
    await sv.post('/api/routes', { date: AFTER, request_ids: [a.id, b.id], verifier_id: 'v1' });
    const vf = as(st.app, await login(st.app, 'v1'));
    const dev = body(await vf.post(`/api/requests/${a.id}/devices`, {
      service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', serial: '777',
    })).device;
    assert.ok(dev.id);
    assert.equal((await vf.post(`/api/requests/${a.id}/close`, { method: 'наличные' })).statusCode, 200);

    const month = AFTER.slice(0, 7);
    const sub = body(await vf.get(`/api/handovers?month=${month}`));
    assert.equal(sub.cash, 900);
    assert.equal(sub.wage, 280);
    assert.equal(sub.left, 620);

    const taken = await sv.post('/api/handovers', { staff_id: 'v1', period: month, amount: 500 });
    assert.equal(taken.statusCode, 200, taken.body);
    assert.equal(body(await vf.get(`/api/handovers?month=${month}`)).left, 120);
    await st.close();
  });
});

describe('вебхук звонков', () => {
  /* Разбор уведомлений обеих платформ, подписи и повторные доставки — в
     test/novofon.test.ts (пункт int-novofon). Здесь остаётся одно: приёмник
     по умолчанию собран под платформу 2.0 и без секрета в адресе не принимает
     ничего — ни с телом, ни без. */
  it('без секрета в адресе приёмник не принимает уведомление', async () => {
    const st = await makeStand();
    const event = { event: 'call_started', call_session_id: 'cs-api-1', numa: '79123456789', numb: '73432000000' };
    const bare = await st.app.inject({ method: 'POST', url: '/api/webhooks/novofon', payload: event });
    assert.equal(bare.statusCode, 401, bare.body);
    const wrong = await st.app.inject({ method: 'POST', url: '/api/webhooks/novofon/не-тот-секрет', payload: event });
    assert.equal(wrong.statusCode, 401, wrong.body);
    const op = as(st.app, await login(st.app, 'o1'));
    assert.equal(body(await op.get('/api/calls')).calls.length, 0, 'отвергнутое уведомление звонка не заводит');
    await st.close();
  });
});
