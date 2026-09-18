/* Короткие видео по ролям (пункт docs-train): запись экрана без озвучки,
 * субтитры рисуются прямо в кадре и дублируются файлом .srt.
 *
 *   cd docs/train && node stand.mjs &       # стенд
 *   node video.mjs [operator|supervisor|verifier|admin]   # → video/*.webm + *.srt
 *
 * Сценарий каждого ролика идёт теми же нажатиями, что и инструкция: элемент
 * перед нажатием подсвечивается, подпись внизу говорит, что происходит. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP, PHONE, api, chromium, here, isoToday, newContext, openLogin, quiet, sleep, standBase } from './lib.mjs';

const base = standBase();
const out = join(here, 'video');
mkdirSync(out, { recursive: true });
const only = process.argv[2];

/* ---------- субтитры ---------- */
const CSS = `#train-sub{position:fixed;left:4%;right:4%;z-index:99999;pointer-events:none;
  background:rgba(20,20,22,.82);color:#fff;font:500 var(--sub-size,21px)/1.35 "SN Pro",system-ui,sans-serif;
  padding:12px 18px;border-radius:12px;text-align:center;letter-spacing:.01em;
  box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .2s}
#train-sub:empty{opacity:0}`;
function makeRecorder(page, { phone, pace = 0 }) {
  const t0 = Date.now();
  const cues = [];
  /* pace — миллисекунд на слово: подпись держится не меньше, чем её читают. */
  const readTime = (text) => pace ? Math.max(2400, text.split(/\s+/).length * pace) : 0;
  const ensure = () => page.evaluate(({ css, phone }) => {
    if (!document.getElementById('train-css')) {
      const s = document.createElement('style'); s.id = 'train-css'; s.textContent = css; document.head.appendChild(s);
    }
    if (!document.getElementById('train-sub')) {
      const d = document.createElement('div'); d.id = 'train-sub';
      d.style.bottom = phone ? '74px' : '28px';
      d.style.setProperty('--sub-size', phone ? '17px' : '21px');
      document.body.appendChild(d);
    }
  }, { css: CSS, phone }).catch(() => {});
  const say = async (text, hold = 3200) => {
    await ensure();
    if (cues.length) cues[cues.length - 1].end = Date.now() - t0;
    cues.push({ start: Date.now() - t0, end: null, text });
    await page.evaluate((t) => { const d = document.getElementById('train-sub'); if (d) d.textContent = t; }, text);
    await sleep(Math.max(hold, readTime(text)));
  };
  const clear = async () => {
    if (cues.length && cues[cues.length - 1].end === null) cues[cues.length - 1].end = Date.now() - t0;
    await page.evaluate(() => { const d = document.getElementById('train-sub'); if (d) d.textContent = ''; }).catch(() => {});
  };
  const srt = () => {
    const ts = (ms) => { const d = new Date(Math.max(0, ms)); return d.toISOString().slice(11, 23).replace('.', ','); };
    return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end ?? c.start + 3000)}\n${c.text}\n`).join('\n');
  };
  return { say, clear, srt, ensure };
}

/* Подсветить элемент и нажать — так в кадре видно, куда именно жмут. */
async function tap(loc, pause = 900) {
  const el = loc.first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.evaluate((e) => { e.dataset.trainOutline = e.style.outline; e.style.outline = '3px solid #e8a33d'; e.style.outlineOffset = '3px'; });
  await sleep(pause);
  await el.click();
  await el.evaluate((e) => { e.style.outline = e.dataset.trainOutline || ''; e.style.outlineOffset = ''; }).catch(() => {});
}
async function type(loc, text) {
  await loc.first().click();
  await loc.first().pressSequentially(text, { delay: 55 });
}
async function record(name, opts, scenario) {
  if (only && only !== name) return;
  console.log('Запись: ' + name);
  const browser = await chromium.launch();
  const ctx = await newContext(browser, base, { ...opts.ctx, recordVideo: { dir: out, size: opts.size } });
  const page = await ctx.newPage();
  const rec = makeRecorder(page, { phone: !!opts.ctx.isMobile, pace: opts.pace });
  try {
    await scenario(page, rec, ctx);
  } finally {
    await rec.clear();
    await sleep(1200);
    const video = page.video();
    await ctx.close();
    const tmp = await video.path();
    const dst = join(out, `${name}.webm`);
    await video.saveAs(dst);
    await video.delete().catch(() => {});
    writeFileSync(join(out, `${name}.srt`), rec.srt());
    await browser.close();
    console.log('  → ' + dst + ' (' + tmp.split('/').pop() + ')');
  }
}

/* Вход теми же нажатиями, что человек: логин, пароль, «Войти». */
async function login(page, rec, loginName, password, who) {
  await openLogin(page);
  await rec.say(`Откройте адрес системы в браузере. Вход — по учётной записи: ${who}.`, 2600);
  await type(page.locator('form.login input[name=login]'), loginName);
  await type(page.locator('form.login input[name=pw]'), password);
  await tap(page.locator('form.login button'));
  await page.waitForFunction(() => window.S?.auth === true, null, { timeout: 30_000 });
  await quiet(page);
}
const navTo = async (page, title) => { await tap(page.locator(`.rail button.nb[title^="${title}"]`)); await quiet(page); };

/* ═════════════ оператор ═════════════ */
await record('operator', { ctx: DESKTOP, size: { width: 1440, height: 900 } }, async (page, rec) => {
  await login(page, rec, 'o2', '1234', 'логин и пароль выдаёт руководитель');
  await rec.say('Экран «Приём заявки». Слева — меню оператора: приём, поддержка маршрутов, мой заработок.', 3600);
  await rec.say('Лента ёмкости: четыре недели, по дням видно города бригады и сколько мест занято.', 3800);
  // Отметка «на смене» хранится на сервере: после прошлых прогонов она может быть
  // включена — выключаем до показа, чтобы нажатие в кадре именно включало смену.
  if (await page.evaluate(() => window.S.op.on)) { await page.evaluate(() => window.toggleShift()); await quiet(page); }
  await rec.say('Включите смену — входящие звонки пойдут на вашу линию.', 2200);
  await tap(page.locator('button.opsw'));
  await quiet(page);
  await rec.say('Пришёл звонок — номер подставится в форму сам. Заполняем заявку.', 2800);
  await page.locator('#inName').scrollIntoViewIfNeeded();
  await rec.say('Тип клиента, ФИО, телефон. По телефону система покажет, обращался ли клиент раньше.', 2000);
  await type(page.locator('#inName'), 'Смирнова Т. А.');
  await type(page.locator('#inPhone'), '9123456789');
  await rec.say('Услуги — кнопками. От них зависит, какие даты подскажет календарь.', 1800);
  await tap(page.locator('.tgls.sk .tgl', { hasText: 'Поверка счётчика воды' }));
  await quiet(page);
  await rec.say('Адрес: улица из списка, дом, подъезд, этаж, квартира, домофон.', 1500);
  await type(page.locator('#inHouse'), '12');
  await type(page.locator('#inEnt'), '3');
  await type(page.locator('#inFloor'), '5');
  await type(page.locator('#inFlat'), '45');
  await rec.say('Дата выезда: календарь подсказывает дни, когда бригада едет в город и закрывает выбранные услуги.', 2000);
  await tap(page.locator('.sel:has(#inDate), [data-fld]:has(button[onclick*="inDate"])').first().locator('button.fld'));
  await page.waitForSelector('.pop.cal');
  await sleep(3200);
  const slot = page.locator('.pop.cal .slot').first();
  if (await slot.count()) { await tap(slot); } else { await page.evaluate(() => { window.S.dd = null; window.render(); }); }
  await quiet(page);
  await rec.say('Время прибытия — час, к которому клиент ждёт: окно ±1 час считается само.', 2600);
  await rec.say('Комментарии: операторам — как звонить, поверителям — что важно на адресе.', 2400);
  await page.evaluate(() => { window.S.intake.cmtVf = 'Стояк в санузле, пломба УК на месте'; window.render(); });
  await sleep(1500);
  await rec.say('«Сохранить заявку». Если такой адрес и телефон на эту дату уже есть — система предупредит о дубле.', 2600);
  const save = page.locator('button[onclick="createReq()"]');
  await tap(save);
  await page.waitForFunction(() => window.S.intake.name === '' || !!window.S.toast, null, { timeout: 30_000 }).catch(() => {});
  await quiet(page);
  await rec.say('Заявка сохранена и появилась в списке «Мои заявки за сегодня».', 3000);
  await page.locator('h3:has-text("Мои заявки за сегодня")').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(2000);

  await rec.say('Вечером — обзвон на завтра. Экран «Поддержка маршрутов».', 2200);
  await navTo(page, 'Поддержка маршрутов');
  await rec.say('Переключатель «Сегодня / Завтра», слева — маршруты дня. Выберите маршрут.', 2400);
  await tap(page.locator('.side .seg button', { hasText: 'Завтра' }));
  await quiet(page);
  const rb = page.locator('.side .rrow .sb').first();
  if (await rb.count()) { await tap(rb); await quiet(page); }
  await rec.say('У каждой точки — кнопки прозвонки: подтверждена, перенос, отказ. Позвонить можно кнопкой с трубкой.', 3400);
  const call = page.locator('button[title="Подтверждена"]').first();
  if (await call.count()) { await tap(call); await quiet(page); }
  await rec.say('Когда все точки прозвонены — «Отметить обзвоненным»: маршрут уйдёт поверителю.', 3200);
  await rec.say('Шкала дня: стрелками заявка сдвигается на час, окно прибытия пересчитается само.', 3000);
  await page.locator('h3:has-text("Шкала дня")').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(2200);
  await rec.say('Лист ожидания: адреса, которые поверитель не смог обслужить. Позвоните клиенту и перенесите, поставьте в маршрут или отмените.', 3600);
  await page.locator('h3:has-text("Лист ожидания")').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(2600);
  await rec.say('«Мой заработок»: начисления за заявки, дошедшие до выполнения, и что ещё в работе.', 2200);
  await navTo(page, 'Мой заработок');
  await sleep(2600);
  await rec.say('Кнопка с ключом — сменить пароль, кнопка с дверью — выйти. Готово.', 2600);
  await tap(page.locator('.rail button.nb[title="Выйти"]'));
  await sleep(1200);
});

/* ═════════════ руководитель ═════════════ */
await record('supervisor', { ctx: DESKTOP, size: { width: 1440, height: 900 } }, async (page, rec) => {
  await login(page, rec, 'sv', '1234', 'руководитель');
  await rec.say('Меню руководителя: планирование, маршруты, график, отсутствия, оплата, услуги, «Аршин», сотрудники, журнал.', 3800);
  await rec.say('«Планирование дня»: календарь месяца. Клик по дню открывает карточку дня.', 2600);
  const ds = isoToday(5);
  await tap(page.locator(`button.pcell[onclick="editDay('${ds}')"]`));
  await page.waitForSelector('.modal');
  await rec.say('Города приёма — куда едет бригада в этот день. Не больше пяти.', 2600);
  await rec.say('План по городам — сколько заявок готовы принять. Приём закроется при +10 % сверх плана.', 3000);
  await rec.say('Поверители на дату — смена. Пустой день — выходной: оператор не сможет на него записать.', 3000);
  await tap(page.locator('.modal button:has-text("Готово")'));
  await quiet(page);
  await rec.say('Вкладка «Смены операторов» — отдельный график линии.', 2200);
  await tap(page.locator('.seg button', { hasText: 'Смены операторов' }));
  await sleep(2000);

  await rec.say('«Сборка маршрутов»: список по дням, «Создать маршрут» открывает карту.', 2200);
  await navTo(page, 'Сборка маршрутов');
  let freeDay = isoToday(1);
  for (let d = 2; d < 45; d++) {
    const dd = isoToday(d);
    const rts = await api(page, 'GET', `/routes?date=${dd}`);
    const reqs = await api(page, 'GET', `/requests?date=${dd}`);
    if (!(rts.body?.routes || []).length && (reqs.body?.requests || []).length > 5) { freeDay = dd; break; }
  }
  await tap(page.locator('button:has-text("Создать маршрут")').first());
  await page.waitForSelector('.modal.rcm');
  await quiet(page);
  await page.evaluate((d) => window.rcDate(d), freeDay);
  await quiet(page);
  await rec.say('Выберите дату. Точки — адреса заявок; нажимайте их по порядку объезда.', 2800);
  const ids = await page.evaluate((d) => window.S.requests.filter((r) => r.date === d && !r.routeId && r.status === 'создана').slice(0, 4).map((r) => r.id), freeDay);
  for (const id of ids) { await tap(page.locator(`g.mp[onclick="rcPick('${id}')"]`), 500); }
  await sleep(800);
  await rec.say('«Создать маршрут» — адреса уходят в маршрут, дата закрывается для операторов.', 2000);
  await tap(page.locator('.modal.rcm button:has-text("Создать маршрут")'));
  await page.waitForFunction(() => (window.S.rc?.made || []).length > 0, null, { timeout: 30_000 });
  await quiet(page);
  await rec.say('Справа — маршруты этой сессии: назначьте поверителя из смены.', 2400);
  const made = await page.evaluate(() => window.S.rc.made[0]);
  await tap(page.locator(`.rclist .sel button.fld`).first());
  await sleep(600);
  const opt = page.locator('.rclist .pop .o').nth(1);
  if (await opt.count()) { await tap(opt, 500); await quiet(page); }
  await sleep(1500);
  await rec.say('Закройте конструктор — маршруты остаются. На экране их можно расформировать или сменить поверителя.', 2800);
  await page.evaluate(() => window.closeRC());
  await quiet(page);
  await sleep(1200);
  await rec.say('«Заявка на дату» — единственный способ добавить адрес на день, который уже ушёл под маршруты.', 3200);

  await rec.say('«График смен»: клик по клетке ставит или снимает сотрудника с даты.', 2200);
  await navTo(page, 'График смен');
  await sleep(2400);
  await rec.say('«Отсутствия»: запросы сотрудников — согласовать или отклонить. Согласованные дни уходят из графика.', 2400);
  await navTo(page, 'Отсутствия');
  await sleep(2400);

  await rec.say('«Сдельная оплата»: начисления, подотчёт бригады и долги — выполнено без оплаты.', 2400);
  await navTo(page, 'Сдельная оплата');
  await page.locator('h3:has-text("Подотчёт бригады")').scrollIntoViewIfNeeded().catch(() => {});
  await rec.say('Поверитель привёз деньги — «Принять возврат»: сумма по умолчанию равна остатку подотчёта.', 3000);
  const ho = page.locator('button[onclick^="openHo("]:not([disabled])').first();
  if (await ho.count()) {
    await tap(ho);
    await page.waitForSelector('.modal');
    await sleep(2600);
    await tap(page.locator('.modal button:has-text("Принять")').first());
    await quiet(page);
    await sleep(1800);
  }
  await rec.say('«Услуги и ставки»: цены и сдельные ставки правятся прямо в таблице, начисления пересчитываются сразу.', 2400);
  await navTo(page, 'Услуги и ставки');
  const cell = page.locator('input[onchange^="setSvc(0,\'pF\'"]');
  if (await cell.count()) {
    const was = await cell.inputValue();
    await tap(cell); await cell.fill(''); await cell.pressSequentially('950', { delay: 80 }); await cell.press('Enter');
    await quiet(page); await sleep(1500);
    const again = page.locator('input[onchange^="setSvc(0,\'pF\'"]');
    await again.fill(''); await again.pressSequentially(was, { delay: 60 }); await again.press('Enter');
    await quiet(page);
  }
  await rec.say('Ниже — компетенции поверителей и шаблоны СМС и писем клиентам.', 2400);
  await rec.say('«Сотрудники»: учётные записи — подробно в инструкции администратора и отдельном видео.', 2400);
  await navTo(page, 'Сотрудники');
  await sleep(1800);
  await rec.say('«ФГИС Аршин»: очередь записей о поверке, сроки, «Собрать выгрузку» для личного кабинета.', 2600);
  await navTo(page, 'ФГИС');
  await sleep(2400);
  await rec.say('«Журнал действий»: кто, когда и что менял. Строка раскрывается в разницу по полям, есть выгрузка CSV.', 2600);
  await navTo(page, 'Журнал действий');
  const row = page.locator('table.audit tr.ln').first();
  if (await row.count()) { await tap(row); await sleep(2400); }
  await rec.say('Готово.', 1500);
});

/* ═════════════ поверитель (телефон) ═════════════ */
/* Ролик поверителя короче остальных по числу экранов, поэтому подписи держатся
 * по темпу чтения (pace), а шаги, зависящие от ответа сервера, не роняют запись:
 * поле или кнопка, которых нет в кадре, пропускаются. */
const tryTap = async (loc, pause) => { if (await loc.count()) { await tap(loc, pause); return true; } return false; };
await record('verifier', { ctx: PHONE, size: { width: 780, height: 1688 }, pace: 340 }, async (page, rec, ctx) => {
  await login(page, rec, 'v2', '1234', 'поверитель, с телефона');
  await rec.say('«Мой маршрут»: маршрут на сегодня. Внизу — панель: маршрут, отсутствия, заработок, тема, пароль, выход.', 3800);
  await rec.say('Если маршрутов несколько — выберите нужный в списке «Мои маршруты». Рядом — сколько точек выполнено.', 2600);
  await rec.say('Точки идут по порядку объезда: адрес, окно, клиент, подъезд, этаж, домофон, комментарий оператора.', 3400);
  const stop = page.locator('.stop:not(.fin)').first();
  await stop.scrollIntoViewIfNeeded();
  await sleep(1500);
  await rec.say('«Навигатор» строит маршрут до адреса. «Клиент» — позвонить. «Работы» открывает акт. «Не обслужена» — если не попали.', 3200);
  await rec.say('Что-то не так на адресе — напишите оператору в чат маршрута: «Открыть чат» под карточкой.', 2400);
  if (await tryTap(page.locator('button:has-text("Открыть чат")').first(), 700)) {
    await sleep(2600);
    await tryTap(page.locator('.mchat button.mchatt').first(), 300);
    await sleep(600);
  }
  await stop.scrollIntoViewIfNeeded();
  await tap(stop.locator('button:has-text("Работы")'));
  await quiet(page);
  const act = page.locator('.c', { has: page.locator('.acthd') }).first();
  await act.scrollIntoViewIfNeeded();
  await rec.say('Акт: по каждому прибору — услуга, тип, носитель, заводской номер, показания, место, пломба, пенсионер.', 3400);
  if (!(await page.locator('.wrow').count())) {
    await rec.say('«Добавить прибор» — по строке на каждый обслуженный прибор.', 1800);
    await tap(page.locator('button:has-text("Добавить прибор")'));
    await page.waitForSelector('.wrow', { timeout: 30_000 });
    await quiet(page);
  }
  const rid = await page.evaluate(() => window.S.openStop);
  await rec.say('Впишите заводской номер и показания — без номера позицию не закрыть.', 1600);
  // Поля акта перерисовываются на каждую букву — печатать по символу нельзя, заполняем целиком.
  await page.locator(`#sn${rid}_0`).fill('41230017');
  await sleep(900);
  await page.locator(`#rd${rid}_0`).fill('00123,456');
  await sleep(900);
  await quiet(page);
  await rec.say('«Добавить фото» открывает камеру. Кадры уходят в хранилище по одному и сжимаются сами. Не больше десяти на прибор.', 3000);
  await page.locator('.wrow').first().locator('label.addph').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(1500);
  await rec.say('Результат поверки: «годен» или «не годен».', 1400);
  await tap(page.locator('.wrow').first().locator('.seg button:has-text("не годен")'));
  await quiet(page);
  // Отметка уезжает на сервер и приходит обратно: ждём блок «Непригоден», при нужде перечитываем экран.
  await page.waitForSelector('.wrow .wbad', { timeout: 8_000 }).catch(() => {});
  if (!(await page.locator('.wrow .wbad').count())) { await page.evaluate(() => window.reload()).catch(() => {}); await quiet(page); }
  await page.waitForSelector('.wrow .wbad', { timeout: 15_000 }).catch(() => {});
  await page.locator('.wrow .wbad').first().scrollIntoViewIfNeeded().catch(() => {});
  await rec.say('Непригодный: выберите причину. Свидетельство о непригодности — на бумажном бланке от руки.', 2600);
  await rec.say('Отметьте «выдан бланк о непригодности» и впишите номер бланка — по нему руководитель сверяет нумерацию.', 2600);
  await tryTap(page.locator('.wrow').first().locator('.chk:has-text("выдан бланк о непригодности")'));
  await quiet(page);
  const bl = page.locator(`#bl${rid}_0`);
  if (await bl.count()) { await bl.fill('000217'); await sleep(1200); }
  await quiet(page);
  await rec.say('«Предложить замену» добавит строку нового прибора; «Замена отложена» отправит адрес оператору в лист ожидания.', 3200);
  await sleep(600);
  await rec.say('Оплата: способ и сумма — подставлена из прайса. Наличные и перевод уходят в ваш подотчёт.', 3200);
  await page.locator('.payb').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(2000);
  await rec.say('«Закрыть позицию» — работа выполнена, деньги учтены. Ошиблись — «Вернуть в работу». Дальше — следующая точка.', 2400);
  await page.locator('button:has-text("Закрыть позицию")').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(1800);
  // Пробный прибор убираем: стенд остаётся таким, каким был.
  await tryTap(page.locator('.wrow').first().locator('button[title="Убрать прибор"]'), 300);
  await quiet(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await rec.say('Если на адрес не попали — «Не обслужена»: причина и пара слов. Заявка уйдёт оператору в лист ожидания.', 2400);
  const uns = page.locator('.stop:not(.fin) button:has-text("Не обслужена")').first();
  if (await uns.count()) {
    await tap(uns);
    await page.waitForSelector('.modal', { timeout: 10_000 }).catch(() => {});
    await sleep(3000);
    await tryTap(page.locator('.modal button:has-text("Отмена")'));
    await quiet(page);
  }
  await rec.say('Экран «Нет связи»: интерфейс размывается, идёт ожидание. Введённое не теряется — ждите или нажмите «Проверить сейчас».', 2600);
  await ctx.setOffline(true);
  await page.evaluate(() => window.NET.check());
  await page.waitForFunction(() => !document.getElementById('offline').hidden, null, { timeout: 15_000 });
  await sleep(3600);
  await rec.say('Пропала надолго — закончите адрес по бумажному акту и позвоните оператору. Внесёте, когда связь вернётся.', 2400);
  await rec.say('Связь вернулась — слой уйдёт сам, продолжайте с того же места.', 1200);
  await ctx.setOffline(false);
  await page.evaluate(() => window.NET.check());
  await page.waitForFunction(() => document.getElementById('offline').hidden, null, { timeout: 15_000 });
  await sleep(2200);
  await rec.say('«Мой заработок»: начисления и подотчёт — сколько собрано, сколько сдать руководителю.', 2200);
  await navTo(page, 'Мой заработок');
  await sleep(2600);
  await rec.say('«Отсутствия»: запрос на отгул или отпуск — уходит руководителю. Готово.', 2400);
  await navTo(page, 'Отсутствия');
  await sleep(2000);
});

