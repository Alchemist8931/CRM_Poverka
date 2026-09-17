/* Запись о поверке: как она собирается из закрытого акта и когда истекает срок.
 *
 * Правило одно: в реестр уходит то, что записал поверитель, и ничего сверх.
 * Поля берутся снимком в момент закрытия позиции — справочник приборов и прайс
 * потом переписывают, а переданная в государственный реестр запись обязана
 * остаться той же.
 *
 * Состав сведений — пункт 26 Порядка (приказ Минпромторга России от 28.08.2020
 * № 2906 в редакции приказа от 13.01.2022 № 37), срок передачи — пункт 21
 * Порядка проведения поверки (приказ от 31.07.2020 № 2510). Разбор — docs/arshin.md.
 */
import type { Db } from '../api/db.ts';
import type { ArshinConfig } from './config.ts';

/** Срок передачи сведений: не более 40 рабочих дней с даты поверки для обычных
 *  средств измерений и 20 — для применяемых как эталоны единиц величин
 *  (пункт 21 приказа № 2510). У заказчика поверяются бытовые счётчики, эталонов
 *  среди них нет, поэтому очередь живёт по сроку в 40 рабочих дней; вторая
 *  константа стоит здесь, чтобы её не пришлось искать в документах заново.
 *
 *  Приказ № 2510 действует до 1 января 2027 года, и проект приказа на замену
 *  сокращает сроки до 15 и 30 рабочих дней. К концу 2026 года эти два числа
 *  надо перечитать по действующему документу — правка ровно здесь (docs/arshin.md). */
export const DUE_WORKDAYS = 40;
export const DUE_WORKDAYS_ETALON = 20;

/** Сколько ждать ответа реестра. Оператор Фонда публикует переданные сведения и
 *  выдаёт выписки в срок не более 5 рабочих дней со дня передачи (пункт 30
 *  приказа № 2906). Запись, висящая в «передано» дольше, — повод пойти в личный
 *  кабинет и посмотреть, что с ней, а не ждать дальше. */
export const ANSWER_WORKDAYS = 5;

/** Дата через n рабочих дней, в виде `ГГГГ-ММ-ДД`.
 *
 *  Нерабочими считаются суббота и воскресенье; производственный календарь с
 *  переносами праздников система не знает и знать не обязана — посчитанный без
 *  него срок наступает не позже установленного, то есть напоминание приходит
 *  раньше, а не позже законного дня. */
