/* Журнал действий (пункт be-audit).
 *
 * Экран руководителя: кто, когда и что именно поменял. Строка раскрывается в
 * разницу по полям — в ней и смысл журнала: «заявку перенесли» без «с какого
 * числа на какое» никому не помогает.
 *
 * Отбор живёт в S.auditF и в рабочем режиме уезжает на сервер: три года
 * журнала — это сотни тысяч строк, и тянуть их во вкладку незачем. Тот же
 * отбор применяется и здесь, на пришедших строках: в демо-режиме сервера нет,
 * а повторная проверка того, что уже отобрано, ничего не портит.
 */

import { S, nameOf } from '../state.js';
import { DATE, SEL } from '../ui/controls.js';
import { esc, ru } from '../util.js';
import { cap, shell } from '../ui/shell.js';
import { render, toast } from '../ui/render.js';
import { isDemo, API_BASE } from '../api/mode.js';
import { reload } from '../api/load.js';

/* ---------- словари ---------- */
/* Сущности названы так, как их называет руководитель, а не так, как таблицы. */
const ENTITIES = [
  {v:'requests',l:'Заявки'}, {v:'routes',l:'Маршруты'}, {v:'devices',l:'Приборы в акте'},
  {v:'payments',l:'Оплаты'}, {v:'services',l:'Услуги и прайс'}, {v:'staff',l:'Сотрудники и вход'},
  {v:'clients',l:'Клиенты'}, {v:'calls',l:'Звонки'}, {v:'photos',l:'Фото актов'},
  {v:'days',l:'Планирование дня'}, {v:'absences',l:'Отсутствия'}, {v:'wait_list',l:'Лист ожидания'},
  {v:'handovers',l:'Подотчёт'}, {v:'route_builder',l:'Конструктор маршрутов'},
  {v:'audit_log',l:'Сам журнал'}
];
const ENTITY_NAME = Object.fromEntries(ENTITIES.map(x=>[x.v,x.l]));
const ACTIONS = ['создание','изменение','удаление','просмотр','прослушивание','выгрузка','вход','выход','неудачный вход'];
/* Действия, о которых руководитель судит по-разному: правка данных, обращение
   к персональным данным и всё, что связано со входом. */
const KIND = {'создание':'ch','изменение':'ch','удаление':'ch',
  'просмотр':'pd','прослушивание':'pd','выгрузка':'pd',
  'вход':'in','выход':'in','неудачный вход':'in'};
/* Столбцы базы по-русски. Чего в словаре нет — показывается как есть: журнал
   переживает изменение схемы, и новое поле должно быть видно сразу, а не после
   правки этого списка. */
const FIELD = {
  date:'Дата выезда', time_slot:'Окно приезда', status:'Статус', city:'Город', street:'Улица',
  house:'Дом', flat:'Квартира', entrance:'Подъезд', floor:'Этаж', intercom:'Домофон',
  name:'Клиент', phone:'Телефон', phone2:'Второй телефон', contact:'Контактное лицо',
  email:'Почта', inn:'ИНН', client_type:'Тип клиента', svcs:'Услуги',
  comment_operator:'Комментарий оператора', comment_verifier:'Комментарий поверителю',
  route_id:'Маршрут', verifier_id:'Поверитель', operator_id:'Оператор',
  price_person:'Цена физлицу', price_pensioner:'Цена пенсионеру', price_org:'Цена юрлицу',
  rate_verifier:'Ставка поверителя', rate_operator:'Ставка оператора', active:'В работе',
  method:'Способ оплаты', amount:'Сумма', taken:'Деньги приняты', plan:'План по городам',
  cities:'Города дня', crew:'Смена поверителей', ops:'Смена операторов',
  deleted_at:'Убрано', deleted_by:'Кто убрал', serial:'Заводской номер', reading:'Показание',
  storage_key:'Ключ в хранилище', отказ:'Отказ сервера', login:'Логин', phone_norm:'Телефон (ключ)'
};
const fieldName = k => FIELD[k] || k;

