/* Перевод между строками базы и объектами, которыми живут экраны.
 *
 * Сервер отдаёт строки таблиц как есть: `client_type`, `time_slot`, `comment_operator`.
 * Экраны писались до базы и знают свои имена: `clientType`, `time`, `cmtOp`. Менять
 * экраны под имена столбцов — значит переписать все двенадцать; поэтому перевод
 * собран одним местом, и он же единственное, что придётся править, если столбец
 * переименуют.
 */

/* Имя сотрудника берётся из справочника: в переписке сервер хранит только его
   идентификатор, а экран показывает человека. */
import { nameOf } from '../state.js';

/** Дата из базы приходит то строкой `ГГГГ-ММ-ДД`, то полной отметкой времени. */
const date = (v) => (v ? String(v).slice(0, 10) : null);
/** Отметка времени в том виде, в каком её показывал прототип: «2026-09-16 14:04». */
const stamp = (v) => (v ? `${String(v).slice(0, 10)} ${String(v).slice(11, 16)}` : null);

export function staffFrom(row) {
  return {
    id: row.id, name: row.full_name, role: row.role,
    pattern: row.pattern, anchor: date(row.anchor), extra: [],
    svcs: row.svcs || [], phone: row.phone || undefined, ext: row.ext || undefined,
    blocked: !!row.blocked_at,
    // Поля учётной записи сервер отдаёт только руководителю (экран «Сотрудники»).
    login: row.login ?? null, email: row.email ?? null,
    mustChange: !!row.must_change_password, lockedUntil: row.locked_until || null,
  };
}

export function dayFrom(row) {
  return {
    date: date(row.date), cities: row.cities || [], caps: row.plan || {},
    crew: row.crew || [], ops: row.ops || [], note: row.note || '',
    /* Замок даты и загрузку считает сервер: у него перед глазами все маршруты и
       все заявки, а у вкладки — только загруженный кусок. */
    lock: row.lock ?? null, load: row.load ?? null, cityLoad: row.cityLoad ?? null,
  };
}

export function absenceFrom(row) {
  return {
    id: row.id, staff: row.staff_id, from: date(row.date_from), to: date(row.date_to),
    reason: row.reason, status: row.status, comment: row.comment || '',
  };
}

/* Ссылки на снимок сервер выдаёт две: миниатюру рисуем в акте, оригинал —
   только когда кадр открыли на весь экран (ui/lightbox.js). */
export function photoFrom(row) {
  return {
    id: row.id, src: row.url, thumb: row.thumb_url || row.url,
    name: row.name || '', t: String(row.taken_at || '').slice(0, 5),
    w: row.width || 0, h: row.height || 0,
  };
}

export function deviceFrom(row) {
  return {
    id: row.id, svc: row.service_id, type: row.device_type, grsi: row.grsi || '',
    carrier: row.carrier, serial: row.serial || '', reading: row.reading || '',
    room: row.room || undefined, seal: !!row.seal, pens: !!row.pensioner,
    bad: !!row.bad, badWhy: row.bad_reason || undefined, badNote: row.bad_note || '',
    blank: !!row.blank, blankNo: row.blank_no || '',
    repl: row.replacement || undefined, replW: row.replacement_wait_id || undefined,
    swap: !!row.swap, swapOf: row.swap_of || '',
    /* Номер записи в реестре, который вернул «Аршин» (int-arshin): печатается
       в свидетельстве о поверке. Пустой — сведения ещё не приняты. */
    arshin: row.arshin_number || '',
    photos: (row.photos || []).map(photoFrom),
  };
}

export function paymentFrom(row) {
  if (!row) return undefined;
  return {
    method: row.method, amount: row.amount, charged: row.charged,
    at: stamp(row.paid_at), by: row.by_staff, manual: !!row.manual, note: row.note || '',
  };
}

