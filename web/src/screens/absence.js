/* Отсутствия. */

import { DATE } from '../ui/controls.js';
import { I, svg } from '../ui/icons.js';
import { S, nameOf } from '../state.js';
import { TODAY, addDays, esc, iso, ru, today } from '../util.js';
import { cap, shell } from '../ui/shell.js';
import { toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { decideAbsence as apiDecide, sendAbsence as apiSendAbsence } from '../api/actions.js';

/* ---------- отсутствия ---------- */
function viewAbsence(){
  const sup = S.role==='supervisor';
  const list = sup ? S.absences : S.absences.filter(a=>a.staff===S.me);
  const pend = list.filter(a=>a.status==='на согласовании');
  const A = S.absForm ||= {from:iso(addDays(today,3)),to:iso(addDays(today,5)),reason:''};
  const rows = l => `<table><thead><tr>${sup?'<th>Сотрудник</th>':''}<th class="num">С</th><th class="num">По</th><th class="num">Дней</th><th>Причина</th><th>Статус</th><th></th></tr></thead><tbody>
    ${l.map(a=>{const days=Math.round((new Date(a.to)-new Date(a.from))/864e5)+1;
      return `<tr>${sup?`<td><b>${esc(nameOf(a.staff))}</b></td>`:''}
      <td class="num">${ru(a.from)}</td><td class="num">${ru(a.to)}</td><td class="num">${days}</td>
      <td>${esc(a.reason)}</td>
      <td><span class="tg ${a.status==='согласовано'?'t-ok':a.status==='отклонено'?'t-err':'t-warn'}">${a.status}</span></td>
      <td style="text-align:right">${sup&&a.status==='на согласовании'
        ? `<button class="ib ok" title="Согласовать" onclick="decide('${a.id}','согласовано')">${svg(I.ok,13)}</button>
           <button class="ib no" title="Отклонить" onclick="decide('${a.id}','отклонено')">${svg(I.no,13)}</button>`
        : `<span class="note">${esc(a.comment||'—')}</span>`}</td></tr>`}).join('')}</tbody></table>`;
  return shell(null,`${cap()}
  ${sup?`<div class="c"><h3>На согласовании · ${pend.length}</h3>
    <p class="cap">Согласование убирает дни из графика и уменьшает ёмкость этих дат.</p>
    ${pend.length?rows(pend):`<div class="empty">Новых запросов нет.</div>`}</div>`:
   `<div class="c"><h3>Новый запрос</h3><p class="cap">Уходит руководителю операторов.</p>
    <div class="row">
      <div class="f" style="width:160px"><label>С какого числа</label>${DATE('abFrom',A.from,v=>{A.from=v;})}</div>
      <div class="f" style="width:160px"><label>По какое</label>${DATE('abTo',A.to,v=>{A.to=v;})}</div>
      <div class="f" style="flex:1;min-width:220px"><label>Причина</label>
        <input class="fld" value="${esc(A.reason)}" oninput="S.absForm.reason=this.value" placeholder="Семейные обстоятельства"></div>
      <button class="b" onclick="sendAbs()">Отправить запрос</button></div></div>`}
  <div class="c"><h3>${sup?'Все запросы':'История запросов'}</h3>
    ${list.length?rows(list):`<div class="empty">Запросов не было.</div>`}</div>`);
}
function decide(id,st){
  const a = S.absences.find(x=>x.id===id);
  if(!isDemo()) return apiDecide(id,st);
  a.status=st;
  a.comment = st==='согласовано'?'Согласовано '+ru(TODAY):'Отклонено '+ru(TODAY);
  toast(`Запрос ${nameOf(a.staff)}: ${st}. График и ёмкость пересчитаны.`);
}
function sendAbs(){
  const A = S.absForm;
  if(!A.reason.trim()) return toast('Укажите причину — руководителю нужен контекст.');
  if(!isDemo()) return apiSendAbsence(A.from,A.to,A.reason.trim())
    .then(()=>{ S.absForm = {from:iso(addDays(today,3)),to:iso(addDays(today,5)),reason:''}; });
  S.absences.unshift({id:'A'+(++S.seq),staff:S.me,from:A.from,to:A.to,reason:A.reason,status:'на согласовании',comment:''});
  S.absForm = {from:iso(addDays(today,3)),to:iso(addDays(today,5)),reason:''};
  toast('Запрос отправлен руководителю на согласование.');
}

export { decide, sendAbs, viewAbsence };
