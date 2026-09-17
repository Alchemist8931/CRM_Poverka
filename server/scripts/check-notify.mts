/* Сквозная проверка уведомлений (пункт int-notify).
 *
 *   npx tsx scripts/check-notify.mts
 *
 * Тест `test/notify.test.ts` проверяет правила: согласие, подстановки, повторы,
 * права на шаблоны. Здесь проверяется другое — что письмо и СМС действительно
 * уходят из системы наружу и выглядят так, как задумано.
 *
 * Ни почтового ящика, ни ключей СМС-шлюза у проверки нет и быть не должно:
 * она не имеет права зависеть от чужой службы и от чужого счёта. Поэтому на
 * свободных портах поднимаются два приёмника — настоящий SMTP-сервер (разговор
 * идёт по протоколу, письмо приходит байтами) и эмулятор HTTP-интерфейса
 * SMSC.ru, отвечающий тем же JSON, что и шлюз. Клиенты при этом работают
 * настоящие, те же, что в облаке: src/notify/smtp.ts и src/notify/sms.ts.
 *
 * Чего эта проверка не проверяет и проверить не может: попадёт ли письмо в
 * папку «Спам» у настоящего получателя. Это решает принимающая почта по
 * подписи домена отправителя, и увидеть это можно только с боевого ящика
 * (`npm run notify:probe -- --to ...`). Здесь сверяется то, от чего спам
 * зависит с нашей стороны: адрес отправителя из настроек, заголовки письма и
 * кодировка темы.
 */
import { createServer as createTcp, type Socket } from 'node:net';
import { createServer as createHttp } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { singleConnectionDb, type Db } from '../src/api/db.ts';
import { notifyConfig } from '../src/notify/config.ts';
import { notifiers } from '../src/notify/notifier.ts';
import { enqueue } from '../src/notify/events.ts';
import { runOutbox } from '../src/notify/outbox.ts';
import { planMorning, planReminders } from '../src/notify/schedule.ts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;

function ok(what: string, good: boolean, detail = ''): void {
  if (good) {
    console.log(`  ✓ ${what}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.error(`  ✗ ${what}${detail ? ' — ' + detail : ''}`);
  }
}

/* ───────────────────────────── приёмник SMTP ───────────────────────────── */

interface Letter { from: string; to: string; raw: string }

/** Настоящий SMTP-сервер в четырёх ответах. Порт спрашивается у системы (0):
 *  занятый чужим процессом порт — это не та поломка, которую стоит ловить. */
function smtpSink(): Promise<{ port: number; letters: Letter[]; stop: () => Promise<void> }> {
  const letters: Letter[] = [];
  const server = createTcp((socket: Socket) => {
    let mode: 'команды' | 'письмо' = 'команды';
    let buf = '';
    let from = '';
    let to = '';
    let raw = '';
    socket.setEncoding('utf8');
    socket.write('220 приёмник проверки\r\n');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const at = buf.indexOf('\r\n');
        if (at < 0) break;
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (mode === 'письмо') {
          if (line === '.') {
            letters.push({ from, to, raw });
            mode = 'команды';
            socket.write('250 принято\r\n');
          } else {
            raw += line + '\r\n';
          }
          continue;
        }
        if (/^EHLO|^HELO/i.test(line)) socket.write('250-приёмник\r\n250 OK\r\n');
        else if (/^MAIL FROM:/i.test(line)) { from = line.replace(/^MAIL FROM:\s*/i, ''); socket.write('250 OK\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { to = line.replace(/^RCPT TO:\s*/i, ''); socket.write('250 OK\r\n'); }
        else if (/^DATA/i.test(line)) { mode = 'письмо'; raw = ''; socket.write('354 пишите\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 пока\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => { /* клиент ушёл — приёмнику это безразлично */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, letters, stop: () => new Promise((done) => { server.close(() => done()); }) });
    });
  });
}

/* ──────────────────────── эмулятор шлюза SMSC.ru ──────────────────────── */

interface SmsSent { phones: string; mes: string; virtsms: string | null; login: string | null }

function smsGateway(): Promise<{ url: string; sent: SmsSent[]; stop: () => Promise<void> }> {
  const sent: SmsSent[] = [];
  let id = 1000;
  const server = createHttp((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      res.setHeader('content-type', 'application/json');
      if (!p.get('login') || !p.get('psw')) {
        // Тот же формат отказа, что у настоящего шлюза: очередь обязана уметь
        // разобрать и его, а не только удачу.
        res.end(JSON.stringify({ error: 'не указан логин или пароль', error_code: 4 }));
        return;
      }
      sent.push({
        phones: p.get('phones') ?? '', mes: p.get('mes') ?? '',
        virtsms: p.get('virtsms'), login: p.get('login'),
      });
      res.end(JSON.stringify({ id: ++id, cnt: 1, cost: '0.00', balance: '100.00' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/sys/send.php`, sent, stop: () => new Promise((done) => { server.close(() => done()); }) });
    });
  });
}

