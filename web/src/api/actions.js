/* Действия рабочего режима.
 *
 * В прототипе действие меняло S и звало render(). Здесь каждое действие — это
 * запрос к серверу, а экран перерисовывается по ответу: сначала правило
 * проверено на сервере, потом картинка. Отказ правила (422) приходит с тем же
 * текстом, который прототип показывал подсказкой, — его и показываем.
 *
 * Имена совпадают с действиями экранов: `createReq` здесь — это то, что делает
 * `createReq()` в screens/intake.js, когда демо-режим выключен.
 */

import { api } from './client.js';
import { requestBody } from './map.js';
import { loadView, mergeRequests, reload } from './load.js';
import { S } from '../state.js';
import { CUR_M, money, ru } from '../util.js';
import { nameOf } from '../state.js';
import { render, toast } from '../ui/render.js';
import { closeModal } from '../ui/modals.js';

/** Обёртка любого действия: отказ правила показываем подсказкой, экран
 *  перечитываем. Ничего не «угадываем» заранее — картинку рисует ответ. */
export async function run(fn, ok) {
  try {
    const out = await fn();
    await reload();
    if (ok) toast(typeof ok === 'function' ? ok(out) : ok);
    return out;
  } catch (err) {
    // Слой «нет связи» поднял сам client.js; здесь говорим только о правилах.
    if (!err?.offline) toast(err?.message || 'Действие не выполнено.');
    render();
    return null;
  }
}

/* ── приём и правка заявки ───────────────────────────────── */

export const createReq = (K, day) => run(
  () => api.post('/requests', requestBody(K, day)),
  (out) => `Заявка ${out.request.id} принята на ${ru(out.request.date)}.`);

export const patchReq = (id, K, day) => run(
  () => api.patch(`/requests/${id}`, requestBody(K, day)),
  (out) => (out.moved ? `Заявка ${id} перенесена на ${ru(out.request.date)} и снята с маршрута.`
    : `Заявка ${id} сохранена.`));

export const shiftReq = (id, delta) => run(() => api.post(`/requests/${id}/shift`, { delta }));

/* ── день и смены ────────────────────────────────────────── */

export const saveDay = (date, patch) => run(() => api.put(`/days/${date}`, patch));

/* ── отсутствия ──────────────────────────────────────────── */

export const sendAbsence = (from, to, reason) => run(
  () => api.post('/absences', { date_from: from, date_to: to, reason }),
  'Запрос отправлен руководителю на согласование.');

export const decideAbsence = (id, status) => run(
  () => api.post(`/absences/${id}/decide`, { status }),
  `Решение записано.`);

/* ── маршруты ────────────────────────────────────────────── */

export const buildRoutes = (date, city) => run(
  () => api.post('/routes/build', { date, city }),
  (out) => (out.routes?.length ? `${city}: собрано маршрутов — ${out.routes.length}.`
    : `${city}: свободных заявок на эту дату нет.`));

export const createRoute = (date, city, requestIds, verifierId) => run(
  () => api.post('/routes', { date, city, request_ids: requestIds, verifier_id: verifierId || undefined }),
  (out) => `Маршрут ${out.route.id} создан: адресов ${requestIds.length}.`);

export const patchRoute = (id, patch) => run(() => api.patch(`/routes/${id}`, patch));
export const dropRoute = (id) => run(() => api.del(`/routes/${id}`), `Маршрут расформирован, заявки вернулись в свободные.`);
export const addStop = (routeId, requestId) => run(() => api.post(`/routes/${routeId}/stops`, { request_id: requestId }));
export const dropStop = (routeId, requestId) => run(() => api.del(`/routes/${routeId}/stops/${requestId}`));
export const moveStop = (routeId, requestId, delta) => run(() => api.post(`/routes/${routeId}/stops/${requestId}/move`, { delta }));
export const callStop = (routeId, requestId, result) => run(() => api.post(`/routes/${routeId}/stops/${requestId}/call`, { result }));
export const sendChat = (routeId, text) => run(() => api.post(`/routes/${routeId}/chat`, { text }));

