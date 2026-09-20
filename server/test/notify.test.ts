/* Уведомления клиентам: согласие, шаблоны, очередь и повторы (пункт int-notify).
 *
 * Здесь проверяются правила, а не доставка. Что письмо и СМС действительно
 * уходят по протоколу и как выглядят снаружи — отдельная сквозная проверка
 * `scripts/check-notify.mts`: она поднимает приёмник SMTP и эмулятор шлюза.
 *
 * Отправители здесь подставные — список в памяти. Это и есть смысл абстракции
 * `Notifier`: очередь не знает, кто на другом конце, и проверяется целиком без
 * единого сетевого соединения.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { TOMORROW, AFTER, as, draft, login, makeStand, type Stand } from './helpers.ts';
import { notifyConfig } from '../src/notify/config.ts';
import { enqueue } from '../src/notify/events.ts';
import { backoffMinutes, runOutbox } from '../src/notify/outbox.ts';
import { planMorning, planReminders, cancelStale } from '../src/notify/schedule.ts';
import { placeholdersIn, render, templateProblem } from '../src/notify/templates.ts';
import type { Message, Notifier, Sent } from '../src/notify/notifier.ts';

const body = (res: { body: string }) => JSON.parse(res.body);

/** Настройки проверки: адрес отправителя и телефон конторы заданы явно, чтобы
 *  видеть их в готовом тексте и не зависеть от окружения машины. */
const CFG = notifyConfig({
  NOTIFY_FROM: 'poverka.asbest@yandex.ru',
  NOTIFY_OFFICE_PHONE: '+7 (34365) 7-77-77',
  NOTIFY_SIGNATURE: 'С уважением, ИП Бердинских А. А.',
} as NodeJS.ProcessEnv);

/** Подставной отправитель: складывает сообщения в список. `fail` — шлюз,
 *  который отказывает: на нём проверяются повторы. */
function fake(channel: 'email' | 'sms', fail = false): Notifier & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    channel,
    sent,
    async send(msg: Message): Promise<Sent> {
      if (fail) throw new Error('шлюз отказал: кончились деньги на счёте');
      sent.push(msg);
      return { id: `id-${sent.length}`, response: 'принято' };
    },
  };
}

interface Row {
  id: number; event: string; channel: string; address: string; subject: string; body: string;
  status: string; attempts: number; last_error: string | null; provider_id: string | null;
}

const queue = async (st: Stand, where = '', params: unknown[] = []): Promise<Row[]> => {
  const { rows } = await st.db.query<Row>(
    `SELECT * FROM notifications ${where ? 'WHERE ' + where : ''} ORDER BY id`, params);
  return rows;
};

/** Постановка в очередь при приёме заявки идёт мимо ответа оператору нарочно
 *  (упавшая почта не должна ронять приём), поэтому в проверке её ждём. */
async function settled(st: Stand, count: number, ms = 2000): Promise<Row[]> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = await queue(st);
    if (rows.length >= count || Date.now() > until) return rows;
    await new Promise((done) => setTimeout(done, 10));
  }
}

const withMail = (over: Record<string, unknown> = {}) =>
  draft({ email: 'client@example.org', notify_consent: true, ...over });

describe('уведомления: согласие клиента', () => {
  it('с галочкой согласия заявка ставит письмо и СМС', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', withMail()));
      assert.equal(made.request.notify_consent, true);

      const rows = await settled(st, 2);
      assert.deepEqual(rows.map((r) => r.channel).sort(), ['email', 'sms']);
      assert.ok(rows.every((r) => r.event === 'заявка' && r.status === 'в очереди'));
      assert.equal(rows.find((r) => r.channel === 'email')!.address, 'client@example.org');
      assert.equal(rows.find((r) => r.channel === 'sms')!.address, '+79123456789');
    } finally { await st.close(); }
  });

  it('без галочки не ставится ничего', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', draft({ email: 'client@example.org' }));
      // Ждём столько же, сколько ждали бы появления строки: «ничего не пришло»
      // должно быть проверено после паузы, иначе проверка ничего не значит.
      const rows = await settled(st, 1, 300);
      assert.equal(rows.length, 0);
    } finally { await st.close(); }
  });

  it('согласие запоминается в карточке клиента', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      const { rows } = await st.db.query<{ notify_consent: boolean }>(
        `SELECT notify_consent FROM clients WHERE phone_norm = '+79123456789'`);
      assert.equal(rows[0]!.notify_consent, true);
    } finally { await st.close(); }
  });

  it('заявка без почты уходит только СМС', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', draft({ notify_consent: true }));
      const rows = await settled(st, 1);
      assert.deepEqual(rows.map((r) => r.channel), ['sms']);
    } finally { await st.close(); }
  });
});

