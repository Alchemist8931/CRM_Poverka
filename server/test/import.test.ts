/* Импорт справочников и клиентской базы. Пункт плана be-import.
 *
 * Проверяется то, ради чего импорт и писался:
 *   • телефон приводится к десяти цифрам, как бы его ни записали;
 *   • один и тот же клиент тремя строками становится одним клиентом;
 *   • повторный прогон того же файла не меняет в базе ничего;
 *   • импорт не заводит ни одной учётной записи — ни логина, ни пароля;
 *   • отвергнутые строки попадают в отчёт .xlsx с причиной.
 *
 *   npm test
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { normPhone } from '../src/db.ts';
import { importClients } from '../scripts/import/clients.mts';
import { importRefs } from '../scripts/import/refs.mts';
import { writeReport } from '../scripts/import/report.mts';
import type { Result } from '../scripts/import/result.mts';
import {
  addYears, date, devices, parseAddress, phone10, phoneNorm, weekdays,
} from '../scripts/import/normalize.mts';
import { loadMap } from '../scripts/import/map.mts';
import {
  REFS_TEMPLATE, freshDb, writeClientBase, writeClientMap, writeMessyRefs, type TestDb,
} from './import-fixtures.ts';

const work = mkdtempSync(join(tmpdir(), 'uchetkin-import-'));
after(() => rmSync(work, { recursive: true, force: true }));

const one = async <T>(db: TestDb, sql: string, params: unknown[] = []): Promise<T> =>
  (await db.query<T>(sql, params)).rows[0]!;
const num = async (db: TestDb, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await one<{ n: string }>(db, sql, params)).n);

/** Итог прогона: всё ли попало в «без изменений». */
const allUnchanged = (res: Result): boolean =>
  [...res.tally.values()].every((t) => t.created === 0 && t.updated === 0);

describe('телефон приводится к десяти цифрам', () => {
  it('разбирает все написания, какие диктуют на приёме', () => {
    for (const raw of ['8 (912) 345-67-89', '+7 912 345-67-89', '79123456789', '9123456789',
      '8-912-345-67-89', ' 8 912 3456789 ', '+7 (912) 345 67 89 доб. 12']) {
      assert.equal(phone10(raw), '9123456789', `не разобран: ${raw}`);
      assert.equal(phoneNorm(raw), '+79123456789');
    }
  });

  it('совпадает с нормализацией, по которой база ищет клиента', () => {
    for (const raw of ['8 (912) 345-67-89', '+7 912 345-67-89', '9123456789']) {
      assert.equal(phoneNorm(raw), normPhone(raw));
    }
  });

  it('отказывается от того, что телефоном не является', () => {
    for (const raw of ['', '912-345', '123', 'нет телефона', '0000', '+7 (000) 00', '12345678901234']) {
      assert.equal(phone10(raw), null, `принят за телефон: ${raw}`);
    }
  });
});

describe('разбор адреса одной строкой', () => {
  const cities = ['Асбест', 'Екатеринбург', 'Верхняя Пышма'];

  it('город, улица, дом и квартира', () => {
    const a = parseAddress('г. Асбест, ул. Ленина, д. 12, кв. 5', cities);
    assert.deepEqual([a.city, a.street, a.house, a.flat], ['Асбест', 'Ленина', '12', '5']);
  });

  it('квартира через дефис после дома', () => {
    const a = parseAddress('Асбест, Ленина 12-5', cities);
    assert.deepEqual([a.city, a.street, a.house, a.flat], ['Асбест', 'Ленина', '12', '5']);
  });

  it('номер дома — последнее число, а не число в названии улицы', () => {
    const a = parseAddress('Екатеринбург, ул. 8 Марта, 12а кв 77', cities);
    assert.deepEqual([a.city, a.street, a.house, a.flat], ['Екатеринбург', '8 Марта', '12а', '77']);
  });

  it('город из двух слов не путается с другим городом', () => {
    assert.equal(parseAddress('Верхняя Пышма, Успенский 1', cities).city, 'Верхняя Пышма');
  });

  it('подъезд и этаж не притворяются домом', () => {
    const a = parseAddress('Асбест, Победы 3, подъезд 2, этаж 4', cities);
    assert.equal(a.house, '3');
    assert.match(a.rest, /подъезд 2/);
  });

  it('незнакомый город оставляет адрес без города, но с улицей', () => {
    const a = parseAddress('Тагил, Строителей 7', cities);
    assert.equal(a.city, null);
    assert.equal(a.house, '7');
  });
});