/* ---------- отбор ---------- */
const blankAudit = () => ({actor:'',entity:'',action:'',from:'',to:'',q:''});
/* Строки, пришедшие последними, показываются первыми — как их и отдаёт сервер. */
function auditRows(){
  const F = S.auditF || (S.auditF = blankAudit());
  const day = e => String(e.at).slice(0,10);
  return (S.audit||[]).filter(e =>
    (!F.actor || e.actor_id===F.actor) &&
    (!F.entity || e.entity===F.entity) &&
    (!F.action || e.action===F.action) &&
    (!F.from || day(e)>=F.from) &&
    (!F.to || day(e)<=F.to) &&
    (!F.q || `${e.entity_id||''} ${JSON.stringify(e.before||{})} ${JSON.stringify(e.after||{})}`
      .toLowerCase().includes(F.q.toLowerCase())));
}
/* Отбор меняется — в рабочем режиме за строками идём на сервер заново:
   во вкладке лежит только показанный кусок, а не весь журнал. */
function auditSet(k,v){
  S.auditF = {...(S.auditF||blankAudit()), [k]: v===undefined||v===null?'':String(v)};
  S.auditOpen = null;
  if(!isDemo()) return reload();
  render();
}
function auditReset(){ S.auditF = blankAudit(); S.auditOpen = null; if(!isDemo()) return reload(); render(); }
function auditRow(id){ S.auditOpen = S.auditOpen===String(id)?null:String(id); render(); }

/* ---------- разница по полям ---------- */
const val = v => v===null||v===undefined||v===''
  ? '<span class="note">—</span>'
  : typeof v==='object' ? esc(JSON.stringify(v)) : esc(String(v));
function diffRows(e){
  const was = e.before||{}, now = e.after||{};
  return [...new Set([...Object.keys(was),...Object.keys(now)])]
    .map(k=>({k,was:was[k],now:now[k],only:!(k in was)}));
}
/* Короткая выжимка для строки списка: полный разбор — в раскрытии. */
function summary(e){
  const rows = diffRows(e);
  if(!rows.length) return '<span class="note">—</span>';
  const head = rows.slice(0,2).map(d=>d.only
    ? `${esc(fieldName(d.k))}: ${val(d.now)}`
    : `${esc(fieldName(d.k))}: ${val(d.was)} → ${val(d.now)}`).join('; ');
  return head + (rows.length>2?` <span class="note">и ещё ${rows.length-2}</span>`:'');
}
const when = at => {
  const d = new Date(at);
  const p = n => String(n).padStart(2,'0');
  return `${ru(String(at).slice(0,10))} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const actionTag = a => `<span class="tg ${a==='неудачный вход'?'t-err':KIND[a]==='pd'?'t-warn':KIND[a]==='in'?'t-cold':'t-mut'}">${esc(a)}</span>`;

/* ---------- выгрузка ---------- */
/* Те же столбцы, что у сервера: руководитель выгружает то, что видит.
   В рабочем режиме файл собирает сервер — и записывает выгрузку в журнал. */
function auditExport(){
  const F = S.auditF || blankAudit();
  if(!isDemo()){
    const p = new URLSearchParams(Object.entries({actor_id:F.actor,entity:F.entity,action:F.action,
      from:F.from,to:F.to,q:F.q}).filter(([,v])=>v));
    location.href = `${API_BASE}/audit/export.csv${p.toString()?'?'+p:''}`;
    return toast('Выгрузка журнала пошла в файл — она и сама записана в журнал.');
  }
  const cell = v => /[";\n]/.test(String(v??'')) ? `"${String(v).replace(/"/g,'""')}"` : String(v??'');
  const text = rows => diffRows(rows).map(d=>d.only
    ? `${d.k}: ${d.now??'—'}` : `${d.k}: ${d.was??'—'} → ${d.now??'—'}`).join('; ');
  const csv = '﻿' + [['Время','Сотрудник','Роль','Действие','Сущность','Запись','Изменения','Адрес'].join(';'),
    ...auditRows().map(e=>[when(e.at),e.actor_name||nameOf(e.actor_id),e.actor_role||'',e.action,
      e.entity,e.entity_id||'',text(e),e.ip||''].map(cell).join(';'))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download = `audit-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Выгружено записей: ${auditRows().length}.`);
}

