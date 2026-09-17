/* Импорт данных заказчика из командной строки. Пункт плана be-import.
 *
 *   npm run import -- refs «Учёткин — справочники.xlsx» --dry-run
 *   npm run import -- refs «Учёткин — справочники.xlsx» --report отчёт.xlsx
 *   npm run import -- clients база.xlsx --map карта.json --city Асбест --dry-run
 *
 * Два правила, ради которых всё и написано:
 *   • пробный прогон показывает ровно то, что случится в боевом. Достигается не
 *     вторым кодом «как будто», а тем же самым кодом в откатываемой транзакции;
 *   • повторный запуск на том же файле ничего не меняет. Видно по столбцу
 *     «без изменений» в сводке: во второй раз там оказываются все строки.
 */
import { connect } from '../../src/db.ts';
import { importClients } from './clients.mts';
import { loadMap } from './map.mts';
import { importRefs } from './refs.mts';
import { writeReport } from './report.mts';
import { format, type Result } from './result.mts';

const HELP = `Импорт данных заказчика в базу «Учёткина».

  npm run import -- refs <книга.xlsx> [ключи]
      Справочники из книги пункта req-refs: города с днями выезда и нормативом,
      услуги с ценами и сдельными ставками, типы приборов с ГРСИ и межповерочным
      интервалом. Заполненные листы «Сотрудники» и «Компетенции» грузятся как
      справочник людей — без логинов и паролей.

  npm run import -- clients <файл.xlsx> [ключи]
      Клиентская база: телефоны, адреса, прошлые поверки, приборы. Столбцы
      ищутся по карте (--map), телефоны нормализуются, дубли склеиваются.

Ключи:
  --dry-run            ничего не записывать, только показать, что будет
  --report <файл.xlsx> отчёт об отвергнутых строках и замечаниях
  --map <файл.json>    карта столбцов клиентской базы (см. import-map.example.json)
  --sheet <название>   лист книги, если он не первый
  --city <город>       город для строк, где он не указан
  --help               эта справка
`;

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(argv.length ? 0 : 1);
}

/** Ключи со значением следующим словом: всё остальное — либо флаг, либо файл. */
const WITH_VALUE = new Set(['--report', '--map', '--sheet', '--city']);

const command = argv[0]!;
const flags = new Set<string>();
const opts: Record<string, string | null> = {};
const positional: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const arg = argv[i]!;
  if (WITH_VALUE.has(arg)) { opts[arg] = argv[++i] ?? null; continue; }
  if (arg.startsWith('--')) { flags.add(arg); continue; }
  positional.push(arg);
}

const file = positional[0];
const dryRun = flags.has('--dry-run');
const report = opts['--report'] ?? null;
const mapFile = opts['--map'] ?? null;
const sheet = opts['--sheet'] ?? null;
const city = opts['--city'] ?? null;

if (command !== 'refs' && command !== 'clients') {
  console.error(`Неизвестная команда «${command}». Есть две: refs и clients.\n`);
  console.error(HELP);
  process.exit(1);
}
if (!file) {
  console.error(`Не указан файл. Пример: npm run import -- ${command} книга.xlsx --dry-run\n`);
  process.exit(1);
}

const db = await connect();
let failed = false;
try {
  console.log(`Файл: ${file}`);
  console.log(dryRun ? 'Режим: пробный прогон, в конце всё откатывается.\n' : 'Режим: боевой.\n');
  await db.query('BEGIN');
  let res: Result;
  if (command === 'refs') {
    res = await importRefs(db, file);
  } else {
    res = await importClients(db, file, {
      map: loadMap(mapFile), sheet: sheet ?? undefined, city: city ?? undefined,
      source: file.split('/').pop() ?? file,
    });
  }
  // Отчёт пишется до отката: он про строки файла, а не про содержимое базы.
  if (report) {
    await writeReport(report, res, { source: file, dryRun });
    console.log(`Отчёт: ${report}`);
  }
  await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  console.log('\n' + format(res, dryRun) + '\n');
  if (!dryRun && res.rejected.length && !report) {
    console.log('Отвергнутые строки есть, но отчёт не запрошен: добавьте --report отчёт.xlsx,\n' +
      'чтобы было что вернуть заказчику.');
  }
} catch (err) {
  await db.query('ROLLBACK').catch(() => { /* соединение уже могло упасть */ });
  console.error('\nИмпорт не выполнен: ' + (err instanceof Error ? err.message : String(err)));
  failed = true;
} finally {
  await db.end();
}
process.exit(failed ? 1 : 0);
