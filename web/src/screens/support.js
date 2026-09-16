/* Поддержка маршрутов. */

import { I, svg } from '../ui/icons.js';
import { S, nameOf } from '../state.js';
import { TODAY, esc, pad, ru } from '../util.js';
import { addrOf, payLine } from '../rules.js';
import { badTag } from '../refs.js';
import { cap, shell } from '../ui/shell.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { addStop as apiAddStop, shiftReq as apiShiftReq } from '../api/actions.js';
import { waitList } from './wait-list.js';

/* ---------- логистика ---------- */
function poolOf(ds,city){
  return S.requests.filter(r=>r.date===ds&&r.city===city&&!r.routeId&&r.status==='создана')
    .sort((a,b)=>a.street.localeCompare(b.street,'ru')||(+a.house)-(+b.house));
}
/* ============ ПОДДЕРЖКА МАРШРУТОВ ============ */
const HOURS = Array.from({length:13},(_,i)=>9+i);   // рабочее окно дня 9:00–21:00
const stTag = s => `<span class="tg ${s==='выполнен'?'t-ok':s==='в работе'?'t-warn':s==='обзвонен'?'t-cold':'t-mut'}">${s}</span>`;
const routesToday = () => S.routes.filter(r=>r.date===TODAY);

function viewSupport(){
  const list = routesToday();
  const sel = list.find(r=>r.id===S.openRoute) || null;   // null = все маршруты дня
  const shown = sel?[sel]:list;
  /* Точка на шкале знает свой маршрут: в общем режиме без этого не понять, кому писать. */
  const stops = shown.flatMap(rt=>rt.stops.map((s,i)=>({rt,s,i,r:S.requests.find(x=>x.id===s.req)})))
    .filter(x=>x.r);
  const all = list.reduce((a,r)=>a+r.stops.length,0);
  const called = stops.filter(x=>x.s.called).length, done = stops.filter(x=>x.s.done).length;
  const free = S.requests.filter(r=>r.date===TODAY && !r.routeId && r.status==='создана');
  const side = `<div class="lbl" style="padding:6px 10px 8px">Маршруты · ${ru(TODAY)}</div>
    <button class="sb" aria-current="${!sel}" onclick="S.openRoute=null;render()">
      <span>Все маршруты</span><span class="n">${all}</span></button>
    ${list.map(rt=>`<div class="rrow ${sel&&sel.id===rt.id?'on':''}">
      <button class="sb" aria-current="${sel&&sel.id===rt.id}" onclick="S.openRoute='${rt.id}';render()">
        <span style="min-width:0"><span class="mono" style="font-size:12px">${rt.id}</span>
        <span style="display:block;font-size:11px;color:var(--ink3);overflow:hidden;text-overflow:ellipsis">${rt.city} · ${rt.verifier?esc(nameOf(rt.verifier)):'не назначен'}</span></span>
        <span class="n">${rt.stops.filter(s=>s.done).length}/${rt.stops.length}</span></button>
      <button class="ib sm" title="Чат маршрута ${rt.id}" onclick="S.modal={k:'chat',id:'${rt.id}'};render()">
        ${svg(I.chat,14)}${rt.chat.length?`<span class="cnt">${rt.chat.length}</span>`:''}</button>
    </div>`).join('')}
    ${list.length?'':`<p class="note" style="padding:8px 10px">На сегодня маршрутов нет.</p>`}`;

  return shell(side, `${cap()}
  <div class="c">
    <div style="display:flex;align-items:flex-start;gap:12px">
      <div style="flex:1;min-width:0">
        <h3>${sel?`${sel.id} · ${sel.city}`:`Все маршруты дня · ${list.length}`}</h3>
        <div class="mono" style="font-size:11px;color:var(--ink3);margin-top:3px">
          ${sel?`${sel.verifier?esc(nameOf(sel.verifier)):'поверитель не назначен'} · ${sel.stops.length} точек · прозвонено ${called} · выполнено ${done}`
              :`${all} точек · прозвонено ${called} · выполнено ${done}`}</div>
      </div>
      ${sel?`${stTag(sel.status)}
        <button class="g sm" onclick="S.modal={k:'chat',id:'${sel.id}'};render()">${svg(I.chat,12)}Чат маршрута${sel.chat.length?' · '+sel.chat.length:''}</button>`
        :`<span class="note" style="max-width:340px">Общий режим тяжёлый: на шкале сразу ${all} заявок. Для работы удобнее выбрать маршрут слева.</span>`}
    </div></div>

  <div class="c"><h3>Шкала дня</h3>
    <p class="cap">Стрелки сдвигают заявку на час — окно прибытия пересчитывается автоматически.</p>
    <div class="tlg">${HOURS.map(h=>{
      const inHour = stops.filter(x=>x.r.time===h);
      const now = new Date().getHours()===h;
      return `<div class="tlh ${now?'now':''}">
        <div class="hh"><span class="mono">${pad(h)}:00</span><i></i></div>
        <div class="lane ${inHour.length?'':'empty'}">${inHour.length?inHour.map(x=>chip(x)).join('')
          :'<span class="none">свободно</span>'}</div></div>`}).join('')}</div>
  </div>

  ${waitList()}

  <div class="c"><h3>Заявки без маршрута · ${free.length}</h3>
    <p class="cap">Созданные сегодня и ещё не поставленные в маршрут. Добавляются в маршрут дня по городу.</p>
    ${free.length?`<table><thead><tr><th>Заявка</th><th>Город</th><th>Адрес</th><th>Клиент</th><th class="num">Окно</th><th>В маршрут</th></tr></thead><tbody>
      ${free.slice(0,12).map(r=>{const fit=list.filter(rt=>rt.city===r.city);
        return `<tr><td class="mono">${r.id}</td><td>${r.city}</td><td><b>${esc(addrOf(r))}</b></td>
        <td>${esc(r.name)}</td><td class="num mono">${pad(r.time-1)}:00–${pad(r.time+1)}:00</td>
        <td style="width:240px">${fit.length
          ? fit.map(rt=>`<button class="g sm" style="margin:0 4px 4px 0" onclick="addToRoute('${rt.id}','${r.id}')">${rt.id}</button>`).join('')
          : '<span class="note">нет маршрута по этому городу</span>'}</td></tr>`}).join('')}</tbody></table>
      ${free.length>12?`<p class="note" style="margin-top:10px">Показаны первые 12 из ${free.length}.</p>`:''}`
      :`<div class="empty">Все сегодняшние заявки разложены по маршрутам.</div>`}</div>`);
}
/* Миниатюра заявки на шкале: город, улица и две кнопки — открыть и позвонить. */
function chip({rt,s,i,r}){
  return `<div class="chip2 ${s.done?'fin':''}">
    <span class="mono rt">${rt.id}</span>
    <div class="ad"><b>${esc(r.city)}</b><small>${esc(r.street)}, ${r.house}${r.flat?', кв. '+r.flat:''}${s.done?' · оплата: '+esc(payLine(r)):''}</small></div>
    ${badTag(r)}
    ${s.called?`<span class="tg ${s.called==='подтверждена'?'t-ok':s.called==='перенос'?'t-warn':'t-err'}">${s.called}</span>`:''}
    <div class="ctl">
      <button class="ib sm" title="На час раньше" onclick="shiftReq('${r.id}',-1)" ${r.time<=10?'disabled':''}>${svg(I.up,12)}</button>
      <button class="ib sm" title="На час позже" onclick="shiftReq('${r.id}',1)" ${r.time>=20?'disabled':''}>${svg(I.down,12)}</button>
      <button class="g sm" onclick="openReq('${r.id}')">Открыть</button>
      <button class="ib sm ok" title="Позвонить ${esc(r.phone)}" onclick="startCall('${esc(r.phone)}','основной','${esc(r.name)}')">${svg(I.phone,13)}</button>
    </div></div>`;
}
function shiftReq(id,d){
  /* Границы окна проверит и сервер — здесь они стоят, чтобы стрелка не дёргала
     запрос впустую. В рабочем режиме заявки может не быть в памяти вкладки:
     решение принимает сервер, а не загруженный срез. */
  if(!isDemo()) return apiShiftReq(id,d);
  const r = S.requests.find(x=>x.id===id);
  const t = r.time + d;
  if(t<10 || t>20) return;
  r.time = t; render();
  toast(`${r.id}: окно сдвинуто на ${pad(t-1)}:00–${pad(t+1)}:00. Поверитель увидит изменение в маршруте.`);
}
function addToRoute(rid,reqId){
  /* Заявки может не быть в загруженном срезе — она только что принята на другом
     экране. Есть ли она и влезает ли в маршрут, знает сервер. */
  if(!isDemo()) return apiAddStop(rid,reqId);
  const rt = S.routes.find(r=>r.id===rid), r = S.requests.find(x=>x.id===reqId);
  if(!rt||!r) return;
  r.routeId = rt.id; r.status = 'в маршруте';
  rt.stops.push({req:r.id,called:null,done:false});
  rt.stops.sort((a,b)=>{const A=S.requests.find(x=>x.id===a.req),B=S.requests.find(x=>x.id===b.req);
    return (A?.time||0)-(B?.time||0);});
  toast(`${r.id} добавлена в ${rt.id} на ${pad(r.time-1)}:00–${pad(r.time+1)}:00.`);
}

export { HOURS, addToRoute, chip, poolOf, routesToday, shiftReq, stTag, viewSupport };
