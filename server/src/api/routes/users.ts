/* Учётные записи сотрудников (пункт be-users).
 *
 * Своего администратора у заказчика нет: полный доступ — это роль руководителя,
 * и учётки заводит он сам, по мере найма. Поэтому здесь нет ни приглашений по
 * почте, ни самостоятельной регистрации: руководитель создаёт карточку, система
 * показывает ему временный пароль один раз, и он передаёт его человеку.
 *
 * Адреса нарочно живут под `/api/staff`, рядом с чтением справочника сотрудников
 * (`routes/refs.ts`), а не отдельным разделом `/api/users`. Причина не в красоте:
 * промежуточный слой журнала (`src/api/audit.ts`) узнаёт сущность по первому куску
 * пути и для `staff` уже умеет снимать строку «до» и «после». На `/api/users` он
 * бы записал действие без разницы по полям — то есть «кто-то что-то поменял».
 *
 * Учётка не удаляется никогда. Увольнение — это `blocked_at`: человек пропадает
 * из выбора в новые смены и маршруты, но остаётся во всей истории, потому что
 * иначе прошлогодний акт окажется подписан пустым местом.
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  requireRole, requireUser, makeSession, setSessionCookie, clearSessionCookie, sessionsFrom,
} from '../auth.ts';
import { ApiError, notFound, ruleError } from '../errors.ts';
import { loadServices, loadStaff } from '../store.ts';
import type { Db } from '../db.ts';
import { canManageUsers, type Role } from '../../rules.ts';
import { hashPassword, verifyPassword, passwordProblem, temporaryPassword } from '../../password.ts';

const ROLES: Role[] = ['operator', 'senior', 'supervisor', 'verifier'];
const PATTERNS = ['5/2', '2/2'];

/** Логин из почты: часть до «@», приведённая к тому, что человек наберёт с
 *  клавиатуры без раскладки и сомнений. `Arina.Berdinskikh@yandex.ru` → `arina.berdinskikh`. */
export function loginFromEmail(email: string): string {
  return email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

/** Идентификатор новой карточки. Он текстовый и осмысленный (`v12`, `o4`) — тот
 *  же вид, что у перенесённых из прототипа: по идентификатору в журнале и в
 *  выгрузке должно быть видно, о ком речь, без похода в справочник. */
export async function nextStaffId(db: Db, role: Role): Promise<string> {
  const prefix = role === 'verifier' ? 'v' : role === 'supervisor' ? 'sv' : 'o';
  const { rows } = await db.query<{ id: string }>('SELECT id FROM staff');
  const taken = new RegExp(`^${prefix}(\\d*)$`);
  let max = -1;
  for (const r of rows) {
    const m = taken.exec(r.id);
    if (m) max = Math.max(max, m[1] ? Number(m[1]) : 0);
  }
  return `${prefix}${max + 1}`;
}

/** Карточка, как её видит руководитель: всё, кроме хеша пароля. */
async function cardOf(db: Db, id: string) {
  const [card] = await loadStaff(db, { account: true }).then((rows) => rows.filter((r) => r.id === id));
  if (!card) throw notFound(`Нет сотрудника «${id}».`);
  return card;
}

/** Компетенции поверителя. У остальных ролей их нет: услуги закрывает тот, кто
 *  выезжает, а оператор и руководитель на адрес не едут. */
async function setSkills(db: Db, id: string, role: Role, svcs: string[]): Promise<void> {
  if (role !== 'verifier') {
    await db.query('DELETE FROM staff_skills WHERE staff_id = $1', [id]);
    return;
  }
  const { map } = await loadServices(db);
  const unknown = svcs.find((s) => !map.has(s));
  if (unknown) throw ruleError(`Нет услуги «${unknown}» в справочнике.`);
  await db.query('DELETE FROM staff_skills WHERE staff_id = $1', [id]);
  for (const s of [...new Set(svcs)]) {
    await db.query('INSERT INTO staff_skills (staff_id, service_id) VALUES ($1, $2)', [id, s]);
  }
}

/** Занят ли логин или почта кем-то другим. Сверка идёт без учёта регистра —
 *  так же, как потом ищет вход. */
async function takenBy(db: Db, field: 'login' | 'email', value: string, exceptId: string | null): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM staff WHERE lower(${field}) = lower($1) AND ($2::text IS NULL OR id <> $2)`,
    [value, exceptId]);
  return rows.length > 0;
}

/** Последнего руководителя нельзя ни заблокировать, ни понизить: система
 *  останется без единственного человека, который может завести учётку, и
 *  чинить это придётся руками в базе. */
async function lastSupervisor(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM staff
      WHERE role = 'supervisor' AND blocked_at IS NULL AND id <> $1`, [id]);
  return Number(rows[0]?.n ?? 0) === 0;
}

