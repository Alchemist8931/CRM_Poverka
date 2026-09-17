/* Телефония в рабочем режиме (пункт int-novofon).
 *
 * Три нитки между пультом и сервером:
 *   линия      — «на смене» и «пауза» уходят в /calls/line, оттуда — в АТС;
 *   звонок     — кнопка «Вызов» в карточке просит АТС соединить (/calls/dial);
 *   события    — сервер толкает входящие, ответы и завершения потоком SSE, и
 *                пульт поднимает полосу входящего с карточкой клиента.
 *
 * Трубку снимает и кладёт софтфон оператора, не CRM: у АТС нет команды «ответить
 * из браузера». Поэтому здесь нет ни «принять», ни «завершить» — только то, что
 * система знает и показывает. В демо-режиме этот модуль не зовётся: там звонки
 * имитирует пульт сам (screens/op-console.js).
 */

import { api } from './client.js';
import { S } from '../state.js';
import { render } from '../ui/render.js';

/** Отметка линии. Ответ говорит, дошла ли она до АТС (`synced`). */
export const setLine = (on_shift, paused) => api.post('/calls/line', { on_shift, paused: !!paused });

/** Позвонить клиенту: АТС сначала звонит оператору, потом клиенту. */
export const dial = (phone, request_id) => api.post('/calls/dial', request_id ? { phone, request_id } : { phone });

/* Что делать с событием, решает пульт: он регистрирует обработчики здесь, а
   модуль их только зовёт. Так поток не знает ни форм, ни экранов. */
const hooks = {};
export const onCall = (h) => Object.assign(hooks, h);

let es = null;

/** Событие с шины сервера → состояние пульта. Возвращает true, если экран
 *  надо перерисовать. Вынесено из подписки, чтобы проверяться без браузера. */
export function applyCallEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const O = S.op;
  if (ev.direction === 'исходящий') {
    // Звонок из карточки: окно вызова ведут события, а не таймер.
    const c = S.call;
    if (ev.kind === 'ответ' && c) { c.st = 'разговор'; c.t0 = Date.now(); return true; }
    if ((ev.kind === 'завершение' || ev.kind === 'пропущен') && c) {
      hooks.hangup?.(c, ev);
      return true;
    }
    return false;
  }
  if (ev.direction !== 'входящий') return false;
  const num = ev.phone || ev.from || '';
  switch (ev.kind) {
    case 'входящий':
      O.inc = { num, t0: Date.now(), client: ev.client || null, history: ev.history || [], call_id: ev.call_id || null };
      return true;
    case 'ответ':
      O.live = { num: O.inc?.num || num, t0: Date.now(), client: O.inc?.client || ev.client || null, call_id: ev.call_id || O.inc?.call_id || null };
      O.inc = null;
      O.calls++;
      hooks.answered?.(O.live);
      return true;
    case 'завершение':
      if (O.live) { O.talkSec += Math.floor((Date.now() - O.live.t0) / 1000); O.live = null; O.acw = 12; }
      O.inc = null;
      return true;
    case 'пропущен':
      if (O.inc) { O.inc = null; O.missed++; }
      return true;
    default:
      return false;
  }
}

/** Открыть поток событий. Повторный вызов ничего не делает; обрыв связи
 *  EventSource переживает сам — переподключается с той же cookie. */
export function listenCalls() {
  if (es || typeof EventSource !== 'function') return;
  es = new EventSource('/api/calls/stream', { withCredentials: true });
  es.onmessage = (e) => {
    let ev = null;
    try { ev = JSON.parse(e.data); } catch (err) { return; }
    if (applyCallEvent(ev)) render();
  };
  // Отметка линии живёт на сервере: открытая заново вкладка её не теряет.
  api.get('/calls/line').then((line) => {
    if (!line) return;
    S.op.on = !!line.on_shift;
    S.op.from = line.on_shift ? Date.now() : null;
    S.op.sentPause = !!line.paused;
    render();
  }).catch(() => { /* линия — не условие работы */ });
}

export function stopCalls() {
  if (es) { es.close(); es = null; }
}

/** Отказ АТС в понятных словах: 503 — телефония к контуру не подключена,
 *  422 — учётка не связана с сотрудником АТС, остальное — как сказал сервер. */
export function explainDial(err, phone) {
  if (err?.status === 503) return `Телефония не подключена к этому контуру — наберите ${phone} в телефоне.`;
  return err?.message || 'Позвонить не удалось.';
}
