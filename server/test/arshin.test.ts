/* ФГИС «Аршин»: запись о поверке, очередь передачи и ответ реестра (пункт int-arshin).
 *
 * Проверяется то, из-за чего пункт вообще существует: поверка без переданных
 * сведений юридической силы не имеет, поэтому запись обязана появляться сама
 * при закрытии акта — на каждый прибор, включая непригодный, — и не теряться
 * между «отправили» и «реестр ответил».
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AFTER, as, draft, login, makeStand, type Stand } from './helpers.ts';
import { addWorkdays, addYears, DUE_WORKDAYS } from '../src/arshin/records.ts';

// Реквизиты аккредитованного лица читаются из окружения на каждый запрос —
// здесь они задаются до первого стенда и действуют на весь файл.
process.env.ARSHIN_ORG_NAME = 'ИП Бердинских А.А.';
process.env.ARSHIN_ORG_CODE = 'БРД';
// Обмена по API нет: ключей у заказчика нет, и выгрузка идёт файлом.
delete process.env.ARSHIN_API_URL;
delete process.env.ARSHIN_API_TOKEN;

const body = (res: { body: string }) => JSON.parse(res.body);

/** Справочник типов приборов заказчик заполняет сам: методика и эталоны стоят
 *  там же, где межповерочный интервал. Без них запись в реестр не уходит. */
async function fillTypes(st: Stand): Promise<void> {
  await st.db.query(
    `UPDATE device_types SET method_doc = 'МИ 1592-2015', etalons = 'Установка поверочная УПСЖ-100, зав. № 412'`);
}

/** Счётчик вторых точек маршрута: номера телефонов в них должны не повторяться,
 *  иначе приём заявки видит дубль. */
let pairs = 0;

/** Закрытый акт с одним прибором. Возвращает заявку и строку прибора. */
/* Заявки заводит руководитель, а не оператор: как только на дату собран маршрут,
   приём на неё закрывается и добавить заявку может только он (правило `lock` в
   `rules.ts`). Второй акт того же дня оператор уже не завёл бы, а «Аршину»
   нужны несколько закрытых актов одной датой. */
async function closedAct(st: Stand, opts: { phone: string; bad?: boolean } ) {
  const sv = as(st.app, await login(st.app, 'sv'));
  const made = await sv.post('/api/requests', draft({ date: AFTER, phone: opts.phone }));
  assert.equal(made.statusCode, 200, made.body);
  const r = body(made).request;
  // Маршрут строится минимум по двум точкам — вторая нужна только для этого.
  const madePair = await sv.post('/api/requests',
    draft({ date: AFTER, phone: `91299${String(++pairs).padStart(5, '0')}` }));
  assert.equal(madePair.statusCode, 200, madePair.body);
  const pair = body(madePair).request;
  const route = await sv.post('/api/routes', { date: AFTER, request_ids: [r.id, pair.id], verifier_id: 'v1' });
  assert.equal(route.statusCode, 200, route.body);
  const vf = as(st.app, await login(st.app, 'v1'));
  const dev = body(await vf.post(`/api/requests/${r.id}/devices`, {
    service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', grsi: '32245-11',
  })).device;
  await vf.patch(`/api/devices/${dev.id}`, {
    serial: '1234' + opts.phone.slice(-4), reading: '00123',
    ...(opts.bad ? { bad: true, bad_reason: 'Погрешность выше допуска', blank: true, blank_no: 'И-77' } : {}),
  });
  const closed = await vf.post(`/api/requests/${r.id}/close`, { method: 'наличные' });
  assert.equal(closed.statusCode, 200, closed.body);
  return { request: r, device: dev, closed: body(closed) };
}

describe('аршин: срок передачи', () => {
  it('срок считается рабочими днями от даты поверки — 40 по пункту 21 приказа № 2510', () => {
    assert.equal(DUE_WORKDAYS, 40);
    // Пятница 2026-09-18 плюс один рабочий день — понедельник 21-го, а не суббота.
    assert.equal(addWorkdays('2026-09-18', 1), '2026-09-21');
    assert.equal(addWorkdays('2026-09-18', 5), '2026-09-25');
    // 40 рабочих дней — это восемь недель ровно.
    assert.equal(addWorkdays('2026-09-18', 40), '2026-11-13');
  });

  it('срок действия поверки считается межповерочным интервалом от её даты', () => {
    assert.equal(addYears('2026-09-17', 6), '2032-09-17');
    // 29 февраля: в невисокосном году срок кончается последним днём февраля.
    assert.equal(addYears('2024-02-29', 6), '2030-02-28');
  });
});

