/* Сквозная проверка телефонии против эмулятора АТС (пункт int-novofon).
 *
 *   npx tsx scripts/check-novofon-flow.mts
 *
 * Тесты `test/novofon*.test.ts` проверяют правила по одному. Здесь проходится
 * весь круг так, как он случится в смене: АТС сообщает о входящем → у
 * оператора на линии поднимается карточка клиента → оператор принимает
 * заявку и привязывает к ней звонок → разговор кончается → АТС присылает
 * ссылку на запись → файл ложится в бакет, а руководитель получает на него
 * подписанную ссылку.
 *
 * Настоящей АТС у проверки нет и быть не должно: уведомления шлёт эмулятор
 * (те же события платформы 2.0, тот же секрет в адресе), запись отдаёт
 * поднятый здесь же HTTP-сервер, бакет — карта в памяти с теми же действиями,
 * что у Object Storage. Клиент АТС в этом круге не нужен: платформа 2.0
 * присылает ссылку на файл прямо в событии.
 *
 * Чего проверка не проверяет: подпись API 1.0 и отказ чужого адреса — это в
 * тестах; и то, что настоящая АТС настроена на наш адрес, — это видно только
 * в кабинете Новофон (адреса печатает сервер при старте).
 */
import { createServer } from 'node:http';
import { once } from 'node:events';

process.env.NOVOFON_PLATFORM = 'v2';
process.env.NOVOFON_WEBHOOK_SECRET = 'секрет-эмулятора';
process.env.PUBLIC_BASE_URL = 'https://crm-temp.example.net';

const { as, draft, login, makeStand, AFTER } = await import('../test/helpers.ts');
const { novofonConfig } = await import('../src/novofon/config.ts');
const { runQueue } = await import('../src/novofon/recordings.ts');
type PhotoStorage = import('../src/storage.ts').PhotoStorage;
type LineEvent = import('../src/novofon/bus.ts').LineEvent;

const body = (res: { body: string }) => JSON.parse(res.body);
let failed = 0;
const say = (ok: boolean, text: string, detail = ''): void => {
  if (ok) console.log(`  ок   ${text}`);
  else { console.error(`  НЕ СОШЛОСЬ: ${text}${detail ? `\n         ${detail}` : ''}`); failed++; }
};
const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);

/* ── бакет записей в памяти ─────────────────────────────────────────── */
const objects = new Map<string, Buffer>();
const records: PhotoStorage = {
  bucket: 'uchetkin-check-records',
  uploadUrl: async (key) => `https://s3.check/records/${key}`,
  viewUrl: async (key, ttl = 900) => `https://s3.check/records/${key}?X-Amz-Expires=${ttl}`,
  head: async (key) => (objects.has(key) ? { size: objects.get(key)!.length, contentType: 'audio/mpeg' } : null),
  read: async (key) => objects.get(key)!,
  write: async (key, buf) => { objects.set(key, buf); },
  remove: async (key) => { objects.delete(key); },
};

/* ── эмулятор хранилища записей АТС: отдаёт mp3 по ссылке ───────────── */
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 7)]);
const media = createServer((req, res) => {
  if (req.url?.startsWith('/media/talk/')) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(MP3); return; }
  res.writeHead(404); res.end();
});
media.listen(0, '127.0.0.1');
await once(media, 'listening');
const mediaPort = (media.address() as { port: number }).port;

const SECRET = process.env.NOVOFON_WEBHOOK_SECRET!;
const st = await makeStand({ records, novofon: novofonConfig(process.env) });

/* Эмулятор АТС: уведомление платформы 2.0 — JSON на адрес с секретом. */
const ats = (event: string, extra: Record<string, unknown>) => st.app.inject({
  method: 'POST',
  url: `/api/webhooks/novofon/${encodeURIComponent(SECRET)}`,
  payload: { event, call_session_id: 'cs-777', numa: '79123456789', numb: '73432000000', ...extra },
});

/* Пульт оператора — подписка на шину, как это делает /calls/stream. */
const seen: LineEvent[] = [];
st.app.calls.subscribe('o1', (e) => seen.push(e));

