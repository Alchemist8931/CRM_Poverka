/* Чтение того, без чего правила не посчитать: справочник услуг, запись дня,
 * сколько уже записано на дату и в город, замок даты, состав смены.
 *
 * Здесь только выборки и никаких решений: решение принимает `src/rules.ts`.
 * Разделение не ради красоты — правила так проверяются тестами без базы.
 */
import type { Db } from './db.ts';
import type { DayPlan, Role, Service, SlotDay } from '../rules.ts';
import { dayLock } from '../rules.ts';

export interface ServiceRow extends Service {
  grp: string;
  name: string;
  short: string;
  is_verification: boolean;
  replacement_service: string | null;
  active: boolean;
  sort: number;
}

/** Услуги справочником и картой: карта нужна правилам, список — экранам. */
export async function loadServices(db: Db): Promise<{ list: ServiceRow[]; map: Map<string, ServiceRow> }> {
  const { rows } = await db.query<ServiceRow>('SELECT * FROM services ORDER BY sort, id');
  return { list: rows, map: new Map(rows.map((s) => [s.id, s])) };
}

export async function loadDay(db: Db, date: string): Promise<DayPlan | null> {
  const { rows } = await db.query<DayPlan>(
    'SELECT date::text AS date, cities, plan, crew, ops FROM days WHERE date = $1', [date]);
  return rows[0] ?? null;
}

/** Отменённая заявка место в плане не занимает — так считает и прототип. */
export async function bookedOn(db: Db, date: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM requests WHERE date = $1 AND status <> 'отменена'`, [date]);
  return Number(rows[0]?.n ?? 0);
}

export async function bookedIn(db: Db, date: string, city: string | null | undefined): Promise<number> {
  if (!city) return 0;
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM requests WHERE date = $1 AND city = $2 AND status <> 'отменена'`, [date, city]);
  return Number(rows[0]?.n ?? 0);
}

/** Окно конструктора, оставленное открытым и забытое, не должно держать приём
 *  закрытым до конца времён: через два часа замок считается снятым. */
export const BUILDER_TTL = '2 hours';

