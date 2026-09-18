/* Проверка выгрузки заявок за период (`npm run export:period`, пункт launch).
 *
 * Выгрузка — страховка отката пилота, и убедиться, что она собирается, нужно
 * до пилота, а не в тот день, когда решат откатываться. На временной базе
 * заводятся три заявки: две в периоде (с приборами и оплатой), одна вне его.
 * Проверяется: команда отвечает кодом 0, файл создан, на листах ровно те
 * строки, что попали в период, суммы в сводке сходятся, а без ключей или с
 * перепутанными датами команда отказывает кодом 1.
 *
 *   npx tsx scripts/check-export-period.mts
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { Client } from 'pg';
import { freePort } from './free-port.mts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const PORT = await freePort();
const work = mkdtempSync(join(tmpdir(), 'uchetkin-check-export-'));

function startDatabase(): Promise<{ url: string; stop: () => void }> {
  const child = spawn('npx', ['tsx', 'scripts/pglite-server.mts', String(PORT)],
    { cwd: serverDir, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('база не поднялась за 90 секунд')), 90_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const url = out.match(/postgres:\/\/\S+/)?.[0];
      if (!url) return;
      clearTimeout(timer);
      resolve({ url, stop: () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* уже умерла */ } } });
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`база завершилась с кодом ${code}`)); });
  });
}

const { url, stop } = await startDatabase();
const env = { ...process.env, DATABASE_URL: url };
let failed = 0;
const say = (ok: boolean, text: string): void => {
  if (ok) console.log(`  ${text}`);
  else { console.error(`  НЕ СОШЛОСЬ: ${text}`); failed++; }
};

function run(title: string, args: string[], expected: number): string {
  const res = spawnSync('npm', ['run', 'export:period', '--', ...args],
    { cwd: serverDir, env, encoding: 'utf8', timeout: 120_000 });
  const got = res.status ?? -1;
  const out = (res.stdout || '') + (res.stderr || '');
  if (got === expected) console.log(`  ${title}: код ${got}, как и ожидалось`);
  else { console.error(`  ${title}: код ${got}, ожидался ${expected}\n${out}`); failed++; }
  return out;
}

/* Одно соединение на всё наполнение: встроенная база выставлена одним сокетом,
   и держать его открытым, пока идёт выгрузка отдельным процессом, нельзя. */
async function fill(): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(`INSERT INTO cities (name, short) VALUES ('Асбест', 'АСБ')`);
    await db.query(`INSERT INTO services (id, grp, name, short, price_person, price_pensioner, price_org, rate_verifier, rate_operator, is_verification)
                    VALUES ('wv', 'Вода', 'Поверка счётчика воды', 'Поверка', 900, 800, 1200, 300, 50, true)`);
    await db.query(`INSERT INTO staff (id, full_name, role) VALUES ('v1', 'Поверитель Тестовый', 'verifier'), ('o1', 'Оператор Тестовая', 'operator')`);
    const req = (id: string, date: string, status: string) => db.query(
      `INSERT INTO requests (id, date, created_date, city, client_type, name, phone, phone_norm, street, house, flat, time_slot, svcs, status, operator_id, verifier_id)
       VALUES ($1, $2, '2026-09-18', 'Асбест', 'Физлицо', 'Иванова А. А.', '8 900 000-00-01', '+79000000001', 'Ленина', '5', '12', 11, '{Поверка}', $3, 'o1', 'v1')`,
      [id, date, status]);
    await req('T-1', '2026-09-22', 'выполнена');
    await req('T-2', '2026-09-24', 'перенос');
    await req('T-3', '2026-10-05', 'создана');   // вне периода
    await db.query(`INSERT INTO devices (request_id, position, service_id, device_type, carrier, serial, price_charged, rate_verifier, rate_operator)
                    VALUES ('T-1', 1, 'wv', 'СВК-15', 'ХВС', '1001', 900, 300, 50), ('T-1', 2, 'wv', 'СВК-15', 'ГВС', '1002', 900, 300, 50),
                           ('T-3', 1, 'wv', 'СВК-15', 'ХВС', '1003', 900, 300, 50)`);
    await db.query(`INSERT INTO payments (request_id, method, amount, charged, paid_at, by_staff)
                    VALUES ('T-1', 'наличные', 1800, 1800, '2026-09-22 14:30:00+05', 'v1'),
                           ('T-3', 'наличные', 900, 900, '2026-10-05 10:00:00+05', 'v1')`);
  } finally {
    await db.end();
  }
}

try {
  const migrate = spawnSync('npx', ['node-pg-migrate', 'up'], { cwd: serverDir, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (migrate.status !== 0) throw new Error(`миграции не применились, код ${migrate.status}`);
  console.log('Миграции применены.');
  await fill();
  console.log('Заведены три заявки: две в периоде, одна вне.\n');

  const file = join(work, 'период.xlsx');
  run('выгрузка за период', ['--from', '2026-09-21', '--to', '2026-09-27', '--out', file], 0);
  say(existsSync(file), 'файл выгрузки создан');

  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  const rows = (name: string): unknown[][] => {
    const ws = book.getWorksheet(name);
    if (!ws) throw new Error(`нет листа «${name}»`);
    const out: unknown[][] = [];
    ws.eachRow((row, n) => { if (n > 1) out.push((row.values as unknown[]).slice(1)); });
    return out;
  };
  const reqs = rows('Заявки'), devs = rows('Приборы'), pays = rows('Оплаты');
  say(reqs.length === 2 && reqs.map((r) => r[0]).join(',') === 'T-1,T-2', `на листе «Заявки» две заявки периода: ${reqs.map((r) => r[0]).join(', ')}`);
  say(devs.length === 2 && devs.every((d) => d[0] === 'T-1'), 'на листе «Приборы» два прибора заявки T-1, чужих нет');
  say(pays.length === 1 && pays[0]![0] === 'T-1' && pays[0]![5] === 1800, 'на листе «Оплаты» одна оплата на 1800 ₽');
  const t1 = reqs[0]!;
  say(t1[12] === 'Ленина, 5, кв. 12' && t1[13] === '10:00–12:00', `адрес и окно собраны: «${t1[12]}», ${t1[13]}`);
  say(t1[22] === 2 && t1[23] === 1800 && t1[24] === 'наличные' && t1[25] === 1800, 'у заявки T-1 в строке: 2 прибора, 1800 по прайсу, наличные 1800');
  const summary = new Map<string, unknown>();
  book.getWorksheet('Сводка')!.eachRow((row) => summary.set(String((row.values as unknown[])[1]), (row.values as unknown[])[2]));
  say(summary.get('Заявок') === 2 && summary.get('По прайсу, ₽') === 1800 && summary.get('  наличными') === 1800,
    'сводка: заявок 2, по прайсу 1800, наличными 1800');

  console.log('\nОтказы:');
  run('без ключей', [], 1);
  run('даты перепутаны', ['--from', '2026-09-27', '--to', '2026-09-21'], 1);
  run('дата не в том виде', ['--from', '21.09.2026', '--to', '2026-09-27'], 1);
} catch (err) {
  console.error('\nПроверка сорвалась: ' + (err instanceof Error ? err.message : String(err)));
  failed++;
} finally {
  stop();
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nПроверка выгрузки не пройдена: расхождений ${failed}.`);
  process.exit(1);
}
console.log('\nВыгрузка за период работает.');
