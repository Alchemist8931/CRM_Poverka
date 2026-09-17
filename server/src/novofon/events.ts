/* Приведение уведомлений АТС к одному виду.
 *
 * Дальше по коду звонок один и тот же независимо от того, на какой линии
 * интерфейсов работает кабинет заказчика. Разница живёт только здесь.
 *
 * API 1.0 присылает события с готовыми именами (NOTIFY_START, NOTIFY_END…) и
 * фиксированным составом полей — их не выбирают. На платформе 2.0 состав
 * параметров задаёт администратор кабинета при создании уведомления, поэтому
 * имена ниже — это не «как приходит», а «как мы просим настроить»: они выписаны
 * в docs/novofon.md, и уведомление, настроенное иначе, сюда просто не доедет.
 * Чтобы расхождение не выглядело как тишина, неизвестное событие попадает в
 * журнал `call_events` целиком.
 *
 * Время АТС отдаёт без часового пояса («2026-09-17 12:07:31») и по Москве —
 * так работают обе линии. Без явного пояса сервер в UTC записал бы звонок на
 * три часа раньше, и лента звонков разъехалась бы с рабочим днём оператора.
 */

/** Что случилось со звонком — в терминах пульта оператора, а не АТС. */
export type CallKind = 'входящий' | 'ответ' | 'исходящий' | 'завершение' | 'пропущен' | 'запись';

export interface CallEvent {
  platform: 'v1' | 'v2';
  /** Имя события так, как его прислала АТС: идёт в журнал сырых событий. */
  name: string;
  kind: CallKind;
  /** Идентификатор звонка на стороне АТС. Склеивает события одного разговора. */
  sessionId: string;
  direction: 'входящий' | 'исходящий';
  from: string;
  to: string;
  /** Внутренний номер оператора, если АТС его назвала. */
  internal: string | null;
  at: string;
  durationSec: number | null;
  disposition: string | null;
  /** Идентификатор записи на стороне АТС. */
  recordRef: string | null;
  /** Готовая ссылка на файл записи (платформа 2.0, поле file_link). */
  recordUrl: string | null;
}

/** Часовой пояс АТС: время в уведомлениях московское и без указания пояса. */
const MSK = '+03:00';

export function atsTime(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!s) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s.replace(' ', 'T') + MSK).toISOString();
  }
  const d = new Date(/^\d+$/.test(s) ? Number(s) * 1000 : s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Итог звонка словами АТС → словами системы. Набор слов в базе закрыт
 *  ограничением (`calls.disposition`), поэтому всё незнакомое — «сброшен». */
export function disposition(value: unknown): string | null {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'answered' || s === 'отвечен') return 'отвечен';
  if (s === 'busy' || s === 'занято') return 'занято';
  if (s === 'no answer' || s === 'no-answer' || s === 'noanswer' || s === 'пропущен') return 'пропущен';
  return 'сброшен';
}

const text = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};
const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
};

/** Уведомление API 1.0. Возвращает `null`, если событие нам неизвестно:
 *  ни в звонки, ни в карточку оно не пойдёт, но в журнал попадёт. */
export function fromV1(p: Record<string, unknown>): CallEvent | null {
  const name = String(p.event ?? '');
  const sessionId = text(p.pbx_call_id);
  if (!sessionId) return null;
  const base = {
    platform: 'v1' as const,
    name,
    sessionId,
    internal: text(p.internal) ?? text(p.last_internal),
    at: atsTime(p.call_start),
    durationSec: num(p.duration),
    disposition: disposition(p.disposition),
    recordRef: text(p.call_id_with_rec),
    recordUrl: null,
  };
  switch (name) {
    case 'NOTIFY_START':
      return { ...base, kind: 'входящий', direction: 'входящий',
        from: String(p.caller_id ?? ''), to: String(p.called_did ?? '') };
    case 'NOTIFY_ANSWER':
      return { ...base, kind: 'ответ', direction: 'входящий',
        from: String(p.caller_id ?? ''), to: String(p.destination ?? '') };
    case 'NOTIFY_END':
      return {
        ...base,
        // «Отвечен» приходит только если разговор состоялся; всё прочее при
        // входящем — пропущенный, по которому оператору ставится перезвонить.
        kind: base.disposition === 'отвечен' ? 'завершение' : 'пропущен',
        direction: 'входящий',
        from: String(p.caller_id ?? ''), to: String(p.called_did ?? ''),
      };
    case 'NOTIFY_OUT_START':
      return { ...base, kind: 'исходящий', direction: 'исходящий',
        from: String(p.internal ?? ''), to: String(p.destination ?? '') };
    case 'NOTIFY_OUT_END':
      return { ...base, kind: 'завершение', direction: 'исходящий',
        from: String(p.internal ?? ''), to: String(p.destination ?? '') };
    case 'NOTIFY_RECORD':
      return { ...base, kind: 'запись', direction: 'входящий', from: '', to: '' };
    default:
      return null;
  }
}

/** Имена событий, которые мы просим настроить в кабинете на платформе 2.0.
 *  Слева — как назван раздел уведомления в кабинете. */
const V2_KIND: Record<string, CallKind> = {
  call_started: 'входящий',     // «Ожидание ответа»
  call_answered: 'ответ',       // «Начало разговора»
  call_ended: 'завершение',     // «Завершение звонка»
  call_missed: 'пропущен',      // «Потерянный звонок»
  call_out_started: 'исходящий', // «Исходящий звонок»
  call_recorded: 'запись',      // «Записанный разговор»
};

/** Уведомление платформы 2.0. Имена полей — те, что выписаны в docs/novofon.md;
 *  у номеров приняты оба написания, `numa`/`numb` из интерактивной обработки
 *  вызова и человеческие `caller`/`called`, чтобы настройка кабинета не падала
 *  из-за выбора в выпадающем списке. */
export function fromV2(p: Record<string, unknown>): CallEvent | null {
  const name = String(p.event ?? '');
  const kind = V2_KIND[name];
  const sessionId = text(p.call_session_id) ?? text(p.communication_id);
  if (!kind || !sessionId) return null;
  const outgoing = kind === 'исходящий' || String(p.direction ?? '') === 'out';
  return {
    platform: 'v2',
    name,
    kind,
    sessionId,
    direction: outgoing ? 'исходящий' : 'входящий',
    from: String(p.numa ?? p.caller ?? p.contact_phone_number ?? ''),
    to: String(p.numb ?? p.called ?? p.virtual_phone_number ?? ''),
    internal: text(p.employee_phone_number) ?? text(p.internal) ?? text(p.extension),
    at: atsTime(p.start_time ?? p.call_start),
    durationSec: num(p.duration ?? p.talk_duration),
    disposition: disposition(p.disposition ?? (kind === 'пропущен' ? 'no answer' : null)),
    recordRef: text(p.call_record_id) ?? text(p.communication_id),
    recordUrl: text(p.file_link),
  };
}

export const parseEvent = (platform: 'v1' | 'v2', p: Record<string, unknown>): CallEvent | null =>
  (platform === 'v1' ? fromV1(p) : fromV2(p));
