/* Кладёт демо-сборку в корень репозитория.
 *
 *   npm run build:all      # рабочая сборка + демо + эта выкладка
 *
 * GitHub Pages раздаёт корень репозитория, и раньше там лежал сам прототип —
 * один index.html. Теперь там лежит собранная одним файлом демо-версия: тот же
 * прототип, с тем же наполнением в памяти, но собранный из модулей web/src.
 * Править его руками бессмысленно — правится исходник и пересобирается.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const built = readFileSync(`${web}dist-demo/index.html`, 'utf8');

const banner = `<!--
  СОБРАННЫЙ ФАЙЛ, НЕ ПРАВИТЬ РУКАМИ.

  Демо-режим CRM «Учёткин»: наполнение делается в памяти вкладки, сервер и база
  не нужны — этим файлом прототип открывается на GitHub Pages.

  Исходники: web/src (модули), сборка: cd web && npm ci && npm run build:all.
  Рабочая версия, которая ходит в API, собирается оттуда же (web/dist) и
  поднимается через docker compose.
-->
`;

const marked = built.replace('<!DOCTYPE html>', `<!DOCTYPE html>\n${banner}`);
writeFileSync(`${web}../index.html`, marked);
console.log(`Корневой index.html обновлён демо-сборкой: ${(marked.length / 1024).toFixed(0)} КБ.`);
