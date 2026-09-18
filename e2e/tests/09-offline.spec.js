/* Сценарий 9. Телефон поверителя теряет связь: интерфейс закрывается слоем
 * «нет связи», после возвращения связи слой уходит сам. */
import { test, expect } from '@playwright/test';
import { context, signIn } from '../lib/app.mjs';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const C = context();

test('потеря связи на телефоне: слой поднимается и снимается сам', async ({ page, context: ctx }) => {
  await signIn(page, C.ver.login, C.ver.password);
  const shown = () => page.evaluate(() => !document.getElementById('offline').hidden);
  expect(await shown()).toBe(false);
  // Первые секунды после открытия страницы слой молчит нарочно (окно тишины).
  await page.waitForTimeout(3500);

  await ctx.setOffline(true);
  await page.evaluate(() => window.reload()).catch(() => {});
  await page.waitForFunction(() => !document.getElementById('offline').hidden, null, { timeout: 30_000 });
  await expect(page.locator('#offline .offc'), 'слой «нет связи» поднялся').toBeVisible();
  await expect(page.locator('#offline')).toContainText('Нет связи');

  await ctx.setOffline(false);
  // Опрос /health раз в десять секунд снимает слой без единого нажатия.
  await page.waitForFunction(() => document.getElementById('offline').hidden, null, { timeout: 40_000 });
  expect(await shown(), 'связь вернулась — слой ушёл').toBe(false);
  await expect(page.locator('.app')).toBeVisible();
});