/* ── лист ожидания ───────────────────────────────────────── */

export const markUnserved = (routeId, requestId, reason, note) => run(
  () => api.post(`/routes/${routeId}/stops/${requestId}/unserved`, { reason, note }),
  `Адрес отмечен не обслуженным и ушёл в лист ожидания.`);

export const clearUnserved = (routeId, requestId) => run(
  () => api.del(`/routes/${routeId}/stops/${requestId}/unserved`), 'Отметка снята, адрес снова в работе.');

export const waitToRoute = (waitId, routeId) => run(
  () => api.post(`/wait-list/${waitId}/to-route`, { route_id: routeId }),
  `Адрес поставлен в маршрут ${routeId} на сегодня.`);

export const waitDrop = (waitId) => run(() => api.post(`/wait-list/${waitId}/drop`), 'Запись снята с листа ожидания.');
export const waitCancel = (waitId) => run(() => api.post(`/wait-list/${waitId}/cancel`), 'Заявка отменена.');

/* ── акт ─────────────────────────────────────────────────── */

export const addDevice = (requestId, body) => run(() => api.post(`/requests/${requestId}/devices`, body));
export const dropDevice = (id) => run(() => api.del(`/devices/${id}`));
export const setReplacement = (id, mode) => run(() => api.post(`/devices/${id}/replacement`, { mode }));
export const closeAct = (requestId, payment) => run(
  () => api.post(`/requests/${requestId}/close`, payment || {}),
  `Позиция закрыта, акт записан.`);
export const reopenAct = (requestId) => run(() => api.post(`/requests/${requestId}/reopen`), 'Позиция возвращена в работу.');

/* ── фото работ ──────────────────────────────────────────── */

/* Кадр в хранилище идёт мимо сервера. Порядок такой: просим подписанную ссылку,
   кладём снимок прямо в Object Storage, подтверждаем — и только тогда сервер
   записывает кадр в акт и делает миниатюру. Между вторым и третьим шагом файл
   в бакете уже лежит, но в акте его ещё нет: это и значит «кадр не долетел»,
   если связь оборвалась. Повторная съёмка такой объект не трогает — у нового
   кадра свой ключ. */
export async function uploadPhoto(deviceId, blob, name) {
  const slot = await api.post(`/devices/${deviceId}/photos/upload`,
    { size: blob.size, content_type: blob.type || 'image/jpeg' });
  const put = await fetch(slot.url, {
    method: 'PUT', body: blob, headers: { 'content-type': slot.content_type },
  }).catch(() => null);
  if (!put || !put.ok) throw new Error('Кадр не ушёл в хранилище — попробуйте ещё раз.');
  const t = new Date().toTimeString().slice(0, 5);
  return api.post(`/devices/${deviceId}/photos`, { key: slot.key, name: name || '', taken_at: t });
}

/** Убрать кадр из акта. Доступно руководителю; файл в хранилище остаётся. */
export const dropPhoto = (id) => run(() => api.del(`/photos/${id}`), 'Кадр убран из акта.');

/* Поле прибора правится на месте и уходит на сервер с задержкой: перерисовывать
   страницу на каждую букву нельзя — каретка уедет из поля. Ответ картинку не
   трогает, а вот отказ сервера показываем и перечитываем экран. */
const pending = new Map();
export function patchDevice(id, patch, delay = 600) {
  const waiting = pending.get(id) || { patch: {}, timer: null };
  Object.assign(waiting.patch, patch);
  clearTimeout(waiting.timer);
  waiting.timer = setTimeout(async () => {
    const body = waiting.patch;
    pending.delete(id);
    try {
      await api.patch(`/devices/${id}`, body);
    } catch (err) {
      if (!err?.offline) toast(err?.message || 'Строка прибора не сохранилась.');
      await reload();
    }
  }, delay);
  pending.set(id, waiting);
}

