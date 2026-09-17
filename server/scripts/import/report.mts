/* Отчёт о прогоне в .xlsx — для возврата заказчику.
 *
 * Отвергнутая строка — это не наша беда, а его работа: телефон из девяти цифр
 * или пустой межповерочный интервал исправить можем только он. Поэтому отчёт
 * сделан так, чтобы с ним можно было сесть за свою же таблицу: лист, номер
 * строки, причина человеческими словами и сама строка целиком.
 */
import ExcelJS from 'exceljs';
import type { Issue, Result } from './result.mts';

const HEADERS = ['Лист', 'Строка', 'Что не так', 'Строка из вашего файла'];

export async function writeReport(file: string, res: Result, opts: { source: string; dryRun: boolean }): Promise<void> {
  const book = new ExcelJS.Workbook();
  book.creator = 'CRM «Учёткин» — импорт';
  book.created = new Date();

  sheet(book, 'Отвергнутые строки', res.rejected,
    'Эти строки в систему не попали. Исправьте их в своём файле и пришлите его снова — ' +
    'повторный импорт возьмёт только исправленное, задвоения не будет.');
  sheet(book, 'Замечания', res.warnings,
    'Эти строки загружены, но что-то в них пришлось угадывать или отбросить. Проверьте.');

  const info = book.addWorksheet('Сводка');
  info.columns = [{ width: 34 }, { width: 60 }];
  const rows: [string, string][] = [
    ['Файл', opts.source],
    ['Прогон', opts.dryRun ? 'пробный (--dry-run), в базу ничего не записано' : 'боевой, данные загружены'],
    ['Отвергнуто строк', String(res.rejected.length)],
    ['Замечаний', String(res.warnings.length)],
    ['Склеено дублей', String(res.merged)],
    ...[...res.tally].map(([table, t]) =>
      [table, `создано ${t.created}, обновлено ${t.updated}, без изменений ${t.unchanged}`] as [string, string]),
    ...res.skipped.map((s) => ['Не загружалось', s] as [string, string]),
  ];
  for (const [name, value] of rows) {
    const line = info.addRow([name, value]);
    line.getCell(1).font = { bold: true };
    line.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }
  await book.xlsx.writeFile(file);
}

function sheet(book: ExcelJS.Workbook, title: string, issues: Issue[], hint: string): void {
  const ws = book.addWorksheet(title);
  ws.columns = [{ width: 26 }, { width: 9 }, { width: 62 }, { width: 62 }];
  const note = ws.addRow([hint]);
  note.font = { italic: true, color: { argb: 'FF666666' } };
  ws.mergeCells(1, 1, 1, HEADERS.length);
  note.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(1).height = 30;

  const head = ws.addRow(HEADERS);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
  ws.views = [{ state: 'frozen', ySplit: 2 }];

  for (const issue of issues) {
    const row = ws.addRow([issue.sheet, issue.line, issue.reason, issue.values]);
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
  }
  if (!issues.length) ws.addRow(['', '', 'Ни одной такой строки — всё в порядке.', '']);
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + issues.length, column: HEADERS.length } };
}
