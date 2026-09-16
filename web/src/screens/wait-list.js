/* Лист ожидания. */

import { I, svg } from '../ui/icons.js';
import { S, nameOf } from '../state.js';
import { TODAY, esc, pad, ru } from '../util.js';
import { WAIT_REASONS } from '../refs.js';
import { addToRoute, routesToday } from './support.js';
import { addrOf } from '../rules.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { clearUnserved as apiClearUnserved, markUnserved as apiMarkUnserved,
  waitCancel as apiWaitCancel, waitDrop as apiWaitDrop, waitToRoute as apiWaitToRoute } from '../api/actions.js';

/* ============ ЛИСТ ОЖИДАНИЯ ============
   Точку, которую не удалось выполнить, поверитель отмечает не обслуженной с причиной.
   Заявка уходит в ожидание, а оператор решает: перенести на дату, поставить в маршрут
   сегодня или отменить. Пока решения нет — запись висит в листе и считается в бейдже. */
const waitsNew = () => S.waits.filter(w=>w.state==='не обработана');
const waitOf = id => S.waits.find(w=>w.req===id && w.state==='не обработана');
const waitTag = w => w.state==='перенесена' ? `<span class="tg t-cold">перенесена на ${ru(w.to)}</span>`
  : w.state==='отменена' ? '<span class="tg t-err">отменена</span>'
  : w.state==='снята' ? '<span class="tg t-mut">снята с листа</span>'
  : '<span class="tg t-warn">не обработана</span>';
/* В лист попадают записи двух родов: адрес, который не удалось обслужить, и адрес,
   где прибор признан непригодным, а клиент отложил замену. Работа со вторыми другая:
   заявка там выполнена и оплачена, переносить и отменять её нельзя — оператор звонит
   и оформляет замену отдельной заявкой. */
const isRepl = w => w.kind==='замена';
/* Поверитель: отметка «не обслужена» с причиной. */
function openUnserved(id,i){ S.uns = {reason:WAIT_REASONS[0],note:''}; S.modal = {k:'uns',id,i}; render(); }
function markUnserved(){
  const rt = S.routes.find(r=>r.id===S.modal.id); if(!rt) return;
  const s = rt.stops[S.modal.i], r = s && S.requests.find(x=>x.id===s.req); if(!r) return;
  const K = S.uns || {reason:WAIT_REASONS[0],note:''}, note = (K.note||'').trim();
  if(K.reason==='Другое' && !note) return toast('Причина «другое» — опишите словами, оператор будет звонить клиенту.');
  if(!isDemo()){
    S.modal = null; S.uns = null; S.openStop = null;
    return apiMarkUnserved(rt.id,r.id,K.reason,note);
  }
  const now = new Date();
  s.unserved = {reason:K.reason,note,at:`${TODAY} ${pad(now.getHours())}:${pad(now.getMinutes())}`,by:rt.verifier};
  s.done = false;
  r.status = 'ожидание';
  S.waits.push({id:'W'+(++S.seq),req:r.id,route:rt.id,city:r.city,reason:K.reason,note,
    at:s.unserved.at,by:rt.verifier,state:'не обработана',to:null});
  S.modal = null; S.uns = null; S.openStop = null;
  toast(`${r.id}: ${addrOf(r)} — не обслужена, ${K.reason.toLowerCase()}. Заявка ушла в лист ожидания оператора.`);
}
/* Ошибся — пока оператор не взялся за запись, отметку можно снять. */
function clearUnserved(id,i){
  const rt = S.routes.find(r=>r.id===id); if(!rt) return;
  const s = rt.stops[i], r = s && S.requests.find(x=>x.id===s.req); if(!r) return;
  if(!isDemo()) return apiClearUnserved(rt.id,r.id);
  const w = waitOf(r.id); if(w) S.waits = S.waits.filter(x=>x!==w);
  s.unserved = null; r.status = r.routeId ? 'в маршруте' : 'создана';
  toast(`${r.id}: отметка снята, точка снова в работе.`);
}
/* Оператор: поставить не обслуженный адрес в маршрут сегодня. Старая точка остаётся
   во вчерашнем маршруте следом неудачного выезда — по ней виден срыв. */
