/* Чистка журнала действий по сроку хранения (пункт be-audit).
 *
 *   npm run audit:prune            # посчитать и удалить просроченное
 *   npm run audit:prune -- --dry   # только посчитать
 *
 * Срок — три года (docs/security.md). Записи моложе срока база удалить не даст
 * вовсе: запрет стоит триггером `audit_log_immutable`, и эта чистка ходит ровно
 * в ту щель, которую он оставил. Поэтому «удалить лишнего» здесь невозможно
 * даже ошибкой в условии — база откажет.
 *
 * Запускается раз в сутки по расписанию на машине приложения (пункт cloud-ops).
 */
import { pgDb } from '../src/api/db.ts';

/** Три года — нижняя граница хранения журнала действий (docs/security.md).
 *  `AUDIT_RETAIN_DAYS` задаёт срок журналов контура (infra/cloud-init.yaml.tftpl),
 *  и в dev он короче — 90 дней. Здесь он может срок только продлить: записи
 *  моложе трёх лет база удалить и не даст. */
const FLOOR_DAYS = 1095;
const days = Math.max(FLOOR_DAYS, Number(process.env.AUDIT_RETAIN_DAYS) || 0);

const dry = process.argv.includes('--dry');
const db = pgDb();

try {
  const older = `at < now() - make_interval(days => ${days})`;
  const { rows: count } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE ${older}`);
  const n = Number(count[0]?.n ?? 0);
  if (days !== FLOOR_DAYS) console.log(`Срок хранения: ${days} дней (AUDIT_RETAIN_DAYS).`);
  if (!n) {
    console.log(`Журнал действий: записей старше ${days} дней нет.`);
  } else if (dry) {
    console.log(`Журнал действий: старше ${days} дней — ${n} записей (ничего не удалено, --dry).`);
  } else {
    await db.query(`DELETE FROM audit_log WHERE ${older}`);
    console.log(`Журнал действий: удалено записей старше ${days} дней — ${n}.`);
  }
} finally {
  await db.close();
}
