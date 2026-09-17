/* Справочники из книги заказчика: города, услуги и прайс, типы приборов.
 * При заполненных необязательных листах — ещё и штат с компетенциями.
 *
 * Книга — та самая, что ушла заказчику в пункте req-refs: листы «Города»,
 * «Услуги и прайс», «Приборы», «Формы» и два необязательных. Столбцов
 * `cities.short` и `services.id` в ней нет и быть не должно — это внутренние
 * обозначения системы, и импорт их придумывает сам, один раз: у уже заведённой
 * строки ни сокращение, ни идентификатор не меняются никогда.
 *
 * Чего импорт не делает намеренно: не заводит ни одной учётной записи. Лист
 * «Сотрудники» грузится как справочник людей — ФИО, роль, телефон, график.
 * Логин, пароль и одноразовый код остаются пустыми: по решению владельца
 * учётки создаёт руководитель в интерфейсе по мере найма (пункт be-users).
 */
import { upsert, type SqlRunner } from './db.mts';
import {
  blank, cityShort, integer, key, personName, phoneNorm, shortName, slug, text, weekdays, yesNo,
} from './normalize.mts';
import { count, newResult, reject, warn, type Result } from './result.mts';
import { at, findSheet, pick, readBook, type Row, type Sheet } from './workbook.mts';

/** Услуги прототипа: их обозначения уже зашиты в правила и в акт, и услуга
 *  с тем же названием обязана получить тот же идентификатор, а не новый.
 *  Здесь же пары «прибор непригоден → чем меняем»: в книге такого столбца нет. */
const KNOWN_SERVICES: Record<string, { id: string; replacement?: string }> = {
  'поверка счетчика воды': { id: 'wv', replacement: 'wr' },
  'замена счетчика воды': { id: 'wr' },
  'поверка теплосчетчика': { id: 'hv', replacement: 'hm' },
  'монтаж теплосчетчика': { id: 'hm' },
  'демонтаж теплосчетчика': { id: 'hd' },
};

const ROLES: [RegExp, string][] = [
  [/^старш/i, 'senior'],
  [/^(руковод|директор|начальн)/i, 'supervisor'],
  [/^операт/i, 'operator'],
  [/^(повер|мастер|инженер)/i, 'verifier'],
];

/** Вся строка листа одной строкой — для отчёта заказчику. */
const rowText = (row: Row): string =>
  Object.values(row.cells).map((c) => text(c)).filter(Boolean).join(' | ');

export async function importRefs(db: SqlRunner, file: string): Promise<Result> {
  const res = newResult();
  const sheets = await readBook(file);

  await importCities(db, sheets, res);
  const services = await importServices(db, sheets, res);
  await importDeviceTypes(db, sheets, res);
  const staff = await importStaff(db, sheets, res);
  await importSkills(db, sheets, res, staff, services);
  noteForms(sheets, res);
  return res;
}

/* ───────────────────────────── города ───────────────────────────── */

