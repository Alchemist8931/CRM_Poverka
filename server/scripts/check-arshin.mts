/* Выгрузка для ФГИС «Аршин»: собирается из закрытых актов и проходит по схеме.
 *
 * Тесты `test/arshin.test.ts` проверяют правила очереди — что запись рождается
 * при закрытии акта, что статусы меняются, что повторная отправка пересобирает
 * запись. Здесь проверяется другое, то, ради чего пункт существует: **файл,
 * который руководитель понесёт в личный кабинет, — валидный XML**, и валидность
 * подтверждает не наш разбор строки, а настоящий libxml2 (xmllint-wasm).
 *
 * Про схему честно: официальная XSD пакетной загрузки выдаётся в личном кабинете
 * ФГИС Росаккредитации и открыто не публикуется, поэтому здесь проверка идёт по
 * `src/arshin/vri.xsd` — нашей схеме, описывающей нормативный состав сведений
 * пункта 26 приказа Минпромторга России № 2906. Что это значит и что придётся
 * заменить, когда схема появится, — в docs/arshin.md.
 *
 * Чтобы «валидно» не было пустым словом, проверка сначала убеждается, что
 * валидатор вообще умеет ругаться: заведомо испорченная выгрузка обязана быть
 * отвергнута. Проверка, которая всё принимает, не проверяет ничего.
 *
 *   npx tsx scripts/check-arshin.mts
 */
import { readFileSync } from 'node:fs';
import { validateXML } from 'xmllint-wasm';

// Реквизиты аккредитованного лица читаются из окружения на каждый запрос:
// выставляем их до первого обращения к приложению.
process.env.ARSHIN_ORG_NAME = 'ИП Бердинских А.А.';
process.env.ARSHIN_ORG_CODE = 'БРД';
// Канал — файл: ключей API у заказчика нет, и проверка не должна зависеть от
// того, что осталось в окружении машины.
delete process.env.ARSHIN_API_URL;
delete process.env.ARSHIN_API_TOKEN;

const { as, draft, login, makeStand, AFTER } = await import('../test/helpers.ts');
const { xsdPath } = await import('../src/arshin/xml.ts');

const body = (res: { body: string }) => JSON.parse(res.body);
const schema = readFileSync(xsdPath, 'utf8');

let failed = 0;
const say = (ok: boolean, text: string, detail = ''): void => {
  if (ok) console.log(`  ок   ${text}`);
  else { console.error(`  НЕ СОШЛОСЬ: ${text}${detail ? `\n         ${detail}` : ''}`); failed++; }
};

/** Проверка по схеме настоящим libxml2. Возвращает список замечаний. */
async function validate(xml: string): Promise<string[]> {
  const res = await validateXML({
    xml: [{ fileName: 'export.xml', contents: xml }],
    schema: [schema],
  });
  return res.valid ? [] : res.errors.map((e) => (typeof e === 'string' ? e : e.rawMessage || e.message));
}

const st = await makeStand();

