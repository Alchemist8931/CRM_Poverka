/* Сверка описания схемы с самой схемой.
 *
 * docs/schema.md — единственное место, откуда человек узнаёт, что в базе лежит.
 * Проверяем, что оно на месте и что в нём названа каждая таблица: забытая при
 * описании таблица хуже отсутствующего документа, потому что выглядит как полный.
 *
 *   npx tsx scripts/check-docs.mts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const docPath = join(root, 'docs', 'schema.md');

if (!existsSync(docPath)) {
  console.error('Нет файла docs/schema.md.');
  process.exit(1);
}
const doc = readFileSync(docPath, 'utf8');
let failed = 0;

// Таблицы берём из самих миграций, а не из списка в коде проверки: так документ
// сверяется со схемой, а не со вторым списком, который тоже можно забыть поправить.
const migrations = join(root, 'server', 'migrations');
const tables = readdirSync(migrations)
  .filter((f) => f.endsWith('.sql'))
  .flatMap((f) => [...readFileSync(join(migrations, f), 'utf8')
    .matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]!));

const undocumented = tables.filter((t) => !doc.includes('`' + t + '`'));
if (undocumented.length) {
  console.error('В docs/schema.md не описаны таблицы: ' + undocumented.join(', '));
  failed++;
} else {
  console.log(`Описаны все таблицы схемы: ${tables.length}.`);
}

// Разделы, без которых документ не выполняет своей работы.
const SECTIONS = ['## Связи', '## Таблицы', '## Индексы', '## Наполнение демо-данными', '## Проверка'];
for (const section of SECTIONS) {
  if (doc.includes(section)) continue;
  console.error(`В docs/schema.md нет раздела «${section.replace('## ', '')}».`);
  failed++;
}

if (failed) {
  console.error(`\nСверка описания не сошлась: расхождений ${failed}.`);
  process.exit(1);
}
console.log('docs/schema.md на месте и описывает всю схему.');
