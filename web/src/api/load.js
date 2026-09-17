/* Загрузка данных экрана.
 *
 * Прототип держал в памяти весь набор сразу и считал по нему что угодно. С базой
 * так нельзя: заявок тысячи, и тянуть их целиком на каждый экран — это секунды
 * ожидания на ровном месте. Поэтому каждый экран говорит, какой срез ему нужен,
 * а S остаётся тем же объектом, по которому экраны считают: меняется не способ
 * чтения, а источник.
 *
 * Правило одно: здесь только чтение. Всё, что меняет данные, живёт в actions.js
 * и заканчивается вызовом reload() — перерисовкой по ответу сервера.
 */

import { api, q } from './client.js';
import * as M from './map.js';
import { S, dayCities } from '../state.js';
import { BIG, CITIES, CSHORT, DEV_TYPES, LOCS, SERVICES, SMALL, SVC } from '../refs.js';
import { CUR_M, TODAY, addDays, iso, today } from '../util.js';
import { render } from '../ui/render.js';
import { dayLock } from '../rules.js';
import { setNotify } from '../screens/services.js';

/** Сколько заявок просим за раз. Потолок списка на сервере — 500. */
const PAGE = 500;

/** Замена содержимого массива-справочника: сами массивы объявлены const и на них
 *  ссылаются все экраны, поэтому меняем содержимое, а не ссылку. */
function refill(target, items) {
  target.length = 0;
  target.push(...items);
  return target;
}

/* ── справочники ─────────────────────────────────────────── */

/** Города, услуги, приборы и сотрудники. Читаются один раз после входа:
 *  меняются они руководителем и редко, а нужны каждому экрану. */
export async function loadRefs() {
  const [cities, services, types, staff] = await Promise.all([
    api.get('/cities'), api.get('/services'), api.get('/device-types'), api.get('/staff'),
  ]);
  refill(LOCS, cities.cities.map((c) => ({ n: c.name, s: c.short, big: c.is_big })));
  refill(CITIES, LOCS.map((x) => x.n));
  refill(BIG, LOCS.filter((x) => x.big).map((x) => x.n));
  refill(SMALL, LOCS.filter((x) => !x.big).map((x) => x.n));
  for (const key of Object.keys(CSHORT)) delete CSHORT[key];
  for (const x of LOCS) CSHORT[x.n] = x.s;

  refill(SERVICES, services.services.map((s) => ({
    id: s.id, grp: s.grp, name: s.name, sh: s.short,
    pF: s.price_person, pP: s.price_pensioner, pU: s.price_org,
    rV: s.rate_verifier, rO: s.rate_operator,
  })));
  for (const key of Object.keys(SVC)) delete SVC[key];
  for (const s of SERVICES) SVC[s.id] = s;

  refill(DEV_TYPES, types.device_types.map((t) => ({ v: t.name, grsi: t.grsi })));
  S.staff = staff.staff.map(M.staffFrom);
}

/* ── срезы ───────────────────────────────────────────────── */

/** Дни с планом, сменой и замком. Загрузка и замок приходят посчитанными:
 *  у сервера перед глазами все заявки и маршруты, у вкладки — только её кусок. */
export async function loadDays(from, to) {
  const { days } = await api.get(q('/days', { from, to }));
  const fresh = days.map(M.dayFrom);
  const keep = S.days.filter((d) => d.date < from || d.date > to);
  S.days = [...keep, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
  // Загрузку дня и города экраны считают правилами из rules.js — отдаём им счётчики.
  S.booked = S.booked || {};
  for (const d of days) {
    S.booked[d.date] = d.load?.b ?? 0;
    for (const [city, load] of Object.entries(d.cityLoad || {})) S.booked[`${d.date}#${city}`] = load.b;
  }
}

/** Заявки в S: то, что пришло, заменяет прежнее, остальное не трогаем. */
export function mergeRequests(rows, extra = () => ({})) {
  const byId = new Map(S.requests.map((r) => [r.id, r]));
  for (const row of rows) byId.set(row.id, M.requestFrom(row, { devices: row.devices, payment: row.payment, ...extra(row) }));
  S.requests = [...byId.values()];
}

/** Страничная выборка заявок: список экранов считает по всему срезу, а не по первой сотне. */
export async function loadRequests(params) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const { requests } = await api.get(q('/requests', { ...params, limit: PAGE, offset }));
    out.push(...requests);
    if (requests.length < PAGE) break;
  }
  mergeRequests(out);
  return out;
}

