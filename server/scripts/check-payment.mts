/* Сквозная проверка эквайринга и фискализации (пункт int-pay).
 *
 *   npx tsx scripts/check-payment.mts
 *
 * Тест `test/payment.test.ts` проверяет правила через app.inject: приёмник там
 * вызывается самим тестом. Здесь проверяется другое — что круг проходит по
 * сети целиком: приложение слушает порт, эмулятор провайдера шлёт уведомление
 * на настоящий адрес приёмника, QR — настоящая картинка, чек — «отправлен»
 * на почту клиента, выгрузка сверки читается как CSV.
 *
 * Ключей настоящего провайдера у проверки нет и быть не должно: она не имеет
 * права зависеть от чужого счёта. Провайдер и касса — эмулятор HTTP-интерфейса
 * ЮKassa на свободном порту (src/payment/emulator.ts); клиент к нему — тот же,
 * что в облаке ходит к настоящему (src/payment/yookassa.ts).
 *
 * Чего проверка не проверяет и проверить не может: примет ли настоящий
 * провайдер ключи заказчика и зарегистрирована ли касса на выездные услуги.
 * Это делается в тестовом контуре провайдера по docs/payment.md, раздел
 * «Подключение у заказчика», когда договор подписан.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../src/api/app.ts';
import { singleConnectionDb } from '../src/api/db.ts';
import { hashPassword } from '../src/password.ts';
import { novofonConfig } from '../src/novofon/config.ts';
import { paymentConfig } from '../src/payment/config.ts';
import { yookassa } from '../src/payment/yookassa.ts';
import { startEmulator } from '../src/payment/emulator.ts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;

function ok(what: string, good: boolean, detail = ''): void {
  if (good) console.log(`  ✓ ${what}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.error(`  ✗ ${what}${detail ? ' — ' + detail : ''}`); }
}

const iso = (shift: number): string => { const d = new Date(); d.setDate(d.getDate() + shift); return d.toISOString().slice(0, 10); };
const TODAY = iso(0);
const SECRET = 'секрет-проверки';

/* ─────────────────────────────── стенд ─────────────────────────────── */