/* ---------- экран ---------- */
function viewAudit(){
  const F = S.auditF || (S.auditF = blankAudit());
  const rows = auditRows();
  const total = isDemo() ? rows.length : (S.auditTotal ?? rows.length);
  const people = [{v:'',l:'Все сотрудники'},
    ...S.staff.map(p=>({v:p.id,l:p.name})).sort((a,b)=>a.l.localeCompare(b.l))];
  const count = k => rows.filter(e=>KIND[e.action]===k).length;
  const open = S.auditOpen;

  return shell(null,`${cap()}
  <div class="c"><h3>Отбор</h3>
    <p class="cap">Журнал хранится три года. Записи не правятся и не удаляются — ни с экрана, ни через API.</p>
    <div class="row">
      <div class="f" style="width:190px"><label>Сотрудник</label>
        ${SEL('aud-who',F.actor,people,v=>auditSet('actor',v))}</div>
      <div class="f" style="width:190px"><label>Сущность</label>
        ${SEL('aud-ent',F.entity,[{v:'',l:'Все'},...ENTITIES],v=>auditSet('entity',v))}</div>
      <div class="f" style="width:170px"><label>Действие</label>
        ${SEL('aud-act',F.action,[{v:'',l:'Любое'},...ACTIONS],v=>auditSet('action',v))}</div>
      <div class="f" style="width:150px"><label>С даты</label>${DATE('aud-from',F.from,v=>auditSet('from',v))}</div>
      <div class="f" style="width:150px"><label>По дату</label>${DATE('aud-to',F.to,v=>auditSet('to',v))}</div>
      <div class="f" style="flex:1;min-width:190px"><label>Номер заявки или слово</label>
        <input id="aud-q" class="fld mono" value="${esc(F.q)}" placeholder="R-1207"
          onchange="auditSet('q',this.value)"></div>
    </div>
    <div class="row" style="margin-top:2px;align-items:center">
      <button class="g sm" onclick="auditReset()">Сбросить отбор</button>
      <button class="b sm" onclick="auditExport()">Выгрузить CSV</button>
      <div style="flex:1"></div>
      <span class="note">Показано ${rows.length} из ${total}${rows.length<total?' — уточните отбор, чтобы увидеть остальное':''}.</span>
    </div>
  </div>
  <div class="kpi">
    <div><div class="v">${total}</div><div class="k">записей в отборе</div></div>
    <div><div class="v">${count('ch')}</div><div class="k">изменений данных</div></div>
    <div><div class="v">${count('pd')}</div><div class="k">обращений к перс. данным</div></div>
    <div><div class="v" ${rows.some(e=>e.action==='неудачный вход')?'style="color:var(--error)"':''}>${rows.filter(e=>e.action==='неудачный вход').length}</div>
      <div class="k">неудачных входов</div></div>
  </div>
  <div class="c"><h3>Записи</h3>
    <p class="cap">Строка раскрывается: видно, какое поле чем было и чем стало.</p>
    ${rows.length?`<table class="audit"><thead><tr><th>Время</th><th>Сотрудник</th><th>Действие</th>
      <th>Сущность</th><th>Запись</th><th>Что изменилось</th><th>Адрес</th></tr></thead><tbody>
      ${rows.map(e=>{const on = open===String(e.id);
        return `<tr class="ln ${on?'on':''}" onclick="auditRow('${e.id}')" title="Показать разницу по полям">
          <td class="mono">${when(e.at)}</td>
          <td>${e.actor_id?`<b>${esc(e.actor_name||nameOf(e.actor_id))}</b>`:'<span class="note">не определён</span>'}
            ${e.actor_role?`<span class="tg t-mut">${esc(e.actor_role)}</span>`:''}</td>
          <td>${actionTag(e.action)}</td>
          <td>${esc(ENTITY_NAME[e.entity]||e.entity)}</td>
          <td class="mono">${esc(e.entity_id||'—')}</td>
          <td>${summary(e)}</td>
          <td class="mono note">${esc(e.ip||'—')}</td></tr>
        ${on?`<tr class="dif"><td colspan="7">
          <table class="inner"><thead><tr><th>Поле</th><th>Было</th><th>Стало</th></tr></thead><tbody>
            ${diffRows(e).map(d=>`<tr><td>${esc(fieldName(d.k))}</td>
              <td>${d.only?'<span class="note">—</span>':val(d.was)}</td><td>${val(d.now)}</td></tr>`).join('')
              || '<tr><td colspan="3"><span class="note">Действие без правки полей.</span></td></tr>'}
          </tbody></table>
          <p class="note" style="margin-top:8px">Браузер: ${esc(e.user_agent||'—')}</p></td></tr>`:''}`}).join('')}
    </tbody></table>`
    :'<div class="empty">По этому отбору записей нет.</div>'}</div>`);
}

export { auditExport, auditReset, auditRow, auditRows, auditSet, blankAudit, viewAudit };
