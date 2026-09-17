/* Клиентская база заказчика: телефоны, адреса, прошлые поверки, приборы.
 *
 * Здесь всё держится на телефоне. Он и ключ клиента в базе, и единственное, чем
 * в старой таблице отличается один человек от другого: ФИО пишут как придётся,
 * адрес — одной строкой, а один и тот же клиент попадает в выгрузку столько раз,
 * сколько раз к нему выезжали. Поэтому порядок такой:
 *   1. строку без разборного телефона отвергаем — привязать её не к чему;
 *   2. остальные склеиваем по нормализованному номеру в одного клиента;
 *   3. адреса и приборы из всех его строк кладём в `client_history`.
 *
 * Карточку клиента, которая уже есть в системе, импорт не переписывает: он
 * заполняет только пустые поля. Оператор, поправивший ФИО руками, важнее
 * выгрузки десятилетней давности.
 */
import { upsert, type SqlRunner } from './db.mts';
import {
  addYears, addressKey, blank, date, devices as parseDevices, digits, key, parseAddress,
  personName, phoneNorm, text, type Address, type Cell, type DeviceRef,
} from './normalize.mts';
import { DEFAULT_MAP, type ColumnMap } from './map.mts';
import { count, newResult, reject, warn, type Result } from './result.mts';
import { at, findSheet, pick, readBook, type Row, type Sheet } from './workbook.mts';

export interface ClientsOptions {
  map?: ColumnMap;
  /** Лист книги: из ключа командной строки или из конфига. */
  sheet?: string;
  /** Город по умолчанию для строк, где его не написали. */
  city?: string;
  /** Имя файла, попадающее в `client_history.source`. */
  source?: string;
}

/** Строка выгрузки после разбора. */
interface Parsed {
  line: number;
  phone: string;
  /** Номер так, как он записан у заказчика: он же ляжет в `clients.phone_raw`. */
  phoneRaw: string;
  name: string;
  inn: string;
  email: string;
  note: string;
  address: Address;
  addressRaw: string;
  verifiedOn: string | null;
  devices: DeviceRef[];
}