function waitToRoute(wid,rtId){
  const w = S.waits.find(x=>x.id===wid); if(!w) return;
  if(!isDemo()) return apiWaitToRoute(wid,rtId);
  const rt = S.routes.find(x=>x.id===rtId), r = S.requests.find(x=>x.id===w.req);
  if(!rt||!r) return;
  r.date = rt.date; r.status = 'создана';
  w.state = 'перенесена'; w.to = rt.date;
  addToRoute(rt.id,r.id);
}
/* Запись о нужной замене оператор закрывает сама по себе: либо он принял новую
   заявку на замену обычным приёмом, либо клиент окончательно отказался. Выполненную
   заявку это не трогает — работа по ней сдана и оплачена. */
function waitDrop(wid){
  const w = S.waits.find(x=>x.id===wid); if(!w) return;
  if(!isDemo()) return apiWaitDrop(wid);
  w.state = 'снята'; w.to = null;
  toast(`${w.req}: замена снята с листа ожидания. Если клиент согласился — примите отдельную заявку на замену.`);
}
function waitCancel(wid){
  const w = S.waits.find(x=>x.id===wid); if(!w) return;
  if(!isDemo()) return apiWaitCancel(wid);
  const r = S.requests.find(x=>x.id===w.req);
  w.state = 'отменена'; w.to = null;
  if(r) r.status = 'отменена';
  toast(`${w.req}: заявка отменена, адрес снят с листа ожидания.`);
}
function waitList(){
  const list = [...S.waits].sort((a,b)=>
    (a.state==='не обработана'?0:1)-(b.state==='не обработана'?0:1) || b.at.localeCompare(a.at));
  const nw = waitsNew().length, today_ = routesToday();
  const nr = waitsNew().filter(isRepl).length;
  return `<div class="c"><h3>Лист ожидания · ${nw}</h3>
    <p class="cap">Адреса, которые поверитель не смог обслужить. Оператор звонит клиенту и решает:
      перенести на другую дату в карточке заявки, поставить в маршрут сегодня или отменить.
      Сюда же попадают адреса с отложенной заменой${nr?` · сейчас их ${nr}`:''}: прибор признан непригодным, а менять его клиент пока отказался —
      по ним оператор звонит и оформляет замену отдельной заявкой.</p>
    ${list.length?`<table><thead><tr><th>Заявка</th><th>Адрес</th><th>Город</th><th>Причина</th><th>Когда и кто</th><th>Состояние</th><th>Действия</th></tr></thead><tbody>
      ${list.map(w=>{
        const r = S.requests.find(x=>x.id===w.req); if(!r) return '';
        const open = w.state==='не обработана', fit = today_.filter(rt=>rt.city===r.city);
        return `<tr class="wtr ${open?'':'off'}"><td class="mono">${w.req}</td>
          <td style="min-width:170px"><b>${esc(addrOf(r))}</b><small>${esc(r.name)}</small></td>
          <td>${esc(w.city)}</td>
          <td style="min-width:150px">${isRepl(w)?'<span class="tg t-err">нужна замена</span>':esc(w.reason)}${w.note?`<small>${esc(w.note)}</small>`:''}</td>
          <td class="mono" style="white-space:nowrap">${ru(w.at.slice(0,10))} ${w.at.slice(11)}<small>${esc(nameOf(w.by))}</small></td>
          <td>${waitTag(w)}</td>
          <td style="width:250px">${open?isRepl(w)?`<div class="wact">
            <button class="g sm" onclick="startCall('${esc(r.phone)}','основной','${esc(r.name)}')">${svg(I.phone,12)}Позвонить</button>
            <button class="g sm" title="Клиент отказался или заявка на замену уже принята" onclick="waitDrop('${w.id}')">Снять с листа</button>
          </div>`:`<div class="wact">
            <button class="g sm" onclick="openReq('${w.req}')">Перенести на дату</button>
            ${fit.length?fit.map(rt=>`<button class="g sm" title="${rt.city} · ${rt.stops.length} точек · ${rt.status}"
              onclick="waitToRoute('${w.id}','${rt.id}')">В ${rt.id} сегодня</button>`).join('')
              :'<span class="note">сегодня нет маршрута по этому городу</span>'}
            <button class="ib sm no" title="Отменить заявку" onclick="waitCancel('${w.id}')">${svg(I.no,13)}</button>
          </div>`:`<span class="note">решение принято</span>`}</td></tr>`}).join('')}
    </tbody></table>`
    :`<div class="empty">Все выезды закрыты — не обслуженных адресов нет.</div>`}</div>`;
}
/* Карточка заявки правится поверх страницы: копия, чтобы «Отмена» ничего не портила. */

export { clearUnserved, isRepl, markUnserved, openUnserved, waitCancel, waitDrop, waitList, waitOf, waitTag, waitToRoute, waitsNew };
