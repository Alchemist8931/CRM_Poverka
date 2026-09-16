/* Сверка перенесённой модели с прототипом.
 *
 * src/seed/prototype-model.mjs — дословные куски index.html. Пока это так,
 * демо-набор в базе совпадает с тем, что показывает прототип; стоит кому-нибудь
 * поправить перенесённый код руками (или поменять прототип, забыв перенести) —
 * распределения разъедутся молча. Эта проверка ловит такое.
 *
 *   npx tsx scripts/check-model-sync.mts
 *   npx tsx scripts/check-model-sync.mts --expect '{"requests":2492,...}'
 *
 * Без --expect печатает отпечаток набора; с --expect сверяет его с тем, что
 * снято с прототипа в браузере, и валится на первом расхождении.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoState } from '../src/seed/prototype-model.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const model = readFileSync(root + 'server/src/seed/prototype-model.mjs', 'utf8');

/* Исходники прототипа с пункта be-fe-wire лежат модулями в web/src (в корневом
   index.html — собранный демо-режим, искать в нём нечего). Блок ищется внутри
   одного файла: перенесённый кусок обязан и там остаться сплошным, иначе от
   «дословно» ничего не остаётся. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : (path.endsWith('.js') ? [readFileSync(path, 'utf8')] : []);
  });
}
const files = sources(root + 'web/src');
const somewhere = (text: string) => files.some((f) => f.includes(text));

// ── 1. каждый перенесённый блок обязан лежать в исходниках прототипа дословно ──
const MARKER = /^\/\* ── (.+?) ─+ \*\/$/gm;
const marks = [...model.matchAll(MARKER)];
if (!marks.length) throw new Error('в перенесённой модели не найдено ни одного блока');

let drifted = 0;
for (const [i, mark] of marks.entries()) {
  const from = mark.index! + mark[0].length;
  const to = i + 1 < marks.length ? marks[i + 1]!.index! : model.indexOf('\n/* Единственное добавление');
  const block = model.slice(from, to).trim();
  if (somewhere(block)) continue;
  drifted++;
  console.error(`Блок «${mark[1]}» не найден в web/src дословно.`);
  // Показываем первую разошедшуюся строку — по ней сразу видно, что случилось.
  const stray = block.split('\n').find((line) => line.trim() && !somewhere(line));
  if (stray) console.error(`  первая расходящаяся строка: ${stray.trim().slice(0, 100)}`);
}
if (drifted) {
  console.error(`\nРазошлись блоки: ${drifted}. Перенесите их из web/src заново целиком.`);
  process.exit(1);
}
console.log(`Блоков перенесено: ${marks.length}, все совпадают с исходниками прототипа дословно.`);

// ── 2. отпечаток набора ──
const sum = <T>(a: T[], f: (x: T) => number) => a.reduce((n, x) => n + f(x), 0);
const { S } = buildDemoState();
const fingerprint: Record<string, number | string> = {
  staff: S.staff.length,
  days: S.days.length,
  requests: S.requests.length,
  routes: S.routes.length,
  stops: sum(S.routes, (r) => r.stops.length),
  devices: sum(S.requests, (r) => (r.devices || []).length),
  photos: sum(S.requests, (r) => sum(r.devices || [], (d) => (d.photos || []).length)),
  absences: S.absences.length,
  waits: S.waits.length,
  handovers: S.handovers.length,
  pays: S.requests.filter((r) => r.pay).length,
  chat: sum(S.routes, (r) => (r.chat || []).length),
  phones: new Set(S.requests.map((r) => r.phone)).size,
  sumAmount: sum(S.requests.filter((r) => r.pay), (r) => r.pay!.amount),
  firstReq: `${S.requests[0]!.id}|${S.requests[0]!.phone}|${S.requests[0]!.name}`,
  lastReq: `${S.requests.at(-1)!.id}|${S.requests.at(-1)!.phone}`,
};

const flag = process.argv.indexOf('--expect');
if (flag < 0) {
  console.log(JSON.stringify(fingerprint, null, 2));
  process.exit(0);
}

const expected = JSON.parse(process.argv[flag + 1] ?? '{}') as Record<string, number | string>;
const bad = Object.entries(expected).filter(([k, v]) => fingerprint[k] !== v);
if (bad.length) {
  console.error('\nОтпечаток набора разошёлся с прототипом:');
  for (const [k, v] of bad) console.error(`  ${k}: у прототипа ${v}, здесь ${fingerprint[k]}`);
  process.exit(1);
}
console.log(`Отпечаток набора совпал с прототипом по ${Object.keys(expected).length} показателям.`);
