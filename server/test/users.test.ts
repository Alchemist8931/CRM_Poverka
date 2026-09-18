/* Учётные записи: заведение, первый вход, увольнение (пункт be-users).
 *
 * Проверяется то, чем этот пункт живёт в работе у заказчицы: она заводит
 * сотрудника сама, диктует ему временный пароль, а при увольнении выключает
 * учётку — и человек должен исчезнуть из выбора в новые смены, но не из
 * истории. Всё остальное (длина пароля, счётчик попыток) проверяется здесь же,
 * потому что именно на этом ломается первый рабочий день.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { TOMORROW, as, login, makeStand, type Stand } from './helpers.ts';
import { MIN_PASSWORD } from '../src/password.ts';
import { LOGIN_FAIL_LIMIT } from '../src/api/auth.ts';

const body = (res: { body: string }) => JSON.parse(res.body);

/** Вход с произвольным паролем: `login` из helpers знает только демо-пароль. */
async function signIn(app: FastifyInstance, name: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: name, password } });
}

/** Cookie сессии из ответа входа. */
function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0]! : String(raw);
  return first.split(';')[0]!;
}

/** Новый сотрудник руками руководителя — как это делает заказчица на экране. */
async function hire(st: Stand, over: Record<string, unknown> = {}) {
  const sv = as(st.app, await login(st.app, 'sv'));
  const res = await sv.post('/api/staff', {
    full_name: 'Новикова А. С.', role: 'operator', phone: '+7 (912) 000-11-22',
    ext: '105', email: 'novikova@example.org', ...over,
  });
  assert.equal(res.statusCode, 200, res.body);
  return { sv, ...body(res) as { staff: Record<string, unknown>; temporary_password: string } };
}

describe('учётные записи: заведение', () => {
  it('руководитель заводит сотрудника, логин собирается из почты, пароль выдаётся один раз', async () => {
    const st = await makeStand();
    try {
      const { staff, temporary_password: pw } = await hire(st);
      assert.equal(staff.login, 'novikova', 'логин собран из части почты до «@»');
      assert.equal(staff.role, 'operator');
      assert.equal(staff.ext, '105');
      assert.equal(staff.must_change_password, true, 'пароль заведён как временный');
      assert.equal(staff.blocked_at, null);
      assert.ok(pw.length >= MIN_PASSWORD, `временный пароль не короче ${MIN_PASSWORD} знаков`);
      assert.ok(!JSON.stringify(staff).includes(pw), 'пароль в карточке не лежит — только в ответе на создание');

      // Идентификатор осмысленный и не занят: оператор — «o» с номером.
      assert.match(String(staff.id), /^o\d+$/);

      // Тем же паролем сотрудник входит.
      const res = await signIn(st.app, 'novikova', pw);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(body(res).user.must_change_password, true);
    } finally { await st.close(); }
  });

  it('логин можно задать руками, а без почты и логина карточку не завести', async () => {
    const st = await makeStand();
    try {
      const { staff } = await hire(st, { login: 'Petrova', email: '' });
      assert.equal(staff.login, 'petrova', 'логин приводится к нижнему регистру');
      assert.equal(staff.email, null);

      const sv = as(st.app, await login(st.app, 'sv'));
      const bare = await sv.post('/api/staff', { full_name: 'Без входа', role: 'operator' });
      assert.equal(bare.statusCode, 422, bare.body);
      assert.equal(body(bare).reason, 'login');
    } finally { await st.close(); }
  });

  it('занятый логин и занятая почта не проходят', async () => {
    const st = await makeStand();
    try {
      await hire(st);
      const sv = as(st.app, await login(st.app, 'sv'));
      const same = await sv.post('/api/staff',
        { full_name: 'Другая Н. Н.', role: 'operator', login: 'NOVIKOVA' });
      assert.equal(same.statusCode, 422, same.body);
      assert.equal(body(same).reason, 'login');

      // Почта занята, а логин свободен: отказ должен быть именно про почту —
      // иначе руководитель будет менять не то поле.
      const mail = await sv.post('/api/staff',
        { full_name: 'Третья Н. Н.', role: 'operator', login: 'tretya', email: 'Novikova@Example.org' });
      assert.equal(mail.statusCode, 422, mail.body);
      assert.equal(body(mail).reason, 'email');
    } finally { await st.close(); }
  });

  it('поверителю заводятся компетенции, оператору — нет', async () => {
    const st = await makeStand();
    try {
      const { staff, sv } = await hire(st,
        { full_name: 'Седых В. В.', role: 'verifier', email: 'sedyh@example.org', svcs: ['wv', 'wr'] });
      assert.deepEqual(staff.svcs, ['wr', 'wv']);

      const moved = await sv.patch(`/api/staff/${staff.id}`, { role: 'operator' });
      assert.equal(moved.statusCode, 200, moved.body);
      assert.deepEqual(body(moved).staff.svcs, [], 'оператор услуг не закрывает — компетенции сняты');
    } finally { await st.close(); }
  });
});

