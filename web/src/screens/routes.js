/* Сборка маршрутов: список, карточка, обзвон. */

import { I, svg } from '../ui/icons.js';
import { S, nameOf } from '../state.js';
import { SEL } from '../ui/controls.js';
import { WD, addDays, esc, iso, pad, ru, today } from '../util.js';
import { badDevs, badTag } from '../refs.js';
import { cap, shell } from '../ui/shell.js';
import { chatPanel } from '../ui/modals.js';
import { crewOn, noPay, payLine, photoCount } from '../rules.js';
import { poolOf, stTag } from './support.js';
import { rcAssign } from './route-builder.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { callStop as apiCallStop, moveStop as apiMoveStop, patchRoute as apiPatchRoute,
  sendChat as apiSendChat } from '../api/actions.js';
import { waitOf } from './wait-list.js';

/* ---------- список маршрутов ---------- */
function viewRoutes(){
  const from = iso(addDays(today,-3));
  const list = S.routes.filter(r=>r.date>=from).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  const older = S.routes.length - list.length;
  const byDay = {}; list.forEach(rt=>(byDay[rt.date] ||= []).push(rt));
  return shell(null,`${cap()}
  <div class="row" style="margin-bottom:14px;align-items:center">
    <button class="b long" onclick="openRC('${iso(addDays(today,1))}')">${svg(I.plus,13)}Создать маршрут</button>
    <span class="note" style="flex:1">Маршрутов на ближайшие дни: <b class="mono" style="color:var(--ink)">${list.length}</b>${older?` · в архиве ещё ${older}`:''}</span>
  </div>
  ${Object.keys(byDay).length?Object.entries(byDay).map(([ds,rts])=>{
    const crew = crewOn(ds), noV = rts.filter(r=>!r.verifier).length;
    return `<div class="c"><div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
      <h3>${ru(ds)} · ${WD[new Date(ds+'T00:00:00').getDay()]}</h3>
      <span class="note">${rts.length} маршрут(ов) · ${rts.reduce((a,r)=>a+r.stops.length,0)} адресов · в смене ${crew.length} поверителей${noV?` · <span style="color:var(--warning)">без поверителя ${noV}</span>`:''}</span>
      <div style="flex:1"></div>
      <button class="g sm" onclick="openSupReq('${ds}')">${svg(I.plus,12)}Заявка на дату</button>
      <button class="g sm" onclick="openRC('${ds}')">${svg(I.map,12)}Открыть карту дня</button></div>
    <table><thead><tr><th>Маршрут</th><th>Города</th><th class="num">Адресов</th><th>Поверитель</th><th>Статус</th><th></th></tr></thead><tbody>
      ${rts.map(rt=>`<tr><td class="mono"><b>${rt.id}</b></td>
        <td>${(rt.cities||[rt.city]).map(c=>`<span class="tag">${esc(c)}</span>`).join(' ')}</td>
        <td class="num">${rt.stops.length}</td>
        <td style="width:210px">${SEL('rr'+rt.id,rt.verifier||'',[{v:'',l:'— не назначен —'},
          ...crew.map(p=>({v:p.id,l:p.name,hint:S.routes.filter(x=>x.date===ds&&x.verifier===p.id).length+' марш.'}))],
          v=>rcAssign(rt.id,v),{sm:true})}</td>
        <td>${stTag(rt.status)}</td>
        <td style="text-align:right"><button class="g sm" onclick="rcDisband('${rt.id}')" ${rt.status==='выполнен'?'disabled':''}>Расформировать</button></td></tr>`).join('')}
    </tbody></table></div>`}).join('')
  :`<div class="c"><div class="empty">Маршрутов на ближайшие дни нет. Соберите первый на карте.</div></div>`}`);
}

function build(ds,city){
  const pool = poolOf(ds,city), made=[];
  for(let i=0;i<pool.length;i+=25){
    const chunk = pool.slice(i,i+25), id='M'+(++S.seq);
    chunk.forEach(r=>{r.routeId=id;r.status='в маршруте';});
    const rt = {id,date:ds,city,verifier:null,status:'черновик',
      stops:chunk.map(r=>({req:r.id,called:null,done:false})),chat:[],duty:null};
    S.routes.push(rt); made.push(rt);
  }
  return made;
}