describe('уведомления: события', () => {
  it('в письме о заявке — дата, окно прибытия, сумма по прайсу и способы оплаты', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail({ svcs: ['wv', 'wr'], time_slot: 12 }));
      const rows = await settled(st, 2);
      const letter = rows.find((r) => r.channel === 'email')!;
      const date = TOMORROW.split('-').reverse().join('.');
      assert.ok(letter.subject.includes(date), letter.subject);
      assert.ok(letter.body.includes('с 11:00 до 13:00'), letter.body);
      // 900 за поверку воды + 2600 за замену — прайс стенда для физлица.
      assert.ok(letter.body.includes('3500'), letter.body);
      assert.ok(letter.body.includes('наличные или перевод на карту'), letter.body);
      assert.ok(letter.body.includes('Поверка счётчика воды, Замена счётчика воды'), letter.body);
      assert.ok(!/\{[а-яё_]+\}/i.test(letter.body), 'в тексте осталась подстановка');
    } finally { await st.close(); }
  });

  it('юрлицу считается цена юрлица и предлагается счёт', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail({ client_type: 'Юрлицо', inn: '6603001234', svcs: ['wv'] }));
      const rows = await settled(st, 2);
      const letter = rows.find((r) => r.channel === 'email')!;
      assert.ok(letter.body.includes('1200'), letter.body);
      assert.ok(letter.body.includes('по счёту'), letter.body);
    } finally { await st.close(); }
  });

  it('перенос даты ставит сообщение с прежней и новой датой', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', withMail()));
      await settled(st, 2);
      await op.patch(`/api/requests/${made.request.id}`, { date: AFTER });
      const rows = await settled(st, 4);
      const moved = rows.filter((r) => r.event === 'перенос');
      assert.equal(moved.length, 2);
      assert.ok(moved[0]!.body.includes(TOMORROW.split('-').reverse().join('.')), moved[0]!.body);
      assert.ok(moved[0]!.body.includes(AFTER.split('-').reverse().join('.')), moved[0]!.body);
    } finally { await st.close(); }
  });

  it('правка без смены даты событием не считается', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', withMail()));
      await settled(st, 2);
      await op.patch(`/api/requests/${made.request.id}`, { comment_operator: 'домофон не работает' });
      const rows = await settled(st, 3, 300);
      assert.equal(rows.length, 2);
    } finally { await st.close(); }
  });

  it('напоминание накануне уходит в 18:00 по месту, утреннее — в 8:00', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());          // на завтра
      await settled(st, 2);
      const evening = await planReminders(st.db, CFG);
      assert.equal(evening.queued, 2);

      const { rows } = await st.db.query<{ local: string }>(
        `SELECT DISTINCT to_char(send_after AT TIME ZONE $1, 'HH24:MI') AS local
           FROM notifications WHERE event = 'напоминание'`, [CFG.timezone]);
      assert.deepEqual(rows.map((r) => r.local), ['18:00']);

      // Второй проход планировщика ничего не добавляет: ключ разбора уникален.
      assert.equal((await planReminders(st.db, CFG)).queued, 0);
    } finally { await st.close(); }
  });

  it('утреннее сообщение называет поверителя из маршрута', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', withMail({ date: TOMORROW })));
      await settled(st, 2);
      // Двигаем заявку на сегодня и ставим ей маршрут с поверителем: утренний
      // проход смотрит именно на сегодняшний день.
      await st.db.query(`INSERT INTO routes (id, date, city, verifier_id) VALUES ('RT-1', current_date, 'Екатеринбург', 'v1')`);
      await st.db.query(`UPDATE requests SET date = current_date, route_id = 'RT-1', status = 'в маршруте' WHERE id = $1`,
        [made.request.id]);

      const morning = await planMorning(st.db, CFG);
      assert.equal(morning.queued, 2);
      const rows = await queue(st, `event = 'выезд' AND channel = 'email'`);
      assert.ok(rows[0]!.body.includes('Алимпиев И.'), rows[0]!.body);
      assert.ok(rows[0]!.body.includes('с 11:00 до 13:00'), rows[0]!.body);
    } finally { await st.close(); }
  });

  it('отменённая заявка снимается с очереди с причиной', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', withMail()));
      await settled(st, 2);
      await st.db.query(`UPDATE requests SET status = 'отменена' WHERE id = $1`, [made.request.id]);
      assert.equal(await cancelStale(st.db), 2);
      const rows = await queue(st);
      assert.ok(rows.every((r) => r.status === 'отменено' && r.last_error === 'заявка отменена'));
    } finally { await st.close(); }
  });

  it('отозванное согласие снимает с очереди то, что ещё не ушло', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', withMail()));
      await settled(st, 2);
      await op.patch(`/api/requests/${made.request.id}`, { notify_consent: false });
      assert.equal(await cancelStale(st.db), 2);
      assert.ok((await queue(st)).every((r) => r.last_error === 'согласие отозвано'));
    } finally { await st.close(); }
  });
});