/* ──────────────────────────── стенд с базой ───────────────────────────── */

const iso = (shift: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + shift);
  return d.toISOString().slice(0, 10);
};
const TODAY = iso(0);
const TOMORROW = iso(1);

async function stand(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  const dir = join(serverDir, 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await pg.exec(sql.split('-- Down Migration')[0]!.split('-- Up Migration')[1] ?? '');
  }
  const db = singleConnectionDb({
    query: (text, params) => pg.query(text, params as never[]) as never,
    close: () => pg.close(),
  });
  await db.query(`INSERT INTO cities (name, short, sort) VALUES ('Асбест', 'АСБ', 1)`);
  await db.query(
    `INSERT INTO services (id, grp, name, short, price_person, price_pensioner, price_org,
        rate_verifier, rate_operator, is_verification, sort) VALUES
       ('wv', 'Вода', 'Поверка счётчика воды', 'Поверка воды', 900, 760, 1200, 280, 45, true, 1),
       ('wr', 'Вода', 'Замена счётчика воды', 'Замена воды', 2600, 2200, 3200, 750, 70, false, 2)`);
  await db.query(
    `INSERT INTO staff (id, full_name, role, login, password_hash, must_change_password) VALUES
       ('v1', 'Алимпиев И. С.', 'verifier', 'v1', 'x', false),
       ('o1', 'Ефимова О. В.', 'operator', 'o1', 'x', false)`);
  await db.query(`INSERT INTO routes (id, date, city, verifier_id) VALUES ('RT-1', $1, 'Асбест', 'v1')`, [TODAY]);
  // Заявка на завтра: по ней пойдут «заявка», «перенос» и «напоминание».
  await db.query(
    `INSERT INTO requests (id, date, created_date, city, client_type, name, phone, phone_norm, email,
        street, house, flat, time_slot, svcs, status, operator_id, notify_consent)
     VALUES ('R-1', $1, current_date, 'Асбест', 'Физлицо', 'Иванов И. И.', '+7 912 345-67-89', '+79123456789',
        'client@example.org', 'Ленина', '10', '5', 12, ARRAY['wv','wr'], 'создана', 'o1', true)`, [TOMORROW]);
  // Заявка на сегодня в собранном маршруте: по ней пойдёт «выезд» с именем поверителя.
  await db.query(
    `INSERT INTO requests (id, date, created_date, city, client_type, name, phone, phone_norm, email,
        street, house, flat, time_slot, svcs, status, operator_id, route_id, notify_consent)
     VALUES ('R-2', $1, current_date, 'Асбест', 'Физлицо', 'Петрова А. С.', '+7 912 000-11-22', '+79120001122',
        'petrova@example.org', 'Мира', '4', '12', 11, ARRAY['wv'], 'в маршруте', 'o1', 'RT-1', true)`, [TODAY]);
  // Третья заявка — без согласия. По ней не должно уйти ничего.
  await db.query(
    `INSERT INTO requests (id, date, created_date, city, client_type, name, phone, phone_norm, email,
        street, house, time_slot, svcs, status, operator_id, notify_consent)
     VALUES ('R-3', $1, current_date, 'Асбест', 'Физлицо', 'Сидоров П. П.', '+7 912 777-88-99', '+79127778899',
        'sidorov@example.org', 'Садовая', '7', 14, ARRAY['wv'], 'создана', 'o1', false)`, [TOMORROW]);
  return { db, close: () => pg.close() };
}

/** Тема письма из заголовков: MIME-слово раскодируется обратно в текст. */
function subjectOf(raw: string): string {
  const line = raw.split('\r\n').find((l) => l.startsWith('Subject: ')) ?? '';
  const value = line.slice('Subject: '.length);
  const mime = value.match(/^=\?UTF-8\?B\?(.+)\?=$/);
  return mime ? Buffer.from(mime[1]!, 'base64').toString('utf8') : value;
}

/** Текст письма: тело идёт base64, его и раскодируем — ровно так же, как почта. */
function bodyOf(raw: string): string {
  const at = raw.indexOf('\r\n\r\n');
  return Buffer.from(raw.slice(at + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');
}

const headerOf = (raw: string, name: string): string =>
  (raw.split('\r\n').find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':')) ?? '').slice(name.length + 2);

/* ───────────────────────────────── круг ───────────────────────────────── */