describe('учётные записи: первый вход', () => {
  it('со временным паролём дальше смены пароля не пускают, после смены работа открыта', async () => {
    const st = await makeStand();
    try {
      const { staff, temporary_password: pw } = await hire(st);
      const cookie = cookieOf(await signIn(st.app, 'novikova', pw));
      const she = as(st.app, cookie);

      // Пока пароль временный, работать нельзя — но видно, кто ты, и можно выйти.
      const work = await she.get('/api/cities');
      assert.equal(work.statusCode, 403, work.body);
      assert.equal(body(work).reason, 'password');
      assert.equal((await she.get('/api/auth/me')).statusCode, 200, 'узнать себя можно');

      // Короткий пароль не принимается.
      const short = await she.post(`/api/staff/${staff.id}/password`, { current: pw, password: 'короткий' });
      assert.equal(short.statusCode, 422, short.body);
      assert.equal(body(short).reason, 'password');

      // Неверный текущий пароль — тоже.
      const wrong = await she.post(`/api/staff/${staff.id}/password`,
        { current: 'не тот пароль', password: 'долгий-и-надёжный' });
      assert.equal(wrong.statusCode, 401, wrong.body);

      const done = await she.post(`/api/staff/${staff.id}/password`,
        { current: pw, password: 'долгий-и-надёжный' });
      assert.equal(done.statusCode, 200, done.body);

      // Смена гасит прежние сессии, но выданная в ответе — рабочая.
      const after = as(st.app, cookieOf(done));
      assert.equal((await after.get('/api/cities')).statusCode, 200, 'после смены пароля экран открыт');
      assert.equal(body(await after.get('/api/auth/me')).user.must_change_password, false);

      // Прежней cookie больше нет: она выдана до смены пароля.
      assert.equal((await she.get('/api/auth/me')).statusCode, 401, 'старая сессия погашена');

      // Старый пароль больше не пускает, новый — пускает.
      assert.equal((await signIn(st.app, 'novikova', pw)).statusCode, 401);
      assert.equal((await signIn(st.app, 'novikova', 'долгий-и-надёжный')).statusCode, 200);
    } finally { await st.close(); }
  });

  it('чужой пароль не меняет никто, включая руководителя', async () => {
    const st = await makeStand();
    try {
      const { staff, sv, temporary_password: pw } = await hire(st);
      const res = await sv.post(`/api/staff/${staff.id}/password`, { current: pw, password: 'долгий-и-надёжный' });
      assert.equal(res.statusCode, 403, res.body);
      assert.equal(body(res).reason, 'self');
    } finally { await st.close(); }
  });

  it('сброс пароля руководителем выдаёт новый временный и снова требует смены', async () => {
    const st = await makeStand();
    try {
      const { staff, sv, temporary_password: pw } = await hire(st);
      const cookie = cookieOf(await signIn(st.app, 'novikova', pw));

      const res = await sv.post(`/api/staff/${staff.id}/password/reset`);
      assert.equal(res.statusCode, 200, res.body);
      const fresh = body(res).temporary_password as string;
      assert.ok(fresh.length >= MIN_PASSWORD);
      assert.notEqual(fresh, pw);

      assert.equal((await signIn(st.app, 'novikova', pw)).statusCode, 401, 'прежний пароль не работает');
      const back = await signIn(st.app, 'novikova', fresh);
      assert.equal(back.statusCode, 200, back.body);
      assert.equal(body(back).user.must_change_password, true, 'новый пароль снова временный');
      // Сброс гасит и открытые сессии: сбрасывают пароль тогда, когда он утёк.
      assert.equal((await as(st.app, cookie).get('/api/auth/me')).statusCode, 401);
    } finally { await st.close(); }
  });
});

