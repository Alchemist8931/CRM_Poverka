/* Скриншоты для инструкций по ролям (пункт docs-train).
 *
 *   cd docs/train && node stand.mjs &      # стенд
 *   node shots.mjs                          # → shots/*.png
 *
 * Снимается тот же интерфейс, что выложен на dev: сборка web/dist из текущего
 * кода. Каждый кадр подписан именем роли и экрана; элементы, о которых говорит
 * инструкция, ищутся по их надписям — если надпись на экране переименуют,
 * скрипт упадёт, и это правильно: инструкцию тогда тоже надо править. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP, PHONE, api, card, chromium, go, here, isoToday, newContext, openLogin, quiet, signIn, sleep, standBase } from './lib.mjs';

const base = standBase();
const out = join(here, 'shots');
mkdirSync(out, { recursive: true });
const shot = async (target, name, opts = {}) => {
  await target.screenshot({ path: join(out, name + '.png'), ...opts });
  console.log('  ' + name);
};
/* Высокий элемент на телефоне: временно удлиняем окно, иначе кадр режется. */
const tallShot = async (page, loc, name) => {
  await page.setViewportSize({ width: 390, height: 2600 });
  await page.waitForTimeout(300);
  await shot(loc, name);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
};
/* Элемент, который перерисовывается каждую секунду: снимаем по координатам. */
const clipShot = async (page, loc, name) => {
  const box = await loc.first().boundingBox();
  await page.screenshot({ path: join(out, name + '.png'), clip: { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: box.height + 4 } });
  console.log('  ' + name);
};
const must = async (loc, what) => {
  if (!(await loc.count())) throw new Error(`Не найдено на экране: ${what}`);
  return loc.first();
};

const browser = await chromium.launch();
const TODAY = isoToday();
let tempLogin = '', tempPassword = '';

/* ───────────── оператор ───────────── */
{
  console.log('Оператор');
  const ctx = await newContext(browser, base, DESKTOP);
  const page = await ctx.newPage();
  await openLogin(page);
  await shot(page, 'op-01-login');
  await signIn(page, 'o2', '1234');
  await shot(page, 'op-02-intake');
  await shot(card(page, 'Ёмкость'), 'op-03-ribbon');

  // Линия оператора: смена включена.
  await (await must(page.locator('button.opsw'), 'переключатель смены')).click();
  await quiet(page);
  await shot(card(page, 'Линия оператора'), 'op-04-line');

  // Форма заявки: заполняем как при звонке.
  await page.fill('#inName', 'Смирнова Т. А.');
  await page.fill('#inPhone', '+7 (912) 345-67-89');
  await page.fill('#inHouse', '12');
  await page.fill('#inFlat', '45');
  await page.fill('#inFloor', '5');
  await page.fill('#inEnt', '3');
  await page.locator('.tgls.sk .tgl', { hasText: 'Поверка счётчика воды' }).first().click();
  await page.evaluate(() => { window.S.intake.cmtOp = 'Звонить после 18:00, отвечает дочь'; window.S.intake.cmtVf = 'Стояк в санузле, пломба УК на месте'; window.render(); });
  await quiet(page);
  await shot(card(page, 'Новая заявка'), 'op-05-form');

  // Подсказка дат под услуги: раскрытый календарь.
  await page.evaluate(() => window.dd('inDate'));
  await page.waitForSelector('.pop.cal');
  await shot(page.locator('.pop.cal'), 'op-06-date-slots');
  await page.evaluate(() => { window.S.dd = null; window.render(); });

  // Клиент уже обращался: подставляем телефон из прежней заявки.
  const known = await api(page, 'GET', `/requests?date=${TODAY}`);
  const prev = (known.body?.requests || []).find((r) => r.phone);
  if (prev) {
    await page.fill('#inPhone', prev.phone);
    await page.waitForSelector('.known', { timeout: 10_000 }).catch(() => {});
    if (await page.locator('.known').count()) await clipShot(page, page.locator('.known'), 'op-07-known-client');
  }

  // Поддержка маршрутов.
  await go(page, 'support');
  await shot(page, 'op-08-support');
  const routeBtn = page.locator('.side .rrow .sb').first();
  if (await routeBtn.count()) {
    await routeBtn.click(); await quiet(page);
    await shot(page, 'op-09-support-route');
    await shot(page.locator('.g2 .c').first(), 'op-10-route-card');
    await shot(card(page, 'Шкала дня'), 'op-11-timeline');
  }
  await shot(card(page, 'Лист ожидания'), 'op-12-wait-list');
  const openBtn = page.locator('.chip2 button:has-text("Открыть")').first();
  if (await openBtn.count()) {
    await openBtn.click(); await page.waitForSelector('.modal');
    await shot(page.locator('.modal'), 'op-13-request-card');
    await page.evaluate(() => window.closeModal());
  }
  await go(page, 'me');
  await shot(page, 'op-14-me');
  // Смена пароля по своей воле — кнопка с ключом в меню.
  await page.locator('.rail button.nb[title="Сменить пароль"]').click();
  await page.waitForSelector('form.login');
  await shot(page.locator('form.login'), 'op-15-password');
  await ctx.close();
}

