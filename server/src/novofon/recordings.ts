/* Записи разговоров: из АТС в бакет системы.
 *
 * Почему это фоновая задача, а не часть вебхука. Запись готовится на стороне
 * АТС уже после разговора, приходит отдельным событием и лежит по ссылке с
 * ограниченным сроком жизни. Скачивать файл в обработчике вебхука нельзя —
 * АТС ждёт ответа пару секунд и повторит доставку; а откладывать скачивание
 * «на потом руками» нельзя тем более: ссылка протухнет.
 *
 * Отсюда устройство. Событие о записи только помечает звонок: record_status =
 * «ждёт». Дальше очередь разбирает эти пометки — сразу после события и потом
 * по таймеру, пока не получится. Файл кладётся в отдельный бакет записей
 * (RECORDINGS_BUCKET), в базе остаётся ключ; наружу запись отдаётся только
 * подписанной ссылкой на четверть часа и только тем, кому положено её слушать
 * (`routes/calls.ts`).
 *
 * Раз в сутки очередь дополняется сверкой: get.calls_report за прошедшие сутки
 * показывает звонки с записями, и те из них, по которым событие не дошло,
 * встают в очередь. Чаще сверку не гоняем — у API есть суточный и минутный
 * лимит обращений, и на его исчерпании перестаёт работать и звонок из карточки.
 */
import type { Db } from '../api/db.ts';
import type { PhotoStorage } from '../storage.ts';
import { RECORD_CONTENT_TYPE, recordKey } from '../storage.ts';
import type { NovofonApi } from './api.ts';

/** Сколько раз пробуем скачать запись, прежде чем оставить её в «ошибке».
 *  Пять попыток с часовым шагом — это сутки, за которые АТС успевает прийти в
 *  себя; дальше запись добирает суточная сверка. */
export const MAX_TRIES = 5;
/** Потолок на файл: час разговора в mp3 — это около 30 МБ, сто мегабайт
 *  означают, что по ссылке лежит не запись. */
export const RECORD_MAX_BYTES = 100 * 1024 * 1024;

export interface RecordingsDeps {
  db: Db;
  store: PhotoStorage | null;
  api: NovofonApi | null;
  log?: (msg: string, err?: unknown) => void;
}

interface Pending {
  id: string;
  pbx_id: string;
  record_ref: string | null;
  record_tries: number;
  started: string;
}

/** Пометить звонок: запись обещана. Ссылку, если она пришла в событии,
 *  используем сразу — она живёт недолго. */
export async function markRecorded(
  db: Db, sessionId: string, recordRef: string | null,
): Promise<void> {
  await db.query(
    `UPDATE calls SET record_status = CASE WHEN record_status = 'сохранена' THEN 'сохранена' ELSE 'ждёт' END,
        record_ref = COALESCE($2, record_ref)
      WHERE pbx_id = $1`,
    [sessionId, recordRef]);
}