async function importCities(db: SqlRunner, sheets: Sheet[], res: Result): Promise<void> {
  const sheet = findSheet(sheets, 'Города', 'Города и расписание');
  if (!sheet) { res.skipped.push('лист «Города» в книге не найден'); return; }

  const cName = pick(sheet, ['Населённый пункт', 'Город', 'Название']);
  const cKind = pick(sheet, ['Тип: крупный / малый', 'Тип', 'Крупный']);
  const cDays = pick(sheet, ['Дни недели выезда', 'Дни выезда', 'Расписание']);
  const cNorm = pick(sheet, ['Норматив адресов на поверителя в день', 'Норматив', 'Адресов на поверителя']);
  if (!cName) { res.skipped.push('на листе «Города» не найден столбец с названием города'); return; }

  const { rows: have } = await db.query<{ name: string; short: string }>('SELECT name, short FROM cities');
  const shortOf = new Map(have.map((c) => [key(c.name), c.short]));
  const takenShorts = new Set(have.map((c) => c.short));
  const seen = new Set<string>();

  let sort = 0;
  for (const row of sheet.rows) {
    const name = text(at(row, cName)).replace(/\s+/g, ' ');
    if (blank(name)) continue;
    if (!/[а-яёa-z]/i.test(name)) {
      reject(res, { sheet: sheet.title, line: row.line, reason: 'в столбце города нет названия', values: rowText(row) });
      continue;
    }
    if (seen.has(key(name))) {
      reject(res, { sheet: sheet.title, line: row.line, reason: `город «${name}» уже есть выше в этом листе`, values: rowText(row) });
      continue;
    }
    seen.add(key(name));
    sort += 10;

    const norm = blank(at(row, cNorm)) ? null : integer(at(row, cNorm));
    if (norm !== null && norm <= 0) {
      reject(res, { sheet: sheet.title, line: row.line, reason: `норматив адресов должен быть числом больше нуля, а стоит «${text(at(row, cNorm))}»`, values: rowText(row) });
      continue;
    }
    if (norm === null && !blank(at(row, cNorm))) {
      warn(res, { sheet: sheet.title, line: row.line, reason: `норматив «${text(at(row, cNorm))}» не похож на число — город загружен без норматива`, values: rowText(row) });
    }
    const days = weekdays(at(row, cDays));
    if (!days.length && !blank(at(row, cDays))) {
      warn(res, { sheet: sheet.title, line: row.line, reason: `дни выезда «${text(at(row, cDays))}» не разобраны — ждём «пн, ср, пт»`, values: rowText(row) });
    }

    let short = shortOf.get(key(name));
    if (!short) {
      short = uniqueShort(cityShort(name), takenShorts);
      takenShorts.add(short);
    }
    const { change } = await upsert(db, {
      table: 'cities',
      conflict: 'name',
      values: {
        name, short,
        is_big: /крупн|больш/i.test(text(at(row, cKind))),
        weekdays: days,
        norm_per_verifier: norm,
        sort,
      },
      update: ['is_big', 'weekdays', 'norm_per_verifier', 'sort'],
    });
    count(res, 'cities', change);
  }
}

/** Сокращение города, которого ещё нет в базе: «АСБ», «АСБ2», «АСБ3». */
function uniqueShort(base: string, taken: Set<string>): string {
  const start = base || 'ГОР';
  if (!taken.has(start)) return start;
  for (let n = 2; n < 100; n++) {
    const next = (start + n).slice(0, 6);
    if (!taken.has(next)) return next;
  }
  return start + Date.now().toString().slice(-3);
}

/* ───────────────────────────── услуги и прайс ───────────────────────────── */