describe('уведомления: очередь и повторы', () => {
  it('отправленное помечается и попадает в журнал доставки', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      await settled(st, 2);

      const email = fake('email');
      const sms = fake('sms');
      const result = await runOutbox(st.db, { email, sms }, { cfg: CFG });
      assert.deepEqual(result, { sent: 2, failed: 0, skipped: 0 });
      assert.equal(email.sent.length, 1);
      assert.equal(sms.sent.length, 1);

      const rows = await queue(st);
      assert.ok(rows.every((r) => r.status === 'отправлено' && r.attempts === 1 && r.provider_id));
      const { rows: tries } = await st.db.query<{ ok: boolean; response: string }>(
        'SELECT ok, response FROM notification_attempts ORDER BY id');
      assert.equal(tries.length, 2);
      assert.ok(tries.every((t) => t.ok && t.response === 'принято'));
    } finally { await st.close(); }
  });

  it('второй проход не отправляет то же самое второй раз', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      await settled(st, 2);
      const email = fake('email');
      const sms = fake('sms');
      await runOutbox(st.db, { email, sms }, { cfg: CFG });
      const again = await runOutbox(st.db, { email, sms }, { cfg: CFG });
      assert.deepEqual(again, { sent: 0, failed: 0, skipped: 0 });
      assert.equal(email.sent.length, 1);
    } finally { await st.close(); }
  });

  it('отказ шлюза откладывает повтор и пишет причину', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      await settled(st, 2);

      const result = await runOutbox(st.db, { email: fake('email', true), sms: fake('sms') }, { cfg: CFG });
      assert.deepEqual(result, { sent: 1, failed: 1, skipped: 0 });

      const [letter] = await queue(st, `channel = 'email'`);
      assert.equal(letter!.status, 'ошибка');
      assert.equal(letter!.attempts, 1);
      assert.match(letter!.last_error ?? '', /кончились деньги/);

      // Следующий проход её не берёт: срок повтора ещё не подошёл.
      const soon = await runOutbox(st.db, { email: fake('email'), sms: fake('sms') }, { cfg: CFG });
      assert.equal(soon.sent, 0);

      const { rows } = await st.db.query<{ mins: string }>(
        `SELECT round(extract(epoch FROM send_after - now()) / 60)::text AS mins
           FROM notifications WHERE channel = 'email'`);
      assert.equal(Number(rows[0]!.mins), CFG.retryMinutes);
    } finally { await st.close(); }
  });

  it('после исчерпанных попыток сообщение останавливается с последней причиной', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      await settled(st, 2);
      const cfg = { ...CFG, maxAttempts: 3 };

      for (let i = 0; i < 4; i++) {
        // Перед каждым проходом двигаем срок: иначе проверка ждала бы паузу.
        await st.db.query(`UPDATE notifications SET send_after = now() WHERE status = 'ошибка'`);
        await runOutbox(st.db, { email: fake('email', true), sms: fake('sms') }, { cfg });
      }
      const [letter] = await queue(st, `channel = 'email'`);
      assert.equal(letter!.attempts, 3, 'попыток потрачено больше, чем разрешено');
      assert.equal(letter!.status, 'ошибка');
      assert.match(letter!.last_error ?? '', /шлюз отказал/);
    } finally { await st.close(); }
  });

  it('ненастроенный канал не тратит попытку: сообщение ждёт ключей', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      await settled(st, 2);
      const result = await runOutbox(st.db, { email: null, sms: fake('sms') }, { cfg: CFG });
      assert.deepEqual(result, { sent: 1, failed: 0, skipped: 1 });
      const [letter] = await queue(st, `channel = 'email'`);
      assert.equal(letter!.status, 'в очереди');
      assert.equal(letter!.attempts, 0);
    } finally { await st.close(); }
  });

  it('пауза перед повтором растёт', () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffMinutes(n, 10)), [10, 20, 40, 80]);
  });
});