/** Скачать запись по ссылке и положить в бакет. Возвращает ключ объекта. */
export async function fetchAndStore(
  deps: RecordingsDeps, callId: string, url: string, at: Date,
): Promise<string> {
  if (!deps.store) throw new Error('Бакет записей не подключён (RECORDINGS_BUCKET).');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`АТС отдала запись с ответом ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length) throw new Error('По ссылке на запись пришёл пустой файл.');
  if (body.length > RECORD_MAX_BYTES) throw new Error(`Запись больше ${RECORD_MAX_BYTES} байт — это не разговор.`);
  const key = recordKey(callId, at);
  await deps.store.write(key, body, RECORD_CONTENT_TYPE);
  return key;
}

/** Разобрать одну пометку: взять ссылку (из события или у АТС), скачать, убрать
 *  из очереди. Возвращает `true`, если запись легла в бакет. */
export async function takeOne(deps: RecordingsDeps, call: Pending, url?: string | null): Promise<boolean> {
  const link = url ?? (deps.api ? await deps.api.recordUrl({ sessionId: call.pbx_id, recordRef: call.record_ref }) : null);
  try {
    if (!link) throw new Error('Ссылки на запись нет: ни в событии, ни в ответе АТС.');
    const key = await fetchAndStore(deps, call.id, link, new Date(call.started));
    await deps.db.query(
      `UPDATE calls SET record_key = $2, record_status = 'сохранена', record_error = NULL,
          record_tries = record_tries + 1 WHERE id = $1`, [call.id, key]);
    return true;
  } catch (err) {
    const message = (err as Error).message;
    // Попытки считаем всегда: без счётчика «ошибка» крутилась бы вечно и
    // съедала суточный лимит обращений к АТС.
    await deps.db.query(
      `UPDATE calls SET record_status = 'ошибка', record_error = $2, record_tries = record_tries + 1
        WHERE id = $1`, [call.id, message]);
    deps.log?.(`Запись звонка №${call.id} не забрана: ${message}`, err);
    return false;
  }
}

/** Очередь целиком: всё, что помечено и ещё не исчерпало попытки. */
export async function runQueue(deps: RecordingsDeps, limit = 20): Promise<{ done: number; failed: number }> {
  if (!deps.store) return { done: 0, failed: 0 };
  const { rows } = await deps.db.query<Pending>(
    `SELECT id::text, pbx_id, record_ref, record_tries, started FROM calls
      WHERE record_status IN ('ждёт', 'ошибка') AND record_tries < $2
      ORDER BY started LIMIT $1`, [limit, MAX_TRIES]);
  let done = 0;
  for (const row of rows) {
    if (await takeOne(deps, row)) done += 1;
  }
  return { done, failed: rows.length - done };
}

/** Суточная сверка: звонки с записями, по которым событие не дошло.
 *  Ходит в АТС один раз за вызов, поэтому её место — раз в сутки. */
export async function reconcile(deps: RecordingsDeps, hoursBack = 26): Promise<{ added: number }> {
  if (!deps.api) return { added: 0 };
  const till = new Date();
  const from = new Date(till.getTime() - hoursBack * 3600_000);
  const iso = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
  const rows = await deps.api.callsReport(iso(from), iso(till));
  let added = 0;
  for (const row of rows) {
    const rec = row.call_records?.[0];
    if (!rec) continue;
    // В ссылку на файл идёт обращение, а не сессия звонка: держим обе части
    // вместе, иначе по идентификатору записи её потом не найти.
    const ref = row.communication_id ? `${row.communication_id}/${rec}` : rec;
    const { rows: touched } = await deps.db.query(
      `UPDATE calls SET record_status = 'ждёт', record_ref = $2, record_tries = 0, record_error = NULL
        WHERE pbx_id = $1 AND record_status IN ('нет', 'ошибка') RETURNING id`, [String(row.id), ref]);
    added += touched.length;
  }
  return { added };
}

/** Фоновая задача приложения: очередь каждые несколько минут, сверка раз в
 *  сутки. Останавливается вместе с сервером — таймеры не держат процесс. */
export function startRecordings(deps: RecordingsDeps, opts: { queueMs?: number; reconcileMs?: number } = {}): () => void {
  const queueMs = opts.queueMs ?? 5 * 60_000;
  const reconcileMs = opts.reconcileMs ?? 24 * 3600_000;
  const tick = async (fn: () => Promise<unknown>, what: string) => {
    try { await fn(); } catch (err) { deps.log?.(`Записи разговоров, ${what}: ${(err as Error).message}`, err); }
  };
  const t1 = setInterval(() => void tick(() => runQueue(deps), 'очередь'), queueMs);
  const t2 = setInterval(() => void tick(() => reconcile(deps), 'сверка'), reconcileMs);
  t1.unref?.();
  t2.unref?.();
  return () => { clearInterval(t1); clearInterval(t2); };
}