/** Замок даты: открытый конструктор маршрутов или уже собранные маршруты. */
export async function lockFactsFor(db: Db, date: string) {
  const { rows } = await db.query<{ building: boolean; has_routes: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM route_builder WHERE date = $1 AND opened_at > now() - interval '${BUILDER_TTL}') AS building,
       EXISTS (SELECT 1 FROM routes WHERE date = $1) AS has_routes`, [date]);
  return { building: !!rows[0]?.building, hasRoutes: !!rows[0]?.has_routes };
}

/** Причина замка или `null`. */
export async function lockOf(db: Db, date: string): Promise<string | null> {
  return dayLock(await lockFactsFor(db, date));
}

export interface StaffRow {
  id: string;
  full_name: string;
  role: Role;
  phone: string | null;
  ext: string | null;
  pattern: string | null;
  anchor: string | null;
  blocked_at: string | null;
  svcs: string[];
}

/** Сотрудники с компетенциями. Учётные данные наружу не выходят ни одним полем. */
export async function loadStaff(db: Db, opts: { role?: Role } = {}): Promise<StaffRow[]> {
  const { rows } = await db.query<StaffRow>(
    `SELECT s.id, s.full_name, s.role, s.phone, s.ext, s.pattern, s.anchor::text AS anchor,
            s.blocked_at, coalesce(k.svcs, '{}') AS svcs
       FROM staff s
       LEFT JOIN (SELECT staff_id, array_agg(service_id ORDER BY service_id) AS svcs
                    FROM staff_skills GROUP BY staff_id) k ON k.staff_id = s.id
      WHERE ($1::text IS NULL OR s.role = $1)
      ORDER BY s.role, s.full_name`, [opts.role ?? null]);
  return rows;
}

/** Согласованное отсутствие снимает человека со смены, даже если он в ней назначен. */
export async function absentOn(db: Db, date: string): Promise<Set<string>> {
  const { rows } = await db.query<{ staff_id: string }>(
    `SELECT staff_id FROM absences WHERE status = 'согласовано' AND $1 BETWEEN date_from AND date_to`, [date]);
  return new Set(rows.map((r) => r.staff_id));
}

/** Даты-кандидаты для подсказки: всё, что нужно правилу `slotsFor`, одним куском.
 *  Запросов ровно четыре на весь горизонт, а не по четыре на каждый день. */
export async function slotDays(db: Db, from: string, days: number, city?: string | null): Promise<SlotDay[]> {
  const { rows: dayRows } = await db.query<DayPlan>(
    `SELECT date::text AS date, cities, plan, crew, ops
       FROM days WHERE date >= $1::date AND date < $1::date + $2::int ORDER BY date`, [from, days]);
  const { rows: bookedRows } = await db.query<{ date: string; city: string; n: string }>(
    `SELECT date::text AS date, city, count(*)::text AS n FROM requests
      WHERE date >= $1::date AND date < $1::date + $2::int AND status <> 'отменена'
      GROUP BY date, city`, [from, days]);
  const { rows: lockRows } = await db.query<{ date: string; building: boolean; has_routes: boolean }>(
    `SELECT d::date::text AS date,
            EXISTS (SELECT 1 FROM route_builder b WHERE b.date = d AND b.opened_at > now() - interval '${BUILDER_TTL}') AS building,
            EXISTS (SELECT 1 FROM routes r WHERE r.date = d) AS has_routes
       FROM generate_series($1::date, $1::date + ($2::int - 1), interval '1 day') AS d`, [from, days]);
  const { rows: absRows } = await db.query<{ staff_id: string; date_from: string; date_to: string }>(
    `SELECT staff_id, date_from::text AS date_from, date_to::text AS date_to
       FROM absences WHERE status = 'согласовано' AND date_to >= $1::date`, [from]);
  const skills = new Map((await loadStaff(db, { role: 'verifier' })).map((p) => [p.id, p]));

  const bookedTotal = new Map<string, number>();
  const bookedCity = new Map<string, number>();
  for (const r of bookedRows) {
    bookedTotal.set(r.date, (bookedTotal.get(r.date) ?? 0) + Number(r.n));
    bookedCity.set(`${r.date}#${r.city}`, Number(r.n));
  }
  const locks = new Map(lockRows.map((r) => [r.date, { building: r.building, hasRoutes: r.has_routes }]));
  const byDate = new Map(dayRows.map((d) => [d.date, d]));

  return [...locks.keys()].sort().map((date) => {
    const day = byDate.get(date) ?? null;
    const crew = (day?.crew ?? [])
      .filter((id) => !absRows.some((a) => a.staff_id === id && date >= a.date_from && date <= a.date_to))
      .map((id) => skills.get(id))
      .filter((p): p is StaffRow => !!p && !p.blocked_at)
      .map((p) => ({ id: p.id, svcs: p.svcs }));
    return {
      date,
      day,
      lock: locks.get(date)!,
      bookedOnDate: bookedTotal.get(date) ?? 0,
      bookedInCity: city ? bookedCity.get(`${date}#${city}`) ?? 0 : 0,
      crew,
    };
  });
}

/** Следующий идентификатор вида `R1234`. Прототип вёл сквозной счётчик в памяти,
 *  здесь его роль играет сама таблица: берём наибольший номер и прибавляем единицу.
 *  Замок на время транзакции нужен, чтобы два оператора, принимающие звонок
 *  одновременно, не получили один и тот же номер заявки. */
export async function nextId(db: Db, table: string, prefix: string): Promise<string> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [table]);
  const { rows } = await db.query<{ n: string }>(
    `SELECT coalesce(max(nullif(regexp_replace(id, '\\D', '', 'g'), '')::bigint), 0) + 1 AS n FROM ${table}`);
  return prefix + rows[0]!.n;
}

/** Приборы акта одной заявки, по порядку строк. */
export async function loadDevices(db: Db, requestId: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    'SELECT * FROM devices WHERE request_id = $1 ORDER BY position', [requestId]);
  return rows;
}
