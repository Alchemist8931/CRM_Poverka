/* Выгрузка заявок за период в .xlsx — страховка пилота (пункт плана launch).
 *
 * Если во время пилота решат вернуться к старому учёту, всё принятое и
 * закрытое в системе за эти дни должно лечь в таблицу, с которой можно
 * продолжить работать руками: заявки с адресами и контактами, приборы из актов
 * с результатом поверки и ценой, оплаты на месте. Порядок отката целиком —
 * docs/launch.md, раздел «Откат».
 *
 *   npm run export:period -- --from 2026-09-21 --to 2026-09-27 [--out заявки.xlsx]
 *
 * База — DATABASE_URL, как у остальных команд. Ничего не пишет и не меняет:
 * только SELECT. Выгружаются заявки, у которых дата выезда попадает в период,
 * включая перенесённые и отменённые: для сверки с кассой и обзвона нужны все.
 */
import ExcelJS from 'exceljs';
import type { Client } from 'pg';
import { connect } from '../src/db.ts';

const HELP = `Выгрузка заявок за период в .xlsx.

  npm run export:period -- --from ГГГГ-ММ-ДД --to ГГГГ-ММ-ДД [--out файл.xlsx]

Ключи:
  --from   первая дата выезда, включительно (обязателен)
  --to     последняя дата выезда, включительно (обязателен)
  --out    куда писать; по умолчанию заявки-<from>-<to>.xlsx в текущем каталоге
`;

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 1);
}
const opts: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!;
  if (!arg.startsWith('--')) { console.error(`Лишний аргумент «${arg}».\n\n${HELP}`); process.exit(1); }
  const value = argv[++i];
  if (value === undefined) { console.error(`У ключа ${arg} нет значения.\n\n${HELP}`); process.exit(1); }
  opts[arg] = value;
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const from = opts['--from'], to = opts['--to'];
if (!from || !to || !ISO.test(from) || !ISO.test(to)) {
  console.error(`Нужны --from и --to в виде ГГГГ-ММ-ДД.\n\n${HELP}`);
  process.exit(1);
}
if (from > to) { console.error(`--from (${from}) позже --to (${to}).`); process.exit(1); }
const out = opts['--out'] ?? `заявки-${from}-${to}.xlsx`;

type Row = Record<string, unknown>;
const q = async (db: Client, sql: string): Promise<Row[]> => (await db.query(sql, [from, to])).rows as Row[];

const REQUESTS = `
  SELECT r.id, r.date, r.created_date, r.city, r.status, r.client_type, r.name, r.inn,
         r.phone, r.contact, r.phone2, r.contact2, r.email,
         r.street, r.house, r.entrance, r.floor, r.flat, r.intercom, r.time_slot,
         r.svcs, r.comment_operator, r.comment_verifier, r.route_id, r.moved_from,
         op.full_name AS operator, vf.full_name AS verifier,
         (SELECT count(*) FROM devices d WHERE d.request_id = r.id)::int AS devices,
         (SELECT coalesce(sum(d.price_charged), 0) FROM devices d WHERE d.request_id = r.id)::int AS charged,
         p.method AS pay_method, p.amount AS pay_amount
    FROM requests r
    LEFT JOIN staff op ON op.id = r.operator_id
    LEFT JOIN staff vf ON vf.id = r.verifier_id
    LEFT JOIN payments p ON p.request_id = r.id
   WHERE r.date BETWEEN $1 AND $2
   ORDER BY r.date, r.city, r.id`;

const DEVICES = `
  SELECT d.request_id, r.date, r.city, d.position, s.name AS service, d.device_type, d.grsi, d.carrier,
         d.serial, d.reading, d.room, d.seal, d.pensioner, d.bad, d.bad_reason, d.bad_note,
         d.blank_no, d.replacement, d.swap, d.swap_of, d.price_charged, d.rate_verifier, d.rate_operator
    FROM devices d
    JOIN requests r ON r.id = d.request_id
    JOIN services s ON s.id = d.service_id
   WHERE r.date BETWEEN $1 AND $2
   ORDER BY r.date, d.request_id, d.position`;