const sink = await smtpSink();
const gateway = await smsGateway();
const { db, close } = await stand();

const FROM = 'poverka.asbest@yandex.ru';
const cfg = notifyConfig({
  NOTIFY_FROM: FROM,
  NOTIFY_FROM_NAME: 'ИП Бердинских А. А.',
  NOTIFY_SIGNATURE: 'С уважением, ИП Бердинских А. А. — поверка счётчиков, Асбест.',
  NOTIFY_OFFICE: 'ИП Бердинских',
  NOTIFY_OFFICE_PHONE: '+7 (34365) 7-77-77',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(sink.port),
  SMTP_SECURE: '0',
  SMS_API_URL: gateway.url,
  SMS_LOGIN: 'проверка',
  SMS_PASSWORD: 'пароль',
  SMS_SENDER: 'UCHETKIN',
  SMS_TEST: '1',
} as NodeJS.ProcessEnv);

try {
  console.log('1. Согласие клиента');
  const withoutConsent = await enqueue(db, 'заявка', 'R-3', {}, cfg);
  ok('без галочки согласия в очередь не попадает ничего', withoutConsent.length === 0,
    `поставлено ${withoutConsent.length}`);

  console.log('2. События');
  const accepted = await enqueue(db, 'заявка', 'R-1', {}, cfg);
  ok('заявка принята: письмо и СМС', accepted.length === 2, accepted.map((m) => m.channel).join(' + '));
  const moved = await enqueue(db, 'перенос', 'R-1', { movedFrom: TODAY }, cfg);
  ok('перенос даты: письмо и СМС', moved.length === 2, moved.map((m) => m.channel).join(' + '));
  const evening = await planReminders(db, cfg);
  ok('напоминание накануне поставлено по завтрашней заявке', evening.queued === 2,
    `заявок ${evening.requests}, сообщений ${evening.queued}`);
  const morning = await planMorning(db, cfg);
  ok('утреннее окно поставлено по сегодняшней заявке', morning.queued === 2,
    `заявок ${morning.requests}, сообщений ${morning.queued}`);
  const again = await planReminders(db, cfg);
  ok('повторный проход планировщика не дублирует', again.queued === 0);

  console.log('3. Срок отправки');
  const { rows: times } = await db.query<{ event: string; local: string }>(
    `SELECT DISTINCT event, to_char(send_after AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS local
       FROM notifications WHERE event IN ('напоминание', 'выезд') ORDER BY event`, [cfg.timezone]);
  const reminder = times.find((t) => t.event === 'напоминание')?.local ?? '';
  const trip = times.find((t) => t.event === 'выезд')?.local ?? '';
  ok('напоминание уходит накануне в 18:00 по месту', reminder === `${TODAY} 18:00`, reminder);
  ok('утреннее сообщение уходит в 8:00 по месту', trip === `${TODAY} 08:00`, trip);

  console.log('4. Отправка');
  // Часы переводим здесь нарочно: проверка не ждёт до вечера, а срок отправки
  // уже сверен выше.
  await db.query(`UPDATE notifications SET send_after = now() WHERE status = 'в очереди'`);
  const result = await runOutbox(db, await notifiers(cfg), { cfg });
  ok('отправлено всё поставленное', result.sent === 8 && result.failed === 0,
    `ушло ${result.sent}, не прошло ${result.failed}, отложено ${result.skipped}`);
  ok('в приёмник пришло четыре письма', sink.letters.length === 4, `писем ${sink.letters.length}`);
  ok('на шлюз ушло четыре СМС', gateway.sent.length === 4, `сообщений ${gateway.sent.length}`);

  console.log('5. Письма');
  for (const letter of sink.letters) {
    const subject = subjectOf(letter.raw);
    const body = bodyOf(letter.raw);
    const head = letter.raw.split('\r\n\r\n')[0]!;
    ok(`«${subject}»: отправитель из настроек`,
      letter.from === `<${FROM}>` && head.includes(`<${FROM}>`), letter.from);
    ok(`«${subject}»: заголовки на месте`,
      ['Reply-To', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type'].every((h) => headerOf(head, h)),
      headerOf(head, 'Content-Type'));
    ok(`«${subject}»: тема в UTF-8 читается`, /[А-Яа-яё]/.test(subject), subject);
    ok(`«${subject}»: подстановки заполнены`, !/\{[а-яёa-z_]+\}/i.test(subject + body),
      (subject + body).match(/\{[а-яёa-z_]+\}/i)?.[0] ?? 'ни одной скобки не осталось');
    ok(`«${subject}»: подпись из настроек`, body.includes(cfg.signature));
  }
  const texts = sink.letters.map((l) => subjectOf(l.raw) + '\n' + bodyOf(l.raw));
  const find = (what: string) => texts.find((t) => t.includes(what)) ?? '';
  ok('в письме о заявке — дата, окно, сумма и способы оплаты',
    ['11:00', '13:00', '3500', 'наличные или перевод на карту', 'Поверка счётчика воды']
      .every((s) => find('Ваша заявка принята').includes(s)),
    find('Ваша заявка принята').replace(/\n/g, ' ').slice(0, 120));
  ok('в утреннем письме — имя поверителя и окно прибытия',
    find('приедет наш поверитель').includes('Алимпиев И. С.') && find('приедет наш поверитель').includes('10:00'),
    find('приедет наш поверитель').replace(/\n/g, ' ').slice(0, 120));
  ok('в письме о переносе — прежняя и новая дата',
    find('перенесена с').includes(TODAY.split('-').reverse().join('.'))
    && find('перенесена с').includes(TOMORROW.split('-').reverse().join('.')));
  ok('в напоминании — завтрашняя дата и адрес',
    find('Напоминаем').includes('Ленина') && find('Напоминаем').includes(TOMORROW.split('-').reverse().join('.')));

  console.log('6. СМС');
  ok('шлюз получил номер в цифрах', gateway.sent.every((s) => /^7\d{10}$/.test(s.phones)),
    gateway.sent[0]?.phones ?? '');
  ok('отправка пошла в тестовый контур провайдера (virtsms=1)',
    gateway.sent.every((s) => s.virtsms === '1'));
  ok('подстановки в СМС заполнены', gateway.sent.every((s) => !/\{[а-яёa-z_]+\}/i.test(s.mes)),
    gateway.sent[0]?.mes ?? '');
  ok('в СМС о заявке — дата, окно и сумма',
    gateway.sent.some((s) => s.mes.includes('Заявка принята') && s.mes.includes('3500') && s.mes.includes('11:00')),
    gateway.sent.find((s) => s.mes.includes('Заявка принята'))?.mes ?? '');

  console.log('7. Журнал доставки');
  const { rows: log } = await db.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM notifications GROUP BY status ORDER BY status`);
  ok('в очереди не осталось неотправленного',
    log.length === 1 && log[0]!.status === 'отправлено' && log[0]!.n === '8',
    log.map((r) => `${r.status}: ${r.n}`).join(', '));
  const { rows: tries } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification_attempts WHERE ok`);
  ok('каждая отправка записана в журнал попыток', tries[0]!.n === '8', `записей ${tries[0]!.n}`);
  const { rows: ids } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications WHERE provider_id IS NOT NULL`);
  ok('у каждого сообщения есть идентификатор шлюза', ids[0]!.n === '8');

  console.log('8. Отказ шлюза и повтор');
  await sink.stop();
  await db.query(
    `UPDATE notifications SET status = 'в очереди', attempts = 0, send_after = now(), sent_at = NULL
      WHERE channel = 'email' AND event = 'заявка'`);
  const broken = await runOutbox(db, await notifiers(cfg), { cfg });
  ok('недоступная почта не роняет проход', broken.failed === 1 && broken.sent === 0,
    `не прошло ${broken.failed}`);
  const { rows: failedRow } = await db.query<{ status: string; attempts: number; last_error: string }>(
    `SELECT status, attempts, last_error FROM notifications WHERE channel = 'email' AND event = 'заявка'`);
  ok('сообщение осталось в очереди с причиной и потраченной попыткой',
    failedRow[0]!.status === 'ошибка' && failedRow[0]!.attempts === 1 && !!failedRow[0]!.last_error,
    failedRow[0]!.last_error?.slice(0, 80));
  const { rows: retryAt } = await db.query<{ mins: string }>(
    `SELECT round(extract(epoch FROM send_after - now()) / 60)::text AS mins
       FROM notifications WHERE channel = 'email' AND event = 'заявка'`);
  ok('повтор отложен на паузу из настроек', Number(retryAt[0]!.mins) === cfg.retryMinutes,
    `через ${retryAt[0]!.mins} мин`);
} finally {
  await close();
  await gateway.stop();
  await sink.stop().catch(() => {});
}

console.log('');
console.log('Чего эта проверка не проверяет: попадёт ли письмо в «Спам» у настоящего');
console.log('получателя — это решает принимающая почта по подписи домена отправителя.');
console.log('Проверяется с боевого ящика: npm run notify:probe -- --to адрес@пример.рф');

if (failed) {
  console.error(`\nСверка уведомлений не сошлась: расхождений ${failed}.`);
  process.exit(1);
}
console.log('\nУведомления: письма и СМС уходят по всем четырём событиям, подстановки на месте.');