try {
  // Справочник типов приборов заказчик ведёт сам: методика поверки и эталоны
  // стоят там же, где межповерочный интервал. Без них запись не полна.
  await st.db.query(
    `UPDATE device_types SET method_doc = 'МИ 1592-2015',
            etalons = 'Установка поверочная УПСЖ-100, зав. № 412'`);

  const sv = as(st.app, await login(st.app, 'sv'));
  const vf = as(st.app, await login(st.app, 'v1'));

  /* ── три выполненных акта ──────────────────────────────────── */

  // Третий акт — с непригодным прибором: отрицательный результат уходит в фонд
  // наравне с положительным (подпункты «м» и «у» пункта 26 приказа № 2906),
  // и выгрузка обязана оставаться валидной вместе с ним.
  const ACTS = [
    { phone: '9120101001', serial: '41230001', bad: false },
    { phone: '9120101002', serial: '41230002', bad: false },
    { phone: '9120101003', serial: '41230003', bad: true },
  ];
  // Заявки заводит руководитель: как только на дату собран маршрут, приём по
  // ней закрывается и оператор второй адрес того же дня уже не добавит.
  const ids: string[] = [];
  for (const act of ACTS) {
    const made = await sv.post('/api/requests', draft({ date: AFTER, phone: act.phone }));
    if (made.statusCode !== 200) throw new Error(`заявка не завелась: ${made.body}`);
    ids.push(body(made).request.id);
  }
  // Маршрут строится минимум по двум точкам — все три ложатся в один.
  const route = await sv.post('/api/routes', { date: AFTER, request_ids: ids, verifier_id: 'v1' });
  if (route.statusCode !== 200) throw new Error(`маршрут не собрался: ${route.body}`);

  for (const [i, act] of ACTS.entries()) {
    const dev = body(await vf.post(`/api/requests/${ids[i]}/devices`, {
      service_id: 'wv', device_type: 'Бетар СХВ-15', carrier: 'ХВС', grsi: '32245-11',
    })).device;
    await vf.patch(`/api/devices/${dev.id}`, {
      serial: act.serial, reading: '00' + (120 + i),
      ...(act.bad ? { bad: true, bad_reason: 'Погрешность выше допуска', blank: true, blank_no: 'И-90' } : {}),
    });
    const closed = await vf.post(`/api/requests/${ids[i]}/close`, { method: 'наличные' });
    if (closed.statusCode !== 200) throw new Error(`акт не закрылся: ${closed.body}`);
    say(body(closed).arshin === 1, `акт ${ids[i]} закрыт, запись о поверке заведена`);
  }

  const queue = body(await sv.get('/api/arshin/queue'));
  say(queue.summary.ready === 3, `к передаче готовы три записи (готово: ${queue.summary.ready})`);
  say(queue.channel === 'файл', `канал обмена — файл (без ключей API), получено: ${queue.channel}`);

  /* ── выгрузка и схема ──────────────────────────────────────── */

  const made = await sv.post('/api/arshin/batches', {});
  if (made.statusCode !== 200) throw new Error(`выгрузка не собралась: ${made.body}`);
  const batch = body(made);
  say(batch.records === 3, `в выгрузке три записи (получено: ${batch.records})`);

  const errors = await validate(batch.xml);
  say(errors.length === 0, `выгрузка ${batch.file_name} проходит по схеме vri.xsd`, errors.join('\n         '));

  // Схема не бутафория: испорченную выгрузку валидатор обязан отвергнуть.
  // Выкидываем обязательный элемент <method> (подпункт «з» пункта 26).
  const broken = batch.xml.replace(/ *<method>[^<]*<\/method>\n/, '');
  const brokenErrors = await validate(broken);
  say(broken !== batch.xml, 'испорченная выгрузка действительно отличается от исходной');
  say(brokenErrors.length > 0, 'выгрузка без обязательного элемента схемой отвергается');

  // Тот же файл, скачанный заново, — тоже валидный: руководитель прикладывает
  // его к отчёту и загружает в кабинет повторно, если первая попытка не прошла.
  const again = await sv.get(`/api/arshin/batches/${batch.batch_id}/file.xml`);
  say(again.statusCode === 200, `файл выгрузки ${batch.batch_id} скачивается заново`);
  const againErrors = await validate(again.body);
  say(againErrors.length === 0, 'повторно скачанный файл проходит по схеме',
    againErrors.join('\n         '));

  /* ── выгрузка за период ────────────────────────────────────── */

  const period = await sv.get(`/api/arshin/export.xml?from=${AFTER}&to=${AFTER}`);
  say(period.statusCode === 200, 'выгрузка за период отдаётся');
  const periodErrors = await validate(period.body);
  say(periodErrors.length === 0, 'выгрузка за период проходит по схеме',
    periodErrors.join('\n         '));

  /* ── ответ реестра ─────────────────────────────────────────── */

  const sent = body(await sv.get('/api/arshin/queue'));
  say(sent.summary.sent === 3, `после выгрузки три записи в «передано» (получено: ${sent.summary.sent})`);
  const recs = sent.records.filter((r: { batch_id: string }) => r.batch_id === batch.batch_id);

  const answer = await sv.post(`/api/arshin/batches/${batch.batch_id}/result`, {
    accepted: recs.slice(0, 2).map((r: { id: number }, i: number) =>
      ({ source_id: String(r.id), number: `1-100${i + 1}-2026` })),
    failed: [{ source_id: String(recs[2].id), error: 'Заводской номер уже есть в реестре' }],
  });
  say(answer.statusCode === 200, 'ответ реестра принят');
  say(body(answer).accepted === 2 && body(answer).failed === 1,
    `принято 2, отклонена 1 (получено: ${body(answer).accepted} и ${body(answer).failed})`);

  // Номер записи в реестре печатается в свидетельстве о поверке, поэтому он
  // обязан лечь в прибор, а не остаться в очереди (пункт fe-forms).
  const card = body(await sv.get(`/api/requests/${recs[0].request_id}`));
  say(card.devices[0].arshin_number === '1-1001-2026',
    `номер реестра сохранён в приборе (получено: «${card.devices[0].arshin_number}»)`);

  // Отклонённую запись руководитель отправляет повторно — она возвращается в очередь.
  const retry = await sv.post(`/api/arshin/records/${recs[2].id}/retry`, {});
  say(retry.statusCode === 200 && body(retry).record.status === 'готово',
    'повторная отправка вернула отклонённую запись в очередь');

  const failedRec = sent.records.find((r: { id: number }) => r.id === recs[2].id);
  say(!!failedRec, 'отклонённая запись видна в очереди');
} finally {
  await st.close();
}

console.log('');
console.log('Схема: src/arshin/vri.xsd — НАША, не официальная XSD ФГИС «Аршин».');
console.log('Она описывает нормативный состав сведений пункта 26 приказа № 2906;');
console.log('официальная выдаётся в личном кабинете и открыто не публикуется (docs/arshin.md).');

if (failed) {
  console.error(`\nПроверка выгрузки не сошлась: расхождений ${failed}.`);
  process.exit(1);
}
console.log('\nВыгрузка для ФГИС «Аршин» собирается из актов и проходит по схеме.');
