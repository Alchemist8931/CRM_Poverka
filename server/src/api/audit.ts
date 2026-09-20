/* Журнал действий: промежуточный слой (пункт be-audit).
 *
 * Система ведёт персональные данные клиентов и деньги — цены, скидки, начисления
 * и подотчёт. Поэтому след нужен у каждого изменения, а не у тех мест, где про
 * него вспомнили: журнал, который пишут обработчики по одному, отличается от
 * отсутствующего только тем, что выглядит полным.
 *
 * Отсюда устройство: слой висит на самом приложении и не знает ни одного
 * обработчика в лицо.
 *
 *   preHandler — снимок строки «до» по адресу запроса (`/api/requests/:id` →
 *                строка `requests`);
 *   onSend     — снимок «после», разница по полям и запись в `audit_log`.
 *
 * Запись идёт до ответа, а не после: если журнал не принял строку, это должно
 * быть видно в логе того же запроса, а не в следующем. Сама запись ошибку не
 * поднимает — отказать оператору в приёме заявки из-за журнала было бы хуже.
 *
 * Чего слой сознательно не пишет: вебхук телефонии (это не человек, а АТС, и
 * она шлёт сотни строк в день) и неудавшиеся запросы — кроме неудачного входа,
 * который как раз и интересен.
 *
 * Читается журнал только через `routes/audit.ts` и только руководителем.
 * Править и удалять записи нельзя вовсе: запрет стоит триггером в базе
 * (`migrations/1757980600000_audit.sql`), а не обещанием обработчиков.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from './db.ts';

/** Снимок строки: сущность → таблица, ключ и имя параметра в адресе. */
const SNAPSHOT: Record<string, { table: string; key: string; param: string }> = {
  requests: { table: 'requests', key: 'id', param: 'id' },
  routes: { table: 'routes', key: 'id', param: 'id' },
  services: { table: 'services', key: 'id', param: 'id' },
  staff: { table: 'staff', key: 'id', param: 'id' },
  days: { table: 'days', key: 'date', param: 'date' },
  absences: { table: 'absences', key: 'id', param: 'id' },
  devices: { table: 'devices', key: 'id', param: 'id' },
  photos: { table: 'photos', key: 'id', param: 'id' },
  handovers: { table: 'handovers', key: 'id', param: 'id' },
  'wait-list': { table: 'wait_list', key: 'id', param: 'id' },
  'route-builder': { table: 'route_builder', key: 'date', param: 'date' },
  // Возврат и отмена платежа — деньги клиента: в журнале должно быть видно,
  // кто и почему (пункт int-pay).
  'online-payments': { table: 'online_payments', key: 'id', param: 'id' },
};

/** Адреса, где сущность не совпадает с первым куском пути. */
const OVERRIDE: Record<string, { table: string; key: string; param: string }> = {
  'PUT /api/requests/:id/payment': { table: 'payments', key: 'request_id', param: 'id' },
};

/** Действия, которые не про изменение строки: вход, чтение чужих данных, выгрузка.
 *  `id` считается по запросу — журналу нужен не адрес, а то, что смотрели. */
const SPECIAL: Record<string, {
  entity: string;
  action: string;
  /** Действие при отказе (сейчас — только неудачный вход). */
  denied?: string;
  id?: (req: FastifyRequest) => string | null;
  details?: (req: FastifyRequest) => Record<string, unknown> | null;
}> = {
  'POST /api/auth/login': {
    entity: 'staff', action: 'вход', denied: 'неудачный вход',
    id: (req) => String((req.body as { login?: string })?.login ?? '') || null,
    details: (req) => ({ login: (req.body as { login?: string })?.login ?? '' }),
  },
  'POST /api/auth/logout': { entity: 'staff', action: 'выход', id: (req) => req.user?.id ?? null },
  'GET /api/clients': {
    entity: 'clients', action: 'просмотр',
    id: (req) => String((req.query as { phone?: string })?.phone ?? '') || null,
    details: (req) => ({ phone: (req.query as { phone?: string })?.phone ?? '' }),
  },
  'GET /api/calls': {
    entity: 'calls', action: 'просмотр',
    details: (req) => ({ отбор: req.query as Record<string, unknown> }),
  },
  'GET /api/calls/:id/record': {
    // Отказ пишется тем же действием: по 152-ФЗ видно должно быть само
    // обращение к записи разговора, а не только удавшееся. Чем кончилось,
    // сказано в «после» — там код отказа.
    entity: 'calls', action: 'прослушивание', denied: 'прослушивание',
    id: (req) => String((req.params as { id?: string })?.id ?? '') || null,
  },
  'GET /api/audit/export.csv': {
    entity: 'audit_log', action: 'выгрузка',
    details: (req) => ({ отбор: req.query as Record<string, unknown> }),
  },
};

