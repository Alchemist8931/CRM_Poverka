/* Эквайринг и фискализация (пункт int-pay).
 *
 * Провайдер в проверках — эмулятор HTTP-интерфейса ЮKassa на свободном порту
 * (src/payment/emulator.ts); клиент к нему — тот же, что ходит к настоящему
 * (src/payment/yookassa.ts). Уведомление об оплате эмулятор отдаёт телом, а
 * тест кладёт его в приёмник сам: так видно, что именно приходит и что с
 * этим делает система.
 *
 *   npx tsx --test test/payment.test.ts
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { AFTER, as, draft, login, makeStand, type Stand } from './helpers.ts';
import { paymentConfig, ipAllowed } from '../src/payment/config.ts';
import { yookassa } from '../src/payment/yookassa.ts';
import { startEmulator, type Emulator } from '../src/payment/emulator.ts';
import { receiptItems, receiptTotal, priceOf, type Service } from '../src/rules.ts';

const body = (res: { body: string }) => JSON.parse(res.body);
const SECRET = 'секрет-приёмника';

let em: Emulator;
before(async () => { em = await startEmulator({ shopId: '100', secretKey: 'test_ключ' }); });
after(async () => { await em.stop(); });

/** Стенд с подключённым эквайрингом: ключи есть, приёмник открыт, адрес эмулятора разрешён. */
async function payStand(over: Record<string, string> = {}): Promise<Stand> {
  const cfg = paymentConfig({
    PAYMENT_SHOP_ID: '100', PAYMENT_SECRET_KEY: 'test_ключ', PAYMENT_API_URL: `${em.url}/v3`,
    PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENT_ALLOWED_IPS: '127.0.0.1', PUBLIC_BASE_URL: 'https://uchetkin.ru',
    ...over,
  } as NodeJS.ProcessEnv);
  return makeStand({ payment: cfg, paymentProvider: yookassa(cfg) });
}

/** Заявка в маршруте у v1 с одним прибором на 900 ₽. */
async function actFor(st: Stand, phone: string, over: Record<string, unknown> = {}) {
  const sv = as(st.app, await login(st.app, 'sv'));
  const r = body(await sv.post('/api/requests', draft({ date: AFTER, phone, email: 'client@example.org', notify_consent: true, ...over }))).request;
  // Маршрут строится не меньше чем из двух точек: вторая — попутчик без акта.
  const mate = body(await sv.post('/api/requests', draft({ date: AFTER, phone: phone.replace(/^912/, '913') }))).request;
  const route = await sv.post('/api/routes', { date: AFTER, request_ids: [r.id, mate.id], verifier_id: 'v1' });
  assert.equal(route.statusCode, 200, route.body);
  const vf = as(st.app, await login(st.app, 'v1'));
  const dev = body(await vf.post(`/api/requests/${r.id}/devices`, {
    service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', serial: `s-${phone}`,
  })).device;
  return { r, sv, vf, dev };
}

const webhook = (app: FastifyInstance, notification: unknown, secret = SECRET) =>
  app.inject({ method: 'POST', url: `/api/webhooks/payment/${encodeURIComponent(secret)}`, payload: notification as never });

describe('позиции чека', () => {
  const svc = (id: string, person: number, pens: number, org: number, name: string): [string, Service & { name: string }] =>
    [id, { id, name, price_person: person, price_pensioner: pens, price_org: org, rate_verifier: 1, rate_operator: 1 }];
  const services = new Map([svc('wv', 900, 760, 1200, 'Поверка счётчика воды'), svc('wr', 2600, 2200, 3200, 'Замена счётчика воды')]);

  it('одна строка прибора — одна позиция, скидка пенсионеру в цене, сумма равна цене акта', () => {
    const act = [
      { service_id: 'wv', pensioner: true, device_type: 'Бетар СХВ-15', serial: '123' },
      { service_id: 'wv', pensioner: false, device_type: 'Бетар СХВ-15', serial: '' },
      { service_id: 'wr', pensioner: false, device_type: 'Бетар СХВ-15', serial: '124' },
      { service_id: 'нет', pensioner: false },
    ];
    const items = receiptItems(services, 'Физлицо', act, 1);
    assert.equal(items.length, 3, 'строка с неизвестной услугой в чек не идёт');
    assert.equal(items[0]!.amount, 760, 'пенсионеру — цена со скидкой');
    assert.equal(items[0]!.description, 'Поверка счётчика воды · Бетар СХВ-15 · № 123');
    assert.equal(items[1]!.description, 'Поверка счётчика воды · Бетар СХВ-15', 'без номера — без «№»');
    assert.deepEqual([items[0]!.vat_code, items[0]!.payment_subject, items[0]!.payment_mode], [1, 'service', 'full_payment']);
    assert.equal(receiptTotal(items), priceOf(services, 'Физлицо', act), 'сумма чека = цена акта');
    assert.equal(receiptTotal(items), 760 + 900 + 2600);
  });

  it('юрлицу — тариф юрлица, скидка не применяется', () => {
    const items = receiptItems(services, 'Юрлицо', [{ service_id: 'wv', pensioner: true }], 1);
    assert.equal(items[0]!.amount, 1200);
  });

  it('адрес провайдера сверяется по списку с масками', () => {
    const list = ['185.71.76.0/27', '77.75.156.11', '2a02:5180::/32'];
    assert.ok(ipAllowed('185.71.76.31', list));
    assert.ok(!ipAllowed('185.71.76.32', list));
    assert.ok(ipAllowed('77.75.156.11', list));
    assert.ok(!ipAllowed('77.75.156.12', list));
    assert.ok(ipAllowed('2a02:5180:0:1::5', list));
    assert.ok(ipAllowed('::ffff:77.75.156.11', list), 'IPv4 в обёртке IPv6');
    assert.ok(ipAllowed('10.0.0.1', []), 'пустой список — проверки нет');
  });
});

