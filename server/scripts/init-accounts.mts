/* Первичная инициализация доступа (пункт be-users).
 *
 *   npm run init:accounts
 *
 * На момент запуска в боевом контуре существуют ровно две учётные записи с
 * полным доступом — владельца проекта и заказчицы. Сотрудников заранее не
 * заводим: заказчица создаёт их сама по мере найма, на экране «Сотрудники».
 *
 * Скрипт печатает временные пароли в консоль и больше нигде их не показывает:
 * в базе лежит только хеш (scrypt, `src/password.ts`). При первом входе система
 * потребует сменить пароль — до смены дальше формы не пускает охрана в `app.ts`.
 *
 * Повторный запуск ничего не меняет: учётка, найденная по логину, остаётся как
 * есть — с тем же паролем, ролью и состоянием. Это важнее удобства: скрипт
 * попадёт в развёртывание (пункт cloud-cicd), и «переинициализация» после
 * каждой выкладки сбрасывала бы пароль руководителю раз в неделю.
 *
 * Адреса и имена задаются окружением. Значения по умолчанию — временные, на
 * домене `.local`, который наружу не маршрутизируется: заказчик на вопрос
 * «какой ящик заводить под компанию» ещё не ответил (опросный лист № 2).
 * Когда ответит — адрес меняется в карточке на экране «Сотрудники», без правки
 * кода и без пересоздания учётки.
 *
 *   UCHETKIN_OWNER_NAME   UCHETKIN_OWNER_LOGIN   UCHETKIN_OWNER_EMAIL
 *   UCHETKIN_CHIEF_NAME   UCHETKIN_CHIEF_LOGIN   UCHETKIN_CHIEF_EMAIL
 */
import type { Db } from '../src/api/db.ts';
import { hashPassword, temporaryPassword } from '../src/password.ts';
import { nextStaffId } from '../src/api/routes/users.ts';

export interface Account {
  /** Кто это и зачем ему полный доступ — печатается рядом с паролем. */
  title: string;
  full_name: string;
  login: string;
  email: string;
  phone?: string | null;
}

export interface Created {
  account: Account;
  id: string;
  /** Пароль, если учётка заведена сейчас; `null` — она уже была. */
  password: string | null;
}

/** Временный адрес: домен `.local` зарезервирован и наружу не ходит. Признак
 *  нужен, чтобы скрипт сказал вслух, что почта ещё не настоящая. */
export const isPlaceholder = (email: string): boolean => email.toLowerCase().endsWith('.local');

/** Две учётные записи полного доступа. Больше в этом списке ничего нет и быть
 *  не должно: любой третий человек заводится руками руководителя. */
export function accountsFrom(env: NodeJS.ProcessEnv = process.env): Account[] {
  return [
    {
      title: 'владелец проекта',
      full_name: env.UCHETKIN_OWNER_NAME || 'Владелец проекта',
      login: (env.UCHETKIN_OWNER_LOGIN || 'owner').toLowerCase(),
      email: env.UCHETKIN_OWNER_EMAIL || 'owner@uchetkin.local',
    },
    {
      title: 'заказчица, ИП Бердинских А. А.',
      full_name: env.UCHETKIN_CHIEF_NAME || 'Бердинских А. А.',
      login: (env.UCHETKIN_CHIEF_LOGIN || 'berdinskikh').toLowerCase(),
      email: env.UCHETKIN_CHIEF_EMAIL || 'berdinskikh@uchetkin.local',
    },
  ];
}

/** Завести недостающие учётки полного доступа. Уже существующие не трогает —
 *  ни пароля, ни роли, ни блокировки. */
export async function initAccounts(db: Db, accounts = accountsFrom()): Promise<Created[]> {
  const out: Created[] = [];
  for (const account of accounts) {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM staff WHERE lower(login) = lower($1)', [account.login]);
    if (rows[0]) {
      out.push({ account, id: rows[0].id, password: null });
      continue;
    }
    const id = await nextStaffId(db, 'supervisor');
    const password = temporaryPassword();
    await db.query(
      `INSERT INTO staff (id, full_name, role, phone, login, email, password_hash, must_change_password)
       VALUES ($1, $2, 'supervisor', $3, $4, $5, $6, true)`,
      [id, account.full_name, account.phone ?? null, account.login, account.email,
       await hashPassword(password)]);
    out.push({ account, id, password });
  }
  return out;
}

/** Отчёт о прогоне: то, что руководитель читает в консоли развёртывания. */
export function report(created: Created[]): string[] {
  const lines: string[] = [];
  const fresh = created.filter((c) => c.password);
  for (const c of created) {
    lines.push(c.password
      ? `  ✓ ${c.account.title}: ${c.account.full_name} · логин ${c.account.login} · `
        + `почта ${c.account.email} · временный пароль: ${c.password}`
      : `  · ${c.account.title}: логин ${c.account.login} уже есть (${c.id}) — ничего не менялось`);
  }
  lines.push(fresh.length
    ? `Заведено учётных записей: ${fresh.length}. Пароли показаны один раз — `
      + 'сохраните их сейчас, при первом входе система потребует их сменить.'
    : 'Ничего не изменилось: обе учётные записи уже заведены.');
  const placeholders = created.filter((c) => isPlaceholder(c.account.email));
  if (placeholders.length) {
    lines.push(`Внимание: у ${placeholders.length} учётных записей временная почта на домене .local — `
      + 'заказчик ещё не сказал, какой ящик заводить под компанию. Адрес правится в карточке '
      + 'на экране «Сотрудники», пересоздавать учётку не нужно.');
  }
  return lines;
}

/* ── запуск из командной строки ───────────────────────────────── */

if (import.meta.filename === process.argv[1]) {
  const { pgDb } = await import('../src/api/db.ts');
  const db = pgDb();
  try {
    console.log('Учётные записи полного доступа:');
    for (const line of report(await initAccounts(db))) console.log(line);
  } finally {
    await db.close();
  }
}
