/* Подготовка прогона: техническая учётка входит, заводит (или чинит) двух
 * сотрудников испытаний и ставит бригаду на две даты.
 *
 *   uat.op   — оператор, принимает заявки и ведёт лист ожидания;
 *   uat.ver  — поверитель со всеми компетенциями, выезжает по маршруту.
 *
 * Пароль обоим выдаётся заново на каждом прогоне: сброс руководителем даёт
 * временный, затем сотрудник меняет его на UAT_STAFF_PASSWORD — тем же путём,
 * что и живой человек при первом входе. Учётки не удаляются: увольнение в
 * системе — это блокировка, и повторный прогон их просто разблокирует.
 *
 * Сценарий заведения сотрудника руководителем через экран проверяется отдельно
 * (tests/01-staff.spec.js) — на одноразовой учётке с меткой прогона. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { apiAs, must, BASE, BOT, STAFF_PASSWORD, ROOT, CONTEXT_FILE, isoToday, runTag } from './lib/app.mjs';

export default async function globalSetup() {
  if (!BOT.password) {
    throw new Error('Не задан UAT_PASSWORD — пароль технической учётки. Её заводит server/scripts/uat-stand.mts.');
  }
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (health?.db !== 'ok') throw new Error(`${BASE}/health: ${JSON.stringify(health)}`);

  const sv = await apiAs(BOT.login, BOT.password);
  if (sv.me.role !== 'supervisor') throw new Error(`Учётка ${BOT.login} — не руководитель (${sv.me.role}).`);

  const { cities } = must(await sv.get('/api/cities'), 'города');
  const { services } = must(await sv.get('/api/services'), 'услуги');
  const city = process.env.UAT_CITY || cities.find((c) => c.name === 'Асбест')?.name || cities[0].name;
  const svcIds = services.map((s) => s.id);

  /* ── сотрудники испытаний ─────────────────────────────────── */
  async function ensure(login, role, name) {
    const { staff } = must(await sv.get('/api/staff'), 'сотрудники');
    let card = staff.find((p) => (p.login || '').toLowerCase() === login);
    let temp;
    if (!card) {
      const made = must(await sv.post('/api/staff', {
        full_name: name, role, login, email: `${login}@uchetkin.local`,
        pattern: '5/2', anchor: isoToday(), svcs: role === 'verifier' ? svcIds : [],
      }), `завести ${login}`);
      card = made.staff;
      temp = made.temporary_password;
    } else {
      if (card.blocked_at) must(await sv.patch(`/api/staff/${card.id}`, { blocked: false }), `разблокировать ${login}`);
      if (card.role !== role) must(await sv.patch(`/api/staff/${card.id}`, { role }), `роль ${login}`);
      if (role === 'verifier') must(await sv.patch(`/api/staff/${card.id}`, { svcs: svcIds }), `компетенции ${login}`);
      temp = must(await sv.post(`/api/staff/${card.id}/password/reset`), `сброс пароля ${login}`).temporary_password;
    }
    // Первый вход по временному паролю и смена — как у живого сотрудника.
    const me = await apiAs(login, temp);
    if (!me.me.must_change_password) throw new Error(`${login}: после сброса система не требует смены пароля`);
    must(await me.post(`/api/staff/${card.id}/password`, { current: temp, password: STAFF_PASSWORD }), `смена пароля ${login}`);
    await me.close();
    return { id: card.id, login, password: STAFF_PASSWORD, name };
  }
  const op = await ensure('uat.op', 'operator', 'Испытания Оператор');
  const ver = await ensure('uat.ver', 'verifier', 'Испытания Поверитель');

  /* ── даты ─────────────────────────────────────────────────── */
  // Дата приёма: свободная от маршрутов и замка, чтобы оператор мог записывать.
  let planDate = null;
  for (let d = 10; d < 45 && !planDate; d++) {
    const ds = isoToday(d);
    const day = must(await sv.get(`/api/days/${ds}`), `день ${ds}`);
    const { routes } = must(await sv.get(`/api/routes?date=${ds}`), `маршруты ${ds}`);
    if (!day.lock && !routes.length) planDate = ds;
  }
  if (!planDate) throw new Error('Не нашлось свободной даты в ближайшие полтора месяца.');

  /** Бригада на дату: город, план по нему, поверитель и оператор испытаний. */
  async function staffDay(ds, plan) {
    const { day } = must(await sv.get(`/api/days/${ds}`), `день ${ds}`);
    const cityList = [city, ...(day.cities || []).filter((c) => c !== city)].slice(0, 5);
    const body = {
      cities: cityList,
      plan: { ...(day.plan || {}), [city]: Math.max(plan, Number(day.plan?.[city] || 0)) },
      crew: [...new Set([...(day.crew || []), ver.id])],
      ops: [op.id, ...(day.ops || []).filter((o) => o !== op.id)].slice(0, 4),
    };
    for (const c of Object.keys(body.plan)) if (!cityList.includes(c)) delete body.plan[c];
    must(await sv.put(`/api/days/${ds}`, body), `смена на ${ds}`);
  }
  await staffDay(isoToday(), 20);
  await staffDay(planDate, 20);

  const ctx = {
    run: runTag(), base: BASE, city, today: isoToday(), planDate,
    bot: { id: sv.me.id, login: BOT.login },
    op, ver,
    services: services.map((s) => ({ id: s.id, name: s.name, price_person: s.price_person, price_pensioner: s.price_pensioner })),
  };
  mkdirSync(ROOT + '.run', { recursive: true });
  writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
  await sv.close();
  console.log(`Контур ${BASE}: город ${city}, дата приёма ${planDate}, сотрудники ${op.id} и ${ver.id}.`);
}