const pg = new PGlite();
for (const file of readdirSync(join(serverDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(serverDir, 'migrations', file), 'utf8');
  await pg.exec(sql.split('-- Down Migration')[0]!.split('-- Up Migration')[1] ?? '');
}
const db = singleConnectionDb({ query: (t, p) => pg.query(t, p as never[]) as never, close: () => pg.close() });
const hash = await hashPassword('1234');
await db.query(`INSERT INTO cities (name, short, sort) VALUES ('Асбест', 'АСБ', 1)`);
await db.query(
  `INSERT INTO services (id, grp, name, short, price_person, price_pensioner, price_org, rate_verifier, rate_operator, is_verification, sort) VALUES
     ('wv', 'Вода', 'Поверка счётчика воды', 'Поверка воды', 900, 760, 1200, 280, 45, true, 1)`);
await db.query(`INSERT INTO device_types (name, grsi, interval_years, carrier_kind, sort) VALUES ('Бетар СХВ-15', '32245-11', 6, 'Вода', 1)`);
await db.query(
  `INSERT INTO staff (id, full_name, role, login, password_hash, must_change_password) VALUES
     ('sv', 'Панченко И.', 'supervisor', 'sv', $1, false), ('v1', 'Алимпиев И.', 'verifier', 'v1', $1, false)`, [hash]);
await db.query(`INSERT INTO staff_skills (staff_id, service_id) VALUES ('v1', 'wv')`);
await db.query(`INSERT INTO routes (id, date, city, verifier_id) VALUES ('RT-1', $1, 'Асбест', 'v1')`, [TODAY]);
await db.query(
  `INSERT INTO requests (id, date, created_date, city, client_type, name, phone, phone_norm, email, street, house, flat,
      time_slot, svcs, status, route_id, notify_consent)
   VALUES ('R-1', $1, current_date, 'Асбест', 'Физлицо', 'Иванова М. П.', '+7 912 345-67-89', '+79123456789',
      'ivanova@example.org', 'Ленина', '10', '5', 12, ARRAY['wv'], 'в маршруте', 'RT-1', true)`, [TODAY]);
await db.query(`INSERT INTO stops (route_id, request_id, position) VALUES ('RT-1', 'R-1', 1)`);
// Пенсионерка: в чеке должна стоять цена со скидкой (760), а не по прайсу (900).
await db.query(
  `INSERT INTO devices (request_id, position, service_id, device_type, grsi, carrier, serial, pensioner)
   VALUES ('R-1', 1, 'wv', 'Бетар СХВ-15', '32245-11', 'ХВС', '0451233', true)`);

/* ───────────────────────── эмулятор и приложение ───────────────────────── */

// Сначала приложение — эмулятору нужен адрес приёмника. Секрет и ключи —
// свои, настоящих здесь нет.
const cfgDraft = paymentConfig({
  PAYMENT_SHOP_ID: 'check', PAYMENT_SECRET_KEY: 'check-key', PAYMENT_API_URL: 'http://127.0.0.1:1/v3',
  PAYMENT_WEBHOOK_SECRET: SECRET, PAYMENT_ALLOWED_IPS: '127.0.0.1', PUBLIC_BASE_URL: 'http://127.0.0.1',
  PAYMENT_TAX_SYSTEM: '2', PAYMENT_VAT_CODE: '1',
} as NodeJS.ProcessEnv);
const app = await buildApp({
  db, secret: 'проверочный-ключ', storage: null, records: null,
  novofon: novofonConfig({ NOVOFON_WEBHOOK_SECRET: 'x' } as NodeJS.ProcessEnv), novofonClient: null,
  payment: cfgDraft, paymentProvider: null,
});
const address = await app.listen({ port: 0, host: '127.0.0.1' });
const em = await startEmulator({ shopId: 'check', secretKey: 'check-key', webhookUrl: `${address}/api/webhooks/payment/${encodeURIComponent(SECRET)}` });
// Провайдер смотрит на эмулятор; настройки те же, адрес — его.
const cfg = { ...cfgDraft, apiUrl: `${em.url}/v3`, publicBaseUrl: address };
app.paymentConfig.apiUrl = cfg.apiUrl;
app.paymentConfig.publicBaseUrl = cfg.publicBaseUrl;
app.payments = yookassa(app.paymentConfig);

async function login(who: string): Promise<string> {
  const res = await fetch(`${address}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: who, password: '1234' }),
  });
  if (!res.ok) throw new Error(`вход ${who}: ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}
const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${address}${path}`, {
    method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* не JSON — вернём текстом */ }
  return { status: res.status, text, json, type: res.headers.get('content-type') ?? '' };
};

/** Ждать, пока состояние платежа не станет нужным: уведомление идёт по сети. */
async function waitFor(vf: ReturnType<typeof call>, id: number, status: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const p = (await vf('GET', `/api/online-payments/${id}`)).json.payment as Record<string, unknown>;
    if (p.status === status) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  return (await vf('GET', `/api/online-payments/${id}`)).json.payment as Record<string, unknown>;
}

try {
  const vf = call(await login('v1'));
  const sv = call(await login('sv'));

  console.log('1. Настройки');
  const config = (await sv('GET', '/api/payments/config')).json;
  ok('эквайринг подключён, оба вида', config.enabled === true && JSON.stringify(config.kinds) === '["qr","link"]');
  ok('адрес приёмника считается от PUBLIC_BASE_URL и секрета',
    config.webhook_url === `${address}/api/webhooks/payment/${encodeURIComponent(SECRET)}`, String(config.webhook_url));

  console.log('2. QR на сумму акта');
  const created = await vf('POST', '/api/requests/R-1/online-payment', { kind: 'qr' });
  ok('платёж создан', created.status === 200, created.text.slice(0, 120));
  const p = created.json.payment as Record<string, unknown>;
  ok('сумма — цена акта со скидкой пенсионерке', p.amount === 760, `${p.amount} ₽`);
  ok('строка QR — от провайдера, формата НСПК', /^https:\/\/qr\.nspk\.ru\//.test(String(p.confirmation)), String(p.confirmation));
  const svg = await vf('GET', `/api/online-payments/${p.id}/qr.svg`);
  ok('QR отдаётся картинкой SVG', svg.status === 200 && svg.type.includes('image/svg+xml') && svg.text.includes('<svg') && svg.text.length > 1000,
    `${svg.text.length} байт`);
  const items = p.items as { description: string; amount: number; vat_code: number }[];
  ok('позиция чека: услуга, прибор, номер, цена со скидкой, без НДС',
    items.length === 1 && items[0]!.description === 'Поверка счётчика воды · Бетар СХВ-15 · № 0451233' && items[0]!.amount === 760 && items[0]!.vat_code === 1,
    JSON.stringify(items[0]));
  const mark = (await vf('GET', '/api/requests/R-1/payment')).json as { payment: Record<string, unknown>; methods: string[] };
  ok('в заявке — способ «СБП по QR», деньги ещё не приняты', mark.payment.method === 'СБП по QR' && mark.payment.paid_at === null);
  ok('поверителю видны оба безналичных способа', mark.methods.includes('СБП по QR') && mark.methods.includes('платёжная ссылка'));

  console.log('3. Оплата и уведомление по сети');
  const paid = await em.pay(String(p.external_id));
  ok('эмулятор доставил уведомление на приёмник и получил 200', paid.delivered === 200, `ответ ${paid.delivered}`);
  const done = await waitFor(vf, Number(p.id), 'оплачен');
  ok('платёж оплачен', done.status === 'оплачен', String(done.status));
  ok('сумма оплаты сошлась с актом', done.paid_amount === 760 && done.mismatch === false);

  console.log('4. Чек');
  ok('чек зарегистрирован в кассе', done.receipt_status === 'зарегистрирован' && !!done.receipt_number, String(done.error ?? done.receipt_number));
  const receipt = [...em.receipts.values()][0];
  ok('в кассе — позиции акта, УСН доходы, безналичный расчёт',
    !!receipt && receipt.type === 'payment' && receipt.tax_system_code === 2
      && (receipt.settlements as { type: string }[])[0]?.type === 'cashless' && receipt.items.length === 1);
  ok('касса отправила чек на почту клиента', em.mails.length === 1 && em.mails[0]!.to === 'ivanova@example.org',
    em.mails.map((m) => m.to).join(', ') || 'писем нет');
  const card = (await vf('GET', '/api/requests/R-1')).json as { payment: Record<string, unknown> };
  ok('номер чека — в заявке', card.payment.receipt_number === done.receipt_number && !!card.payment.paid_at, String(card.payment.receipt_number));
  const { rows: queued } = await db.query<{ channel: string; body: string; address: string }>(
    `SELECT channel, body, address FROM notifications WHERE event = 'чек' ORDER BY channel`);
  ok('событие «чек отправлен» — в очереди уведомлений, письмо и СМС', queued.length === 2 && queued.every((q) => q.body.includes(String(done.receipt_number))),
    queued.map((q) => `${q.channel} → ${q.address}`).join(', '));

  console.log('5. Повтор уведомления');
  const twice = await fetch(`${address}/api/webhooks/payment/${encodeURIComponent(SECRET)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(paid.notification),
  });
  const twiceBody = await twice.json() as { applied: string };
  ok('повторная доставка принята с 200 и не обработана второй раз', twice.status === 200 && twiceBody.applied === 'повтор');
  ok('второго чека нет', em.receipts.size === 1);
  const { rows: ev } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment_events');
  ok('обе доставки в журнале событий', ev[0]!.n === '2', `записей ${ev[0]!.n}`);

  console.log('6. Закрытие позиции и подотчёт');
  const closed = await vf('POST', '/api/requests/R-1/close', { method: 'СБП по QR' });
  ok('позиция закрыта безналом', closed.status === 200 && closed.json.hand === 0, closed.text.slice(0, 120));
  const sub = (await vf('GET', `/api/handovers?month=${TODAY.slice(0, 7)}`)).json as Record<string, number>;
  ok('в подотчёт поверителя безнал не попал', sub.cash === 0 && sub.card === 0 && sub.got === 0 && sub.wage === 280,
    `наличные ${sub.cash}, перевод ${sub.card}, сдельная ${sub.wage}`);

  console.log('7. Сверка руководителя и выгрузка');
  const rec = (await sv('GET', `/api/online-payments?date=${TODAY}`)).json as { totals: Record<string, number>; payments: unknown[] };
  ok('итоги за день: оплачено 760, чеков 1', rec.totals.paid === 760 && rec.totals.n_receipts === 1 && rec.payments.length === 1,
    JSON.stringify(rec.totals));
  // Байты, а не текст: `Response.text()` метку порядка байтов молча съедает.
  const csvRes = await fetch(`${address}/api/online-payments/export.csv?date=${TODAY}`, { headers: { cookie: await login('sv') } });
  const csvBytes = Buffer.from(await csvRes.arrayBuffer());
  const csv = { status: csvRes.status, type: csvRes.headers.get('content-type') ?? '', text: csvBytes.toString('utf8') };
  const lines = csv.text.split('\r\n').filter(Boolean);
  ok('выгрузка для бухгалтера — CSV с меткой порядка байтов, шапкой, строкой и итогом',
    csv.status === 200 && csv.type.includes('text/csv') && csvBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && lines.length === 3
      && lines[0]!.includes('Чек №') && lines[1]!.includes('R-1') && lines[1]!.includes(String(done.receipt_number)) && lines[2]!.startsWith('Итого'),
    `${lines.length} строк`);
  ok('поверителю сверка не отдаётся', (await vf('GET', `/api/online-payments?date=${TODAY}`)).status === 403);

  console.log('8. Возврат руководителем');
  const refund = await sv('POST', `/api/online-payments/${p.id}/refund`, { reason: 'клиент отказался от услуги' });
  ok('возврат проведён', refund.status === 200 && (refund.json.payment as Record<string, unknown>).status === 'возвращён', refund.text.slice(0, 120));
  ok('чек возврата пробит и отправлен', [...em.receipts.values()].some((r) => r.type === 'refund') && em.mails.length === 2);
  const { rows: audit } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE entity = 'online_payments' AND actor_id = 'sv' AND action = 'изменение'`);
  ok('возврат записан в журнал действий', Number(audit[0]!.n) >= 1);
  const after = (await sv('GET', '/api/requests/R-1/payment')).json as { payment: Record<string, unknown> };
  ok('заявка — «не оплачено» с причиной', after.payment.method === 'не оплачено' && String(after.payment.note).includes('возврат'), String(after.payment.note));
} finally {
  await em.stop();
  await app.close();
  await db.close();
}

console.log('');
console.log('Чего эта проверка не проверяет: примет ли настоящий провайдер ключи заказчика и');
console.log('зарегистрирована ли касса на выездные услуги — это тестовый контур провайдера,');
console.log('docs/payment.md, раздел «Подключение у заказчика».');

if (failed) {
  console.error(`\nСверка эквайринга не сошлась: расхождений ${failed}.`);
  process.exit(1);
}
console.log('\nЭквайринг: QR → оплата → чек → уведомление → сверка → возврат проходят по сети целиком.');