describe('прочие разборы', () => {
  it('даты в четырёх написаниях', () => {
    assert.equal(date('15.03.2021'), '2021-03-15');
    assert.equal(date('2021-03-15'), '2021-03-15');
    assert.equal(date(new Date(Date.UTC(2023, 4, 20))), '2023-05-20');
    assert.equal(date(44270), '2021-03-15');
    assert.equal(date('13.13.2020'), null);
    assert.equal(date(''), null);
  });

  it('срок следующей поверки — дата плюс межповерочный интервал', () => {
    assert.equal(addYears('2021-03-15', 6), '2027-03-15');
    assert.equal(addYears('2020-02-29', 4), '2024-02-29');
  });

  it('дни выезда', () => {
    assert.deepEqual(weekdays('пн, ср, пт'), [1, 3, 5]);
    assert.deepEqual(weekdays('вторник и четверг'), [2, 4]);
    assert.deepEqual(weekdays('по договорённости'), []);
  });

  it('приборы и заводские номера из одной ячейки', () => {
    assert.deepEqual(devices('Бетар СХВ-15 №12345678; Бетар СГВ-15 №12345679'), [
      { type: 'Бетар СХВ-15', serial: '12345678' },
      { type: 'Бетар СГВ-15', serial: '12345679' },
    ]);
    assert.deepEqual(devices('Пульсар М-15'), [{ type: 'Пульсар М-15', serial: '' }]);
    assert.deepEqual(devices(''), []);
  });
});

describe('справочники из книги заказчика', () => {
  it('шаблон с примерами заполняет базу, повторный прогон её не меняет', async () => {
    const db = await freshDb();
    try {
      const first = await importRefs(db, REFS_TEMPLATE);
      assert.equal(first.tally.get('cities')?.created, 1);
      assert.equal(first.tally.get('services')?.created, 1);
      assert.equal(first.tally.get('device_types')?.created, 1);
      assert.equal(first.tally.get('staff')?.created, 1);

      const city = await one<{ short: string; weekdays: number[]; norm_per_verifier: number }>(
        db, `SELECT short, weekdays, norm_per_verifier FROM cities WHERE name = 'Екатеринбург'`);
      assert.deepEqual(city.weekdays, [1, 3, 5]);
      assert.equal(city.norm_per_verifier, 25);
      assert.equal(city.short, 'ЕКА');

      // Услуга прототипа обязана получить своё же обозначение: на него ссылаются
      // и правила, и строки актов.
      const svc = await one<{ id: string; price_person: number; is_verification: boolean; replacement_service: string | null }>(
        db, `SELECT id, price_person, is_verification, replacement_service FROM services WHERE name = 'Поверка счётчика воды'`);
      assert.equal(svc.id, 'wv');
      assert.equal(svc.price_person, 900);
      assert.equal(svc.is_verification, true);
      assert.equal(svc.replacement_service, null); // «Замены» в шаблоне нет — ссылаться не на что

      const type = await one<{ grsi: string; interval_years: number; carrier_kind: string }>(
        db, `SELECT grsi, interval_years, carrier_kind FROM device_types WHERE name = 'Бетар СХВ-15'`);
      assert.deepEqual([type.grsi, type.interval_years, type.carrier_kind], ['32245-11', 6, 'Вода']);

      const again = await importRefs(db, REFS_TEMPLATE);
      assert.ok(allUnchanged(again), 'повторный прогон что-то изменил: ' + JSON.stringify([...again.tally]));
      assert.equal(await num(db, 'SELECT count(*) AS n FROM cities'), 1);
      assert.equal(await num(db, 'SELECT count(*) AS n FROM services'), 1);
    } finally {
      await db.close();
    }
  });

  it('кривые строки отвергаются с причиной, остальные грузятся', async () => {
    const db = await freshDb();
    const file = join(work, 'refs-messy.xlsx');
    try {
      await writeMessyRefs(file);
      const res = await importRefs(db, file);

      assert.equal(await num(db, 'SELECT count(*) AS n FROM cities'), 3);       // повтор — мимо
      assert.equal(await num(db, 'SELECT count(*) AS n FROM services'), 2);     // «договорная» цена — мимо
      assert.equal(await num(db, 'SELECT count(*) AS n FROM device_types'), 3); // без интервала — мимо
      assert.equal(await num(db, 'SELECT count(*) AS n FROM staff'), 2);        // «главный по всему» — мимо

      const reasons = res.rejected.map((r) => `${r.sheet}: ${r.reason}`).join('\n');
      assert.match(reasons, /Города: город «Екатеринбург» уже есть выше/);
      assert.match(reasons, /нужна цена числом/);
      assert.match(reasons, /межповерочный интервал должен быть числом лет/);
      assert.match(reasons, /роль «главный по всему» непонятна/);
      assert.match(reasons, /сотрудника «Седов П.» нет/);

      // Норматив словами строку не губит: город загружен, а заказчику — замечание.
      assert.match(res.warnings.map((w) => w.reason).join('\n'), /норматив «по договорённости» не похож на число/);
      assert.equal((await one<{ norm_per_verifier: number | null }>(
        db, `SELECT norm_per_verifier FROM cities WHERE name = 'Нижний Тагил'`)).norm_per_verifier, null);

      // Связка «прибор непригоден → чем меняем» проставляется, когда обе услуги в книге.
      assert.equal((await one<{ replacement_service: string }>(
        db, `SELECT replacement_service FROM services WHERE id = 'wv'`)).replacement_service, 'wr');
      // Допуск «нет» компетенцию не заводит.
      assert.deepEqual((await db.query<{ service_id: string }>(
        'SELECT service_id FROM staff_skills ORDER BY service_id')).rows, [{ service_id: 'wv' }]);
    } finally {
      await db.close();
    }
  });

  it('не заводит ни одной учётной записи: ни логина, ни пароля, ни кода на вход', async () => {
    const db = await freshDb();
    const file = join(work, 'refs-staff.xlsx');
    try {
      await writeMessyRefs(file);
      await importRefs(db, file);
      assert.equal(await num(db, 'SELECT count(*) AS n FROM staff'), 2);
      assert.equal(await num(db,
        `SELECT count(*) AS n FROM staff
          WHERE login IS NOT NULL OR password_hash IS NOT NULL
             OR otp_hash IS NOT NULL OR mfa_secret IS NOT NULL`), 0);
      // Карточка при этом заполнена: человек в справочнике есть, доступа у него нет.
      const man = await one<{ role: string; phone: string; pattern: string }>(
        db, `SELECT role, phone, pattern FROM staff WHERE full_name = 'Алимпиев И.'`);
      assert.deepEqual([man.role, man.phone, man.pattern], ['verifier', '+79000000000', '5/2']);
    } finally {
      await db.close();
    }
  });
});