describe('учётные записи: вход под замком', () => {
  it(`после ${LOGIN_FAIL_LIMIT} неудачных попыток вход закрывается, верный пароль тоже не пускает`, async () => {
    const st = await makeStand();
    try {
      for (let i = 1; i < LOGIN_FAIL_LIMIT; i++) {
        const res = await signIn(st.app, 'sv', 'не тот пароль');
        assert.equal(res.statusCode, 401, `попытка ${i} — обычный отказ`);
      }
      const last = await signIn(st.app, 'sv', 'не тот пароль');
      assert.equal(last.statusCode, 403, last.body);
      assert.equal(body(last).reason, 'locked');
      assert.match(body(last).error, /15 мин|мин/);

      const right = await signIn(st.app, 'sv', '1234');
      assert.equal(right.statusCode, 403, 'под замком не пускает и верный пароль');
      assert.equal(body(right).reason, 'locked');

      // Замок временный: отодвигаем его в прошлое — вход снова работает.
      await st.db.query(`UPDATE staff SET locked_until = now() - interval '1 minute' WHERE id = 'sv'`);
      assert.equal((await signIn(st.app, 'sv', '1234')).statusCode, 200);

      // Удачный вход обнуляет счётчик: следующая опечатка начинает счёт заново.
      const { rows } = await st.db.query<{ failed_logins: number; locked_until: string | null }>(
        `SELECT failed_logins, locked_until FROM staff WHERE id = 'sv'`);
      assert.equal(rows[0]!.failed_logins, 0);
      assert.equal(rows[0]!.locked_until, null);
    } finally { await st.close(); }
  });

  it('счётчик неудач у одного человека не закрывает вход другому', async () => {
    const st = await makeStand();
    try {
      for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) await signIn(st.app, 'o1', 'не тот пароль');
      assert.equal((await signIn(st.app, 'o1', '1234')).statusCode, 403);
      assert.equal((await signIn(st.app, 'sv', '1234')).statusCode, 200);
    } finally { await st.close(); }
  });
});