/* ───────────── руководитель ───────────── */
{
  console.log('Руководитель');
  const ctx = await newContext(browser, base, DESKTOP);
  const page = await ctx.newPage();
  await signIn(page, 'sv', '1234');
  await shot(page, 'sv-01-plan');
  const ds = isoToday(3);
  await page.evaluate((d) => window.editDay(d), ds);
  await page.waitForSelector('.modal');
  await shot(page.locator('.modal'), 'sv-02-day-modal');
  await page.evaluate(() => window.closeModal());
  await page.evaluate((d) => window.editOps(d), ds);
  await page.waitForSelector('.modal');
  await shot(page.locator('.modal'), 'sv-03-ops-modal');
  await page.evaluate(() => window.closeModal());

  await go(page, 'schedule');
  await shot(page, 'sv-04-schedule');
  await go(page, 'absence');
  await shot(page, 'sv-05-absence');

  await go(page, 'routes');
  await shot(page, 'sv-06-routes');
  // Дата, где заявки уже есть, а маршрутов ещё нет: на ней конструктор показателен.
  let freeDay = isoToday(1);
  for (let d = 2; d < 45; d++) {
    const ds = isoToday(d);
    const rts = await api(page, 'GET', `/routes?date=${ds}`);
    const reqs = await api(page, 'GET', `/requests?date=${ds}`);
    if (!(rts.body?.routes || []).length && (reqs.body?.requests || []).length > 5) { freeDay = ds; break; }
  }
  await (await must(page.locator('button:has-text("Создать маршрут")'), 'кнопка «Создать маршрут»')).click();
  await page.waitForSelector('.modal.rcm');
  await quiet(page);
  await page.evaluate((d) => window.rcDate(d), freeDay);
  await quiet(page);
  await page.waitForTimeout(500);
  await page.evaluate((d) => {
    const free = window.S.requests.filter((r) => r.date === d && !r.routeId && r.status === 'создана').slice(0, 4);
    free.forEach((r) => window.rcPick(r.id));
  }, freeDay);
  await page.waitForTimeout(400);
  await shot(page.locator('.modal.rcm'), 'sv-07-route-builder');
  await page.evaluate(() => window.closeRC());
  await quiet(page);
  const supReq = page.locator('button:has-text("Заявка на дату")').first();
  if (await supReq.count()) {
    await supReq.click(); await page.waitForSelector('.modal');
    await shot(page.locator('.modal'), 'sv-08-sup-request');
    await page.evaluate(() => window.closeModal());
  }

  await go(page, 'payroll');
  await shot(page, 'sv-09-payroll');
  await shot(card(page, 'Подотчёт бригады'), 'sv-10-handover-table');
  const ho = page.locator('button[onclick^="openHo("]:not([disabled])').first();
  if (await ho.count()) {
    await ho.click(); await page.waitForSelector('.modal');
    await shot(page.locator('.modal'), 'sv-11-handover-modal');
    await page.evaluate(() => window.closeModal());
  }
  await shot(card(page, 'Выполнено без оплаты'), 'sv-12-unpaid');

  await go(page, 'services');
  await shot(card(page, 'Прайс и сдельные ставки'), 'sv-13-prices');
  await shot(card(page, 'Шаблоны уведомлений'), 'sv-14-templates');

  await go(page, 'arshin');
  await shot(page, 'sv-15-arshin');
  await go(page, 'audit');
  const row = page.locator('table.audit tr.ln').first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(300); }
  await shot(page, 'sv-16-audit');

  /* ── администратор: сотрудники ── */
  console.log('Администратор');
  await go(page, 'staff');
  await shot(page, 'ad-01-staff-list');
  await (await must(page.locator('button:has-text("Новый сотрудник")'), 'кнопка «Новый сотрудник»')).click();
  await quiet(page);
  // Повторный прогон на том же стенде: логин уже занят — берём следующий.
  const taken = await page.evaluate(() => window.S.staff.map((p) => p.login || ''));
  tempLogin = 'ivanova.m';
  for (let n = 2; taken.includes(tempLogin); n++) tempLogin = `ivanova.m${n}`;
  await page.fill('#us-name', 'Иванова М. С.');
  await page.evaluate(() => window.pick('us-crole', 'verifier'));
  await page.fill('#us-phone', '+7 (912) 000-11-22');
  await page.fill('#us-email', `${tempLogin}@example.ru`);
  await page.fill('#us-login', tempLogin);
  await page.locator('.tgls.sk .tgl', { hasText: 'Поверка воды' }).click();
  await page.locator('.tgls.sk .tgl', { hasText: 'Замена воды' }).click();
  await quiet(page);
  await shot(card(page, 'Новый сотрудник'), 'ad-02-new-card');
  await (await must(page.locator('button:has-text("Выдать учётную запись")'), 'кнопка «Выдать учётную запись»')).click();
  await page.waitForSelector('#us-pw', { timeout: 30_000 });
  tempPassword = await page.inputValue('#us-pw');
  await shot(card(page, 'Учётная запись выдана'), 'ad-03-temp-password');
  await page.evaluate(() => window.usPwOk());
  await quiet(page);
  const id = await page.evaluate((l) => window.S.staff.find((p) => p.login === l)?.id, tempLogin);
  await page.locator(`tr.ln[onclick="usOpen('${id}')"]`).click();
  await quiet(page);
  await shot(card(page, 'Иванова М. С.'), 'ad-04-card-actions');
  await shot(page.locator(`tr.ln[onclick="usOpen('${id}')"]`), 'ad-05-row-temp');
  await (await must(page.locator('button:has-text("Сбросить пароль")'), 'кнопка «Сбросить пароль»')).click();
  await page.waitForSelector('#us-pw', { timeout: 30_000 });
  tempPassword = await page.inputValue('#us-pw');
  await shot(card(page, 'Пароль сброшен'), 'ad-06-reset-password');
  await page.evaluate(() => window.usPwOk());
  await quiet(page);
  await shot(page, 'ad-07-staff-after');
  await page.evaluate(() => window.usSet('state', 'blocked'));
  await quiet(page);
  await shot(page, 'ad-08-blocked-filter');
  await page.evaluate(() => window.usSet('state', 'active'));
  await ctx.close();

  /* Первый вход нового сотрудника по временному паролю. */
  const ctx2 = await newContext(browser, base, DESKTOP);
  const p2 = await ctx2.newPage();
  await openLogin(p2);
  await p2.fill('form.login input[name=login]', tempLogin);
  await p2.fill('form.login input[name=pw]', tempPassword);
  await p2.click('form.login button');
  await p2.waitForSelector('form.login h1:has-text("Придумайте свой пароль")', { timeout: 30_000 });
  await shot(p2.locator('form.login'), 'ad-09-first-login');
  await ctx2.close();
}