describe('аршин: запись о поверке из акта', () => {
  it('закрытие акта заводит запись на каждый прибор, включая непригодный', async () => {
    const st = await makeStand();
    await fillTypes(st);
    const { request } = await closedAct(st, { phone: '9120004001' });

    // Второй прибор того же акта — непригодный: он уходит в реестр наравне
    // с годным (подпункты «м» и «у» пункта 26 приказа № 2906).
    const vf = as(st.app, await login(st.app, 'v1'));
    const bad = body(await vf.post(`/api/requests/${request.id}/devices`, {
      service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', grsi: '32245-11',
    })).device;
    await vf.patch(`/api/devices/${bad.id}`, {
      serial: '87654321', reading: '00456', bad: true,
      bad_reason: 'Механическое повреждение', blank: true, blank_no: 'И-78',
    });
    // Замена в реестр не идёт: поверки в ней нет.
    const swap = body(await vf.post(`/api/requests/${request.id}/devices`, {
      service_id: 'wr', device_type: 'Бетар СХВ-15', carrier: 'ХВС', swap: true, swap_of: '87654321',
    })).device;
    await vf.patch(`/api/devices/${swap.id}`, { serial: '99990000' });
    await vf.post(`/api/requests/${request.id}/reopen`);
    assert.equal((await vf.post(`/api/requests/${request.id}/close`, { method: 'наличные' })).statusCode, 200);

    const sv = as(st.app, await login(st.app, 'sv'));
    const queue = body(await sv.get('/api/arshin/queue'));
    const mine = queue.records.filter((r: { request_id: string }) => r.request_id === request.id);
    assert.equal(mine.length, 2, 'две поверки — две записи, замена в реестр не идёт');

    const ok = mine.find((r: { applicable: boolean }) => r.applicable);
    assert.equal(ok.status, 'готово');
    assert.equal(ok.grsi, '32245-11');
    assert.equal(ok.org_code, 'БРД');
    assert.equal(ok.org_name, 'ИП Бердинских А.А.');
    assert.equal(ok.method_doc, 'МИ 1592-2015');
    assert.equal(ok.verifier_name, 'Алимпиев И.');
    assert.equal(ok.verified_on, AFTER, 'дата поверки — день выезда');
    assert.equal(ok.valid_to, addYears(AFTER, 6), 'срок действия — межповерочный интервал типа прибора');
    assert.equal(ok.due_date, addWorkdays(AFTER, 40));
    // Сведения о владельце передаются только с его согласия (пункт 28 приказа
    // № 2906) — согласия нет, поле пустое.
    assert.equal(ok.owner_name, '');

    const fail = mine.find((r: { applicable: boolean }) => !r.applicable);
    assert.equal(fail.status, 'готово');
    assert.match(fail.fail_reason, /Механическое повреждение/);
    await st.close();
  });

  it('незаполненный справочник виден ошибкой в очереди, а не тишиной', async () => {
    const st = await makeStand();
    const { request } = await closedAct(st, { phone: '9120004002' });
    const sv = as(st.app, await login(st.app, 'sv'));
    const queue = body(await sv.get('/api/arshin/queue'));
    const rec = queue.records.find((r: { request_id: string }) => r.request_id === request.id);
    assert.equal(rec.status, 'ошибка');
    assert.match(rec.error_text, /методика поверки/);
    assert.equal(queue.summary.failed >= 1, true);

    // Справочник дозаполнили — повторная отправка пересобирает запись из акта.
    await fillTypes(st);
    const again = await sv.post(`/api/arshin/records/${rec.id}/retry`, {});
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(body(again).record.status, 'готово');
    assert.equal(body(again).record.error_text, '');
    await st.close();
  });

  it('возврат позиции в работу снимает непереданную запись', async () => {
    const st = await makeStand();
    await fillTypes(st);
    const { request } = await closedAct(st, { phone: '9120004003' });
    const vf = as(st.app, await login(st.app, 'v1'));
    const back = await vf.post(`/api/requests/${request.id}/reopen`, {});
    assert.equal(body(back).arshin, 1);

    const sv = as(st.app, await login(st.app, 'sv'));
    const queue = body(await sv.get('/api/arshin/queue'));
    assert.equal(queue.records.filter((r: { request_id: string }) => r.request_id === request.id).length, 0);
    await st.close();
  });
});