describe('клиентская база', () => {
  const load = async (): Promise<{ db: TestDb; res: Result; file: string; map: ReturnType<typeof loadMap> }> => {
    const db = await freshDb();
    const refs = join(work, 'refs-for-clients.xlsx');
    await writeMessyRefs(refs);
    await importRefs(db, refs);
    const file = join(work, 'clients.xlsx');
    const mapFile = join(work, 'client-map.json');
    await writeClientBase(file);
    await writeClientMap(mapFile);
    // Столбец «Марка ПУ» встроенными названиями не опознаётся — на то и карта.
    const map = loadMap(mapFile);
    const res = await importClients(db, file, { map, source: 'clients.xlsx' });
    return { db, res, file, map };
  };

  it('склеивает дубли по телефону и раскладывает адреса с приборами', async () => {
    const { db, res } = await load();
    try {
      // Иванов записан тремя строками с разным написанием номера — клиент один.
      assert.equal(await num(db, 'SELECT count(*) AS n FROM clients'), 4);
      const ivanov = await one<{ id: string; name: string; phone_norm: string; client_type: string; city: string }>(
        db, `SELECT id, name, phone_norm, client_type, city FROM clients WHERE phone_norm = '+79123456789'`);
      assert.equal(ivanov.name, 'Иванов Иван Иванович');
      assert.equal(ivanov.client_type, 'Физлицо');
      assert.equal(ivanov.city, 'Асбест');
      assert.ok(res.merged >= 1, 'ни одна строка не склеена');

      // Два адреса, три прибора: повтор строки 3 по тому же адресу и прибору склеен.
      const rows = await db.query<{ street: string; house: string; flat: string; device_type: string; due_on: string }>(
        `SELECT street, house, flat, device_type, due_on::text FROM client_history
          WHERE client_id = $1 ORDER BY street, device_type`, [ivanov.id]);
      assert.equal(rows.rows.length, 3);
      assert.deepEqual(rows.rows.map((r) => r.device_type),
        ['Бетар СГВ-15', 'Бетар СХВ-15', 'Пульсар М-15']);
      assert.deepEqual(rows.rows[1], { street: 'Ленина', house: '12', flat: '5', device_type: 'Бетар СХВ-15', due_on: '2027-03-15' });
      // У горячей воды интервал четыре года, у холодной шесть — сроки разные.
      assert.equal(rows.rows[0]!.due_on, '2025-03-15');
      // «Пульсар М-15» в справочник не попал (в книге не было интервала) —
      // срок следующей поверки не выдуман, а оставлен пустым.
      assert.equal(rows.rows[2]!.due_on, null);

      // Юрлицо узнаётся по названию и ИНН.
      const org = await one<{ client_type: string; inn: string }>(
        db, `SELECT client_type, inn FROM clients WHERE phone_norm = '+73433004050'`);
      assert.deepEqual([org.client_type, org.inn], ['Юрлицо', '6658012345']);
    } finally {
      await db.close();
    }
  });

  it('строку без разборного телефона отвергает с причиной', async () => {
    const { db, res } = await load();
    try {
      assert.equal(res.rejected.length, 2);
      const reasons = res.rejected.map((r) => r.reason).join('\n');
      assert.match(reasons, /телефон «912-345» не разобран/);
      assert.match(reasons, /нет телефона/);
      // Замечания: незнакомый город, битая дата, прибор не из справочника.
      const notes = res.warnings.map((w) => w.reason).join('\n');
      assert.match(notes, /город не опознан/);
      assert.match(notes, /дата последней поверки «13.13.2020» не разобрана/);
      assert.match(notes, /«Норма СВК-15» нет в справочнике/);
      assert.match(notes, /«Пульсар М-15» нет в справочнике/);
    } finally {
      await db.close();
    }
  });

  it('повторный прогон того же файла ничего не меняет', async () => {
    const { db, file, map } = await load();
    try {
      const before = await one<{ clients: string; history: string; stamp: string }>(db,
        `SELECT (SELECT count(*) FROM clients) AS clients,
                (SELECT count(*) FROM client_history) AS history,
                (SELECT max(updated_at)::text FROM client_history) AS stamp`);
      const again = await importClients(db, file, { map, source: 'clients.xlsx' });
      assert.ok(allUnchanged(again), 'повторный прогон что-то изменил: ' + JSON.stringify([...again.tally]));
      const after_ = await one<{ clients: string; history: string; stamp: string }>(db,
        `SELECT (SELECT count(*) FROM clients) AS clients,
                (SELECT count(*) FROM client_history) AS history,
                (SELECT max(updated_at)::text FROM client_history) AS stamp`);
      assert.deepEqual(after_, before);
    } finally {
      await db.close();
    }
  });

  it('карточку, поправленную руками, импорт не перезаписывает', async () => {
    const { db, file, map } = await load();
    try {
      await db.query(
        `UPDATE clients SET name = 'Иванов И. И. (сосед)' WHERE phone_norm = '+79123456789'`);
      await importClients(db, file, { map, source: 'clients.xlsx' });
      assert.equal((await one<{ name: string }>(
        db, `SELECT name FROM clients WHERE phone_norm = '+79123456789'`)).name, 'Иванов И. И. (сосед)');
    } finally {
      await db.close();
    }
  });
});