async function importServices(db: SqlRunner, sheets: Sheet[], res: Result): Promise<Map<string, string>> {
  /** Название услуги → её идентификатор: нужен листу «Компетенции». */
  const ids = new Map<string, string>();
  const sheet = findSheet(sheets, 'Услуги и прайс', 'Услуги', 'Прайс');
  if (!sheet) { res.skipped.push('лист «Услуги и прайс» в книге не найден'); return ids; }

  const cGrp = pick(sheet, ['Группа', 'Раздел']);
  const cName = pick(sheet, ['Наименование услуги', 'Услуга', 'Наименование']);
  const money: [string, string[]][] = [
    ['price_person', ['Цена, физлицо, ₽', 'Цена физлицо', 'Цена']],
    ['price_pensioner', ['Цена, пенсионер, ₽', 'Цена пенсионер', 'Пенсионер']],
    ['price_org', ['Цена, юрлицо, ₽', 'Цена юрлицо', 'Юрлицо']],
    ['rate_verifier', ['Ставка поверителю, ₽', 'Ставка поверителю', 'Поверителю']],
    ['rate_operator', ['Ставка оператору, ₽', 'Ставка оператору', 'Оператору']],
  ];
  const cols = money.map(([field, names]) => [field, pick(sheet, names)] as const);
  if (!cName) { res.skipped.push('на листе «Услуги и прайс» не найден столбец с названием услуги'); return ids; }

  const { rows: have } = await db.query<{ id: string; name: string }>('SELECT id, name FROM services');
  const byName = new Map(have.map((s) => [key(s.name), s.id]));
  const taken = new Set(have.map((s) => s.id));
  /** Связки «непригоден → меняем», которые проставим вторым проходом. */
  const links: [string, string][] = [];

  let sort = 0;
  for (const row of sheet.rows) {
    const name = text(at(row, cName));
    if (blank(name)) continue;
    const grp = text(at(row, cGrp)) || 'Прочее';

    const values: Record<string, unknown> = {};
    let bad = '';
    for (const [field, header] of cols) {
      const raw = at(row, header);
      const n = integer(raw);
      if (n === null || n < 0) {
        bad = `в столбце «${header ?? field}» нужна цена числом, а стоит «${text(raw)}»`;
        break;
      }
      values[field] = n;
    }
    if (bad) {
      reject(res, { sheet: sheet.title, line: row.line, reason: bad, values: rowText(row) });
      continue;
    }

    const known = KNOWN_SERVICES[key(name)];
    const id = byName.get(key(name)) ?? known?.id ?? uniqueSlug(slug(name), taken);
    taken.add(id);
    ids.set(key(name), id);
    if (known?.replacement) links.push([id, known.replacement]);
    sort += 10;

    const { change } = await upsert(db, {
      table: 'services',
      conflict: 'id',
      values: {
        id, grp, name,
        short: shortName(name),
        ...values,
        is_verification: /^повер/i.test(name),
        sort,
        active: true,
      },
      // `short` в обновлении нет намеренно: короткое имя могли поправить руками,
      // а книга такого столбца не содержит и предложить ничего не может.
      update: ['grp', 'name', 'price_person', 'price_pensioner', 'price_org',
        'rate_verifier', 'rate_operator', 'is_verification', 'sort', 'active'],
      touch: ['updated_at = now()'],
    });
    count(res, 'services', change);
  }

  // Вторым проходом: чем меняют непригодный прибор. Только между услугами,
  // которые в книге и правда есть, — ссылка на несуществующую строку не пройдёт.
  for (const [id, replacement] of links) {
    if (!taken.has(replacement)) continue;
    await db.query(
      `UPDATE services SET replacement_service = $2, updated_at = now()
        WHERE id = $1 AND replacement_service IS DISTINCT FROM $2`, [id, replacement]);
  }
  return ids;
}

function uniqueSlug(base: string, taken: Set<string>): string {
  const start = base || 'svc';
  if (!taken.has(start)) return start;
  for (let n = 2; n < 100; n++) if (!taken.has(`${start}-${n}`)) return `${start}-${n}`;
  return `${start}-${Date.now()}`;
}

/* ───────────────────────────── типы приборов ───────────────────────────── */

async function importDeviceTypes(db: SqlRunner, sheets: Sheet[], res: Result): Promise<void> {
  const sheet = findSheet(sheets, 'Приборы', 'Типы приборов', 'Счётчики');
  if (!sheet) { res.skipped.push('лист «Приборы» в книге не найден'); return; }

  const cName = pick(sheet, ['Тип прибора', 'Прибор', 'Наименование']);
  const cGrsi = pick(sheet, ['Номер в ГРСИ', 'ГРСИ', 'Госреестр']);
  const cYears = pick(sheet, ['Межповерочный интервал, лет', 'Межповерочный интервал', 'МПИ']);
  if (!cName) { res.skipped.push('на листе «Приборы» не найден столбец с типом прибора'); return; }

  const seen = new Set<string>();
  let sort = 0;
  for (const row of sheet.rows) {
    const name = text(at(row, cName));
    if (blank(name)) continue;
    if (seen.has(key(name))) {
      reject(res, { sheet: sheet.title, line: row.line, reason: `тип «${name}» уже есть выше в этом листе`, values: rowText(row) });
      continue;
    }
    seen.add(key(name));

    const years = integer(at(row, cYears));
    if (years === null || years <= 0) {
      reject(res, { sheet: sheet.title, line: row.line, reason: `межповерочный интервал должен быть числом лет больше нуля, а стоит «${text(at(row, cYears))}»`, values: rowText(row) });
      continue;
    }
    const grsi = text(at(row, cGrsi));
    if (!grsi) {
      warn(res, { sheet: sheet.title, line: row.line, reason: 'не указан номер в ГРСИ — без него запись о поверке во ФГИС «Аршин» не уйдёт', values: rowText(row) });
    }
    // Носителя в книге нет: его видно по названию прибора. Тепло опознаётся по
    // слову и по обозначению ТСК, всё остальное — вода.
    const heat = /тепл|тск|втэ|квт/i.test(name);
    if (!heat && !/вод|хвс|гвс|схв|сгв|свк|wfw|пульсар|бетар|итэлма|ителма/i.test(name)) {
      warn(res, { sheet: sheet.title, line: row.line, reason: `по названию не видно, вода это или тепло — записан как «Вода», проверьте`, values: rowText(row) });
    }
    sort += 10;

    const { change } = await upsert(db, {
      table: 'device_types',
      conflict: 'name',
      values: { name, grsi, interval_years: years, carrier_kind: heat ? 'Тепло' : 'Вода', sort, active: true },
      update: ['grsi', 'interval_years', 'carrier_kind', 'sort', 'active'],
    });
    count(res, 'device_types', change);
  }
}

