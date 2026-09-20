/* Услуги и ставки. */

import { S } from '../state.js';
import { SERVICES } from '../refs.js';
import { TODAY, addDays, esc, iso, today } from '../util.js';
import { absentOn, onShift, skillsOf } from '../rules.js';
import { CHK } from '../ui/controls.js';
import { cap, shell } from '../ui/shell.js';
import { render } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { patchService as apiPatchService, saveTemplate as apiSaveTemplate } from '../api/actions.js';

/* ---------- шаблоны уведомлений ----------
   Тексты, которые уходят клиенту, правит руководитель — здесь, а не выкладкой
   новой версии. Что именно можно подставить, знает сервер: он же и проверяет
   шаблон при сохранении, чтобы опечатка в скобках не уехала клиенту.

   Заготовки ниже нужны только демо-режиму: в рабочем режиме сюда кладёт ответ
   сервера загрузка экрана (api/load.js). */
const NOTIFY = {
  templates: [
    {event:'заявка',channel:'email',subject:'Заявка на {дата}: поверка счётчиков',
      body:'Здравствуйте, {имя}!\n\nВаша заявка принята на {дата}, ожидайте мастера с {окно_с} до {окно_до}.\nАдрес: {адрес}.\nУслуги: {услуги}.\nПредварительная стоимость: {сумма} ₽. Оплата на месте: {оплата}.\n\n{подпись}',active:true},
    {event:'заявка',channel:'sms',subject:'',
      body:'Заявка принята: {дата}, с {окно_с} до {окно_до}, {адрес}. Предварительно {сумма} р, оплата на месте. {контора}',active:true},
    {event:'напоминание',channel:'email',subject:'Напоминание: мастер приедет {дата}',
      body:'Здравствуйте, {имя}!\n\nНапоминаем: завтра, {дата}, с {окно_с} до {окно_до} к вам приедет мастер по адресу {адрес}.\n\n{подпись}',active:true},
    {event:'напоминание',channel:'sms',subject:'',
      body:'Завтра {дата} с {окно_с} до {окно_до} мастер по адресу {адрес}. Перенести: {телефон_конторы}. {контора}',active:true},
    {event:'выезд',channel:'email',subject:'Сегодня к вам приедет {поверитель}',
      body:'Здравствуйте, {имя}!\n\nСегодня, {дата}, к вам приедет наш поверитель {поверитель}.\nОкно прибытия: с {окно_с} до {окно_до}. Адрес: {адрес}.\n\n{подпись}',active:true},
    {event:'выезд',channel:'sms',subject:'',
      body:'Сегодня с {окно_с} до {окно_до} приедет {поверитель}, {адрес}. {контора}',active:true},
    {event:'перенос',channel:'email',subject:'Заявка перенесена на {дата}',
      body:'Здравствуйте, {имя}!\n\nВаша заявка перенесена с {прежняя_дата} на {дата}, окно прибытия с {окно_с} до {окно_до}.\n\n{подпись}',active:true},
    {event:'перенос',channel:'sms',subject:'',
      body:'Заявка перенесена на {дата}, с {окно_с} до {окно_до}, {адрес}. {контора}',active:true},
  ],
  placeholders:{}, allowed:{}, sender:{},
};
/* Ответ сервера кладётся сюда целиком: экран рисует то, что пришло. */
function setNotify(data){ Object.assign(NOTIFY,data); }

const EVENT_HINT = {
  'заявка':'уходит сразу после приёма заявки',
  'напоминание':'уходит накануне выезда в 18:00',
  'выезд':'уходит утром в день выезда, в 8:00',
  'перенос':'уходит, когда оператор переставил заявку на другую дату',
  'чек':'уходит, когда касса зарегистрировала чек по безналичной оплате и отправила его клиенту',
};

/* Блок шаблонов. Подстановки перечислены рядом с полем нарочно: без перечня
   их правят наугад, а неверную скобку сервер всё равно не примет. */
function viewTemplates(){
  const list = NOTIFY.templates || [];
  const names = Object.keys(NOTIFY.placeholders||{});
  return `<div class="c"><h3>Шаблоны уведомлений клиенту</h3>
    <p class="cap">Письмо и СМС уходят только тем, кто дал согласие при приёме заявки — галочка «Уведомления» в форме.
      Уведомления не заменяют обзвон накануне: дату по-прежнему подтверждает оператор голосом.
      ${NOTIFY.sender?.from?`Письма уходят с ящика <b class="mono">${esc(NOTIFY.sender.from)}</b> — он задаётся настройками контура, не здесь.`:''}</p>
    ${names.length?`<p class="cap">Подстановки: ${names.map(n=>`<span class="tg t-mut mono" title="${esc(NOTIFY.placeholders[n])}">{${n}}</span>`).join(' ')}</p>`:''}
    <table><thead><tr><th style="width:120px">Событие</th><th style="width:70px">Канал</th><th>Тема и текст</th><th style="width:96px">Отправляем</th></tr></thead><tbody>
      ${list.map((t,i)=>`<tr><td><b>${esc(t.event)}</b><div class="note">${esc(EVENT_HINT[t.event]||'')}</div></td>
        <td><span class="tg t-mut">${t.channel==='sms'?'СМС':'письмо'}</span></td>
        <td>${t.channel==='email'?`<input class="fld sm" id="tplS${i}" value="${esc(t.subject||'')}" placeholder="Тема письма" onchange="saveTpl(${i})">`:''}
          <textarea class="fld" id="tplB${i}" rows="${t.channel==='sms'?2:5}" onchange="saveTpl(${i})">${esc(t.body)}</textarea></td>
        <td><div class="chkbox">${CHK(t.active!==false,t.active!==false?'да':'нет',`tgTpl(${i})`)}</div></td></tr>`).join('')}
    </tbody></table></div>`;
}