/** Вебхуки шлёт АТС, а не человек: журнал действий сотрудников они только
 *  засоряют, а свой след у них свой — таблица `call_events` со всеми событиями
 *  в исходном виде, включая непринятые. Поток событий на пульт (`/calls/stream`)
 *  висит открытым часами: в журнале это была бы одна строка на смену. */
const SKIP = new Set([
  'POST /api/webhooks/novofon', 'GET /api/webhooks/novofon',
  'POST /api/webhooks/novofon/:secret', 'GET /api/webhooks/novofon/:secret',
  'POST /api/webhooks/novofon/routing', 'GET /api/webhooks/novofon/routing',
  'POST /api/webhooks/novofon/routing/:secret', 'GET /api/webhooks/novofon/routing/:secret',
  'GET /api/calls/stream',
  // Уведомления платёжного провайдера — не человек; их след — `payment_events`.
  'POST /api/webhooks/payment/:secret',
]);

/** Поля, которые в журнал не попадают ни при каких обстоятельствах. */
const SECRET = /пароль|password|hash|secret|token|подпис/i;
/** Служебные отметки времени: они меняются при каждой правке и в разнице лишние. */
const NOISE = new Set(['updated_at', 'created_at']);

declare module 'fastify' {
  interface FastifyRequest {
    /** Строка «до» — её снял preHandler, чтобы было с чем сравнивать. */
    auditBefore?: Record<string, unknown> | null;
  }
}

/** Значение так, как его прочтёт человек в журнале. Драйвер отдаёт столбец
 *  `date` объектом времени, и в записи он превратился бы в
 *  «2026-09-18T00:00:00.000Z» — дату переноса заявки так не прочитать. */
function plain(v: unknown): unknown {
  if (!(v instanceof Date)) return v;
  const iso = v.toISOString();
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  // Драйвер `pg` отдаёт `date` полуночью по местному времени, PGlite — по UTC.
  if (!v.getHours() && !v.getMinutes() && !v.getSeconds() && !v.getMilliseconds()) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return iso;
}

const redact = (row: Record<string, unknown> | null): Record<string, unknown> | null => {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = SECRET.test(k) ? '···' : plain(v);
  return out;
};

/** Разница по полям: только то, что изменилось. Значения сравниваются по их
 *  записи в JSON — даты и массивы иначе «меняются» на каждом сохранении. */
function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before && !after) return null;
  if (!before || !after) return { before: redact(before), after: redact(after) };
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOISE.has(key)) continue;
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue;
    was[key] = before[key] ?? null;
    now[key] = after[key] ?? null;
  }
  if (!Object.keys(now).length) return null;
  return { before: redact(was), after: redact(now) };
}

/** Что за действие по методу и адресу. Хвост после идентификатора важен:
 *  `DELETE /api/routes/:id` — это расформирование маршрута, а
 *  `DELETE /api/routes/:id/stops/:requestId` — правка его состава. */
function actionOf(method: string, url: string): string | null {
  const tail = url.split('/').filter(Boolean).slice(2);
  const bare = tail.every((p) => p.startsWith(':'));
  if (method === 'POST') return bare ? 'создание' : 'изменение';
  if (method === 'DELETE') return bare ? 'удаление' : 'изменение';
  if (method === 'PUT' || method === 'PATCH') return 'изменение';
  return null;
}

/** Идентификатор созданной записи: он известен только из ответа.
 *  `{ request: { id: 'R-1207' } }` → `R-1207`, `{ routes: [...] }` → список. */
function idFromPayload(payload: string | null): string | null {
  if (!payload) return null;
  let data: unknown;
  try { data = JSON.parse(payload); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const ids: string[] = [];
  const take = (v: unknown) => {
    if (v && typeof v === 'object' && 'id' in (v as Record<string, unknown>)) {
      const id = (v as Record<string, unknown>).id;
      if (id !== null && id !== undefined) ids.push(String(id));
    }
  };
  take(data);
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(value)) value.forEach(take);
    else take(value);
  }
  if (!ids.length) return null;
  return ids.slice(0, 10).join(', ');
}

