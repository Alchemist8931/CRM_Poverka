/* Приёмочные сквозные сценарии CRM «Учёткин» (пункт test-uat).
 *
 * Куда ходят проверки, задаётся окружением — сами они ничего не поднимают:
 *
 *   UAT_BASE_URL       адрес контура, по умолчанию dev в облаке (https://uchetkin.ru)
 *   UAT_LOGIN          техническая учётка полного доступа (заводит server/scripts/uat-stand.mts)
 *   UAT_PASSWORD       её пароль
 *   UAT_STAFF_PASSWORD пароль, который получают учётки uat.op и uat.ver после смены временного
 *
 * Сценарии идут строго по порядку одним воркером: каждый следующий опирается
 * на данные предыдущего (заявка → маршрут → акт → деньги → «Аршин»), и это
 * не лень, а суть приёмки — проверяется цепочка, а не набор кнопок.
 *
 * Локально, без облака: `node stand.mjs` поднимает то же приложение на
 * встроенном PostgreSQL и гоняет те же сценарии против него.
 */
import { defineConfig } from '@playwright/test';

const BASE = (process.env.UAT_BASE_URL || 'https://uchetkin.ru').replace(/\/$/, '');

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { open: 'never', outputFolder: 'report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  use: {
    baseURL: BASE,
    viewport: { width: 1600, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
  },
  outputDir: './results',
});