/* Сохранение: текст уходит на сервер как есть, а он решает, годится ли.
   Отказ («неизвестная подстановка») показывается подсказкой поверх экрана. */
function saveTpl(i){
  const t = NOTIFY.templates[i];
  if(!t) return;
  const subject = document.getElementById('tplS'+i)?.value ?? t.subject ?? '';
  const body = document.getElementById('tplB'+i)?.value ?? t.body;
  if(!isDemo()) return apiSaveTemplate(t.event,t.channel,{subject,body,active:t.active!==false});
  t.subject = subject; t.body = body; render();
}
function tgTpl(i){
  const t = NOTIFY.templates[i];
  if(!t) return;
  const active = t.active===false;
  if(!isDemo()) return apiSaveTemplate(t.event,t.channel,{subject:t.subject||'',body:t.body,active});
  t.active = active; render();
}

function viewServices(){
  return shell(null,`${cap()}<div class="c"><h3>Прайс и сдельные ставки</h3>
    <p class="cap">Значения редактируются на месте — изменение сразу отражается в расчёте начислений.
      Пенсионный прайс влияет только на счёт клиенту: сдельные ставки поверителя и оператора остаются полными, скидку берёт на себя компания.</p>
    <table><thead><tr><th>Группа</th><th>Услуга</th><th class="num">Физлицо</th><th class="num">Пенсионер</th><th class="num">Юрлицо</th>
      <th class="num">Поверителю</th><th class="num">Оператору</th><th class="num">Доля ФОТ</th></tr></thead><tbody>
      ${SERVICES.map((s,i)=>`<tr><td><span class="tg t-mut">${s.grp}</span></td><td><b>${s.name}</b></td>
        ${['pF','pP','pU','rV','rO'].map(k=>`<td class="num"><input class="fld sm mono" style="width:80px;display:inline-flex;text-align:right" value="${s[k]}" onchange="setSvc(${i},'${k}',this.value)"></td>`).join('')}
        <td class="num">${Math.round((s.rV+s.rO)/s.pF*100)}%</td></tr>`).join('')}</tbody></table></div>
  <div class="c"><h3>Сотрудники</h3><p class="cap">Внутренние номера АТС и загрузка. Персональный номер оператора нужен для всплывающей карточки звонка.
    Услуги поверителя — его компетенции: если он в смене, эти услуги в этот день оказываются, и оператор видит дату в подсказке при приёме заявки.</p>
    <table><thead><tr><th>Сотрудник</th><th>Роль</th><th>Оказывает услуги</th><th class="num">Смен за 14 дней</th><th>Вн. номер</th><th class="num">Телефон</th><th>Сегодня</th></tr></thead><tbody>
      ${S.staff.map(p=>`<tr><td><b>${esc(p.name)}</b></td>
        <td><span class="tg t-mut">${p.role==='verifier'?'поверитель':p.role==='senior'?'старший':p.role==='supervisor'?'руководитель':'оператор'}</span></td>
        <td>${p.role==='verifier'
          ? `<div class="tgls sk">${SERVICES.map(s=>`<button class="tgl" aria-pressed="${skillsOf(p).includes(s.id)}"
              title="${esc(s.name)}" onclick="tgSkill('${p.id}','${s.id}')">${esc(s.sh)}</button>`).join('')}</div>`
          : '<span class="note">не выезжает</span>'}</td>
        <td class="num mono">${Array.from({length:14},(_,i)=>iso(addDays(today,i))).filter(ds=>onShift(p,ds)).length}</td>
        <td class="mono">${p.ext||'—'}</td><td class="num mono">${p.phone||'—'}</td>
        <td>${absentOn(p.id,TODAY)?'<span class="tg t-err">отсутствие</span>':onShift(p,TODAY)?'<span class="tg t-ok">в смене</span>':'<span class="tg t-mut">выходной</span>'}</td></tr>`).join('')}
    </tbody></table></div>
  ${viewTemplates()}`);
}
/* Прайс и ставки правит руководитель прямо в таблице. Имена полей на экране
   свои (pF, rV), в базе — свои: перевод один и тот же, что при чтении. */
const SVC_FIELD = {pF:'price_person', pP:'price_pensioner', pU:'price_org',
  rV:'rate_verifier', rO:'rate_operator'};
function setSvc(i,k,v){
  const value = Math.max(0,parseInt(v)||0);
  if(!isDemo()) return apiPatchService(SERVICES[i].id,{[SVC_FIELD[k]]:value});
  SERVICES[i][k] = value; render();
}

export { setSvc, viewServices, SVC_FIELD, saveTpl, setNotify, tgTpl };