/* ───────────── поверитель (телефон) ───────────── */
{
  console.log('Поверитель');
  const ctx = await newContext(browser, base, PHONE);
  const page = await ctx.newPage();
  await openLogin(page);
  await shot(page, 'vf-01-login-phone');
  await signIn(page, 'v2', '1234');
  await shot(page, 'vf-02-myroute');
  await shot(page.locator('.stop').first(), 'vf-03-stop');
  await shot(page.locator('.rail'), 'vf-04-bottom-bar');
  // Закрытый акт: приборы, фото, оплата — как выглядит заполненный.
  const done = page.locator('.stop.fin button:has-text("Акт")').first();
  if (await done.count()) {
    await done.click(); await quiet(page);
    const actDone = page.locator('.c', { has: page.locator('.acthd') }).first();
    await tallShot(page, actDone, 'vf-05a-act-done');
  }
  // Точка в работе: пустой акт, добавляем прибор.
  const work = page.locator('.stop:not(.fin) button:has-text("Работы")').first();
  await (await must(work, 'кнопка «Работы» у точки')).click();
  await quiet(page);
  const act = page.locator('.c', { has: page.locator('.acthd') }).first();
  await tallShot(page, act, 'vf-05-act');
  if (!(await page.locator('.wrow').count())) {
    await (await must(page.locator('button:has-text("Добавить прибор")'), 'кнопка «Добавить прибор»')).click();
    await page.waitForSelector('.wrow', { timeout: 30_000 });
    await quiet(page);
  }
  const rid = await page.evaluate(() => window.S.openStop);
  await page.fill(`#sn${rid}_0`, '41230017');
  await page.fill(`#rd${rid}_0`, '00123,456');
  await quiet(page);
  await shot(page.locator('.wrow').first(), 'vf-06-device-row');
  const bad = page.locator('.wrow').first().locator('.seg button:has-text("не годен")');
  if (await bad.count()) {
    await bad.click(); await quiet(page);
    // Отметка уезжает на сервер и приходит обратно: ждём блок «Непригоден», при нужде перечитываем экран.
    if (!(await page.locator('.wrow .wbad').count())) {
      await page.waitForSelector('.wrow .wbad', { timeout: 8_000 }).catch(() => {});
      if (!(await page.locator('.wrow .wbad').count())) { await page.evaluate(() => window.reload()); await quiet(page); }
    }
    const blank = page.locator('.wrow').first().locator('.chk:has-text("выдан бланк о непригодности")');
    if (await blank.count()) { await blank.click(); await quiet(page); }
    const blankNo = page.locator(`#bl${rid}_0`);
    if (await blankNo.count()) { await blankNo.fill('000217'); await quiet(page); }
    await shot(page.locator('.wrow').first(), 'vf-07-device-bad');
    await shot(page.locator('.wrow').first().locator('.wbad'), 'vf-07a-bad-block');
  }
  await shot(page.locator('.payb'), 'vf-08-payment');
  await shot(act.locator('.row').last(), 'vf-09-close-button');
  // Убираем пробный прибор: стенд остаётся таким, каким был.
  await page.locator('.wrow').first().locator('button[title="Убрать прибор"]').click();
  await quiet(page);
  const uns = page.locator('button:has-text("Не обслужена")').first();
  if (await uns.count()) {
    await uns.click(); await page.waitForSelector('.modal');
    await shot(page.locator('.modal'), 'vf-10-unserved-modal');
    await page.evaluate(() => window.closeModal());
  }
  const chat = page.locator('button:has-text("Открыть чат")').first();
  if (await chat.count()) {
    await chat.click(); await page.waitForTimeout(300);
    await shot(page.locator('.mchat'), 'vf-11-chat');
    await page.locator('button:has-text("Свернуть чат")').first().click();
  }
  // Нет связи: слой поверх интерфейса.
  await page.evaluate(() => window.scrollTo(0, 0));
  await ctx.setOffline(true);
  await page.evaluate(() => window.NET.check());
  await page.waitForFunction(() => !document.getElementById('offline').hidden, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await shot(page, 'vf-12-offline');
  await ctx.setOffline(false);
  await page.evaluate(() => window.NET.check());
  await page.waitForFunction(() => document.getElementById('offline').hidden, null, { timeout: 15_000 });
  await go(page, 'me');
  await shot(page, 'vf-13-me', { fullPage: true });
  await go(page, 'absence');
  await shot(page, 'vf-14-absence');
  await ctx.close();
}

await browser.close();
console.log('Готово: ' + out);