/** Дописать в базу всё, что ещё не ушло: перед закрытием акта и перед уходом со страницы. */
export async function flushDevices() {
  const ids = [...pending.keys()];
  for (const id of ids) {
    const waiting = pending.get(id);
    clearTimeout(waiting.timer);
    pending.delete(id);
    await api.patch(`/devices/${id}`, waiting.patch).catch(() => {});
  }
}

/* ── деньги ──────────────────────────────────────────────── */

export const setPayment = (requestId, body) => run(() => api.put(`/requests/${requestId}/payment`, body));

/* Отметка оплаты у закрытого акта правится теми же полями, что и строка прибора:
   с задержкой и без перерисовки по ответу — иначе сумма не даётся набрать. */
const payTimers = new Map();
export function savePayment(r, delay = 600) {
  clearTimeout(payTimers.get(r.id));
  payTimers.set(r.id, setTimeout(async () => {
    payTimers.delete(r.id);
    const p = r.pay || {};
    try {
      await api.put(`/requests/${r.id}/payment`, { method: p.method, amount: p.amount || 0, note: p.note || '' });
    } catch (err) {
      if (!err?.offline) toast(err?.message || 'Отметка оплаты не сохранилась.');
      await reload();
    }
  }, delay));
}

export const takeHandover = (staffId, period, amount, at, note) => run(
  () => api.post('/handovers', { staff_id: staffId, period, amount, at, note }),
  () => {
    closeModal();
    return `${nameOf(staffId)}: принято ${money(amount)} от ${ru(at)}.`;
  });

/* ── учётные записи (пункт be-users) ─────────────────────── */
/* Временный пароль приходит в ответе один раз; экран показывает его сам и
   больше нигде не хранит. Своё дело здесь — запрос, перечитывание и подсказка. */

export const createStaff = (body) => run(() => api.post('/staff', body));
export const patchStaff = (id, body, said) => run(() => api.patch(`/staff/${id}`, body), said);
export const resetPassword = (id) => run(() => api.post(`/staff/${id}/password/reset`));
export const closeSessions = (id, said) => run(() => api.post(`/staff/${id}/sessions/close`), said);

/* ── справочники ─────────────────────────────────────────── */

export const patchService = (id, patch) => run(() => api.patch(`/services/${id}`, patch));
export const setSkills = (staffId, svcs) => run(() => api.put(`/staff/${staffId}/skills`, { svcs }));

/** Шаблон уведомления. Подстановки проверяет сервер: отказ приходит текстом
 *  «Неизвестная подстановка {…}» и показывается подсказкой, как любое правило. */
export const saveTemplate = (event, channel, patch) => run(
  () => api.put(`/notify/templates/${encodeURIComponent(event)}/${channel}`, patch),
  `Шаблон «${event}» (${channel === 'sms' ? 'СМС' : 'письмо'}) сохранён.`);

/* ── подсказка дат и клиент по номеру ────────────────────── */

/** История клиента по номеру. Экран приёма считает её по S.requests — поэтому
 *  ответ не показываем отдельно, а докладываем заявки клиента в тот же список:
 *  и плашка «клиент уже обращался», и проверка дублей работают прежним кодом. */
export async function fetchClient(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^[78]/, '').slice(0, 10);
  if (digits.length < 10 || S.clientDigits === digits) return;
  S.clientDigits = digits;
  try {
    const { history } = await api.get(`/clients?${new URLSearchParams({ phone: digits })}`);
    mergeRequests(history);
    render();
  } catch (err) {
    // История — подсказка, а не условие приёма: молча обходимся без неё.
    S.clientDigits = null;
  }
}

/** Открыть или закрыть конструктор маршрутов: он же замок даты на сервере. */
export const openBuilder = (date) => api.post(`/route-builder/${date}`).catch(() => {});
export const closeBuilder = (date) => api.del(`/route-builder/${date}`).catch(() => {});

/** Первая загрузка после входа плюс срез текущего экрана. */
export const bootView = () => loadView(S.view);

export const period = () => S.mMonth || CUR_M;