export async function importClients(db: SqlRunner, file: string, opts: ClientsOptions = {}): Promise<Result> {
  const res = newResult();
  const map = opts.map ?? DEFAULT_MAP;
  const sheets = await readBook(file);
  const col = (field: string, sheet: Sheet): string | null => pick(sheet, map.columns[field] ?? []);

  const sheetName = opts.sheet ?? map.sheet;
  const sheet = sheetName ? findSheet(sheets, sheetName) : sheets.find((s) => col('phone', s)) ?? sheets[0];
  if (!sheet) throw new Error(`в файле ${file} нет ни одного листа`);
  const cPhone = col('phone', sheet);
  if (!cPhone) {
    throw new Error(
      `на листе «${sheet.title}» не нашёлся столбец с телефоном. Найдены столбцы: ` +
      `${sheet.headers.join(', ')}. Допишите название столбца в карту (--map) — поле «phone».`);
  }

  const cols = Object.fromEntries(
    ['name', 'phone2', 'city', 'address', 'street', 'house', 'flat', 'verified_on', 'devices', 'serial', 'email', 'inn', 'note']
      .map((f) => [f, col(f, sheet)]));

  const { rows: cityRows } = await db.query<{ name: string }>('SELECT name FROM cities');
  const cities = cityRows.map((c) => c.name);
  const byCityKey = new Map(cities.map((c) => [key(c), c]));
  const { rows: typeRows } = await db.query<{ name: string; interval_years: number }>(
    'SELECT name, interval_years FROM device_types');

  const defaultCity = opts.city ?? map.city ?? null;
  if (defaultCity && !byCityKey.has(key(defaultCity))) {
    throw new Error(`города «${defaultCity}» нет в справочнике городов. Сначала загрузите справочники: npm run import -- refs <книга.xlsx>`);
  }

  /* ── разбор строк ── */
  const groups = new Map<string, Parsed[]>();
  for (const row of sheet.rows) {
    const phone = phoneNorm(at(row, cPhone));
    if (!phone) {
      const raw = text(at(row, cPhone));
      reject(res, {
        sheet: sheet.title, line: row.line, values: rowText(row),
        reason: raw ? `телефон «${raw}» не разобран: нужно десять цифр номера` : 'нет телефона — строку не к кому привязать',
      });
      continue;
    }
    const parsed = parseRow(row, cols, cities, defaultCity, phone, text(at(row, cPhone)));
    if (parsed.address.city === null && parsed.addressRaw) {
      warn(res, {
        sheet: sheet.title, line: row.line, values: rowText(row),
        reason: `город не опознан по адресу «${parsed.addressRaw}» — строка загружена без города`,
      });
    }
    if (parsed.addressRaw && (!parsed.address.street || !parsed.address.house)) {
      warn(res, {
        sheet: sheet.title, line: row.line, values: rowText(row),
        reason: `адрес «${parsed.addressRaw}» разобран не полностью — проверьте улицу и дом`,
      });
    }
    const rawDate = at(row, cols['verified_on'] ?? null);
    if (parsed.verifiedOn === null && !blank(rawDate)) {
      warn(res, {
        sheet: sheet.title, line: row.line, values: rowText(row),
        reason: `дата последней поверки «${text(rawDate)}» не разобрана — строка загружена без даты`,
      });
    }
    const phone2 = at(row, cols['phone2'] ?? null);
    if (!blank(phone2) && phoneNorm(phone2) === null) {
      warn(res, {
        sheet: sheet.title, line: row.line, values: rowText(row),
        reason: `второй телефон «${text(phone2)}» не разобран — в карточку не попал`,
      });
    }
    const list = groups.get(phone) ?? [];
    list.push(parsed);
    groups.set(phone, list);
  }

  /* ── склейка дублей и запись ── */
  const source = opts.source ?? file.split('/').pop() ?? '';
  const seenKeys = new Set<string>();

  for (const [phone, rows] of groups) {
    const first = rows[0]!;
    const names = [...new Set(rows.map((r) => r.name).filter(Boolean))];
    if (names.length > 1) {
      warn(res, {
        sheet: sheet.title, line: first.line, values: names.join(' / '),
        reason: `на номере ${phone} разные ФИО (${names.join(' / ')}) — склеены в одного клиента, оставлено «${names[0]}»`,
      });
    }
    if (rows.length > 1) res.merged += rows.length - 1;

    const name = names[0] ?? '';
    const inn = rows.map((r) => r.inn).find(Boolean) ?? '';
    const email = rows.map((r) => r.email).find(Boolean) ?? '';
    const city = rows.map((r) => r.address.city).find(Boolean) ?? null;
    const client = await upsertClient(db, { phone, name, inn, email, city, raw: first.phoneRaw });
    count(res, 'clients', client.change);

    for (const parsed of rows) {
      const refs: DeviceRef[] = parsed.devices.length ? parsed.devices : [{ type: '', serial: '' }];
      for (const dev of refs) {
        const importKey = [phone, addressKey(parsed.address), key(dev.type), key(dev.serial)].join('#');
        if (seenKeys.has(importKey)) { res.merged++; continue; }
        seenKeys.add(importKey);
        const years = intervalFor(dev.type, typeRows);
        if (dev.type && years === null) {
          warn(res, {
            sheet: sheet.title, line: parsed.line, values: dev.type,
            reason: `прибора «${dev.type}» нет в справочнике приборов — срок следующей поверки не посчитан`,
          });
        }
        const { change } = await upsert(db, {
          table: 'client_history',
          conflict: 'import_key',
          values: {
            client_id: client.id,
            city: parsed.address.city,
            street: parsed.address.street,
            house: parsed.address.house,
            flat: parsed.address.flat,
            address_raw: parsed.addressRaw,
            device_type: dev.type,
            serial: dev.serial,
            verified_on: parsed.verifiedOn,
            due_on: parsed.verifiedOn && years ? addYears(parsed.verifiedOn, years) : null,
            note: [parsed.note, parsed.address.rest].filter(Boolean).join('; '),
            import_key: importKey,
            source,
          },
          update: ['client_id', 'city', 'street', 'house', 'flat', 'address_raw',
            'device_type', 'serial', 'verified_on', 'due_on', 'note', 'source'],
          touch: ['updated_at = now()'],
        });
        count(res, 'client_history', change);
      }
    }
  }
  return res;
}

/* ───────────────────────────── разбор одной строки ───────────────────────────── */

