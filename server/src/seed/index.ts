/* Наполнение базы демо-данными прототипа — запуск из командной строки.
 *
 *   npm run seed            — наполнить пустую базу
 *   npm run seed -- --reset — сначала очистить таблицы, потом наполнить
 *
 * Вся раскладка по таблицам живёт в load.ts и соединение получает снаружи:
 * так тем же кодом пользуется проверка схемы, у которой своей сети нет.
 */
import { connect } from '../db.ts';
import { formatCounts, seedDemoData } from './load.ts';

const reset = process.argv.includes('--reset');
const db = await connect();
try {
  if (reset) console.log('Очистка таблиц (--reset).');
  const counts = await seedDemoData(db, { reset });
  console.log('\n' + formatCounts(counts) + '\n');
} catch (err) {
  console.error('Наполнение не удалось:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.end();
}
