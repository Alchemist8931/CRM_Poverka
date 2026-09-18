/* Модальный слой: карточка заявки, необслуженный адрес, чат маршрута. */

import { I, svg } from './icons.js';
import { S, nameOf } from '../state.js';
import { SEL } from './controls.js';
import { WAIT_REASONS } from '../refs.js';
import { addrOf } from '../rules.js';
import { clientHistory, dupGuard, dupPending, reqForm, reqTag } from '../screens/intake.js';
import { dayModal, opsModal } from '../screens/plan.js';
import { digitsOf } from './phone.js';
import { esc, ru } from '../util.js';
import { hoModal } from '../screens/money.js';
import { mailOk, supReqModal } from '../screens/op-console.js';
import { rcModal } from '../screens/route-builder.js';
import { render, toast } from './render.js';
import { isDemo } from '../api/mode.js';
import { patchReq as apiPatchReq } from '../api/actions.js';
import { waitOf } from '../screens/wait-list.js';
import { printButtons } from '../screens/print.js';

function openReq(id){
  const r = S.requests.find(x=>x.id===id); if(!r) return;
  S.edit = {...r, day:r.date};
  S.modal = {k:'req',id};
  render();
}
function saveReq(){
  const K = S.edit, r = S.requests.find(x=>x.id===S.modal.id);
  if(!r) return;
  if(!K.name.trim()) return toast('Имя клиента или организация не заполнены.');
  if(K.ctype==='Юрлицо' && ![10,12].includes(String(K.inn).replace(/\D/g,'').length))
    return toast('ИНН — 10 цифр у организации или 12 у ИП.');
  if(digitsOf(K.phone).length!==10) return toast('Телефон неполный: нужно 10 цифр после +7.');
  if(!mailOk(K.email)) return toast('Почта клиента введена с ошибкой — поправьте или очистите поле.');
  if(!K.house.trim()) return toast('Укажите номер дома.');
  if(dupGuard(K,K.day,r.id)) return;
  if(!isDemo()){
    apiPatchReq(r.id,K,K.day).then(out=>{ if(out){ S.modal=null; S.edit=null; render(); } });
    return;
  }
  ['ctype','name','inn','phone','contact','phone2','contact2','email','city','street','house',
   'entrance','floor','flat','intercom','time','cmtOp','cmtVf','svcs'].forEach(k=>r[k]=K[k]);
  const moved = r.date!==K.day;
  if(moved){ r.date = K.day; r.routeId = null; r.status = 'создана';
    S.routes.forEach(rt=>{ const j=rt.stops.findIndex(s=>s.req===r.id); if(j>=0) rt.stops.splice(j,1); });
    /* Перенос по дате — это и есть решение оператора по листу ожидания. */
    const w = waitOf(r.id); if(w){ w.state='перенесена'; w.to=r.date; } }
  S.modal = null; S.edit = null;
  toast(moved ? `${r.id} перенесена на ${ru(r.date)} и снята с маршрута — поставьте её в маршрут той даты.`
              : `${r.id} обновлена.`);
}
function closeModal(){ S.modal=null; S.edit=null; S.supReq=null; S.uns=null; S.ho=null; S.dupAsk=null; render(); }
function modalLayer(){
  if(!S.modal) return '';
  if(S.modal.k==='ho') return hoModal();
  if(S.modal.k==='day') return dayModal(S.modal.date);
  if(S.modal.k==='ops') return opsModal(S.modal.date);
  if(S.modal.k==='supreq') return supReqModal();
  if(S.modal.k==='uns') return unsModal();
  if(S.modal.k==='rc') return rcModal();
  if(S.modal.k==='chat'){
    const rt = S.routes.find(r=>r.id===S.modal.id); if(!rt){ S.modal=null; return ''; }
    return `<div class="mask" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="width:min(620px,94vw)">
        <div class="mhd"><h3>Чат маршрута ${rt.id}</h3>
          <span class="note">${rt.city} · ${rt.verifier?esc(nameOf(rt.verifier)):'поверитель не назначен'}</span>
          <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>
        ${chatPanel(rt)}
      </div></div>`;
  }
  const K = S.edit; if(!K){ S.modal=null; return ''; }
  const r = S.requests.find(x=>x.id===S.modal.id);
  return `<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <div class="mhd"><h3>Заявка ${S.modal.id}</h3>
        <span class="note">${reqTag(r.status)} · создана ${ru(r.created)}${r.routeId?' · маршрут '+r.routeId:''}</span>
        <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>
      ${reqForm(K,'S.edit','ed',K.day,v=>{K.day=v;})}
      ${clientHistory(r)}
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        ${printButtons(r)}
        <button class="g" onclick="closeModal()">Отмена</button>
        <button class="b long" onclick="saveReq()">${dupPending(K,K.day,r.id)?'Сохранить как вторую заявку':'Сохранить изменения'}</button></div>
    </div></div>`;
}
/* Отметка «не обслужена»: причина обязательна, у «другого» — ещё и текст. */
function unsModal(){
  const rt = S.routes.find(r=>r.id===S.modal.id); if(!rt){ S.modal=null; return ''; }
  const s = rt.stops[S.modal.i], r = s && S.requests.find(x=>x.id===s.req);
  if(!r){ S.modal=null; return ''; }
  if(!S.uns) S.uns = {reason:WAIT_REASONS[0],note:''};
  const K = S.uns;
  return `<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="width:min(560px,94vw)">
      <div class="mhd"><h3>Точка не обслужена</h3>
        <span class="note">${rt.id} · ${esc(addrOf(r))} · ${esc(r.name)}</span>
        <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>
      <p class="cap">Заявка уйдёт в лист ожидания оператора: он позвонит клиенту и назначит новую дату.</p>
      <div class="f"><label>Причина</label>
        ${SEL('unsR',K.reason,WAIT_REASONS,v=>{S.uns.reason=v; if(v!=='Другое') S.uns.note='';})}</div>
      <div class="f"><label>Что произошло${K.reason==='Другое'?' · обязательно':''}</label>
        <textarea class="fld" id="unsNote" placeholder="Коротко, своими словами — это увидит оператор"
          oninput="S.uns.note=this.value">${esc(K.note)}</textarea></div>
      <div class="row" style="margin-top:4px;justify-content:flex-end">
        <button class="g" onclick="closeModal()">Отмена</button>
        <button class="b" onclick="markUnserved()">Отметить не обслуженной</button></div>
    </div></div>`;
}
function chatPanel(rt){
  return `<p class="cap">Переписка дублируется руководителю без уведомлений.</p>
    <div class="chat">${rt.chat.length?rt.chat.map(m=>`<div class="msg ${m.vf?'v':''}"><b>${esc(m.who)}</b><small>${m.t}</small><br>${esc(m.txt)}</div>`).join('')
      :`<div class="empty">Сообщений нет. Поверитель напишет сюда, если что-то пойдёт не так.</div>`}</div>
    <div class="row" style="margin-top:10px;flex-wrap:nowrap">
      <input class="fld" id="chatin" placeholder="Сообщение поверителю">
      <button class="b" onclick="send('${rt.id}')">${svg(I.send,14)}</button></div>`;
}

export { chatPanel, closeModal, modalLayer, openReq, saveReq, unsModal };