const PAYMENTS = `
  SELECT p.request_id, r.date, r.city, r.name AS client, p.method, p.amount, p.charged, p.manual, p.note,
         p.paid_at, st.full_name AS by_staff
    FROM payments p
    JOIN requests r ON r.id = p.request_id
    LEFT JOIN staff st ON st.id = p.by_staff
   WHERE r.date BETWEEN $1 AND $2
   ORDER BY r.date, p.request_id`;

const yes = (v: unknown): string => (v ? 'да' : 'нет');
const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ''));
/** Время — по Екатеринбургу, как его видят в системе. */
const at = (v: unknown): string => {
  if (!(v instanceof Date)) return v ? String(v) : '';
  const t = new Date(v.getTime() + 5 * 3600 * 1000);
  return t.toISOString().slice(0, 16).replace('T', ' ');
};
const slot = (h: unknown): string => `${Number(h) - 1}:00–${Number(h) + 1}:00`;
const address = (r: Row): string => [
  `${r.street}, ${r.house}`,
  r.entrance ? `подъезд ${r.entrance}` : '', r.floor ? `этаж ${r.floor}` : '', r.flat ? `кв. ${r.flat}` : '',
  r.intercom ? '' : 'без домофона',
].filter(Boolean).join(', ');

function sheet(book: ExcelJS.Workbook, title: string, columns: { header: string; width: number }[], rows: unknown[][]): void {
  const ws = book.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ width: c.width }));
  const head = ws.addRow(columns.map((c) => c.header));
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F1' } };
  for (const r of rows) ws.addRow(r);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

