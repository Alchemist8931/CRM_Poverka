/* Стенд для проверок API без Docker и без сети.
 *
 * Поднимает настоящий PostgreSQL, собранный в WebAssembly (PGlite), применяет
 * миграции прямо в базу и наполняет её маленьким набором: два города, три услуги,
 * четверо сотрудников, один запланированный день. Демо-набор прототипа здесь не
 * нужен — правила проверяются на данных, которые видно целиком.
 *
 * Миграции применяются чтением Up-части файлов, а не node-pg-migrate: тому нужен
 * сетевой адрес, а сетевой слой PGlite ломается на длинных пачечных вставках
 * (см. `scripts/check-schema.ts`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/api/app.ts';
import { singleConnectionDb, type Db } from '../src/api/db.ts';
import { hashPassword } from '../src/password.ts';
import type { PhotoStorage } from '../src/storage.ts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

/** Дата через n дней от сегодняшней, в виде `ГГГГ-ММ-ДД`. */
export function day(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export const TOMORROW = day(1);
export const AFTER = day(2);

export interface Stand {
  app: FastifyInstance;
  db: Db;
  close(): Promise<void>;
}

export async function makeStand(opts: { storage?: PhotoStorage | null } = {}): Promise<Stand> {
  const pg = new PGlite();
  const dir = join(serverDir, 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const up = sql.split('-- Down Migration')[0]!.split('-- Up Migration')[1] ?? '';
    await pg.exec(up);
  }
  const db = singleConnectionDb({
    query: (text, params) => pg.query(text, params as never[]) as never,
    close: () => pg.close(),
  });
  await fixture(db);
  const app = await buildApp({
    db, secret: 'проверочный-ключ-подписи-сессий', storage: opts.storage ?? null,
  });
  await app.ready();
  return { app, db, close: async () => { await app.close(); await pg.close(); } };
}

/** Маленький набор, на котором видно каждое правило. */
async function fixture(db: Db): Promise<void> {
  const hash = await hashPassword('1234');
  await db.query(
    `INSERT INTO cities (name, short, is_big, sort) VALUES
       ('Екатеринбург', 'ЕКБ', true, 1), ('Нижний Тагил', 'НТ', true, 2)`);
  await db.query(
    `INSERT INTO services (id, grp, name, short, price_person, price_pensioner, price_org,
        rate_verifier, rate_operator, is_verification, sort) VALUES
       ('wv', 'Вода', 'Поверка счётчика воды', 'Поверка воды', 900, 760, 1200, 280, 45, true, 1),
       ('wr', 'Вода', 'Замена счётчика воды', 'Замена воды', 2600, 2200, 3200, 750, 70, false, 2),
       ('hv', 'Тепло', 'Поверка теплосчётчика', 'Поверка тепла', 3400, 2900, 4100, 950, 90, true, 3)`);
  await db.query(`UPDATE services SET replacement_service = 'wr' WHERE id = 'wv'`);
  await db.query(
    `INSERT INTO device_types (name, grsi, interval_years, carrier_kind, sort) VALUES
       ('Бетар СХВ-15', '32245-11', 6, 'Вода', 1), ('ТСК-7 (тепло)', '44096-10', 4, 'Тепло', 2)`);
  await db.query(
    `INSERT INTO staff (id, full_name, role, login, password_hash, must_change_password, ext) VALUES
       ('sv', 'Панченко И.', 'supervisor', 'sv', $1, false, '101'),
       ('o1', 'Ефимова О.', 'operator', 'o1', $1, false, '102'),
       ('v1', 'Алимпиев И.', 'verifier', 'v1', $1, false, null),
       ('v2', 'Седов П.', 'verifier', 'v2', $1, false, null)`, [hash]);
  // v1 закрывает воду и замену, v2 — только поверку воды. Тепло не умеет никто:
  // на этом видно, что подсказка дат считает компетенции смены, а не календарь.
  await db.query(
    `INSERT INTO staff_skills (staff_id, service_id) VALUES
       ('v1','wv'), ('v1','wr'), ('v2','wv')`);
  await db.query(
    `INSERT INTO days (date, cities, plan, crew, ops) VALUES
       ($1, ARRAY['Екатеринбург'], '{"Екатеринбург": 2}'::jsonb, ARRAY['v1','v2'], ARRAY['o1']),
       ($2, ARRAY['Екатеринбург'], '{"Екатеринбург": 5}'::jsonb, ARRAY['v1'], ARRAY['o1'])`,
    [TOMORROW, AFTER]);
}

/** Вход и cookie сессии одной строкой: дальше её носит `as` из этого же файла. */
export async function login(app: FastifyInstance, who: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { login: who, password: '1234' },
  });
  if (res.statusCode !== 200) throw new Error(`вход «${who}» не удался: ${res.statusCode} ${res.body}`);
  const raw = res.headers['set-cookie'];
  const cookie = Array.isArray(raw) ? raw[0]! : String(raw);
  return cookie.split(';')[0]!;
}

/** Запрос от имени вошедшего: `as(app, cookie).post('/api/requests', {...})`. */
export function as(app: FastifyInstance, cookie: string) {
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') =>
    (url: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> =>
      app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) }) as
        Promise<LightMyRequestResponse>;
  return { get: call('GET'), post: call('POST'), put: call('PUT'), patch: call('PATCH'), del: call('DELETE') };
}

/** Заготовка заявки: всё обязательное заполнено, остальное правится в месте вызова. */
export const draft = (over: Record<string, unknown> = {}) => ({
  date: TOMORROW,
  client_type: 'Физлицо',
  name: 'Иванов И.И.',
  phone: '+7 (912) 345-67-89',
  city: 'Екатеринбург',
  street: 'Ленина',
  house: '10',
  flat: '5',
  time_slot: 12,
  svcs: ['wv'],
  ...over,
});
