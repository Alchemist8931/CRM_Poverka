/* Запись в базу: один приём на все справочники.
 *
 * Импорт обязан быть идемпотентным — повторный запуск на том же файле не должен
 * ни плодить строк, ни трогать `updated_at` без причины. Поэтому вставка всегда
 * идёт через `ON CONFLICT DO UPDATE ... WHERE строка и правда изменилась`:
 *   • вернулась строка с `xmax = 0` — её создали;
 *   • вернулась с `xmax <> 0`      — обновили;
 *   • не вернулось ничего          — в базе уже лежит ровно то же самое.
 * Третий случай и есть доказательство идемпотентности, и он же даёт цифру
 * «без изменений» в сводке прогона.
 */
import type { Change } from './result.mts';

/** Всё, что импорту нужно от базы: подходит и клиент pg, и PGlite. */
export interface SqlRunner {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Upsert {
  table: string;
  /** Столбцы конфликта без скобок: `name`, `phone_norm`, `staff_id, service_id`. */
  conflict: string;
  /** Что вставляем: столбец → значение. */
  values: Record<string, unknown>;
  /** Какие столбцы обновлять у уже существующей строки и по каким сравнивать. */
  update: string[];
  /** Что дописать в SET сверх сравниваемого, например `updated_at = now()`. */
  touch?: string[];
  /** Вернуть эти столбцы у затронутой строки (нужен `id` клиента). */
  returning?: string[];
}

export interface UpsertResult<T = Record<string, unknown>> { change: Change; row: T | null }

export async function upsert<T = Record<string, unknown>>(
  db: SqlRunner, spec: Upsert,
): Promise<UpsertResult<T>> {
  const cols = Object.keys(spec.values);
  const params = cols.map((c) => spec.values[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const t = spec.table;

  let tail: string;
  if (spec.update.length) {
    const set = [...spec.update.map((c) => `${c} = EXCLUDED.${c}`), ...(spec.touch ?? [])].join(', ');
    const left = spec.update.map((c) => `${t}.${c}`).join(', ');
    const right = spec.update.map((c) => `EXCLUDED.${c}`).join(', ');
    tail = `DO UPDATE SET ${set} WHERE (${left}) IS DISTINCT FROM (${right})`;
  } else {
    tail = 'DO NOTHING';
  }
  const back = ['(xmax = 0) AS __created', ...(spec.returning ?? [])].join(', ');
  const sql = `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
               ON CONFLICT (${spec.conflict}) ${tail} RETURNING ${back}`;
  const { rows } = await db.query<T & { __created: boolean }>(sql, params);
  const row = rows[0] ?? null;
  if (!row) return { change: 'unchanged', row: await existing<T>(db, spec) };
  return { change: row.__created ? 'created' : 'updated', row };
}

/** Строка, которую вставка не тронула: её всё равно надо вернуть вызывающему
 *  (клиенту нужен `id`, даже когда карточка не изменилась ни на знак). */
async function existing<T>(db: SqlRunner, spec: Upsert): Promise<T | null> {
  if (!spec.returning?.length) return null;
  const cols = spec.conflict.replace(/[()]/g, '').split(',').map((c) => c.trim());
  const where = cols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
  const { rows } = await db.query<T>(
    `SELECT ${spec.returning.join(', ')} FROM ${spec.table} WHERE ${where}`,
    cols.map((c) => spec.values[c]),
  );
  return rows[0] ?? null;
}