/* ═════════════ администратор ═════════════ */
await record('admin', { ctx: DESKTOP, size: { width: 1440, height: 900 } }, async (page, rec) => {
  await login(page, rec, 'sv', '1234', 'руководитель — он же администратор');
  await rec.say('Экран «Сотрудники»: все учётные записи, отбор по роли и состоянию.', 2200);
  await navTo(page, 'Сотрудники');
  await sleep(1800);
  await rec.say('Приняли человека — «Новый сотрудник».', 1600);
  await tap(page.locator('button:has-text("Новый сотрудник")'));
  await quiet(page);
  const taken = await page.evaluate(() => window.S.staff.map((p) => p.login || ''));
  let loginName = 'petrova.a';
  for (let n = 2; taken.includes(loginName); n++) loginName = `petrova.a${n}`;
  await rec.say('ФИО, роль, телефон. Почта или логин — без них человеку нечем войти.', 1800);
  await type(page.locator('#us-name'), 'Петрова А. В.');
  await tap(page.locator('.sel:has(button[onclick*="us-crole"]) button.fld'));
  await sleep(500);
  await tap(page.locator('.pop .o', { hasText: 'поверитель' }), 500);
  await quiet(page);
  await type(page.locator('#us-phone'), '9120001122');
  await type(page.locator('#us-email'), `${loginName}@example.ru`);
  await type(page.locator('#us-login'), loginName);
  await rec.say('У поверителя — компетенции по услугам: что он умеет, то и попадёт в план дня.', 2000);
  await tap(page.locator('.tgls.sk .tgl', { hasText: 'Поверка воды' }), 500);
  await tap(page.locator('.tgls.sk .tgl', { hasText: 'Замена воды' }), 500);
  await quiet(page);
  await rec.say('«Выдать учётную запись».', 1200);
  await tap(page.locator('button:has-text("Выдать учётную запись")'));
  await page.waitForSelector('#us-pw', { timeout: 30_000 });
  let temp = await page.inputValue('#us-pw');
  await rec.say('Временный пароль показывается один раз. «Скопировать» и передать сотруднику лично — не в общий чат.', 3800);
  await tap(page.locator('button:has-text("Скопировать")'));
  await sleep(1500);
  await rec.say('«Пароль передан, закрыть». В списке у сотрудника отметка «временный пароль» — до первого входа.', 2600);
  await tap(page.locator('button:has-text("Пароль передан, закрыть")'));
  await quiet(page);
  const id = await page.evaluate((l) => window.S.staff.find((p) => p.login === l)?.id, loginName);
  await sleep(1500);
  await rec.say('Забыл пароль или замок после пяти неверных попыток — откройте карточку и «Сбросить пароль».', 2400);
  await tap(page.locator(`tr.ln[onclick="usOpen('${id}')"]`));
  await quiet(page);
  await tap(page.locator('button:has-text("Сбросить пароль")'));
  await page.waitForSelector('#us-pw', { timeout: 30_000 });
  // Сброс выдаёт новый временный пароль — прежний больше не действует.
  temp = await page.inputValue('#us-pw');
  await sleep(2200);
  await tap(page.locator('button:has-text("Пароль передан, закрыть")'));
  await quiet(page);
  await rec.say('Роль и компетенции меняются в той же карточке — «Сохранить». Новый набор экранов — при следующем входе.', 2800);
  await tap(page.locator(`tr.ln[onclick="usOpen('${id}')"]`));
  await quiet(page);
  await sleep(1000);
  await rec.say('Увольнение — «Уволен — заблокировать»: вход закрыт, из смен и маршрутов убран, история остаётся.', 2400);
  await tap(page.locator('button:has-text("Уволен — заблокировать")'));
  await quiet(page);
  await sleep(1000);
  await rec.say('Уволенные видны через отбор «Состояние → Уволены». Ошиблись — откройте карточку и «Разблокировать».', 2200);
  await page.evaluate(() => window.usSet('state', 'blocked'));
  await quiet(page);
  await sleep(1200);
  await tap(page.locator(`tr.ln[onclick="usOpen('${id}')"]`));
  await quiet(page);
  await tap(page.locator('button:has-text("Разблокировать")'));
  await quiet(page);
  await page.evaluate(() => window.usSet('state', 'active'));
  await quiet(page);
  await sleep(800);
  await rec.say('Прайс и ставки — экран «Услуги и ставки»: правка прямо в таблице.', 2000);
  await navTo(page, 'Услуги и ставки');
  await sleep(1800);
  await rec.say('Первый вход сотрудника: временный пароль, затем система требует придумать свой.', 2200);
  await openLogin(page);
  await rec.ensure();
  await type(page.locator('form.login input[name=login]'), loginName);
  await type(page.locator('form.login input[name=pw]'), temp);
  await tap(page.locator('form.login button'));
  await page.waitForSelector('form.login h1:has-text("Придумайте свой пароль")', { timeout: 15_000 }).catch(() => {});
  await sleep(1200);
  if (await page.locator('form.login h1:has-text("Придумайте свой пароль")').count()) {
    await rec.say('Временный пароль, новый пароль не короче десяти знаков, ещё раз — «Сменить пароль».', 1800);
    await type(page.locator('input[name=cur]'), temp);
    await type(page.locator('input[name=pw]'), 'Moi-parol-2026!');
    await type(page.locator('input[name=pw2]'), 'Moi-parol-2026!');
    await tap(page.locator('form.login button.b.wide'));
    await page.waitForSelector('.app', { timeout: 30_000 }).catch(() => {});
    await quiet(page);
    await rec.say('Пароль свой — открылись экраны роли. Готово.', 2600);
  } else {
    await rec.say('Вход не прошёл — проверьте логин и временный пароль, при нужде сбросьте его ещё раз. Готово.', 2600);
  }
});

console.log('Готово: ' + out);