describe('аршин: очередь, выгрузка и ответ реестра', () => {
  it('выгрузка переводит записи в «передано», ответ реестра — в «принято» с номером', async () => {
    const st = await makeStand();
    await fillTypes(st);
    const first = await closedAct(st, { phone: '9120005001' });
    const second = await closedAct(st, { phone: '9120005002', bad: true });
    const sv = as(st.app, await login(st.app, 'sv'));

    const made = await sv.post('/api/arshin/batches', {});
    assert.equal(made.statusCode, 200, made.body);
    const batch = body(made);
    assert.equal(batch.channel, 'файл', 'без ключей API выгрузка идёт файлом');
    assert.equal(batch.records, 2);
    assert.match(batch.xml, /<vri-export /);
    assert.match(batch.xml, /org-code="БРД"/);
    assert.match(batch.xml, /<applicable>false<\/applicable>/);

    const queue = body(await sv.get('/api/arshin/queue'));
    assert.equal(queue.summary.sent, 2);
    assert.equal(queue.summary.ready, 0);
    const ids = queue.records.map((r: { id: number }) => String(r.id));

    // Тот же файл скачивается заново — руководителю есть что приложить к отчёту.
    const file = await sv.get(`/api/arshin/batches/${batch.batch_id}/file.xml`);
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'application/xml; charset=utf-8');
    assert.match(file.body, /<record source-id=/);

    // Ответ кабинета: одну запись приняли, вторую вернули с ошибкой.
    const res = await sv.post(`/api/arshin/batches/${batch.batch_id}/result`, {
      accepted: [{ source_id: ids[0], number: '1-1234567-2026' }],
      failed: [{ source_id: ids[1], error: 'Заводской номер уже есть в реестре' }],
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(body(res), { batch_id: batch.batch_id, accepted: 1, failed: 1 });

    const after = body(await sv.get('/api/arshin/queue'));
    const accepted = after.records.find((r: { id: number }) => String(r.id) === ids[0]);
    assert.equal(accepted.status, 'принято');
    assert.equal(accepted.fgis_number, '1-1234567-2026');
    const failed = after.records.find((r: { id: number }) => String(r.id) === ids[1]);
    assert.equal(failed.status, 'ошибка');
    assert.match(failed.error_text, /уже есть в реестре/);

    // Номер записи в реестре лежит в приборе: оттуда он печатается в
    // свидетельстве о поверке (пункт fe-forms).
    const card = body(await sv.get(`/api/requests/${accepted.request_id}`));
    assert.equal(card.devices[0].arshin_number, '1-1234567-2026');

    // Повторная отправка возвращает непринятую запись в очередь.
    const retry = await sv.post(`/api/arshin/records/${ids[1]}/retry`, {});
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(body(retry).record.status, 'готово');
    assert.equal(body(retry).record.batch_id, null);

    // Принятую запись повторно не отправляют: её исправляют в кабинете.
    const no = await sv.post(`/api/arshin/records/${ids[0]}/retry`, {});
    assert.equal(no.statusCode, 422);
    assert.match(body(no).error, /личном кабинете/);

    assert.equal(first.closed.arshin, 1);
    assert.equal(second.closed.arshin, 1);
    await st.close();
  });

  it('просрочка считается по сроку передачи и видна в сводке', async () => {
    const st = await makeStand();
    await fillTypes(st);
    const { request } = await closedAct(st, { phone: '9120006001' });
    const sv = as(st.app, await login(st.app, 'sv'));
    await st.db.query(
      `UPDATE arshin_records SET due_date = current_date - 1 WHERE request_id = $1`, [request.id]);
    const queue = body(await sv.get('/api/arshin/queue'));
    assert.equal(queue.summary.overdue, 1);
    assert.equal(queue.due_workdays, 40);
    assert.equal(queue.channel, 'файл');
    await st.close();
  });

  it('выгрузка за период не трогает статусы и отдаёт XML', async () => {
    const st = await makeStand();
    await fillTypes(st);
    await closedAct(st, { phone: '9120007001' });
    const sv = as(st.app, await login(st.app, 'sv'));
    const res = await sv.get(`/api/arshin/export.xml?from=${AFTER}&to=${AFTER}`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<vri-export /);
    assert.match(String(res.headers['content-disposition']), /arshin-/);
    const queue = body(await sv.get('/api/arshin/queue'));
    assert.equal(queue.summary.ready, 1, 'отчёт за период — не передача сведений');
    await st.close();
  });

  it('очередь «Аршина» открыта только руководителю', async () => {
    const st = await makeStand();
    const op = as(st.app, await login(st.app, 'o1'));
    const vf = as(st.app, await login(st.app, 'v1'));
    assert.equal((await op.get('/api/arshin/queue')).statusCode, 403);
    assert.equal((await vf.get('/api/arshin/queue')).statusCode, 403);
    assert.equal((await op.post('/api/arshin/batches', {})).statusCode, 403);
    await st.close();
  });

  it('пустая очередь не рождает пустую выгрузку', async () => {
    const st = await makeStand();
    const sv = as(st.app, await login(st.app, 'sv'));
    const res = await sv.post('/api/arshin/batches', {});
    assert.equal(res.statusCode, 422);
    assert.match(body(res).error, /Готовых к передаче записей нет/);
    await st.close();
  });
});