try {
  const op = as(st.app, await login(st.app, 'o1'));
  const sv = as(st.app, await login(st.app, 'sv'));

  step(1, 'Клиент уже обращался: заявка с его номером есть в базе');
  const prev = await op.post('/api/requests', draft({ date: AFTER, phone: '+7 (912) 345-67-89' }));
  say(prev.statusCode === 200, 'прежняя заявка заведена', prev.body.slice(0, 200));

  step(2, 'Оператор выходит на смену — АТС узнаёт, кому звонить');
  say(body(await op.post('/api/calls/line', { on_shift: true })).on_shift === true, 'отметка «на смене» принята');
  const routing = body(await st.app.inject({
    method: 'GET',
    url: `/api/webhooks/novofon/routing/${encodeURIComponent(SECRET)}?call_session_id=cs-777&numa=79123456789&numb=73432000000`,
  }));
  say(JSON.stringify(routing.phones) === JSON.stringify(['102']), `«кому звонить» отвечает номером оператора на линии: ${JSON.stringify(routing.phones)}`);

  step(3, 'Входящий: карточка клиента поднимается у оператора на линии');
  const started = await ats('call_started', { employee_phone_number: '102', start_time: '2026-09-17 10:15:00' });
  say(started.statusCode === 200, 'уведомление о входящем принято', started.body.slice(0, 200));
  const ring = seen.find((e) => e.kind === 'входящий');
  say(!!ring, 'на пульт пришло событие «входящий»');
  say((ring?.client as { name?: string } | null)?.name === 'Иванов И.И.', `в карточке имя клиента: ${(ring?.client as { name?: string } | null)?.name}`);
  say(Array.isArray(ring?.history) && (ring!.history as unknown[]).length === 1, 'и его прежняя заявка');

  step(4, 'Оператор снял трубку, принял заявку и привязал к ней звонок');
  await ats('call_answered', { employee_phone_number: '102' });
  say(seen.some((e) => e.kind === 'ответ'), 'событие «ответ» дошло до пульта');
  const { rows: calls } = await st.db.query<{ id: string }>('SELECT id::text FROM calls WHERE pbx_id = $1', ['cs-777']);
  const callId = calls[0]?.id;
  say(!!callId, `звонок записан в calls (№${callId})`);
  const made = await op.post('/api/requests', draft({ date: AFTER, phone: '+7 (912) 345-67-89', flat: '7' }));
  say(made.statusCode === 200, 'новая заявка принята во время разговора', made.body.slice(0, 200));
  const reqId = body(made).request?.id;
  const linked = await op.post(`/api/calls/${callId}/request`, { request_id: reqId });
  say(linked.statusCode === 200 && body(linked).request_id === reqId, `звонок привязан к заявке ${reqId}`);
  const byReq = body(await op.get(`/api/calls?request_id=${encodeURIComponent(reqId)}`));
  say(Array.isArray(byReq.calls ?? byReq) && (byReq.calls ?? byReq).length === 1, 'в ленте звонков заявки — этот звонок');

  step(5, 'Разговор кончился, АТС прислала запись — файл лёг в бакет');
  await ats('call_ended', { employee_phone_number: '102', duration: '95', disposition: 'answered' });
  const url = `http://127.0.0.1:${mediaPort}/media/talk/555/abc/`;
  const rec = await ats('call_recorded', { communication_id: '555', file_link: url });
  say(rec.statusCode === 200, 'уведомление о записи принято', rec.body.slice(0, 200));
  // Приёмник тянет файл после ответа АТС; очередь добирает то, что не успел.
  await new Promise((r) => setTimeout(r, 300));
  await runQueue({ db: st.db, store: records, api: null });
  const { rows: rr } = await st.db.query<{ record_key: string | null; record_status: string; record_error: string | null }>(
    'SELECT record_key, record_status, record_error FROM calls WHERE pbx_id = $1', ['cs-777']);
  say(rr[0]?.record_status === 'сохранена', `запись в состоянии «${rr[0]?.record_status}»`, rr[0]?.record_error ?? '');
  say(!!rr[0]?.record_key && objects.has(rr[0].record_key), `файл лежит в бакете под ключом ${rr[0]?.record_key}`);
  say(objects.get(rr[0]?.record_key ?? '')?.length === MP3.length, 'и это тот самый файл, что отдал эмулятор');

  step(6, 'Запись слушает руководитель по подписанной ссылке; оператору — нет');
  const link = await sv.get(`/api/calls/${callId}/record`);
  say(link.statusCode === 200 && /X-Amz-Expires=900/.test(body(link).url), 'руководителю выдана ссылка на четверть часа');
  say((await op.get(`/api/calls/${callId}/record`)).statusCode === 403, 'оператору запись не отдаётся');

  step(7, 'Адреса приёмников — из настроек, не из кода');
  const settings = body(await sv.get('/api/calls/settings'));
  say(settings.public_base_url === 'https://crm-temp.example.net', 'база адреса — PUBLIC_BASE_URL');
  console.log('   ' + settings.urls.map((u: { what: string; url: string }) => `${u.what}: ${u.url}`).join('\n   '));
} finally {
  await st.close();
  media.close();
}

console.log(failed ? `\nНе сошлось: ${failed}` : '\nКруг телефонии пройден целиком.');
process.exit(failed ? 1 : 0);
