/* Сборка инструкций и плана обучения в .docx (пункт docs-train).
 *
 *   node shots.mjs            # сначала скриншоты
 *   node build-docs.mjs [out] # → out/*.docx (по умолчанию docs/train/out)
 *
 * Содержание — в content/*.mjs, оформление — docx-lib.mjs. Адрес системы
 * задаётся один раз в content/common.mjs и попадает на первую страницу каждого
 * документа. Внутри документов нет комментариев и пометок: всё, что нужно
 * пояснить, пишется в отчёт, а не в файл. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lib from './docx-lib.mjs';
import { here } from './lib.mjs';

const outDir = process.argv[2] || join(here, 'out');
mkdirSync(outDir, { recursive: true });

const DOCS = ['operator', 'supervisor', 'verifier', 'admin', 'training'];
for (const name of DOCS) {
  const mod = await import(`./content/${name}.mjs`);
  const children = mod.default(lib);
  const { file, buf } = await lib.buildDoc({ file: mod.meta.file, title: mod.meta.title, children });
  const path = join(outDir, file);
  writeFileSync(path, buf);
  console.log(`${file} · ${Math.round(buf.length / 1024)} КБ`);
}