const db = await connect();
try {
  // По очереди: одно соединение, второй запрос поверх незавершённого pg не любит.
  const requests = await q(db, REQUESTS);
  const devices = await q(db, DEVICES);
  const payments = await q(db, PAYMENTS);

  const book = new ExcelJS.Workbook();
  book.creator = 'CRM «Учёткин»';
  book.created = new Date();

  sheet(book, 'Заявки', [
    { header: '№ заявки', width: 12 }, { header: 'Дата выезда', width: 12 }, { header: 'Город', width: 14 },
    { header: 'Статус', width: 12 }, { header: 'Клиент', width: 10 }, { header: 'Имя / организация', width: 28 },
    { header: 'ИНН', width: 13 }, { header: 'Телефон', width: 16 }, { header: 'Контакт', width: 18 },
    { header: 'Телефон 2', width: 16 }, { header: 'Контакт 2', width: 18 }, { header: 'Почта', width: 22 },
    { header: 'Адрес', width: 40 }, { header: 'Окно', width: 12 }, { header: 'Заявлено', width: 18 },
    { header: 'Комментарий оператору', width: 30 }, { header: 'Комментарий поверителю', width: 30 },
    { header: 'Оператор', width: 20 }, { header: 'Поверитель', width: 20 }, { header: 'Маршрут', width: 14 },
    { header: 'Принята', width: 12 }, { header: 'Перенесена из', width: 14 }, { header: 'Приборов', width: 9 },
    { header: 'По прайсу, ₽', width: 12 }, { header: 'Оплата', width: 16 }, { header: 'Получено, ₽', width: 12 },
  ], requests.map((r) => [
    r.id, day(r.date), r.city, r.status, r.client_type, r.name, r.inn, r.phone, r.contact, r.phone2, r.contact2,
    r.email, address(r), slot(r.time_slot), (r.svcs as string[]).join(', '), r.comment_operator, r.comment_verifier,
    r.operator ?? '', r.verifier ?? '', r.route_id ?? '', day(r.created_date), r.moved_from ?? '', r.devices,
    r.charged, r.pay_method ?? '', r.pay_amount ?? '',
  ]));

  sheet(book, 'Приборы', [
    { header: '№ заявки', width: 12 }, { header: 'Дата', width: 12 }, { header: 'Город', width: 14 },
    { header: '№ п/п', width: 7 }, { header: 'Услуга', width: 26 }, { header: 'Тип прибора', width: 22 },
    { header: 'ГРСИ', width: 12 }, { header: 'Среда', width: 8 }, { header: 'Зав. номер', width: 14 },
    { header: 'Показания', width: 11 }, { header: 'Помещение', width: 10 }, { header: 'Пломба', width: 8 },
    { header: 'Льгота', width: 8 }, { header: 'Результат', width: 12 }, { header: 'Причина', width: 24 },
    { header: 'Пояснение', width: 24 }, { header: 'Бланк №', width: 10 }, { header: 'Замена', width: 12 },
    { header: 'Установлен взамен', width: 10 }, { header: 'Снят зав. №', width: 14 }, { header: 'Цена, ₽', width: 10 },
    { header: 'Ставка поверителя, ₽', width: 12 }, { header: 'Ставка оператора, ₽', width: 12 },
  ], devices.map((d) => [
    d.request_id, day(d.date), d.city, d.position, d.service, d.device_type, d.grsi, d.carrier, d.serial, d.reading,
    d.room ?? '', yes(d.seal), yes(d.pensioner), d.bad ? 'не годен' : 'годен', d.bad_reason ?? '', d.bad_note,
    d.blank_no, d.replacement ?? '', yes(d.swap), d.swap_of, d.price_charged, d.rate_verifier, d.rate_operator,
  ]));

  sheet(book, 'Оплаты', [
    { header: '№ заявки', width: 12 }, { header: 'Дата', width: 12 }, { header: 'Город', width: 14 },
    { header: 'Клиент', width: 28 }, { header: 'Способ', width: 18 }, { header: 'Получено, ₽', width: 12 },
    { header: 'По прайсу, ₽', width: 12 }, { header: 'Сумма правлена', width: 10 }, { header: 'Примечание', width: 30 },
    { header: 'Когда', width: 17 }, { header: 'Принял', width: 20 },
  ], payments.map((p) => [
    p.request_id, day(p.date), p.city, p.client, p.method, p.amount, p.charged, yes(p.manual), p.note, at(p.paid_at),
    p.by_staff ?? '',
  ]));

  const sum = (rows: Row[], key: string): number => rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
  const byStatus = new Map<string, number>();
  for (const r of requests) byStatus.set(String(r.status), (byStatus.get(String(r.status)) ?? 0) + 1);
  const info = book.addWorksheet('Сводка');
  info.columns = [{ width: 34 }, { width: 40 }];
  const lines: [string, string | number][] = [
    ['Период (дата выезда)', `${from} — ${to}`],
    ['Выгружено', at(new Date())],
    ['Заявок', requests.length],
    ...[...byStatus].map(([s, n]) => [`  из них «${s}»`, n] as [string, number]),
    ['Приборов в актах', devices.length],
    ['  из них не годен', devices.filter((d) => d.bad).length],
    ['По прайсу, ₽', sum(devices, 'price_charged')],
    ['Получено на месте, ₽', sum(payments, 'amount')],
    ['  наличными', sum(payments.filter((p) => p.method === 'наличные'), 'amount')],
    ['  переводом на карту', sum(payments.filter((p) => p.method === 'перевод на карту'), 'amount')],
    ['  по счёту (юрлица)', sum(payments.filter((p) => p.method === 'по счёту'), 'amount')],
    ['Не оплачено, заявок', payments.filter((p) => p.method === 'не оплачено').length],
  ];
  for (const [name, value] of lines) info.addRow([name, value]).getCell(1).font = { bold: true };

  await book.xlsx.writeFile(out);
  console.log(`Период ${from} — ${to}: заявок ${requests.length}, приборов ${devices.length}, оплат ${payments.length}.`);
  console.log(`Файл: ${out}`);
} finally {
  await db.end();
}
