/* Итог прогона импорта: сколько создано, сколько обновлено, что отвергнуто.
 *
 * Считается одинаково и в боевом прогоне, и в `--dry-run`: пробный прогон
 * отличается только тем, что в конце всё откатывается. Иначе «покажи, что
 * будет» показывало бы не то, что случится на самом деле.
 */

/** Строка, которая в базу не попала, или попала с оговоркой. */
export interface Issue {
  sheet: string;
  line: number;
  reason: string;
  /** Исходная строка целиком — чтобы заказчик нашёл её у себя глазами. */
  values: string;
}

export interface Tally { created: number; updated: number; unchanged: number }
export type Change = keyof Tally;

export interface Result {
  tally: Map<string, Tally>;
  rejected: Issue[];
  warnings: Issue[];
  /** Сколько строк выгрузки склеено с уже разобранными: тот же телефон,
   *  тот же адрес, тот же прибор. */
  merged: number;
  /** Что импорт намеренно не грузил: лист «Формы», столбцы без места в базе. */
  skipped: string[];
}

export const newResult = (): Result =>
  ({ tally: new Map(), rejected: [], warnings: [], merged: 0, skipped: [] });

export function count(res: Result, table: string, change: Change, n = 1): void {
  const t = res.tally.get(table) ?? { created: 0, updated: 0, unchanged: 0 };
  t[change] += n;
  res.tally.set(table, t);
}

export const reject = (res: Result, issue: Issue): void => { res.rejected.push(issue); };
export const warn = (res: Result, issue: Issue): void => { res.warnings.push(issue); };

/** Сводка для вывода в терминал. */
export function format(res: Result, dryRun: boolean): string {
  const lines: string[] = [];
  const head = dryRun ? 'Пробный прогон — в базу ничего не записано.' : 'Загружено в базу.';
  lines.push(head, '');
  const width = Math.max(12, ...[...res.tally.keys()].map((t) => t.length));
  lines.push('  ' + 'таблица'.padEnd(width) + '  создано  обновлено  без изменений');
  for (const [table, t] of res.tally) {
    lines.push('  ' + table.padEnd(width) +
      String(t.created).padStart(9) + String(t.updated).padStart(11) + String(t.unchanged).padStart(15));
  }
  if (!res.tally.size) lines.push('  (ни одной строки)');
  lines.push('');
  if (res.merged) lines.push(`  склеено дублей:   ${res.merged}`);
  lines.push(`  отвергнуто строк: ${res.rejected.length}`);
  lines.push(`  замечаний:        ${res.warnings.length}`);
  for (const note of res.skipped) lines.push(`  не загружалось:   ${note}`);
  const shown = res.rejected.slice(0, 10);
  if (shown.length) {
    lines.push('', '  Отвергнутые строки:');
    for (const r of shown) lines.push(`    ${r.sheet}, строка ${r.line}: ${r.reason}`);
    if (res.rejected.length > shown.length) {
      lines.push(`    … и ещё ${res.rejected.length - shown.length}; все — в отчёте.`);
    }
  }
  return lines.join('\n');
}
