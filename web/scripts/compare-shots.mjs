/* Сверка снимков «до» и «после»: компоновка экранов после разбора прототипа
 * на модули меняться не должна.
 *
 *   node scripts/compare-shots.mjs ../docs/screens/before ../docs/screens/after [допуск]
 *
 * Допуск — доля несовпавших точек, при которой снимки считаются одинаковыми
 * (по умолчанию 0.1 %). Возвращает ненулевой код, если разошёлся хоть один
 * экран или набор снимков неполон.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [before, after, limitArg] = process.argv.slice(2);
if (!before || !after) {
  console.error('нужны два каталога со снимками');
  process.exit(2);
}
const limit = Number(limitArg ?? 0.001);
const diffDir = `${after}/diff`;

const names = readdirSync(before).filter((n) => n.endsWith('.png')).sort();
const there = new Set(readdirSync(after).filter((n) => n.endsWith('.png')));
let bad = 0;

for (const name of names) {
  if (!there.has(name)) { console.error(`${name}: снимка «после» нет`); bad++; continue; }
  const a = PNG.sync.read(readFileSync(`${before}/${name}`));
  const b = PNG.sync.read(readFileSync(`${after}/${name}`));
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`${name}: размер ${a.width}×${a.height} против ${b.width}×${b.height}`);
    bad++;
    continue;
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const share = n / (a.width * a.height);
  const ok = share <= limit;
  if (!ok) {
    mkdirSync(diffDir, { recursive: true });
    writeFileSync(`${diffDir}/${name}`, PNG.sync.write(diff));
    bad++;
  }
  console.log(`${ok ? '  ок' : 'РАЗО'} ${name}: ${n} точек (${(share * 100).toFixed(3)} %)`);
}

console.log(bad ? `\nРазошлось экранов: ${bad}.` : `\nВсе ${names.length} снимков совпали по компоновке.`);
process.exit(bad ? 1 : 0);
