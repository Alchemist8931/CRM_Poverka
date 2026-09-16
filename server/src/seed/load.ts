/* Раскладка демо-данных прототипа по таблицам.
 *
 * Сами данные делает prototype-model.mjs — перенесённый из index.html код без
 * единой правки. Здесь только раскладка готового состояния: ни одного решения
 * о том, сколько чего сгенерировать, в этом файле нет и быть не должно.
 *
 * Соединение приходит снаружи и описано минимальным интерфейсом: запуск из
 * командной строки передаёт сюда обычный клиент pg, а проверка схемы —
 * встроенный PostgreSQL, у которого своего сетевого слоя нет.
 */
import { randomUUID } from 'node:crypto';
import { normPhone, stampAt, stampOn } from '../db.ts';
import { buildDemoState } from './prototype-model.mjs';
import type { DemoRequest } from './prototype-model.mjs';

/** Всё, что загрузчику нужно от базы. Этому подходит и клиент pg, и PGlite. */
export interface SqlRunner {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Порядок важен: он же порядок вставки и обратный ему порядок очистки. */
export const TABLES = [
  'cities', 'services', 'device_types', 'staff', 'staff_skills',
  'days', 'absences', 'clients', 'routes', 'requests', 'stops',
  'wait_list', 'devices', 'photos', 'payments', 'handovers',
  'route_chat', 'calls', 'audit_log',
] as const;

/* Межповерочный интервал прототип не хранит — там его негде было показать.
   Значения взяты из описаний типов в Госреестре: холодная вода и общий счётчик
   шесть лет, горячая вода и теплосчётчик четыре. Заказчик подтверждает их
   листом «Приборы» в справочнике (пункт be-import), после чего правятся здесь. */
const DEVICE_TYPE_EXTRA: Record<string, { years: number; kind: 'Вода' | 'Тепло' }> = {
  'Бетар СХВ-15':   { years: 6, kind: 'Вода' },
  'Бетар СГВ-15':   { years: 4, kind: 'Вода' },
  'Ителма WFW20':   { years: 6, kind: 'Вода' },
  'Пульсар М-15':   { years: 6, kind: 'Вода' },
  'Норма СВК-15':   { years: 6, kind: 'Вода' },
  'ТСК-7 (тепло)':  { years: 4, kind: 'Тепло' },
};

/* Дни выезда в крупные города — та же раскладка, по которой прототип строит
   расписание: понедельник, среда, пятница — Екатеринбург; вторник и четверг —
   Нижний Тагил; суббота — Каменск-Уральский. Малые города объезжаются по кругу,
   закреплённых дней у них нет. */
const CITY_WEEKDAYS: Record<string, number[]> = {
  'Екатеринбург': [1, 3, 5],
  'Нижний Тагил': [2, 4],
  'Каменск-Уральский': [6],
};

/** Норматив адресов на одного поверителя в смене — из расчёта плана в прототипе. */
const NORM_PER_VERIFIER = 25;

/** Поверка кончается решением «годен / не годен»; у остальных услуг результата нет. */
const VERIFICATION_SERVICES = new Set(['wv', 'hv']);

/** Чем меняют непригодный прибор: воду — заменой счётчика, тепло — монтажом. */
const REPLACEMENT_BY_GROUP: Record<string, string> = { 'Вода': 'wr', 'Тепло': 'hm' };

/** Сколько параметров отправляем одним запросом. Пачками, потому что 2,5 тысячи
 *  заявок и 3,7 тысячи фотографий по строке за запрос — это десятки секунд на
 *  ровном месте. Потолок в параметрах, а не в строках: у заявки тридцать столбцов,
 *  у фотографии четыре, и одна и та же «пачка в 500 строк» означает для них
 *  запросы, различающиеся в семь раз. */
const MAX_PARAMS = Number(process.env.SEED_MAX_PARAMS || 1000);

async function insertMany(
  db: SqlRunner,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<number> {
  if (!rows.length) return 0;
  const chunk = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = slice
      .map((row) => `(${row.map((v) => { params.push(v); return '$' + params.length; }).join(',')})`)
      .join(',');
    await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values}`, params);
  }
  if (process.env.SEED_VERBOSE) console.log(`  ${table}: ${rows.length}`);
  return rows.length;
}

/** Таблицы, в которых уже что-то лежит, — с числом строк. */
async function nonEmptyTables(db: SqlRunner): Promise<string[]> {
  const filled: string[] = [];
  for (const t of TABLES) {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
    if (rows[0] && rows[0].n !== '0') filled.push(`${t} (${rows[0].n})`);
  }
  return filled;
}

/** Число строк по всем таблицам схемы — итог загрузки. */
export async function countRows(db: SqlRunner): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
    counts[t] = Number(rows[0]!.n);
  }
  return counts;
}

/**
 * Наполняет базу демо-данными прототипа и возвращает число строк по таблицам.
 * Без `reset` отказывается работать по непустой базе: затирать чужие данные
 * молча загрузчик демо-набора не должен.
 */
export async function seedDemoData(
  db: SqlRunner,
  opts: { reset?: boolean } = {},
): Promise<Record<string, number>> {
  const demo = buildDemoState();
  const { S, SERVICES, LOCS, DEV_TYPES, SVC } = demo;

  if (opts.reset) {
    await db.query(`TRUNCATE ${[...TABLES].reverse().join(', ')} RESTART IDENTITY CASCADE`);
  } else {
    const filled = await nonEmptyTables(db);
    if (filled.length) {
      throw new Error(
        'в базе уже есть данные — ' + filled.join(', ') +
        '. Повторите с ключом --reset, если эти данные не нужны.',
      );
    }
  }

  await db.query('BEGIN');
  try {

    // ── справочники ───────────────────────────────────────────────
    await insertMany(db, 'cities',
      ['name', 'short', 'is_big', 'weekdays', 'norm_per_verifier', 'sort'],
      LOCS.map((c, i) => [c.n, c.s, !!c.big, CITY_WEEKDAYS[c.n] ?? [], NORM_PER_VERIFIER, i]));

    // Услуга ссылается на услугу замены, поэтому сначала строки, потом связь.
    await insertMany(db, 'services',
      ['id', 'grp', 'name', 'short', 'price_person', 'price_pensioner', 'price_org',
       'rate_verifier', 'rate_operator', 'is_verification', 'sort'],
      SERVICES.map((s, i) => [s.id, s.grp, s.name, s.sh, s.pF, s.pP, s.pU, s.rV, s.rO,
                              VERIFICATION_SERVICES.has(s.id), i]));
    for (const s of SERVICES) {
      if (!VERIFICATION_SERVICES.has(s.id)) continue;
      await db.query('UPDATE services SET replacement_service = $2 WHERE id = $1',
        [s.id, REPLACEMENT_BY_GROUP[s.grp] ?? 'wr']);
    }

    await insertMany(db, 'device_types',
      ['name', 'grsi', 'interval_years', 'carrier_kind', 'sort'],
      DEV_TYPES.map((t, i) => {
        const extra = DEVICE_TYPE_EXTRA[t.v];
        if (!extra) throw new Error(`Не задан межповерочный интервал для типа «${t.v}»`);
        return [t.v, t.grsi, extra.years, extra.kind, i];
      }));

    // ── люди ──────────────────────────────────────────────────────
    await insertMany(db, 'staff',
      ['id', 'full_name', 'role', 'phone', 'ext', 'pattern', 'anchor', 'extra_days'],
      S.staff.map((p) => [p.id, p.name, p.role, p.phone ?? null, p.ext ?? null,
                          p.pattern ?? null, p.anchor ?? null, p.extra ?? []]));

    await insertMany(db, 'staff_skills', ['staff_id', 'service_id'],
      S.staff.flatMap((p) => (p.svcs ?? []).map((sid) => [p.id, sid])));

    // ── планирование ──────────────────────────────────────────────
    await insertMany(db, 'days', ['date', 'cities', 'plan', 'crew', 'ops', 'updated_by'],
      S.days.map((d) => [d.date, d.cities, JSON.stringify(d.caps ?? {}), d.crew, d.ops, 'sv']));

    await insertMany(db, 'absences',
      ['id', 'staff_id', 'date_from', 'date_to', 'reason', 'status', 'comment', 'decided_by'],
      S.absences.map((a) => [a.id, a.staff, a.from, a.to, a.reason, a.status, a.comment,
                             a.status === 'на согласовании' ? null : 'sv']));

    // ── клиенты ───────────────────────────────────────────────────
    // Отдельной карточки в прототипе нет: клиент — это номер телефона, с которого
    // пришла заявка. Собираем их по первому обращению, остальные заявки с того же
    // номера подхватывают уже заведённого клиента — на этом и держится история.
    const clientByPhone = new Map<string, { id: string; source: DemoRequest }>();
    for (const r of S.requests) {
      const key = normPhone(r.phone);
      if (!clientByPhone.has(key)) clientByPhone.set(key, { id: randomUUID(), source: r });
    }
    await insertMany(db, 'clients',
      ['id', 'phone_norm', 'phone_raw', 'client_type', 'name', 'inn', 'email', 'city'],
      [...clientByPhone].map(([phone, { id, source }]) =>
        [id, phone, source.phone, source.clientType, source.name, source.inn, source.email, source.city]));

    // ── маршруты и заявки ─────────────────────────────────────────
    await insertMany(db, 'routes',
      ['id', 'date', 'city', 'verifier_id', 'duty_operator_id', 'status'],
      S.routes.map((rt) => [rt.id, rt.date, rt.city, rt.verifier, rt.duty, rt.status]));

    await insertMany(db, 'requests',
      ['id', 'client_id', 'date', 'created_date', 'city', 'client_type', 'name', 'inn',
       'phone', 'phone_norm', 'contact', 'phone2', 'contact2', 'email',
       'street', 'house', 'entrance', 'floor', 'flat', 'intercom', 'time_slot',
       'comment_operator', 'comment_verifier', 'svcs', 'status', 'route_id',
       'operator_id', 'verifier_id', 'created_at'],
      S.requests.map((r) => {
        const phone = normPhone(r.phone);
        return [r.id, clientByPhone.get(phone)!.id, r.date, r.created, r.city, r.clientType,
                r.name, r.inn, r.phone, phone, r.contact, r.phone2, r.contact2, r.email,
                r.street, r.house, r.entrance, r.floor, r.flat, r.intercom, r.time,
                r.cmtOp, r.cmtVf, r.svcs, r.status, r.routeId,
                r.operator, r.verifier ?? null,
                // Прототип запоминает только день приёма звонка, не время.
                stampOn(r.created, '00:00')];
      }));

    await insertMany(db, 'stops',
      ['route_id', 'request_id', 'position', 'called', 'done',
       'unserved_reason', 'unserved_note', 'unserved_at', 'unserved_by'],
      S.routes.flatMap((rt) => rt.stops.map((s, i) =>
        [rt.id, s.req, i + 1, s.called, s.done,
         s.unserved?.reason ?? null, s.unserved?.note ?? '',
         stampAt(s.unserved?.at), s.unserved?.by ?? null])));

    // ── лист ожидания (до приборов: на него ссылается отложенная замена) ──
    await insertMany(db, 'wait_list',
      ['id', 'request_id', 'route_id', 'city', 'kind', 'reason', 'note', 'at', 'by_staff', 'state', 'moved_to'],
      S.waits.map((w) => [w.id, w.req, w.route, w.city, w.kind ?? 'адрес', w.reason, w.note,
                          stampAt(w.at), w.by, w.state, w.to]));

    // ── акты ──────────────────────────────────────────────────────
    // Цена и ставки записываются снимком: переписанный прайс не должен менять
    // ни закрытый акт, ни начисленную по нему сдельную оплату.
    await insertMany(db, 'devices',
      ['request_id', 'position', 'service_id', 'device_type', 'grsi', 'carrier',
       'serial', 'reading', 'room', 'seal', 'pensioner',
       'bad', 'bad_reason', 'bad_note', 'blank', 'blank_no',
       'replacement', 'replacement_wait_id', 'swap', 'swap_of',
       'price_charged', 'rate_verifier', 'rate_operator'],
      S.requests.flatMap((r) => r.devices.map((d, i) => {
        const svc = SVC[d.svc];
        return [r.id, i + 1, d.svc, d.type, d.grsi, d.carrier,
                d.serial, d.reading, d.room, d.seal, d.pens,
                !!d.bad, d.bad ? d.badWhy ?? null : null, d.bad ? d.badNote ?? '' : '',
                !!d.blank, d.blank ? d.blankNo ?? '' : '',
                d.repl ?? null, d.replW ?? null, !!d.swap, d.swapOf ?? '',
                demo.priceOfDev(r, d), svc?.rV ?? 0, svc?.rO ?? 0];
      })));

    // Идентификатор прибора присваивает база. Связываем фото по паре
    // «заявка + позиция» — она уникальна, и порядок возврата строк тут не при чём.
    const deviceIds = new Map<string, number>();
    const { rows: devRows } = await db.query<{ id: string; request_id: string; position: number }>(
      'SELECT id, request_id, position FROM devices');
    for (const row of devRows) deviceIds.set(`${row.request_id}#${row.position}`, Number(row.id));

    // Снимок лежит в Object Storage, в базе — только ключ. Раскладка ключа взята
    // из архитектурного решения: acts/{год}/{заявка}/{прибор}/{uuid}.jpg.
    const prefix = process.env.PHOTO_KEY_PREFIX || 'acts';
    await insertMany(db, 'photos', ['device_id', 'storage_key', 'name', 'taken_at'],
      S.requests.flatMap((r) => r.devices.flatMap((d, i) => {
        const deviceId = deviceIds.get(`${r.id}#${i + 1}`);
        if (!deviceId) throw new Error(`Не найден прибор ${r.id}#${i + 1}`);
        return (d.photos ?? []).map((p) =>
          [deviceId, `${prefix}/${r.date.slice(0, 4)}/${r.id}/${i + 1}/${randomUUID()}.jpg`,
           p.name, p.t]);
      })));

    // ── деньги ────────────────────────────────────────────────────
    await insertMany(db, 'payments',
      ['request_id', 'method', 'amount', 'charged', 'manual', 'note', 'paid_at', 'by_staff'],
      S.requests.filter((r) => r.pay).map((r) => {
        const p = r.pay!;
        return [r.id, p.method, p.amount, demo.priceOf(r), p.manual, p.note, stampAt(p.at), p.by];
      }));

    await insertMany(db, 'handovers',
      ['id', 'staff_id', 'at', 'period', 'amount', 'accepted_by', 'note'],
      S.handovers.map((h) => [h.id, h.staff, h.at, h.period, h.amount, h.by, h.note]));

    // ── связь ─────────────────────────────────────────────────────
    const staffByName = new Map(S.staff.map((p) => [p.name, p.id]));
    await insertMany(db, 'route_chat', ['route_id', 'author_id', 'is_verifier', 'text', 'at'],
      S.routes.flatMap((rt) => (rt.chat ?? []).map((m) =>
        [rt.id, staffByName.get(m.who) ?? null, m.vf, m.txt, stampOn(rt.date, m.t)])));

    // Журнал звонков и журнал действий остаются пустыми: прототип их не ведёт —
    // звонки появятся вместе с вебхуками Новофона (int-novofon), записи журнала
    // пишет общий обработчик API (be-audit). Придумывать их здесь нечестно.

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }

  return countRows(db);
}

/** Таблица «таблица — строк» одним куском, чтобы итог загрузки читался глазами. */
export function formatCounts(counts: Record<string, number>): string {
  const lines = Object.entries(counts)
    .map(([table, n]) => `  ${table.padEnd(14)} ${String(n).padStart(6)}`);
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  return ['Загружено строк:', ...lines, `  ${'ВСЕГО'.padEnd(14)} ${String(total).padStart(6)}`].join('\n');
}