describe('эквайринг', () => {
  it('без ключей провайдера безналичных способов нет, приёмник закрыт', async () => {
    const st = await makeStand();
    const { r, vf } = await actFor(st, '9120100001');
    assert.equal(body(await vf.get('/api/payments/config')).enabled, false);
    assert.equal((await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' })).statusCode, 503);
    const denied = await vf.put(`/api/requests/${r.id}/payment`, { method: 'СБП по QR' });
    assert.equal(denied.statusCode, 422);
    assert.match(body(denied).error, /не подключён/);
    assert.ok(!body(await vf.get(`/api/requests/${r.id}/payment`)).methods.includes('СБП по QR'));
    const closed = await vf.post(`/api/requests/${r.id}/close`, { method: 'СБП по QR' });
    assert.equal(closed.statusCode, 422, 'закрыть безналом без провайдера нельзя');
    const hook = await webhook(st.app, { type: 'notification', event: 'payment.succeeded', object: { id: 'x' } });
    assert.equal(hook.statusCode, 400);
    await st.close();
  });

  it('полный круг: QR → уведомление → оплачено → чек в кассе и на почте → номер в заявке → событие «чек»; повтор не дублирует', async () => {
    const st = await payStand();
    const { r, vf } = await actFor(st, '9120100002');
    const config = body(await vf.get('/api/payments/config'));
    assert.deepEqual([config.enabled, config.provider, config.kinds], [true, 'yookassa', ['qr', 'link']]);
    assert.ok(body(await vf.get(`/api/requests/${r.id}/payment`)).methods.includes('СБП по QR'));

    const created = await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' });
    assert.equal(created.statusCode, 200, created.body);
    const p = body(created).payment;
    assert.equal(p.status, 'ожидает');
    assert.equal(p.amount, 900, 'сумма — цена акта, поверитель её не вводит');
    assert.match(p.confirmation, /^https:\/\/qr\.nspk\.ru\//, 'строка QR СБП от провайдера');
    assert.equal(p.items.length, 1);
    assert.equal(body(created).qr_url, `/api/online-payments/${p.id}/qr.svg`);

    const svg = await vf.get(`/api/online-payments/${p.id}/qr.svg`);
    assert.equal(svg.statusCode, 200);
    assert.match(String(svg.headers['content-type']), /image\/svg\+xml/);
    assert.match(svg.body, /<svg/);

    // Повторное нажатие «показать QR» отдаёт тот же платёж, а не второй.
    const again = body(await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' })).payment;
    assert.equal(again.id, p.id);
    assert.equal(em.payments.size, 1, 'у провайдера один платёж');

    // Отметка оплаты в заявке уже стоит, но денег ещё нет.
    const mark = body(await vf.get(`/api/requests/${r.id}/payment`));
    assert.equal(mark.payment.method, 'СБП по QR');
    assert.equal(mark.payment.paid_at, null);

    // Клиент оплатил: эмулятор отдаёт уведомление, оно попадает в приёмник.
    const { notification } = await em.pay(p.external_id);
    const hook = await webhook(st.app, notification);
    assert.equal(hook.statusCode, 200, hook.body);
    assert.equal(body(hook).applied, 'оплачен');

    const paid = body(await vf.get(`/api/online-payments/${p.id}`)).payment;
    assert.equal(paid.status, 'оплачен');
    assert.equal(paid.paid_amount, 900);
    assert.equal(paid.mismatch, false);
    assert.equal(paid.receipt_status, 'зарегистрирован', paid.error ?? '');
    assert.ok(paid.receipt_number, 'номер фискального документа');
    assert.equal(em.receipts.size, 1, 'чек зарегистрирован в кассе');
    const receipt = [...em.receipts.values()][0]!;
    assert.equal(receipt.type, 'payment');
    assert.equal(receipt.tax_system_code, 2, 'УСН доходы по умолчанию');
    assert.deepEqual(em.mails.map((m) => m.to), ['client@example.org'], 'касса отправила чек на почту клиента');

    // Номер чека — в заявке.
    const card = body(await vf.get(`/api/requests/${r.id}`));
    assert.equal(card.payment.receipt_number, paid.receipt_number);
    assert.ok(card.payment.paid_at);
    const status = body(await vf.get(`/api/payments/${card.payment.id}/status`));
    assert.equal(status.provider, 'yookassa');
    assert.equal(status.state, 'оплачен');
    assert.equal(status.in_hand, false);

    // Событие «чек отправлен» — в очереди уведомлений, по обоим каналам.
    const { rows: queued } = await st.db.query<{ channel: string; body: string }>(
      `SELECT channel, body FROM notifications WHERE event = 'чек' AND request_id = $1 ORDER BY channel`, [r.id]);
    assert.deepEqual(queued.map((q) => q.channel), ['email', 'sms']);
    assert.ok(queued.every((q) => q.body.includes(paid.receipt_number) && q.body.includes('900')), queued.map((q) => q.body).join('\n'));

    // Повторная доставка того же уведомления: ни второго чека, ни второго сообщения.
    const twice = await webhook(st.app, notification);
    assert.equal(twice.statusCode, 200);
    assert.equal(body(twice).applied, 'повтор');
    assert.equal(em.receipts.size, 1);
    const { rows: still } = await st.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE event = 'чек'`);
    assert.equal(still[0]!.n, '2');
    const { rows: events } = await st.db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_events WHERE ok');
    assert.equal(events[0]!.n, '2', 'оба уведомления записаны в журнал событий');

    // Закрытие позиции безналом: сумма из платежа, отметка «оплачено» — из уведомления.
    const closed = await vf.post(`/api/requests/${r.id}/close`, { method: 'СБП по QR' });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(body(closed).hand, 0, 'в подотчёт ничего не уходит');
    assert.equal(body(closed).payment.amount, 900);
    assert.ok(body(closed).payment.paid_at);
    assert.equal(body(closed).payment.receipt_number, paid.receipt_number, 'закрытие номер чека не стирает');
    await st.close();
  });

  it('оплата наличными попадает в подотчёт, безнал — нет; сверка руководителя видит безнал', async () => {
    const st = await payStand();
    const cash = await actFor(st, '9120100003');
    const online = await actFor(st, '9120100004');
    assert.equal((await cash.vf.post(`/api/requests/${cash.r.id}/close`, { method: 'наличные' })).statusCode, 200);

    const p = body(await online.vf.post(`/api/requests/${online.r.id}/online-payment`, { kind: 'link' })).payment;
    assert.match(p.confirmation, /^http.*\/pay\//, 'ссылка на страницу оплаты');
    assert.equal(body(await online.vf.get(`/api/online-payments/${p.id}`)).qr_url, null);
    // Клиент платит по ссылке позже; поверитель закрыл позицию, не дожидаясь.
    const closed = await online.vf.post(`/api/requests/${online.r.id}/close`, { method: 'платёжная ссылка' });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(body(closed).payment.paid_at, null, 'закрыто, но ещё не оплачено');
    // Вместо уведомления — опрос провайдера: так работает контур, куда уведомления не доходят.
    await em.pay(p.external_id);
    const syncRes = await online.vf.get(`/api/online-payments/${p.id}?sync=true`);
    assert.equal(syncRes.statusCode, 200, syncRes.body);
    const synced = body(syncRes).payment;
    assert.equal(synced.status, 'оплачен');
    assert.ok(synced.receipt_number);

    const month = AFTER.slice(0, 7);
    const sub = body(await online.vf.get(`/api/handovers?month=${month}`));
    assert.equal(sub.cash, 900, 'наличные — в подотчёте');
    assert.equal(sub.card, 0);
    assert.equal(sub.got, 900, 'безнал в собранное не входит');
    assert.equal(sub.wage, 560, 'сдельная начислена по обоим актам');

    const sv = as(st.app, await login(st.app, 'sv'));
    const today = new Date().toISOString().slice(0, 10);
    const rec = body(await sv.get(`/api/online-payments?date=${today}`));
    assert.equal(rec.totals.paid, 900);
    assert.equal(rec.totals.n_receipts, 1);
    assert.equal(rec.payments.length, 1);
    assert.equal(rec.payments[0].request_id, online.r.id);
    assert.equal((await online.vf.get(`/api/online-payments?date=${today}`)).statusCode, 403, 'сверка — у руководителя');

    const csv = await sv.get(`/api/online-payments/export.csv?date=${today}`);
    assert.equal(csv.statusCode, 200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.ok(csv.body.includes('Чек №') && csv.body.includes(online.r.id) && csv.body.includes('платёжная ссылка'), csv.body);
    await st.close();
  });

  it('сумма платежа обязана совпадать с суммой акта: изменился акт — позиция не закрывается, новый QR отменяет старый', async () => {
    const st = await payStand();
    const { r, vf } = await actFor(st, '9120100005');
    const first = body(await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' })).payment;
    assert.equal(first.amount, 900);
    await vf.post(`/api/requests/${r.id}/devices`, { service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ГВС', serial: 'second' });

    const blocked = await vf.post(`/api/requests/${r.id}/close`, { method: 'СБП по QR' });
    assert.equal(blocked.statusCode, 422, blocked.body);
    assert.match(body(blocked).error, /Сумма акта изменилась.*900.*1800/);
    const marked = await vf.put(`/api/requests/${r.id}/payment`, { method: 'СБП по QR' });
    assert.equal(marked.statusCode, 422, 'отметку с разошедшейся суммой тоже не поставить');

    const second = body(await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' })).payment;
    assert.notEqual(second.id, first.id);
    assert.equal(second.amount, 1800);
    assert.equal(body(await vf.get(`/api/online-payments/${first.id}`)).payment.status, 'отменён');

    // Оплата пришла, а сумма у провайдера другая — платёж помечается расхождением.
    const paidLess = em.payments.get(second.external_id)!;
    paidLess.amount = { value: '1700.00', currency: 'RUB' };
    const { notification } = await em.pay(second.external_id);
    assert.equal((await webhook(st.app, notification)).statusCode, 200);
    const p = body(await vf.get(`/api/online-payments/${second.id}`)).payment;
    assert.equal(p.status, 'оплачен');
    assert.equal(p.paid_amount, 1700);
    assert.equal(p.mismatch, true);
    const note = body(await vf.get(`/api/requests/${r.id}/payment`)).payment;
    assert.equal(note.amount, 1700);
    assert.match(note.note, /разошлась/);
    await st.close();
  });

  it('приёмник: чужой секрет, чужой адрес и неподтверждённый платёж не проходят', async () => {
    const st = await payStand();
    const { r, vf } = await actFor(st, '9120100006');
    const p = body(await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' })).payment;
    const { notification } = await em.pay(p.external_id);

    const wrong = await webhook(st.app, notification, 'не-тот');
    assert.equal(wrong.statusCode, 403);
    // Подделка: событие об оплате платежа, которого у провайдера нет.
    const fake = await webhook(st.app, { type: 'notification', event: 'payment.succeeded', object: { id: 'em-999999', status: 'succeeded' } });
    assert.equal(fake.statusCode, 400);
    assert.match(body(fake).error, /не подтверждён/);
    const garbage = await st.app.inject({ method: 'POST', url: `/api/webhooks/payment/${encodeURIComponent(SECRET)}`, payload: 'не json', headers: { 'content-type': 'text/plain' } });
    assert.equal(garbage.statusCode, 400);
    assert.equal(body(await vf.get(`/api/online-payments/${p.id}`)).payment.status, 'ожидает', 'отвергнутые уведомления состояние не меняют');
    const { rows: log } = await st.db.query<{ ok: boolean; reason: string }>('SELECT ok, reason FROM payment_events ORDER BY id');
    assert.equal(log.length, 3, 'все три записаны в журнал событий');
    assert.ok(log.every((e) => !e.ok && e.reason));
    await st.close();

    // Адрес отправителя не из списка провайдера — отказ, даже с верным секретом.
    const strict = await payStand({ PAYMENT_ALLOWED_IPS: '185.71.76.0/27' });
    const other = await actFor(strict, '9120100007');
    const q = body(await other.vf.post(`/api/requests/${other.r.id}/online-payment`, { kind: 'qr' })).payment;
    const paid = await em.pay(q.external_id);
    const denied = await webhook(strict.app, paid.notification);
    assert.equal(denied.statusCode, 403);
    assert.match(body(denied).error, /адрес/);
    await strict.close();
  });

  it('возврат и отмена — только руководителем, с чеком возврата и записью в журнал', async () => {
    const st = await payStand();
    const { r, vf, sv } = await actFor(st, '9120100008');
    const p = body(await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' })).payment;
    const { notification } = await em.pay(p.external_id);
    await webhook(st.app, notification);
    assert.equal((await vf.post(`/api/requests/${r.id}/close`, { method: 'СБП по QR' })).statusCode, 200);

    assert.equal((await vf.post(`/api/online-payments/${p.id}/refund`, { reason: 'клиент передумал' })).statusCode, 403, 'поверителю возврат недоступен');
    assert.equal((await vf.post(`/api/online-payments/${p.id}/cancel`)).statusCode, 403);
    const noReason = await sv.post(`/api/online-payments/${p.id}/refund`, { reason: '  ' });
    assert.equal(noReason.statusCode, 422);
    const cancelPaid = await sv.post(`/api/online-payments/${p.id}/cancel`);
    assert.equal(cancelPaid.statusCode, 422, 'оплаченный не отменяют — возвращают');

    const mailsBefore = em.mails.length;
    const refunded = await sv.post(`/api/online-payments/${p.id}/refund`, { reason: 'услуга не оказана: прибор не подлежит поверке' });
    assert.equal(refunded.statusCode, 200, refunded.body);
    const rp = body(refunded).payment;
    assert.equal(rp.status, 'возвращён');
    assert.equal(rp.refund_amount, 900);
    assert.equal(rp.handled_by, 'sv');
    assert.equal(em.refunds.size, 1);
    assert.equal([...em.receipts.values()].filter((x) => x.type === 'refund').length, 1, 'чек возврата пробит');
    assert.equal(em.mails.length, mailsBefore + 1, 'чек возврата ушёл клиенту');
    const mark = body(await sv.get(`/api/requests/${r.id}/payment`)).payment;
    assert.equal(mark.method, 'не оплачено');
    assert.equal(mark.amount, 0);
    assert.match(mark.note, /возврат по эквайрингу 900/);

    const { rows: audit } = await st.db.query<{ actor_id: string; action: string; entity_id: string; after: Record<string, unknown> }>(
      `SELECT actor_id, action, entity_id, after FROM audit_log WHERE entity = 'online_payments' ORDER BY id`);
    assert.ok(audit.some((a) => a.actor_id === 'sv' && a.action === 'изменение' && a.entity_id === String(p.id)
      && a.after?.status === 'возвращён'), JSON.stringify(audit));

    // Повторное уведомление о возврате от провайдера ничего не ломает.
    const again = await webhook(st.app, { type: 'notification', event: 'refund.succeeded', object: { id: rp.refund_id, payment_id: p.external_id, status: 'succeeded' } });
    assert.equal(again.statusCode, 200);

    // Отмена ожидающего платежа руководителем: заявка — «не оплачено».
    const link = body(await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'link' })).payment;
    const cancelled = await sv.post(`/api/online-payments/${link.id}/cancel`);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(body(cancelled).payment.status, 'отменён');
    assert.equal(body(await sv.get(`/api/requests/${r.id}/payment`)).payment.method, 'не оплачено');
    const { rows: audit2 } = await st.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE entity = 'online_payments' AND entity_id = $1 AND actor_id = 'sv'`, [String(link.id)]);
    assert.equal(audit2[0]!.n, '1', 'отмена в журнале');
    await st.close();
  });

  it('наличными при ожидающем QR: QR отменяется, деньги идут в подотчёт', async () => {
    const st = await payStand();
    const { r, vf } = await actFor(st, '9120100009');
    const p = body(await vf.post(`/api/requests/${r.id}/online-payment`, { kind: 'qr' })).payment;
    const closed = await vf.post(`/api/requests/${r.id}/close`, { method: 'наличные' });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(body(closed).hand, 900);
    assert.equal(body(await vf.get(`/api/online-payments/${p.id}`)).payment.status, 'отменён');
    // А оплаченный безнал наличными не перекрыть.
    const other = await actFor(st, '9120100010');
    const q = body(await other.vf.post(`/api/requests/${other.r.id}/online-payment`, { kind: 'qr' })).payment;
    const { notification } = await em.pay(q.external_id);
    await webhook(st.app, notification);
    const denied = await other.vf.post(`/api/requests/${other.r.id}/close`, { method: 'наличные' });
    assert.equal(denied.statusCode, 422);
    assert.match(body(denied).error, /уже оплачена/);
    await st.close();
  });
});