/* «Открыть в Навигаторе» — кнопка на точке маршрута у поверителя.
   Адрес геокодирован сервером при сохранении заявки (int-maps); без координат
   кнопки нет, а не «есть, но никуда не ведёт»: неработающая кнопка в телефоне
   на лестничной клетке хуже её отсутствия. */
const naviBtn = r => (r.lat==null||r.lon==null ? ''
  : `<button class="g sm" title="Маршрут до адреса в Яндекс Навигаторе${r.geo&&r.geo!=='exact'?' (точка на улице, не на доме)':''}"
      onclick="openNavi(${r.lat},${r.lon})">${svg(I.nav,12)}Навигатор</button>`);
function routeCard(rt){
  const vf = S.role==='verifier';
  const called = rt.stops.filter(s=>s.called).length, done = rt.stops.filter(s=>s.done).length;
  const byHour = {}; rt.stops.forEach(s=>{const r=S.requests.find(x=>x.id===s.req); if(r) byHour[r.time]=s.done?'done':'busy';});
  return `<div class="g2">
  <div class="c" style="position:relative;margin-bottom:0">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div><h3>${rt.id}</h3>
        <div class="mono" style="font-size:11px;color:var(--ink3);margin-top:3px">${rt.city} · ${ru(rt.date)} · ${rt.stops.length} точек · ${rt.verifier?esc(nameOf(rt.verifier)):'поверитель не назначен'}</div></div>
      ${stTag(rt.status)}</div>
    <div class="tl">${Array.from({length:12},(_,i)=>9+i).map(h=>`<div class="${byHour[h]||''}">${h}</div>`).join('')}</div>
    <div class="stops">${rt.stops.map((s,i)=>{const r=S.requests.find(x=>x.id===s.req); if(!r) return '';
      const note = vf?r.cmtVf:r.cmtOp, ph = photoCount(r);
      return `<div class="stop ${s.done?'fin':''} ${vf&&S.openStop===r.id?'sel':''}"><span class="n">${pad(i+1)}</span>
        <div style="min-width:0"><b style="color:var(--ink)">${r.street}, ${r.house}${r.flat?', кв. '+r.flat:''}</b>
          <small>${pad(r.time-1)}:00–${pad(r.time+1)}:00 · ${esc(r.name)} · ${r.clientType==='Юрлицо'?'юр':'физ'}
            · под. ${r.entrance||'—'} · эт. ${r.floor||'—'} · ${r.intercom?'домофон работает':'<span style="color:var(--warning)">домофон не работает</span>'}</small>
          <small>${r.devices.length?`${r.devices.length} приб. · ${ph} фото`:'акт не заполнен'}${note?` · <span style="color:var(--ink2)">${esc(note)}</span>`:''}</small>
          ${s.done?`<small${noPay(r)?' style="color:var(--warning)"':''}>оплата: ${esc(payLine(r))}</small>`:''}
          ${badDevs(r).length?`<small style="color:var(--error)">непригодны: ${badDevs(r).map(d=>esc(String(d.badWhy||'').toLowerCase())+(d.blank&&d.blankNo?' · бланк №'+esc(d.blankNo):'')).join('; ')}${badDevs(r).some(d=>d.repl==='отложена')?' · замена отложена':''}</small>`:''}
          ${s.unserved?`<small style="color:var(--warning)">не обслужена · ${esc(s.unserved.reason.toLowerCase())}${s.unserved.note?' · '+esc(s.unserved.note):''} · ${esc(s.unserved.at)}</small>`:''}</div>
        <div style="display:flex;gap:4px;align-items:center">
          ${badTag(r)}
          ${s.unserved?'<span class="tg t-err">не обслужена</span>'
            :s.called?`<span class="tg ${s.called==='подтверждена'?'t-ok':s.called==='перенос'?'t-warn':'t-err'}">${s.called}</span>`
            :vf?'<span class="tg t-mut">без прозвонки</span>'
            :`<button class="ib sm ok" title="Подтверждена" onclick="callStop('${rt.id}',${i},'подтверждена')">${svg(I.ok,13)}</button>
              <button class="ib sm wr" title="Перенос" onclick="callStop('${rt.id}',${i},'перенос')">${svg(I.fwd,13)}</button>
              <button class="ib sm no" title="Отказ" onclick="callStop('${rt.id}',${i},'отказ')">${svg(I.no,13)}</button>`}
          ${vf?s.unserved
              ? (waitOf(r.id)?`<button class="g sm" onclick="clearUnserved('${rt.id}',${i})">${svg(I.left,12)}Вернуть в работу</button>`
                             :'<span class="note">оператор уже обработал</span>')
              : `${naviBtn(r)}
                 <button class="g sm" onclick="S.openStop='${r.id}';render()">${svg(I.act,12)}${s.done?'Акт':'Работы'}</button>
                 ${s.done?'':`<button class="g sm" onclick="openUnserved('${rt.id}',${i})">${svg(I.no,12)}Не обслужена</button>`}`
            :`<button class="ib sm" title="Выше" onclick="move('${rt.id}',${i},-1)" ${i?'':'disabled'}>${svg(I.up,12)}</button>
              <button class="ib sm" title="Ниже" onclick="move('${rt.id}',${i},1)" ${i<rt.stops.length-1?'':'disabled'}>${svg(I.down,12)}</button>`}
        </div></div>`}).join('')}</div>
    <div class="row" style="margin-top:14px;justify-content:space-between">
      <span class="note">Прозвонено ${called} из ${rt.stops.length}${done?` · выполнено ${done}`:''}</span>
      <div style="display:flex;gap:6px">
        <button class="g sm" onclick="setStatus('${rt.id}','обзвонен')" ${called===rt.stops.length&&rt.status==='черновик'?'':'disabled'}>Отметить обзвоненным</button>
        <button class="b sm" onclick="setStatus('${rt.id}','выполнен')" ${rt.status==='обзвонен'||rt.status==='в работе'?'':'disabled'}>Закрыть маршрут</button></div></div>
    ${rt.status==='выполнен'?`<div class="stamp"><b>ПОВЕРЕНО</b><span>${rt.id}</span></div>`:''}
  </div>
  <div class="c mchat ${S.mchat?'open':''}" style="margin-bottom:0"><h3>Чат маршрута</h3>
    ${chatPanel(rt)}
    <button class="g sm mchatt" onclick="S.mchat=!S.mchat;render()" title="Чат маршрута ${rt.id}">
      ${svg(I.chat,12)}${S.mchat?'Свернуть чат':'Открыть чат'}${rt.chat.length?' · '+rt.chat.length:''}</button>
  </div></div>`;
}
function callStop(id,i,res){
  const rt = S.routes.find(r=>r.id===id);
  if(!isDemo()) return apiCallStop(id,rt.stops[i].req,res);
  rt.stops[i].called = res;
  if(res!=='подтверждена'){const r=S.requests.find(x=>x.id===rt.stops[i].req); if(r) r.status = res==='отказ'?'отменена':'перенос';}
  render();
}
function move(id,i,d){
  const st = S.routes.find(r=>r.id===id).stops;
  if(!isDemo()) return apiMoveStop(id,st[i].req,d);
  [st[i],st[i+d]]=[st[i+d],st[i]]; render();
}
function setStatus(id,st){
  const rt = S.routes.find(r=>r.id===id);
  if(!isDemo()) return apiPatchRoute(id,{status:st});
  rt.status = st;
  if(st==='выполнен') rt.stops.forEach(s=>{const r=S.requests.find(x=>x.id===s.req);
    if(r&&s.called==='подтверждена'){s.done=true;r.status='выполнена';r.verifier=rt.verifier;}});
  toast(st==='выполнен'?'Маршрут закрыт. Работы ушли в реестр УК и в расчёт сдельной оплаты.':'Маршрут обзвонен и готов к выдаче поверителю.');
}
function send(id){
  const el = document.getElementById('chatin'), t = el.value.trim(); if(!t) return;
  const rt = S.routes.find(r=>r.id===id);
  if(!isDemo()){ el.value=''; return apiSendChat(id,t); }
  rt.chat.push({who:S.user,vf:S.role==='verifier',txt:t,t:new Date().toTimeString().slice(0,5)});
  render();
}

export { build, callStop, move, routeCard, send, setStatus, viewRoutes };