describe('учётные записи: увольнение', () => {
  it('заблокированный не входит, не идёт в смену и в маршрут, но виден в истории', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const cookie = await login(st.app, 'v1');

      // Сначала соберём историю: маршрут вчерашнего дня с этим поверителем.
      await st.db.query(
        `INSERT INTO routes (id, date, city, verifier_id, status)
         VALUES ('M-900', $1, 'Екатеринбург', 'v1', 'выполнен')`, [TOMORROW]);

      const off = await sv.patch('/api/staff/v1', { blocked: true });
      assert.equal(off.statusCode, 200, off.body);
      assert.ok(body(off).staff.blocked_at, 'отметка увольнения проставлена');

      // 1. Вход закрыт, открытая сессия погашена.
      assert.equal((await signIn(st.app, 'v1', '1234')).statusCode, 403);
      assert.equal((await as(st.app, cookie).get('/api/auth/me')).statusCode, 401);

      // 2. В новую смену не ставится.
      const shift = await sv.put(`/api/days/${TOMORROW}`, { crew: ['v1', 'v2'] });
      assert.equal(shift.statusCode, 422, shift.body);

      // 3. На новый маршрут не назначается.
      const route = await sv.patch('/api/routes/M-900', { verifier_id: 'v1' });
      assert.equal(route.statusCode, 422, route.body);
      assert.equal(body(route).reason, 'blocked');

      // 4. В истории остаётся: маршрут по-прежнему подписан им.
      const { rows } = await st.db.query<{ verifier_id: string }>(
        `SELECT verifier_id FROM routes WHERE id = 'M-900'`);
      assert.equal(rows[0]!.verifier_id, 'v1', 'прошлый выезд остался за уволенным');

      // 5. В справочнике он есть, среди работающих — нет.
      const all = body(await sv.get('/api/staff')).staff as { id: string }[];
      const active = body(await sv.get('/api/staff?state=active')).staff as { id: string }[];
      assert.ok(all.some((p) => p.id === 'v1'), 'в полном списке уволенный есть — истории нужно его имя');
      assert.ok(!active.some((p) => p.id === 'v1'), 'среди работающих его нет');
      const blocked = body(await sv.get('/api/staff?state=blocked')).staff as { id: string }[];
      assert.deepEqual(blocked.map((p) => p.id), ['v1']);
    } finally { await st.close(); }
  });

  it('разблокировка возвращает человека в работу и снимает замок входа', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      await sv.patch('/api/staff/v1', { blocked: true });
      const back = await sv.patch('/api/staff/v1', { blocked: false });
      assert.equal(back.statusCode, 200, back.body);
      assert.equal(body(back).staff.blocked_at, null);
      assert.equal((await signIn(st.app, 'v1', '1234')).statusCode, 200);

      const shift = await sv.put(`/api/days/${TOMORROW}`, { crew: ['v1', 'v2'] });
      assert.equal(shift.statusCode, 200, shift.body);
    } finally { await st.close(); }
  });

  it('последнего руководителя не понизить и не заблокировать, себя — тем более', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const self = await sv.patch('/api/staff/sv', { blocked: true });
      assert.equal(self.statusCode, 422, self.body);
      assert.equal(body(self).reason, 'self');

      const down = await sv.patch('/api/staff/sv', { role: 'operator' });
      assert.equal(down.statusCode, 422, down.body);
      assert.equal(body(down).reason, 'last-supervisor');

      // Появился второй руководитель — теперь первого можно понизить.
      const { staff } = await hire(st, { full_name: 'Второй Р. К.', role: 'supervisor', email: 'chief2@example.org' });
      assert.equal(staff.role, 'supervisor');
      const ok = await sv.patch('/api/staff/sv', { role: 'senior' });
      assert.equal(ok.statusCode, 200, ok.body);
    } finally { await st.close(); }
  });

  it('выход со всех устройств гасит чужие сессии', async () => {
    const st = await makeStand();
    try {
      const sv = as(st.app, await login(st.app, 'sv'));
      const his = as(st.app, await login(st.app, 'o1'));
      assert.equal((await his.get('/api/auth/me')).statusCode, 200);

      const res = await sv.post('/api/staff/o1/sessions/close');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await his.get('/api/auth/me')).statusCode, 401, 'вкладка оператора вышла');
      // Пароль при этом не менялся: войти можно тут же.
      assert.equal((await signIn(st.app, 'o1', '1234')).statusCode, 200);
    } finally { await st.close(); }
  });
});