export async function loadStaffAndAbsences() {
  const { absences } = await api.get('/absences');
  S.absences = absences.map(M.absenceFrom);
}

/** Список маршрутов за период — с счётчиками точек, но без самих точек. */
export async function loadRoutes(params) {
  const { routes } = await api.get(q('/routes', params));
  const keep = S.routes.filter((r) => !routes.some((x) => x.id === r.id));
  S.routes = [...keep, ...routes.map((r) => M.routeFrom(r))];
  return routes;
}

/** Маршрут целиком: точки, заявки с актами и переписка.
 *  Заявки берём отдельным запросом со списка: там к ним прикладываются приборы
 *  и оплата — без них ни акт, ни строка оплаты на шкале дня не соберутся. */
export async function loadRoute(id) {
  if (!id) return null;
  const [{ route, stops }, { chat }] = await Promise.all([
    api.get(`/routes/${id}`), api.get(`/routes/${id}/chat`),
  ]);
  await loadRequests({ route_id: id, with: 'devices,payment' });
  const full = M.routeFrom(route, stops, chat);
  S.routes = [...S.routes.filter((r) => r.id !== full.id), full];
  return full;
}

export async function loadWaitList() {
  const { waits } = await api.get('/wait-list');
  S.waits = waits.map(M.waitFrom);
}

/** Подотчёт: сдачи за месяц и за предыдущий — экран показывает последнюю. */
export async function loadHandovers(staffId, month = CUR_M) {
  const prev = iso(new Date(new Date(`${month}-01T00:00:00`).setMonth(new Date(`${month}-01T00:00:00`).getMonth() - 1))).slice(0, 7);
  const parts = await Promise.all([month, prev].map((m) => api.get(q('/handovers', { month: m, staff_id: staffId }))));
  const rows = parts.flatMap((p) => p.handovers || []);
  const keep = S.handovers.filter((h) => !rows.some((x) => x.id === h.id));
  S.handovers = [...keep, ...rows.map(M.handoverFrom)];
}

/** Журнал действий по текущему отбору. Отбор считает сервер: три года журнала
 *  во вкладку не помещаются, да и незачем — руководителю нужен срез. */
export async function loadAudit() {
  const F = S.auditF || {};
  const { entries, total } = await api.get(q('/audit', {
    actor_id: F.actor, entity: F.entity, action: F.action,
    from: F.from, to: F.to, q: F.q, limit: 500,
  }));
  S.audit = entries;
  S.auditTotal = total;
}

/** Шаблоны уведомлений и перечень подстановок для экрана «Услуги и ставки».
 *  Кладутся не в S, а в сам экран: править их может только руководитель, и
 *  остальным экранам они не нужны. */
export async function loadTemplates() {
  setNotify(await api.get('/notify/templates'));
}

/* ── экран → что ему нужно ───────────────────────────────── */

const MONTH_FROM = (m) => `${m}-01`;
const MONTH_TO = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return iso(new Date(y, mo, 0));
};