export function addWorkdays(from: string, n: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/** Та же шкала назад: «какой день был n рабочих дней назад». Нужна очереди,
 *  чтобы отобрать записи, ушедшие в реестр раньше срока ответа. */
export function subWorkdays(from: string, n: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

/** Прибавка межповерочного интервала: срок действия поверки считается от её
 *  даты (подпункт «л» пункта 26). Интервал заказчик ведёт в годах. */
export function addYears(from: string, years: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  // Поверка 29 февраля: в невисокосном году такой даты нет, и перескок на 1 марта
  // дал бы день лишнего срока действия. Отступаем назад, к последнему дню февраля.
  if (d.getUTCDate() !== Number(from.slice(8, 10))) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

export interface RecordDraft {
  device_id: number;
  request_id: string;
  mi_name: string;
  mi_modification: string;
  grsi: string;
  serial: string;
  etalons: string;
  method_doc: string;
  verified_on: string;
  valid_to: string | null;
  applicable: boolean;
  org_name: string;
  org_code: string;
  verifier_id: string | null;
  verifier_name: string;
  owner_name: string;
  fail_reason: string;
  due_date: string;
}

/** Чего записи не хватает, чтобы реестр её принял. Пустой список — можно
 *  передавать. Проверка живёт отдельно от сборки: те же правила применяются и
 *  при повторной отправке, когда справочник уже дозаполнили. */
export function problemsOf(r: RecordDraft): string[] {
  const out: string[] = [];
  if (!r.org_code) out.push('условный шифр организации (ARSHIN_ORG_CODE)');
  if (!r.org_name) out.push('наименование аккредитованного лица (ARSHIN_ORG_NAME)');
  if (!r.grsi) out.push('номер типа в Госреестре');
  if (!r.serial) out.push('заводской номер прибора');
  if (!r.method_doc) out.push('методика поверки в справочнике типов приборов');
  if (!r.valid_to) out.push('межповерочный интервал в справочнике типов приборов');
  if (!r.verifier_name) out.push('поверитель');
  if (!r.applicable && !r.fail_reason) out.push('причина непригодности');
  return out;
}

const initials = (full: string): string => full.trim();

/** Черновики записей по закрытой позиции: строка акта с услугой поверки — одна
 *  запись, включая «не годен». Замена, монтаж и демонтаж в реестр не идут:
 *  поверки там нет и результата «годен / не годен» тоже. */
export async function draftsFor(db: Db, requestId: string, cfg: ArshinConfig): Promise<RecordDraft[]> {
  const { rows: reqRows } = await db.query<{ date: string; verifier_id: string | null; verifier_name: string | null }>(
    `SELECT r.date::text AS date, r.verifier_id, s.full_name AS verifier_name
       FROM requests r LEFT JOIN staff s ON s.id = r.verifier_id WHERE r.id = $1`, [requestId]);
  const request = reqRows[0];
  if (!request) return [];

  const { rows } = await db.query<{
    id: string; device_type: string; grsi: string; serial: string; bad: boolean;
    bad_reason: string | null; bad_note: string; interval_years: number | null;
    method_doc: string | null; etalons: string | null; type_grsi: string | null;
  }>(
    `SELECT d.id, d.device_type, d.grsi, d.serial, d.bad, d.bad_reason, d.bad_note,
            t.interval_years, t.method_doc, t.etalons, t.grsi AS type_grsi
       FROM devices d
       JOIN services s ON s.id = d.service_id
       LEFT JOIN device_types t ON t.name = d.device_type
      WHERE d.request_id = $1 AND s.is_verification
      ORDER BY d.position`, [requestId]);

  return rows.map((d) => {
    const verifiedOn = request.date;
    // Номер в Госреестре пишет поверитель, но обычно он подставляется из
    // справочника типов — берём то, что заполнено.
    const grsi = d.grsi || d.type_grsi || '';
    return {
      device_id: Number(d.id),
      request_id: requestId,
      mi_name: d.device_type,
      mi_modification: '',
      grsi,
      serial: d.serial,
      etalons: d.etalons ?? '',
      method_doc: d.method_doc ?? '',
      verified_on: verifiedOn,
      valid_to: d.interval_years ? addYears(verifiedOn, d.interval_years) : null,
      applicable: !d.bad,
      org_name: cfg.orgName,
      org_code: cfg.orgCode,
      verifier_id: request.verifier_id,
      verifier_name: initials(request.verifier_name ?? ''),
      // Пункт 28 приказа № 2906 определяет сведения о владельце как
      // «наименование юридического лица или фамилия и инициалы индивидуального
      // предпринимателя». Клиент заказчика — физическое лицо с квартирным
      // счётчиком, такого владельца норма не описывает, и поле остаётся пустым.
      // Пойдут юридические лица — заполнять будет откуда: наименование в
      // карточке клиента уже есть.
      owner_name: '',
      fail_reason: d.bad ? `${d.bad_reason ?? ''}${d.bad_note ? `: ${d.bad_note}` : ''}` : '',
      due_date: addWorkdays(verifiedOn, DUE_WORKDAYS),
    };
  });
}

/** Записи по закрытой позиции: создаются при закрытии акта и обновляются, пока
 *  не ушли в реестр. Переданную запись правка акта уже не трогает — в реестре
 *  она живёт своей жизнью, и исправляют её отдельной процедурой. */
export async function syncRecords(db: Db, requestId: string, cfg: ArshinConfig): Promise<number> {
  const drafts = await draftsFor(db, requestId, cfg);
  let n = 0;
  for (const draft of drafts) {
    const problems = problemsOf(draft);
    const status = problems.length ? 'ошибка' : 'готово';
    const error = problems.length ? `Не заполнено: ${problems.join(', ')}.` : '';
    const { rows } = await db.query(
      `INSERT INTO arshin_records (device_id, request_id, mi_name, mi_modification, grsi, serial,
          etalons, method_doc, verified_on, valid_to, applicable, org_name, org_code,
          verifier_id, verifier_name, owner_name, fail_reason, due_date, status, error_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (device_id) DO UPDATE SET
          mi_name = EXCLUDED.mi_name, grsi = EXCLUDED.grsi, serial = EXCLUDED.serial,
          etalons = EXCLUDED.etalons, method_doc = EXCLUDED.method_doc,
          verified_on = EXCLUDED.verified_on, valid_to = EXCLUDED.valid_to,
          applicable = EXCLUDED.applicable, org_name = EXCLUDED.org_name, org_code = EXCLUDED.org_code,
          verifier_id = EXCLUDED.verifier_id, verifier_name = EXCLUDED.verifier_name,
          fail_reason = EXCLUDED.fail_reason, due_date = EXCLUDED.due_date,
          status = EXCLUDED.status, error_text = EXCLUDED.error_text, updated_at = now()
        WHERE arshin_records.status IN ('готово', 'ошибка')
       RETURNING id`,
      [draft.device_id, draft.request_id, draft.mi_name, draft.mi_modification, draft.grsi, draft.serial,
       draft.etalons, draft.method_doc, draft.verified_on, draft.valid_to, draft.applicable,
       draft.org_name, draft.org_code, draft.verifier_id, draft.verifier_name, draft.owner_name,
       draft.fail_reason, draft.due_date, status, error]);
    n += rows.length;
  }
  return n;
}

/** Возврат позиции в работу: непереданные записи снимаются с очереди, переданные
 *  остаются. Отозвать из реестра то, что он уже принял, система не может —
 *  такие сведения исправляются в личном кабинете отдельной процедурой. */
export async function dropUnsent(db: Db, requestId: string): Promise<number> {
  const { rows } = await db.query(
    `DELETE FROM arshin_records WHERE request_id = $1 AND status IN ('готово', 'ошибка') RETURNING id`,
    [requestId]);
  return rows.length;
}
