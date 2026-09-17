/* Журнал действий: чтение и выгрузка (пункт be-audit).
 *
 * Пишет журнал промежуточный слой (`src/api/audit.ts`), здесь его только
 * показывают — и только руководителю: в записях лежат телефоны, адреса и
 * фамилии клиентов, то есть ровно то, доступ к чему журнал и сторожит.
 *
 * Ни правки, ни удаления здесь нет и не будет: запись журнала неизменяема,
 * и это держится триггером в базе, а не отсутствием обработчика.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth.ts';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

/** Отбор один на список и на выгрузку: руководитель выгружает то, что видит. */
const FILTERS = {
  actor_id: { type: 'string', description: 'сотрудник' },
  entity: { type: 'string', description: 'сущность: requests, routes, services, staff, …' },
  action: { type: 'string', description: 'создание, изменение, удаление, просмотр, вход, …' },
  from: DATE,
  to: DATE,
  q: { type: 'string', description: 'поиск по номеру заявки и по содержимому записи' },
} as const;

interface Query {
  actor_id?: string; entity?: string; action?: string;
  from?: string; to?: string; q?: string; limit?: number; offset?: number;
}

/** Условие отбора и его параметры — одно место на список, счётчик и выгрузку. */
function where(q: Query): { sql: string; params: unknown[] } {
  return {
    sql: `($1::text IS NULL OR a.actor_id = $1)
      AND ($2::text IS NULL OR a.entity = $2)
      AND ($3::text IS NULL OR a.action = $3)
      AND ($4::date IS NULL OR a.at >= $4::date)
      AND ($5::date IS NULL OR a.at < $5::date + 1)
      AND ($6::text IS NULL OR a.entity_id ILIKE '%' || $6 || '%'
           OR a.before::text ILIKE '%' || $6 || '%' OR a.after::text ILIKE '%' || $6 || '%')`,
    params: [q.actor_id || null, q.entity || null, q.action || null,
             q.from || null, q.to || null, q.q || null],
  };
}

const SELECT = `SELECT a.id, a.at, a.actor_id, s.full_name AS actor_name, a.actor_role,
       a.action, a.entity, a.entity_id, a.before, a.after, host(a.ip) AS ip, a.user_agent
  FROM audit_log a LEFT JOIN staff s ON s.id = a.actor_id`;

/** Потолок выгрузки. Три года журнала — это сотни тысяч строк, и отдавать их
 *  одним файлом незачем: руководитель выгружает отобранное, а не всё подряд. */
const EXPORT_MAX = 20000;

/** Поле CSV: точка с запятой и кавычки — под Excel с русскими настройками. */
const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Разница по полям одной строкой: «цена: 900 → 950». */
function changes(before: unknown, after: unknown): string {
  const was = (before ?? {}) as Record<string, unknown>;
  const now = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
  const text = (v: unknown) => (v === null || v === undefined ? '—'
    : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return keys.map((k) => (k in was ? `${k}: ${text(was[k])} → ${text(now[k])}` : `${k}: ${text(now[k])}`))
    .join('; ');
}

const plugin: FastifyPluginAsync = async (app) => {
  app.get('/audit', {
    schema: {
      tags: ['журнал'],
      summary: 'Журнал действий: отбор по сотруднику, сущности, действию, датам и поиску',
      security: [{ session: [] }],
      querystring: {
        type: 'object',
        properties: {
          ...FILTERS,
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const q = req.query as Query;
    const { sql, params } = where(q);
    const { rows } = await app.db.query(
      `${SELECT} WHERE ${sql} ORDER BY a.at DESC, a.id DESC LIMIT $7 OFFSET $8`,
      [...params, q.limit ?? 100, q.offset ?? 0]);
    // Счётчик нужен экрану: без него не видно, что отбор показал не всё.
    const { rows: count } = await app.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log a WHERE ${sql}`, params);
    return { entries: rows, total: Number(count[0]?.n ?? 0) };
  });

  app.get('/audit/export.csv', {
    schema: {
      tags: ['журнал'],
      summary: 'Выгрузка отобранного журнала в CSV. Сама выгрузка тоже попадает в журнал',
      security: [{ session: [] }],
      querystring: { type: 'object', properties: FILTERS },
    },
  }, async (req, reply) => {
    requireRole(req, 'supervisor');
    const { sql, params } = where(req.query as Query);
    const { rows } = await app.db.query<Record<string, unknown>>(
      `${SELECT} WHERE ${sql} ORDER BY a.at DESC, a.id DESC LIMIT ${EXPORT_MAX}`, params);

    const head = ['Время', 'Сотрудник', 'Роль', 'Действие', 'Сущность', 'Запись', 'Изменения', 'Адрес'];
    const lines = rows.map((r) => [
      new Date(String(r.at)).toISOString().replace('T', ' ').slice(0, 19),
      r.actor_name ?? r.actor_id ?? '—', r.actor_role ?? '', r.action, r.entity,
      r.entity_id ?? '', changes(r.before, r.after), r.ip ?? '',
    ].map(cell).join(';'));
    // Строка с меткой порядка байтов: без неё Excel открывает кириллицу кракозябрами.
    const csv = '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
    const name = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(csv);
  });
};

export default plugin;