async function snapshot(db: Db, table: string, key: string, id: string | null) {
  if (!id) return null;
  try {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE ${key}::text = $1`, [id]);
    return rows[0] ?? null;
  } catch {
    // Снимок — удобство, а не условие работы: сущность могла остаться без таблицы.
    return null;
  }
}

/** Куда смотреть по адресу запроса: сущность, таблица и ключ. */
function target(method: string, url: string) {
  const seg = url.split('/').filter(Boolean)[1] ?? '';
  const place = OVERRIDE[`${method} ${url}`] ?? SNAPSHOT[seg] ?? null;
  return { entity: place ? place.table : seg.replace(/-/g, '_'), place };
}

const idParam = (req: FastifyRequest, param: string): string | null => {
  const v = (req.params as Record<string, unknown> | undefined)?.[param];
  return v === undefined || v === null ? null : String(v);
};

export interface AuditRow {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

/** Запись в журнал. Ошибку наружу не поднимает: журнал не должен отменять
 *  действие, которое уже случилось, — но молчать о своей беде тоже не должен. */
export async function writeAudit(app: FastifyInstance, row: AuditRow): Promise<void> {
  try {
    await app.db.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, before, after, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet, $9)`,
      [row.actorId, row.actorRole, row.action, row.entity, row.entityId,
       row.before ? JSON.stringify(row.before) : null,
       row.after ? JSON.stringify(row.after) : null,
       row.ip && /^[0-9a-fA-F:.]+$/.test(row.ip) ? row.ip : null, row.userAgent]);
  } catch (err) {
    app.log.error({ err, action: row.action, entity: row.entity }, 'Журнал действий: запись не легла');
  }
}

/** Слой ставится на корневое приложение — не плагином: плагин Fastify замыкает
 *  свои хуки в себе, и маршруты соседних плагинов мимо них бы и прошли. */
export function installAudit(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    const url = req.routeOptions?.url;
    if (!url || !url.startsWith('/api/')) return;
    const key = `${req.method} ${url}`;
    if (SKIP.has(key) || SPECIAL[key]) return;
    if (!actionOf(req.method, url)) return;
    const { place } = target(req.method, url);
    if (!place) return;
    req.auditBefore = await snapshot(app.db, place.table, place.key, idParam(req, place.param));
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const url = req.routeOptions?.url;
    if (!url || !url.startsWith('/api/')) return payload;
    const key = `${req.method} ${url}`;
    if (SKIP.has(key)) return payload;
    const body = typeof payload === 'string' ? payload : null;
    const ok = reply.statusCode < 400;

    const special = SPECIAL[key];
    if (special) {
      if (!ok && !special.denied) return payload;
      // Вход — единственное место, где человек ещё не известен по сессии:
      // при удаче его называет ответ, при отказе остаётся только логин из формы.
      const fromPayload = ok && key === 'POST /api/auth/login'
        ? (JSON.parse(body ?? '{}') as { user?: { id?: string; role?: string } }).user ?? null
        : null;
      const details = special.details?.(req) ?? null;
      await writeAudit(app, {
        actorId: fromPayload?.id ?? req.user?.id ?? null,
        actorRole: fromPayload?.role ?? req.user?.role ?? null,
        action: ok ? special.action : special.denied!,
        entity: special.entity,
        entityId: fromPayload?.id ?? special.id?.(req) ?? null,
        before: null,
        after: ok ? details : { ...(details ?? {}), отказ: reply.statusCode },
        ip: req.ip, userAgent: (req.headers['user-agent'] as string) ?? null,
      });
      return payload;
    }

    const action = actionOf(req.method, url);
    if (!action || !ok) return payload;
    const { entity, place } = target(req.method, url);
    const entityId = (place ? idParam(req, place.param) : null) ?? idFromPayload(body);
    const after = place ? await snapshot(app.db, place.table, place.key, entityId) : null;
    // Разницы нет там, где менялась не сама строка, а её окружение: состав
    // маршрута, компетенции поверителя, обзвон точки. Тогда в журнал идёт то,
    // с чем пришёл запрос, — иначе запись была бы пустой.
    const sent = req.body && typeof req.body === 'object' && Object.keys(req.body).length
      ? redact(req.body as Record<string, unknown>) : null;
    // У удаления «до» пишется целиком: строки больше нет, и восстановить по
    // разнице полей уже нечего — в журнале должно остаться, что именно убрали.
    const changed = action === 'удаление' && req.auditBefore
      ? { before: redact(req.auditBefore), after: redact(after) }
      : diff(req.auditBefore ?? null, after);
    await writeAudit(app, {
      actorId: req.user?.id ?? null,
      actorRole: req.user?.role ?? null,
      action, entity, entityId,
      before: changed ? changed.before : null,
      after: changed ? changed.after : sent,
      ip: req.ip, userAgent: (req.headers['user-agent'] as string) ?? null,
    });
    return payload;
  });
}