/** Выдача нового временного пароля: он же гасит сессии и снимает замок входа.
 *  Возвращает пароль — показать его можно ровно один раз, в базе лежит хеш. */
async function issueTemporary(db: Db, id: string): Promise<string> {
  const password = temporaryPassword();
  await db.query(
    `UPDATE staff SET password_hash = $2, must_change_password = true,
            failed_logins = 0, locked_until = NULL, sessions_from = $3, updated_at = now()
      WHERE id = $1`, [id, await hashPassword(password), sessionsFrom()]);
  return password;
}

const CARD = {
  full_name: { type: 'string', minLength: 1 },
  phone: { type: 'string' },
  ext: { type: 'string' },
  email: { type: 'string' },
  login: { type: 'string' },
  pattern: { type: 'string', enum: PATTERNS },
  anchor: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  svcs: { type: 'array', items: { type: 'string' } },
} as const;

const plugin: FastifyPluginAsync = async (app) => {
  /* ── создание ────────────────────────────────────────────────── */

  app.post('/staff', {
    schema: {
      tags: ['справочники'],
      summary: 'Новый сотрудник с учётной записью. Временный пароль показывается один раз',
      security: [{ session: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['full_name', 'role'],
        properties: { ...CARD, role: { type: 'string', enum: ROLES } },
      },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const b = req.body as {
      full_name: string; role: Role; phone?: string; ext?: string; email?: string;
      login?: string; pattern?: string; anchor?: string; svcs?: string[];
    };
    const email = b.email?.trim() || null;
    // Логин руками или из почты. Если нет ни того, ни другого — человеку не с
    // чем войти, и молча заводить карточку без входа было бы обманом.
    const login = (b.login?.trim() || (email ? loginFromEmail(email) : '')).toLowerCase();
    if (!login) throw ruleError('Укажите почту или логин — иначе сотруднику нечем войти.', 'login');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw ruleError('Почта написана с ошибкой.', 'email');

    return app.db.tx(async (db) => {
      if (await takenBy(db, 'login', login, null)) throw ruleError(`Логин «${login}» уже занят.`, 'login');
      if (email && await takenBy(db, 'email', email, null)) throw ruleError(`Почта «${email}» уже занята.`, 'email');
      const id = await nextStaffId(db, b.role);
      const password = temporaryPassword();
      await db.query(
        `INSERT INTO staff (id, full_name, role, phone, ext, pattern, anchor, login, email,
                            password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`,
        [id, b.full_name.trim(), b.role, b.phone?.trim() || null, b.ext?.trim() || null,
         b.pattern ?? null, b.anchor ?? null, login, email, await hashPassword(password)]);
      await setSkills(db, id, b.role, b.svcs ?? []);
      // Пароль уходит в ответ и больше нигде не появляется: в базе хеш, в
      // журнале действий поле с паролем вычеркнуто слоем журнала.
      return { staff: await cardOf(db, id), temporary_password: password };
    });
  });

  /* ── правка карточки, роль, блокировка ───────────────────────── */

  app.patch('/staff/:id', {
    schema: {
      tags: ['справочники'],
      summary: 'Правка карточки: данные, роль, компетенции, блокировка при увольнении',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...CARD,
          role: { type: 'string', enum: ROLES },
          blocked: { type: 'boolean', description: 'true — уволен, вход закрыт; false — вернулся' },
        },
      },
    },
  }, async (req) => {
    const user = requireRole(req, 'supervisor');
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown> & { role?: Role; blocked?: boolean; svcs?: string[] };

    return app.db.tx(async (db) => {
      const { rows } = await db.query<{ id: string; role: Role; blocked_at: string | null }>(
        'SELECT id, role, blocked_at FROM staff WHERE id = $1', [id]);
      const was = rows[0];
      if (!was) throw notFound(`Нет сотрудника «${id}».`);

      const role = (b.role ?? was.role) as Role;
      const blocked = b.blocked ?? !!was.blocked_at;
      // Себя руководитель не увольняет: выйти из системы, закрыв себе вход,
      // — это потерянный вечер и правка в базе руками.
      if (blocked && id === user.id) throw ruleError('Себя заблокировать нельзя — попросите другого руководителя.', 'self');
      if ((blocked || role !== 'supervisor') && was.role === 'supervisor' && !was.blocked_at
          && await lastSupervisor(db, id)) {
        throw ruleError('Это единственный руководитель — некому будет заводить учётные записи. '
          + 'Сначала заведите второго.', 'last-supervisor');
      }

      const set: string[] = [];
      const params: unknown[] = [id];
      const put = (col: string, value: unknown) => { params.push(value); set.push(`${col} = $${params.length}`); };

      for (const col of ['full_name', 'phone', 'ext', 'pattern', 'anchor'] as const) {
        if (b[col] === undefined) continue;
        const v = typeof b[col] === 'string' ? (b[col] as string).trim() : b[col];
        put(col, v === '' ? null : v);
      }
      if (b.email !== undefined) {
        const email = String(b.email).trim() || null;
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw ruleError('Почта написана с ошибкой.', 'email');
        if (email && await takenBy(db, 'email', email, id)) throw ruleError(`Почта «${email}» уже занята.`, 'email');
        put('email', email);
      }
      if (b.login !== undefined) {
        const login = String(b.login).trim().toLowerCase();
        if (!login) throw ruleError('Логин пустым не бывает — сотруднику нечем будет войти.', 'login');
        if (await takenBy(db, 'login', login, id)) throw ruleError(`Логин «${login}» уже занят.`, 'login');
        put('login', login);
      }
      if (b.role !== undefined) put('role', role);
      if (b.blocked !== undefined && blocked !== !!was.blocked_at) {
        put('blocked_at', blocked ? new Date().toISOString() : null);
        // Заблокированного гасим на всех устройствах сразу: иначе уволенный
        // доработает смену в уже открытой вкладке. Вернувшемуся снимаем замок
        // входа — пять неудачных попыток могли остаться с прошлого раза.
        if (blocked) put('sessions_from', sessionsFrom());
        else { put('failed_logins', 0); put('locked_until', null); }
      }
      if (set.length) {
        await db.query(`UPDATE staff SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, params);
      }
      if (b.svcs !== undefined || (b.role !== undefined && role !== 'verifier')) {
        await setSkills(db, id, role, b.svcs ?? []);
      }
      return { staff: await cardOf(db, id) };
    });
  });

  /* ── пароли ──────────────────────────────────────────────────── */

  app.post('/staff/:id/password/reset', {
    schema: {
      tags: ['вход'],
      summary: 'Сброс пароля руководителем: новый временный пароль, показывается один раз',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    requireRole(req, 'supervisor');
    const { id } = req.params as { id: string };
    const { rows } = await app.db.query<{ id: string }>('SELECT id FROM staff WHERE id = $1', [id]);
    if (!rows[0]) throw notFound(`Нет сотрудника «${id}».`);
    const password = await issueTemporary(app.db, id);
    return { staff_id: id, temporary_password: password };
  });

  app.post('/staff/:id/password', {
    schema: {
      tags: ['вход'],
      summary: 'Смена своего пароля. Первый вход по временному паролю проходит через неё',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['current', 'password'],
        properties: { current: { type: 'string' }, password: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    // Чужой пароль не меняет никто, включая руководителя: у него для этого есть
    // сброс, после которого человек придумает пароль сам. Знать чужой пароль
    // в системе не должен никто.
    if (id !== user.id) throw new ApiError(403, 'Свой пароль меняет каждый сам. Чужой — только сбросом.', 'self');
    const { current, password } = req.body as { current: string; password: string };

    const { rows } = await app.db.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM staff WHERE id = $1', [id]);
    if (!rows[0]) throw notFound(`Нет сотрудника «${id}».`);
    if (!(await verifyPassword(current, rows[0].password_hash))) {
      throw new ApiError(401, 'Текущий пароль введён неверно.', 'current');
    }
    const bad = passwordProblem(password);
    if (bad) throw ruleError(bad, 'password');
    if (password === current) throw ruleError('Новый пароль совпадает со старым.', 'password');

    await app.db.query(
      `UPDATE staff SET password_hash = $2, must_change_password = false,
              failed_logins = 0, locked_until = NULL, sessions_from = $3, updated_at = now()
        WHERE id = $1`, [id, await hashPassword(password), sessionsFrom()]);
    // Смена пароля гасит все выданные раньше сессии — в том числе ту, из которой
    // пришёл запрос. Поэтому тут же выдаём новую: человек остаётся в системе,
    // а чужая открытая вкладка — нет.
    setSessionCookie(reply, makeSession(id, app.sessionSecret));
    return { ok: true };
  });

  /* ── сессии ──────────────────────────────────────────────────── */

  app.post('/staff/:id/sessions/close', {
    schema: {
      tags: ['вход'],
      summary: 'Выход со всех устройств: свой — любому, чужой — руководителю',
      security: [{ session: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (id !== user.id && !canManageUsers(user.role)) {
      throw new ApiError(403, 'Чужие сессии гасит только руководитель.', 'role');
    }
    const { rows } = await app.db.query<{ id: string }>('SELECT id FROM staff WHERE id = $1', [id]);
    if (!rows[0]) throw notFound(`Нет сотрудника «${id}».`);
    await app.db.query('UPDATE staff SET sessions_from = $2, updated_at = now() WHERE id = $1',
      [id, sessionsFrom()]);
    // Свои сессии гасятся вместе со всеми — значит и эта вкладка выходит.
    if (id === user.id) clearSessionCookie(reply);
    return { staff_id: id, closed: true };
  });
};

export default plugin;