/* ───────────────────────────── штат (необязательный лист) ───────────────────────────── */

async function importStaff(db: SqlRunner, sheets: Sheet[], res: Result): Promise<Map<string, string>> {
  /** ФИО → идентификатор сотрудника: нужен листу «Компетенции». */
  const ids = new Map<string, string>();
  const sheet = findSheet(sheets, 'Сотрудники (необязательно)', 'Сотрудники', 'Штат');
  if (!sheet || !sheet.rows.length) return ids;

  const cName = pick(sheet, ['ФИО', 'Сотрудник', 'Фамилия']);
  const cRole = pick(sheet, ['Роль', 'Должность']);
  const cPhone = pick(sheet, ['Мобильный телефон', 'Телефон']);
  const cExt = pick(sheet, ['Внутренний номер', 'Добавочный']);
  const cPattern = pick(sheet, ['Шаблон смен', 'График']);
  const cCity = pick(sheet, ['Город базирования', 'Город']);
  if (!cName || !cRole) { res.skipped.push('лист «Сотрудники» есть, но столбцов ФИО и роли на нём не нашлось'); return ids; }
  if (cCity) res.skipped.push('столбец «Город базирования» — в карточке сотрудника такого поля нет, значение не перенесено');

  const { rows: have } = await db.query<{ id: string; full_name: string }>('SELECT id, full_name FROM staff');
  const byName = new Map(have.map((s) => [key(s.full_name), s.id]));
  const taken = new Set(have.map((s) => s.id));

  for (const row of sheet.rows) {
    const name = personName(at(row, cName));
    if (blank(name)) continue;
    const roleRaw = text(at(row, cRole));
    const role = ROLES.find(([re]) => re.test(roleRaw))?.[1];
    if (!role) {
      reject(res, { sheet: sheet.title, line: row.line, reason: `роль «${roleRaw}» непонятна — нужно «поверитель», «оператор», «старший оператор» или «руководитель»`, values: rowText(row) });
      continue;
    }
    const phone = blank(at(row, cPhone)) ? null : phoneNorm(at(row, cPhone));
    if (phone === null && !blank(at(row, cPhone))) {
      warn(res, { sheet: sheet.title, line: row.line, reason: `телефон «${text(at(row, cPhone))}» не разобран — сотрудник загружен без телефона`, values: rowText(row) });
    }
    const patternRaw = text(at(row, cPattern)).replace(/\s/g, '');
    const pattern = patternRaw === '5/2' || patternRaw === '2/2' ? patternRaw : null;
    if (!pattern && patternRaw) {
      warn(res, { sheet: sheet.title, line: row.line, reason: `график «${patternRaw}» не из списка — сотрудник загружен без графика`, values: rowText(row) });
    }

    const id = byName.get(key(name)) ?? uniqueSlug(slug(name, 16), taken);
    taken.add(id);
    ids.set(key(name), id);

    // Учётных данных здесь нет ни одного столбца: ни login, ни password_hash,
    // ни otp_hash. Это и есть решение владельца — доступ заводит руководитель.
    const { change } = await upsert(db, {
      table: 'staff',
      conflict: 'id',
      values: { id, full_name: name, role, phone, ext: text(at(row, cExt)) || null, pattern },
      update: ['full_name', 'role', 'phone', 'ext', 'pattern'],
      touch: ['updated_at = now()'],
    });
    count(res, 'staff', change);
  }
  return ids;
}