describe('отчёт для заказчика', () => {
  it('отвергнутые строки и замечания ложатся в .xlsx', async () => {
    const { db, res } = await (async () => {
      const db = await freshDb();
      const refs = join(work, 'refs-report.xlsx');
      await writeMessyRefs(refs);
      const res = await importRefs(db, refs);
      return { db, res };
    })();
    const file = join(work, 'otchet.xlsx');
    try {
      await writeReport(file, res, { source: 'refs-report.xlsx', dryRun: true });
      assert.ok(existsSync(file), 'файл отчёта не создан');

      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(file);
      assert.deepEqual(book.worksheets.map((w) => w.name),
        ['Отвергнутые строки', 'Замечания', 'Сводка']);

      const ws = book.getWorksheet('Отвергнутые строки')!;
      // Строка 1 — пояснение, строка 2 — заголовки, дальше сами отказы.
      assert.equal(ws.rowCount, 2 + res.rejected.length);
      assert.deepEqual((ws.getRow(2).values as string[]).slice(1),
        ['Лист', 'Строка', 'Что не так', 'Строка из вашего файла']);
      const first = ws.getRow(3).values as string[];
      assert.equal(first[1], 'Города');
      assert.equal(typeof first[2], 'number');
      assert.match(String(first[3]), /уже есть выше/);
    } finally {
      await db.close();
    }
  });
});