describe('учётные записи: кому это доступно', () => {
  it('оператор на экран учёток не попадает ни одним действием', async () => {
    const st = await makeStand();
    try {
      const op = as(st.app, await login(st.app, 'o1'));
      const made = await op.post('/api/staff', { full_name: 'Свой Человек', role: 'supervisor', login: 'svoi' });
      assert.equal(made.statusCode, 403, made.body);
      assert.equal((await op.patch('/api/staff/v1', { role: 'supervisor' })).statusCode, 403);
      assert.equal((await op.patch('/api/staff/v1', { blocked: true })).statusCode, 403);
      assert.equal((await op.post('/api/staff/v1/password/reset')).statusCode, 403);
      assert.equal((await op.post('/api/staff/v1/sessions/close')).statusCode, 403);

      // Справочник сотрудников ему открыт — но без учётных данных.
      const list = await op.get('/api/staff');
      assert.equal(list.statusCode, 200);
      const row = (body(list).staff as Record<string, unknown>[])[0]!;
      assert.ok('full_name' in row && 'role' in row, 'имя и роль оператору видны');
      assert.ok(!('login' in row) && !('email' in row) && !('must_change_password' in row),
        'логин, почта и признак временного пароля оператору не выдаются');
    } finally { await st.close(); }
  });

  it('старший оператор работает на экранах оператора, но учётки ему тоже закрыты', async () => {
    const st = await makeStand();
    try {
      const { staff, temporary_password: pw, sv } = await hire(st,
        { full_name: 'Кузнецова Е. П.', role: 'senior', email: 'kuznecova@example.org' });
      await sv.post(`/api/staff/${staff.id}/password/reset`);
      const fresh = body(await sv.post(`/api/staff/${staff.id}/password/reset`)).temporary_password as string;
      assert.notEqual(fresh, pw);

      const cookie = cookieOf(await signIn(st.app, 'kuznecova', fresh));
      const she = as(st.app, cookie);
      await she.post(`/api/staff/${staff.id}/password`, { current: fresh, password: 'старший-оператор-пароль' });
      const her = as(st.app, cookieOf(await signIn(st.app, 'kuznecova', 'старший-оператор-пароль')));

      assert.equal((await her.get('/api/cities')).statusCode, 200, 'справочники открыты');
      assert.equal((await her.post('/api/staff', { full_name: 'Кто-то', role: 'operator', login: 'kto' })).statusCode, 403);
    } finally { await st.close(); }
  });
});

describe('учётные записи: журнал действий', () => {
  it('заведение, правка, блокировка и сброс пароля попадают в журнал', async () => {
    const st = await makeStand();
    try {
      const { staff, sv } = await hire(st);
      await sv.patch(`/api/staff/${staff.id}`, { ext: '110' });
      await sv.patch(`/api/staff/${staff.id}`, { blocked: true });
      await sv.post(`/api/staff/${staff.id}/password/reset`);

      const { rows } = await st.db.query<{
        action: string; entity: string; entity_id: string; actor_id: string;
        before: Record<string, unknown> | null; after: Record<string, unknown> | null;
      }>(`SELECT action, entity, entity_id, actor_id, before, after FROM audit_log
           WHERE entity = 'staff' AND entity_id = $1 ORDER BY id`, [staff.id]);

      assert.deepEqual(rows.map((r) => r.action), ['создание', 'изменение', 'изменение', 'изменение']);
      assert.ok(rows.every((r) => r.actor_id === 'sv'), 'в каждой записи виден руководитель');

      assert.equal(rows[0]!.after?.login, 'novikova', 'в заведении видно, какую учётку создали');
      assert.deepEqual(Object.keys(rows[1]!.after ?? {}), ['ext']);
      assert.equal(rows[1]!.before?.ext, '105');
      assert.equal(rows[1]!.after?.ext, '110');
      assert.ok('blocked_at' in (rows[2]!.after ?? {}), 'увольнение видно отдельной записью');

      // Пароль в журнал не попадает ни в каком виде — ни старый, ни новый.
      const text = JSON.stringify(rows);
      assert.ok(!/scrypt\$/.test(text), 'хеша пароля в журнале нет');
      assert.ok(text.includes('···'), 'поле пароля вычеркнуто слоем журнала');
    } finally { await st.close(); }
  });

  it('неудачный вход и замок входа видны руководителю в журнале', async () => {
    const st = await makeStand();
    try {
      for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) await signIn(st.app, 'o1', 'не тот пароль');
      const { rows } = await st.db.query<{ action: string; after: Record<string, unknown> }>(
        `SELECT action, after FROM audit_log WHERE action = 'неудачный вход' ORDER BY id`);
      assert.equal(rows.length, LOGIN_FAIL_LIMIT, 'каждая неудачная попытка — своя запись');
      assert.equal(rows[0]!.after.login, 'o1');
    } finally { await st.close(); }
  });
});