function parseRow(
  row: Row, cols: Record<string, string | null>, cities: string[],
  defaultCity: string | null, phone: string, phoneRaw: string,
): Parsed {
  const rawAddress = text(at(row, cols['address'] ?? null));
  const street = text(at(row, cols['street'] ?? null));
  const house = text(at(row, cols['house'] ?? null));
  const flat = text(at(row, cols['flat'] ?? null));
  const cityCell = text(at(row, cols['city'] ?? null));

  // Адрес бывает одной строкой, бывает разложенным по столбцам, бывает и так,
  // и так. Разбираем всё, что есть, и предпочитаем то, что заказчик разложил
  // сам: его столбец «Квартира» надёжнее нашего разбора строки.
  const parsed = parseAddress(rawAddress, cities);
  const address: Address = {
    city: matchCity(cityCell, cities) ?? parsed.city ?? matchCity(defaultCity ?? '', cities),
    street: street || parsed.street,
    house: house || parsed.house,
    flat: flat || parsed.flat,
    rest: parsed.rest,
  };
  const full = rawAddress || [cityCell, street && `ул. ${street}`, house && `д. ${house}`, flat && `кв. ${flat}`]
    .filter(Boolean).join(', ');

  const list = parseDevices(at(row, cols['devices'] ?? null));
  const serial = text(at(row, cols['serial'] ?? null));
  if (serial) {
    // Отдельный столбец с заводским номером относится к первому прибору строки.
    if (list.length) list[0]!.serial ||= serial;
    else list.push({ type: '', serial });
  }

  const innDigits = digits(at(row, cols['inn'] ?? null));
  return {
    line: row.line,
    phone,
    phoneRaw,
    name: personName(at(row, cols['name'] ?? null)),
    inn: innDigits.length === 10 || innDigits.length === 12 ? innDigits : '',
    email: text(at(row, cols['email'] ?? null)),
    note: text(at(row, cols['note'] ?? null)),
    address,
    addressRaw: full,
    verifiedOn: date(at(row, cols['verified_on'] ?? null)),
    devices: list,
  };
}

const matchCity = (value: Cell, cities: string[]): string | null => {
  const k = key(String(text(value)).replace(/^г\.?\s*/i, ''));
  return cities.find((c) => key(c) === k) ?? null;
};

/** Межповерочный интервал прибора: сначала точное совпадение названия,
 *  потом вхождение — в старых таблицах пишут «Бетар СХВ-15 (кухня)». */
function intervalFor(type: string, types: { name: string; interval_years: number }[]): number | null {
  if (!type) return null;
  const k = key(type);
  const exact = types.find((t) => key(t.name) === k);
  if (exact) return exact.interval_years;
  const loose = types.find((t) => k.includes(key(t.name)) || key(t.name).includes(k));
  return loose?.interval_years ?? null;
}

/** Карточка клиента. Существующую не перезаписываем: дополняем пустые поля. */
async function upsertClient(
  db: SqlRunner,
  c: { phone: string; name: string; inn: string; email: string; city: string | null; raw: string },
): Promise<{ id: string; change: 'created' | 'updated' | 'unchanged' }> {
  // Юрлицо узнаётся по форме собственности в названии или по десятизначному ИНН:
  // у организаций он в десять цифр, у человека и ИП — в двенадцать.
  const orgLike = /(^|\s|«)(ооо|оао|зао|ао|пао|тсж|тсн|ук|мбоу|гбуз|фгуп|нко)(\s|$|«|")/i.test(c.name)
    || c.inn.length === 10;
  const { rows } = await db.query<{ id: string; created: boolean }>(
    `INSERT INTO clients (phone_norm, phone_raw, client_type, name, inn, email, city)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (phone_norm) DO UPDATE SET
       name  = CASE WHEN clients.name  = '' THEN EXCLUDED.name  ELSE clients.name  END,
       inn   = CASE WHEN clients.inn   = '' THEN EXCLUDED.inn   ELSE clients.inn   END,
       email = CASE WHEN clients.email = '' THEN EXCLUDED.email ELSE clients.email END,
       city  = COALESCE(clients.city, EXCLUDED.city),
       updated_at = now()
     WHERE (clients.name  = '' AND EXCLUDED.name  <> '')
        OR (clients.inn   = '' AND EXCLUDED.inn   <> '')
        OR (clients.email = '' AND EXCLUDED.email <> '')
        OR (clients.city IS NULL AND EXCLUDED.city IS NOT NULL)
     RETURNING id, (xmax = 0) AS created`,
    [c.phone, c.raw || c.phone, orgLike ? 'Юрлицо' : 'Физлицо', c.name, c.inn, c.email, c.city]);

  if (rows[0]) return { id: rows[0].id, change: rows[0].created ? 'created' : 'updated' };
  const { rows: had } = await db.query<{ id: string }>(
    'SELECT id FROM clients WHERE phone_norm = $1', [c.phone]);
  return { id: had[0]!.id, change: 'unchanged' };
}

const rowText = (row: Row): string =>
  Object.values(row.cells).map((c) => text(c)).filter(Boolean).join(' | ');