const LOADERS = {
  async intake() {
    // Лента ёмкости показывает четыре недели, подсказка дат смотрит на полтора месяца.
    await loadDays(TODAY, iso(addDays(today, 45)));
    /* Ближайшие даты уже ушли под маршруты — приём открываем с первой свободной.
       В прототипе это делалось один раз при запуске, здесь — когда приехали дни:
       какая дата свободна, до ответа сервера неизвестно. */
    if (!dayCities(S.day).length || dayLock(S.day)) {
      S.day = S.days.find((d) => d.cities.length && !dayLock(d.date))?.date || TODAY;
      S.intake.city = dayCities(S.day)[0] || CITIES[0];
    }
    // Заявки выбранного дня нужны проверке дублей при приёме.
    await loadRequests({ date: S.day });
  },
  async support() {
    await Promise.all([loadDays(TODAY, TODAY), loadWaitList(), loadRoutes({ date: TODAY })]);
    // Свободные заявки дня: их оператор ставит в маршрут прямо со шкалы.
    await loadRequests({ date: TODAY, free: true });
    /* Экран открывается на конкретном маршруте — так же, как в прототипе:
       общий режим на две сотни точек и перерисовывать тяжело, и грузить незачем. */
    const mine = S.routes.filter((r) => r.date === TODAY).sort((a, b) => a.id.localeCompare(b.id));
    if (!S.openRoute || !mine.some((r) => r.id === S.openRoute)) S.openRoute = mine[0]?.id || null;
    await loadRoute(S.openRoute);
  },
  async me() {
    const month = S.mMonth || CUR_M;
    await Promise.all([
      loadRequests({ date_from: MONTH_FROM(month), date_to: MONTH_TO(month), own: true, with: 'devices,payment' }),
      // Вкладка «в работе» смотрит вперёд: заявка ждёт выезда и может уехать в другой месяц.
      loadRequests({ date_from: TODAY, date_to: iso(addDays(today, 60)), own: true, with: 'devices,payment' }),
      loadHandovers(S.me, month),
    ]);
  },
  async plan() {
    const m = S.pMonth || CUR_M;
    await Promise.all([loadDays(MONTH_FROM(m), MONTH_TO(m)), loadStaffAndAbsences()]);
  },
  async routes() {
    const from = iso(addDays(today, -3));
    await Promise.all([loadDays(from, iso(addDays(today, 45))), loadRoutes({ date_from: from })]);
  },
  async schedule() {
    await Promise.all([loadDays(TODAY, iso(addDays(today, 14))), loadStaffAndAbsences()]);
  },
  async absence() {
    await Promise.all([loadStaffAndAbsences(), loadDays(TODAY, iso(addDays(today, 14)))]);
  },
  async payroll() {
    const m = CUR_M;
    await Promise.all([
      loadRequests({ date_from: MONTH_FROM(m), date_to: MONTH_TO(m), status: 'выполнена', with: 'devices,payment' }),
      loadHandovers(null, m),
    ]);
  },
  async services() {
    await Promise.all([loadRefs(), loadDays(TODAY, TODAY), loadStaffAndAbsences(), loadTemplates()]);
  },
  async audit() {
    // Сотрудники — для отбора по человеку: в списке журнала имя приходит уже
    // с записью, а вот выпадающий список собирается из справочника.
    await Promise.all([loadRefs(), loadAudit()]);
  },
  async myroute() {
    await Promise.all([loadDays(TODAY, TODAY), loadRoutes({ date: TODAY })]);
    const mine = S.routes.find((r) => r.date === TODAY && r.verifier === S.me);
    if (mine) await loadRoute(mine.id);
  },
};

/** Данные текущего экрана. Пока идут — на странице состояние загрузки. */
export async function loadView(view = S.view) {
  const loader = LOADERS[view];
  if (!loader) return;
  S.loading = (S.loading || 0) + 1;
  render();
  try {
    await loader();
    S.loadError = null;
  } catch (err) {
    // Текст отказа писался для человека: показываем его, а не «ошибка 500».
    S.loadError = err?.message || 'Не удалось загрузить данные экрана.';
  } finally {
    S.loading--;
    render();
  }
}

/** Перечитать текущий экран — этим заканчивается любое действие. */
export const reload = () => loadView(S.view);