async function importSkills(
  db: SqlRunner, sheets: Sheet[], res: Result,
  staffIds: Map<string, string>, serviceIds: Map<string, string>,
): Promise<void> {
  const sheet = findSheet(sheets, 'Компетенции (необязательно)', 'Компетенции', 'Допуски');
  if (!sheet || !sheet.rows.length) return;

  const cName = pick(sheet, ['ФИО сотрудника', 'ФИО', 'Сотрудник']);
  const cSvc = pick(sheet, ['Услуга (как в листе «Услуги и прайс»)', 'Услуга', 'Работа']);
  const cOk = pick(sheet, ['Допуск: да / нет', 'Допуск', 'Умеет']);
  if (!cName || !cSvc) { res.skipped.push('лист «Компетенции» есть, но столбцов ФИО и услуги на нём не нашлось'); return; }

  const { rows: have } = await db.query<{ id: string; full_name: string }>('SELECT id, full_name FROM staff');
  for (const s of have) if (!staffIds.has(key(s.full_name))) staffIds.set(key(s.full_name), s.id);
  const { rows: svc } = await db.query<{ id: string; name: string }>('SELECT id, name FROM services');
  for (const s of svc) if (!serviceIds.has(key(s.name))) serviceIds.set(key(s.name), s.id);

  for (const row of sheet.rows) {
    const name = personName(at(row, cName));
    if (blank(name)) continue;
    const staffId = staffIds.get(key(name));
    if (!staffId) {
      reject(res, { sheet: sheet.title, line: row.line, reason: `сотрудника «${name}» нет ни на листе «Сотрудники», ни в системе`, values: rowText(row) });
      continue;
    }
    const serviceName = text(at(row, cSvc));
    const serviceId = serviceIds.get(key(serviceName));
    if (!serviceId) {
      reject(res, { sheet: sheet.title, line: row.line, reason: `услуги «${serviceName}» нет на листе «Услуги и прайс»`, values: rowText(row) });
      continue;
    }
    const allowed = yesNo(at(row, cOk));
    if (allowed === false) {
      const { rowCount } = await del(db, staffId, serviceId);
      count(res, 'staff_skills', rowCount ? 'updated' : 'unchanged');
      continue;
    }
    if (allowed === null && !blank(at(row, cOk))) {
      warn(res, { sheet: sheet.title, line: row.line, reason: `«${text(at(row, cOk))}» — непонятный допуск, строка прочитана как «да»`, values: rowText(row) });
    }
    const { change } = await upsert(db, {
      table: 'staff_skills',
      conflict: 'staff_id, service_id',
      values: { staff_id: staffId, service_id: serviceId },
      update: [],
    });
    count(res, 'staff_skills', change);
  }
}

async function del(db: SqlRunner, staffId: string, serviceId: string): Promise<{ rowCount: number }> {
  const { rows } = await db.query(
    'DELETE FROM staff_skills WHERE staff_id = $1 AND service_id = $2 RETURNING staff_id',
    [staffId, serviceId]);
  return { rowCount: rows.length };
}

/* ───────────────────────────── «Формы» ───────────────────────────── */

/** Лист «Формы» в базу не грузится: нумерация бланков и сами бланки — это
 *  печатные формы акта и свидетельства, пункт fe-forms. Здесь только считаем
 *  заполненные строки, чтобы в сводке было видно: лист прочитан и не потерян. */
function noteForms(sheets: Sheet[], res: Result): void {
  const sheet = findSheet(sheets, 'Формы', 'Бланки');
  if (!sheet) return;
  const filled = sheet.rows.filter((r) => Object.values(r.cells).filter((c) => !blank(c)).length >= 2).length;
  res.skipped.push(`лист «Формы»: строк заполнено ${filled} — бланки и их нумерация живут в печатных формах (пункт fe-forms), не в базе`);
}
