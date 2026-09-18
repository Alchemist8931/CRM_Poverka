/* Сценарий 8. Выгрузка во ФГИС «Аршин»: записи из закрытых актов, файл
 * выгрузки, ответ реестра по строке. */
import { test, expect } from '@playwright/test';
import { apiAs, BOT, context, go, signIn, until, watchConsole, quiet } from '../lib/app.mjs';

test.describe.configure({ mode: 'serial' });

const C = context();

test('руководитель собирает выгрузку: файл скачивается, записи переходят в «передано»', async ({ page }) => {
  const errors = watchConsole(page);
  await signIn(page, BOT.login, BOT.password);
  await go(page, 'arshin');
  await expect(page.locator('.hd .ttl')).toContainText('Аршин');
  const before = await page.evaluate(() => ({
    ready: window.S.arshinSum?.ready ?? 0, failed: window.S.arshinSum?.failed ?? 0,
    rows: (window.S.arshin || []).length,
    problems: [...new Set((window.S.arshin || []).map((r) => r.error_text).filter(Boolean))],
  }));
  expect(before.rows, 'записи из закрытых актов есть в очереди').toBeGreaterThan(0);
  if (!before.ready) {
    // Записи есть, но реестр их не примет: не заполнены сведения об организации
    // или справочник приборов. Экран обязан сказать, чего не хватает, а кнопка
    // выгрузки — быть выключенной. Заполняется заказчиком (docs/uat.md).
    expect(before.failed).toBeGreaterThan(0);
    expect(before.problems.length).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: /Собрать выгрузку/ })).toBeDisabled();
    test.info().annotations.push({ type: 'skip', description: `выгрузка не собрана: ${before.problems.join(' | ')}` });
    test.skip(true, `нет готовых записей: ${before.problems.join(' | ')}`);
  }

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: /Собрать выгрузку/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xml$/);
  await quiet(page);
  await until(page, () => (window.S.arshinBatches || []).length > 0);

  const sv = await apiAs(BOT.login, BOT.password);
  const { batches } = (await sv.get('/api/arshin/batches')).body;
  const batch = batches[0];
  expect(batch.records).toBeGreaterThan(0);
  const xml = await sv.get(`/api/arshin/batches/${batch.id}/file.xml`);
  expect(xml.status).toBe(200);
  expect(xml.text).toContain('<');
  const sent = (await sv.get('/api/arshin/queue?status=' + encodeURIComponent('передано'))).body;
  expect(sent.records.some((r) => r.batch_id === batch.id)).toBe(true);
  await sv.close();
  expect(errors, 'ошибок консоли нет').toEqual([]);
});

test('ответ реестра по строке: номер записи ложится в прибор', async ({ page }) => {
  await signIn(page, BOT.login, BOT.password);
  await go(page, 'arshin');
  const rec = await page.evaluate(() => (window.S.arshin || []).find((r) => r.status === 'передано' && r.batch_id));
  test.skip(!rec, 'переданных записей нет — выгрузка не собиралась');
  page.once('dialog', (d) => d.accept('1-2026-00042'));
  await page.evaluate(({ id, batch }) => window.arshinAccept(id, batch), { id: rec.id, batch: rec.batch_id });
  await until(page, (id) => (window.S.arshin || []).find((r) => String(r.id) === String(id))?.status === 'принято', rec.id, 40_000);

  const sv = await apiAs(BOT.login, BOT.password);
  const q = (await sv.get(`/api/arshin/queue?q=${encodeURIComponent(rec.request_id)}`)).body;
  const same = q.records.find((r) => String(r.id) === String(rec.id));
  expect(same.status).toBe('принято');
  expect(same.fgis_number).toBe('1-2026-00042');
  await sv.close();
});