describe('уведомления: шаблоны', () => {
  it('руководитель правит текст, оператор — нет', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const op = as(st.app, await login(st.app, 'o1'));

      const mine = await sv.put('/api/notify/templates/заявка/sms',
        { body: 'Записали на {дата}, ждите с {окно_с} до {окно_до}. {контора}' });
      assert.equal(mine.statusCode, 200);
      assert.equal(body(mine).template.updated_by, 'sv');

      const theirs = await op.put('/api/notify/templates/заявка/sms', { body: 'Что угодно' });
      assert.equal(theirs.statusCode, 422);
      assert.match(body(theirs).error, /только руководитель/);
    } finally { await st.close(); }
  });

  it('правленый шаблон уходит клиенту', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      await sv.put('/api/notify/templates/заявка/sms', { body: 'Мастер приедет {дата}. {контора}' });
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      const rows = await settled(st, 2);
      const sms = rows.find((r) => r.channel === 'sms')!;
      assert.ok(sms.body.startsWith('Мастер приедет'), sms.body);
    } finally { await st.close(); }
  });

  it('опечатка в подстановке не сохраняется', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const res = await sv.put('/api/notify/templates/заявка/sms', { body: 'Ждите {мастера} в {дата}' });
      assert.equal(res.statusCode, 422);
      assert.match(body(res).error, /Неизвестная подстановка \{мастера\}/);
    } finally { await st.close(); }
  });

  it('подстановка, которой у события нет, отвергается с причиной', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const res = await sv.put('/api/notify/templates/заявка/email',
        { subject: 'Заявка', body: 'К вам приедет {поверитель}' });
      assert.equal(res.statusCode, 422);
      assert.match(body(res).error, /нет у события «заявка»/);
    } finally { await st.close(); }
  });

  it('письмо без темы не сохраняется', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const res = await sv.put('/api/notify/templates/заявка/email', { subject: '  ', body: 'Текст' });
      assert.equal(res.statusCode, 422);
      assert.match(body(res).error, /тема/);
    } finally { await st.close(); }
  });

  it('перечень шаблонов показывает подстановки и адрес отправителя', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const res = body(await op.get('/api/notify/templates'));
      // Пять событий на два канала: четыре заказчика плюс «чек» (пункт int-pay).
      assert.equal(res.templates.length, 10);
      assert.ok(res.placeholders['окно_с']);
      assert.ok(res.allowed['чек'].includes('номер_чека') && !res.allowed['заявка'].includes('номер_чека'));
      assert.ok(!res.allowed['заявка'].includes('поверитель'));
      assert.ok(res.allowed['выезд'].includes('поверитель'));
      // Отправитель — из настроек контура, а не из формы: правится выкладкой.
      assert.equal(res.sender.from, notifyConfig().from);
    } finally { await st.close(); }
  });

  it('подстановка без значения оставляет пустое место, а не скобки', () => {
    assert.equal(render('Привет, {имя}! {поверитель}', { 'имя': 'Пётр' }), 'Привет, Пётр! ');
    assert.deepEqual(placeholdersIn('{дата} и снова {дата}, а также {адрес}'), ['дата', 'адрес']);
    assert.equal(templateProblem('выезд', 'sms', '', 'Приедет {поверитель}'), null);
    assert.match(templateProblem('выезд', 'sms', '', '   ') ?? '', /пустой/);
  });
});

describe('уведомления: журнал доставки', () => {
  it('руководитель видит очередь и попытки, оператор — нет', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      await op.post('/api/requests', withMail());
      await settled(st, 2);
      await runOutbox(st.db, { email: fake('email'), sms: fake('sms', true) }, { cfg: CFG });

      const sv = as(st.app, await login(st.app, 'sv'));
      const all = body(await sv.get('/api/notify/queue'));
      assert.equal(all.notifications.length, 2);
      const failed = body(await sv.get('/api/notify/queue?status=ошибка'));
      assert.equal(failed.notifications.length, 1);
      assert.equal(failed.notifications[0].channel, 'sms');
      assert.equal(failed.notifications[0].tries, 1);

      const attempts = body(await sv.get(`/api/notify/queue/${failed.notifications[0].id}/attempts`));
      assert.equal(attempts.attempts.length, 1);
      assert.equal(attempts.attempts[0].ok, false);

      assert.equal((await op.get('/api/notify/queue')).statusCode, 403);
    } finally { await st.close(); }
  });

  it('прямой вызов постановки молчит без согласия', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = body(await op.post('/api/requests', draft({ email: 'client@example.org' })));
      // Согласия нет — и никакое событие его не обходит.
      for (const event of ['заявка', 'напоминание', 'выезд', 'перенос'] as const) {
        assert.deepEqual(await enqueue(st.db, event, made.request.id, {}, CFG), []);
      }
      assert.equal((await queue(st)).length, 0);
    } finally { await st.close(); }
  });
});
