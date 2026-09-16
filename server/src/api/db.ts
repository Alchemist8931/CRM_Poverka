/* Доступ к базе для API.
 *
 * Интерфейс нарочно узкий: запрос и транзакция. Такому подходит и пул `pg` в
 * работе, и встроенный PostgreSQL (PGlite) в тестах — приложение собирается
 * поверх интерфейса и не знает, что под ним. Загрузчик демо-данных устроен так же
 * (`src/seed/load.ts`, `SqlRunner`), и это не совпадение: другого способа
 * проверять схему и API без Docker у нас нет.
 */
import { Pool } from 'pg';
import { databaseUrl } from '../db.ts';

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Транзакция: внутри — своё соединение, чтобы `BEGIN` не разъехался по пулу. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Рабочее соединение: пул `pg`. */
export function pgDb(url = databaseUrl()): Db {
  const pool = new Pool({ connectionString: url });
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    async tx(fn) {
      const client = await pool.connect();
      const scoped: Db = {
        query: (text, params) => client.query(text, params as unknown[]) as never,
        // Вложенная транзакция — это ошибка вызова, а не случай, который надо поддержать.
        tx: () => { throw new Error('Вложенная транзакция: tx уже открыт'); },
        close: async () => {},
      };
      try {
        await client.query('BEGIN');
        const out = await fn(scoped);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Обёртка над чем угодно с одним соединением — PGlite в тестах.
 *  Соединение одно, поэтому `BEGIN` здесь безопасен на той же ручке. */
export function singleConnectionDb(
  conn: { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>; close?(): Promise<void> },
): Db {
  const self: Db = {
    query: (text, params) => conn.query(text, params),
    async tx(fn) {
      await conn.query('BEGIN');
      try {
        const out = await fn(self);
        await conn.query('COMMIT');
        return out;
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {});
        throw err;
      }
    },
    close: async () => { await conn.close?.(); },
  };
  return self;
}
