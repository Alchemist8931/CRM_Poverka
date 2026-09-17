/* Чтение книги .xlsx: листы, заголовки столбцов, строки.
 *
 * Дальше по коду ни одна ячейка не берётся по буквенному адресу — только по
 * названию столбца. Заказчик переставит столбцы местами или переименует лист,
 * и импорт от этого не должен разваливаться: соответствие названий полям
 * лежит в карте столбцов (map.mts), а здесь — только механика чтения.
 */
import ExcelJS from 'exceljs';
import { blank, key, text, type Cell } from './normalize.mts';

/** Строка листа: номер, как его видит заказчик в Excel, и ячейки по заголовкам. */
export interface Row {
  /** Номер строки в файле — он же попадёт в отчёт об отвергнутых. */
  line: number;
  cells: Record<string, Cell>;
}

export interface Sheet {
  title: string;
  /** Заголовки в том виде, в каком их написал заказчик. */
  headers: string[];
  rows: Row[];
}

/** Открыть книгу и разобрать каждый лист на заголовки и строки. */
export async function readBook(file: string): Promise<Sheet[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  return book.worksheets.map(readSheet);
}

function readSheet(ws: ExcelJS.Worksheet): Sheet {
  const raw: Cell[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, line) => {
    const values = row.values as Cell[];
    // exceljs нумерует ячейки с единицы и кладёт в нулевую позицию пустоту.
    raw[line] = Array.from({ length: ws.columnCount + 1 }, (_, i) => values?.[i + 1]);
  });

  // Шапка — первая строка, где заполнено хотя бы два столбца. Выше неё в книгах
  // заказчиков обычно живёт название таблицы и пояснения, и они не заголовки.
  let headerLine = raw.findIndex((cells) => cells && cells.filter((c) => !blank(c)).length >= 2);
  if (headerLine < 0) return { title: ws.name, headers: [], rows: [] };

  const headers = (raw[headerLine] ?? []).map((c) => text(c));
  const rows: Row[] = [];
  for (let line = headerLine + 1; line < raw.length; line++) {
    const cells = raw[line];
    if (!cells || cells.every((c) => blank(c))) continue;
    const byHeader: Record<string, Cell> = {};
    headers.forEach((h, i) => { if (h) byHeader[key(h)] = cells[i]; });
    rows.push({ line, cells: byHeader });
  }
  return { title: ws.name, headers: headers.filter(Boolean), rows };
}

/** Лист по названию: точное совпадение, затем по началу названия.
 *
 *  Второе — не вольность: в шаблоне листы названы «Сотрудники (необязательно)»
 *  и «Компетенции (необязательно)», а заказчик, заполняя, скобки сотрёт. */
export function findSheet(sheets: Sheet[], ...names: string[]): Sheet | null {
  for (const name of names) {
    const exact = sheets.find((s) => key(s.title) === key(name));
    if (exact) return exact;
  }
  for (const name of names) {
    const loose = sheets.find((s) => key(s.title).startsWith(key(name)) || key(name).startsWith(key(s.title)));
    if (loose) return loose;
  }
  return null;
}

/** Заголовок столбца под одно из названий-синонимов.
 *
 *  Сначала полное совпадение, потом вхождение: «Дата последней поверки» должна
 *  найтись и тогда, когда столбец назван «Дата поверки (последняя)». */
export function pick(sheet: Sheet, synonyms: string[]): string | null {
  const have = sheet.headers.map(key);
  for (const want of synonyms) {
    const hit = have.find((h) => h === key(want));
    if (hit) return hit;
  }
  for (const want of synonyms) {
    const hit = have.find((h) => h.includes(key(want)) || key(want).includes(h));
    if (hit) return hit;
  }
  return null;
}

/** Значение строки по найденному заголовку. Столбца нет — пусто, не ошибка. */
export const at = (row: Row, header: string | null): Cell => (header ? row.cells[header] : undefined);