export function requestFrom(row, extra = {}) {
  const devices = (extra.devices || []).map(deviceFrom);
  return {
    id: row.id, date: date(row.date), created: date(row.created_date), city: row.city,
    clientType: row.client_type, name: row.name, inn: row.inn || '',
    phone: row.phone, contact: row.contact || '', phone2: row.phone2 || '', contact2: row.contact2 || '',
    email: row.email || '', street: row.street || '', house: row.house || '',
    entrance: row.entrance || '', floor: row.floor || '', flat: row.flat || '',
    intercom: !!row.intercom, time: row.time_slot, notify: !!row.notify_consent,
    cmtOp: row.comment_operator || '', cmtVf: row.comment_verifier || '',
    svcs: row.svcs || [], services: [...new Set(devices.map((d) => d.svc))], devices,
    /* Координаты адреса и точность ответа Геокодера (int-maps). Точность здесь
       не меньше самой точки: по «exact» конструктор ведёт маршрут, а «street» —
       это середина улицы, и точка на карте показывается бледной с оговоркой. */
    lat: row.lat ?? null, lon: row.lon ?? null, geo: row.geo_precision || null,
    geoAddr: row.geo_address || '', geoErr: row.geo_error || '',
    status: row.status, routeId: row.route_id, operator: row.operator_id,
    verifier: row.verifier_id, from: row.moved_from,
    pay: paymentFrom(extra.payment),
  };
}

/** Поля заявки в том виде, в каком их принимает приём и правка. */
export function requestBody(K, day) {
  return {
    date: day, client_type: K.ctype || K.clientType, name: K.name, inn: K.inn || '',
    phone: K.phone, contact: K.contact || '', phone2: K.phone2 || '', contact2: K.contact2 || '',
    email: K.email || '', city: K.city, street: K.street || '', house: K.house || '',
    entrance: K.entrance || '', floor: K.floor || '', flat: K.flat || '',
    intercom: K.intercom !== false, time_slot: K.time,
    // Согласие на уведомления: чего оператор не отметил, того клиент не говорил.
    // Поэтому здесь именно `!!`, а не «по умолчанию да».
    notify_consent: !!K.notify,
    comment_operator: K.cmtOp || '', comment_verifier: K.cmtVf || '', svcs: K.svcs || [],
  };
}

export function stopFrom(row) {
  const stop = { req: row.request_id, called: row.called, done: !!row.done };
  if (row.unserved_reason) {
    stop.unserved = {
      reason: row.unserved_reason, note: row.unserved_note || '',
      at: stamp(row.unserved_at), by: row.unserved_by,
    };
  }
  return stop;
}

/* Список маршрутов приходит со счётчиками, но без самих точек: на экране сборки
   их сорок с лишним по двадцать пять адресов, и тащить всё ради двух чисел незачем.
   Точки такого маршрута — заглушки: известно только, сколько их, сколько обзвонено
   и сколько выполнено. Настоящие приезжают, когда маршрут открывают. */
function placeholders(row) {
  const n = row.stops ?? 0;
  return Array.from({ length: n }, (_, i) => ({
    req: null, called: i < (row.called ?? 0) ? 'подтверждена' : null, done: i < (row.done ?? 0),
  }));
}

export function routeFrom(row, stops, chat) {
  return {
    id: row.id, date: date(row.date), city: row.city, cities: [row.city],
    verifier: row.verifier_id, duty: row.duty_operator_id, status: row.status,
    stops: stops ? stops.map(stopFrom) : placeholders(row),
    chat: (chat || []).map(chatFrom),
    /** Точки приехали целиком, а не счётчиками. */
    full: !!stops,
  };
}

export function chatFrom(row) {
  return { who: nameOf(row.author_id), vf: !!row.is_verifier, txt: row.text,
    t: String(row.at || '').slice(11, 16) };
}

export function waitFrom(row) {
  return {
    id: row.id, req: row.request_id, route: row.route_id, city: row.city,
    kind: row.kind, reason: row.reason, note: row.note || '', at: stamp(row.at),
    by: row.by_staff, state: row.state, to: row.moved_to ? date(row.request_date) : null,
    /* Сервер добавляет к записи адрес и имя клиента — лист ожидания показывает их,
       не поднимая карточку каждой заявки. */
    name: row.name, phone: row.phone, street: row.street, house: row.house, flat: row.flat,
    reqDate: date(row.request_date), reqStatus: row.request_status,
  };
}

export function handoverFrom(row) {
  return {
    id: row.id, staff: row.staff_id, at: date(row.at), period: row.period,
    amount: row.amount, by: row.accepted_by, note: row.note || '',
  };
}
