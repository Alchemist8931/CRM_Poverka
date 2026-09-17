/* Конструктор маршрутов на карте области.
 *
 * Карт здесь две, и это не переходное состояние.
 *
 *  — Настоящая карта Яндекса (JS API 3.0). Работает, когда у контура есть ключ
 *    и у заявок есть координаты: адреса геокодирует сервер при сохранении
 *    (server/src/maps/place.ts). По ней видно то, ради чего всё и затевалось:
 *    попадёт ли адрес в один объезд с остальными или стоит на отшибе.
 *
 *  — Схематичная карта области. Остаётся ровно та, что была: города на условных
 *    местах, адреса внутри города — подсолнухом. Она рисуется без ключа и без
 *    координат, то есть в демо-режиме на GitHub Pages и на контуре, где ключ
 *    ещё не завели. Убрать её означало бы показывать в демо пустое место.
 *
 * Порядок объезда в обеих один и тот же: клик по точке ставит её в очередь.
 */

import { DATE, SEL } from '../ui/controls.js';
import { I, svg } from '../ui/icons.js';
import { S, dayCities } from '../state.js';
import { addDays, esc, iso, pad, today } from '../util.js';
import { addrOf, crewOn } from '../rules.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { createRoute as apiCreateRoute, dropRoute as apiDropRoute, dropStop as apiDropStop,
  patchRoute as apiPatchRoute, closeBuilder, openBuilder } from '../api/actions.js';
import { loadRequests, loadRoutes, reload } from '../api/load.js';
import { hideMap, mapsOn, showPoints } from '../ui/ymaps.js';
import { orderPoints, routeKm } from '../geo.js';

/* ============ СБОРКА МАРШРУТОВ (руководитель) ============ */
/* Карта: окно 7° долготы × 3.8° широты ≈ 423 × 422 км, поэтому кадр квадратный. */
const GEO = {
  'Екатеринбург':[60.61,56.84],'Нижний Тагил':[59.97,57.92],'Каменск-Уральский':[61.93,56.41],
  'Первоуральск':[59.94,56.91],'Верхняя Пышма':[60.58,56.97],'Берёзовский':[60.81,56.91],
  'Ревда':[59.91,56.80],'Полевской':[60.19,56.49],'Асбест':[61.46,57.01],'Заречный':[61.33,56.81],
  'Сухой Лог':[62.03,56.91],'Богданович':[62.05,56.78],'Арамиль':[60.83,56.70],'Среднеуральск':[60.47,56.99],
  'Дегтярск':[60.09,56.70],'Верхняя Салда':[60.55,58.05],'Невьянск':[60.22,57.49],'Кировград':[60.06,57.43],
  'Реж':[61.39,57.37],'Артёмовский':[61.89,57.34],'Алапаевск':[61.70,57.85],'Серов':[60.58,59.60],
  'Краснотурьинск':[60.19,59.77],'Качканар':[59.49,58.70],'Кушва':[59.76,58.28],'Нижняя Тура':[59.81,58.63],
  'Красноуфимск':[57.77,56.61],'Ирбит':[63.07,57.68],'Талица':[63.72,57.01],'Новоуральск':[60.09,57.25]
};
const MV = {lon0:57.2,lon1:64.2,lat0:56.2,lat1:60.0,size:600};
const mLon = lon => (lon-MV.lon0)/(MV.lon1-MV.lon0)*MV.size;
const mLat = lat => (MV.lat1-lat)/(MV.lat1-MV.lat0)*MV.size;
const OBLAST = [[58.9,61.6],[61.5,61.4],[63.0,60.6],[64.0,59.9],[64.6,59.0],[65.6,58.4],[66.2,57.6],
  [65.2,57.0],[64.3,56.9],[63.6,56.3],[62.6,56.0],[61.7,56.1],[60.7,56.1],[59.9,56.3],[59.0,56.4],
  [58.2,56.4],[57.5,56.7],[57.3,57.3],[57.6,58.0],[58.2,58.7],[58.6,59.4],[58.5,60.3]];
const oblastPath = 'M '+OBLAST.map(([lon,lat])=>`${mLon(lon).toFixed(1)} ${mLat(lat).toFixed(1)}`).join(' L ')+' Z';
const clampM = v => Math.max(16,Math.min(MV.size-16,v));

/* Адреса внутри города раскладываются подсолнухом: детерминированно и без свалки в точке. */
function rcPoints(ds){
  const all = S.requests.filter(r=>r.date===ds && r.status!=='отменена')
    .sort((a,b)=>a.id.localeCompare(b.id));
  const byCity = {};
  all.forEach(r=>{ (byCity[r.city] ||= []).push(r); });
  const pts = [], clusters = [];
  Object.entries(byCity).forEach(([city,list])=>{
    const g = GEO[city]; if(!g) return;
    const cx = mLon(g[0]), cy = mLat(g[1]);
    const R = 20 + Math.sqrt(list.length)*4.4;
    clusters.push({city,cx,cy,R,n:list.length});
    list.forEach((r,k)=>{
      const rad = R*Math.sqrt((k+.5)/list.length), a = k*2.399963;
      /* Координаты от Геокодера идут рядом с условными: настоящая карта берёт
         первые, схематичная — вторые, а точки и их порядок общие. */
      pts.push({r,city,x:clampM(cx+rad*Math.cos(a)),y:clampM(cy+rad*Math.sin(a)),taken:!!r.routeId,
        lat:r.lat??null,lon:r.lon??null,geo:r.geo||null,time:r.time});
    });
  });
  return {pts,clusters};
}
/** Точки, которые можно показать на настоящей карте. */
const located = pts => pts.filter(p=>p.lat!=null && p.lon!=null);
/** Оценка длины объезда по выбранному порядку, км. Без координат — null. */
function selKm(pts,sel){
  const line = sel.map(id=>pts.find(p=>p.r.id===id)).filter(p=>p&&p.lat!=null);
  return line.length>1 && line.length===sel.length ? routeKm(line) : null;
}
/** Длина уже собранного маршрута: те же точки в порядке объезда. */
function routeKmOf(rt){
  const line = rt.stops.map(s=>S.requests.find(x=>x.id===s.req)).filter(r=>r&&r.lat!=null);
  return line.length>1 && line.length===rt.stops.length ? routeKm(line) : null;
}
/** Точки на карту переставляются после перерисовки: живая карта живёт вне #root
    и в разметке ей оставлено только гнездо (ui/ymaps.js). */
let fitKey = '';
function rcSync(){
  const C = S.rc; if(!C) return;
  const nest = document.getElementById('rcnest'); if(!nest) return;
  const {pts} = rcPoints(C.date);
  const on = located(pts);
  const key = C.date+':'+on.map(p=>p.r.id).join(',');
  const fit = key!==fitKey; fitKey = key;
  const line = C.sel.map(id=>on.find(p=>p.r.id===id)).filter(Boolean).map(p=>[p.lon,p.lat]);
  showPoints(nest,{
    pts:on.map(p=>({id:p.r.id,lat:p.lat,lon:p.lon,n:C.sel.indexOf(p.r.id)+1,taken:p.taken,
      title:`${p.r.city}, ${addrOf(p.r)} · ${pad(p.r.time-1)}:00–${pad(p.r.time+1)}:00`
        +(p.taken?` · уже в маршруте ${p.r.routeId}`:'')})),
    line, onPick:rcPick, fit,
  }).catch(()=>{});
}
function openRC(ds){
  S.rc = {date:ds||iso(addDays(today,1)), sel:[], made:[], km:{}};
  S.modal = {k:'rc'}; render();
  rcLoad(S.rc.date);
}
/* Открытый конструктор — это и есть замок даты: пока он открыт, оператор на эту
   дату не записывает. В демо-режиме замок держится в памяти, в рабочем о нём
   знает сервер, иначе вторая вкладка о нём не узнает. */
function rcLoad(ds){
  if(isDemo()) return;
  openBuilder(ds);
  // Карту рисуют заявки этой даты — и свободные, и уже разобранные по маршрутам.
  loadRequests({date:ds}).then(()=>loadRoutes({date:ds})).then(render);
}
function rcDate(v){
  const was = S.rc.date;
  S.rc.date = v; S.rc.sel = []; render();
  if(!isDemo() && was!==v){ closeBuilder(was); rcLoad(v); }
}
function rcPick(id){
  const r = S.requests.find(x=>x.id===id);
  if(!r || r.routeId) return;
  const i = S.rc.sel.indexOf(id);
  if(i>=0) S.rc.sel.splice(i,1); else S.rc.sel.push(id);
  render();
}
/* Кнопка «Упорядочить»: разложить выбранные точки по окнам приезда и внутри
   окна — ближайшим соседом (geo.js). Это подсказка, а не решение: руководитель
   и дальше может снять точку или выбрать их заново в своём порядке. */
function rcOrder(){
  const C = S.rc; if(!C) return;
  const {pts} = rcPoints(C.date);
  const chosen = C.sel.map(id=>pts.find(p=>p.r.id===id)).filter(Boolean);
  const blind = chosen.filter(p=>p.lat==null);
  if(blind.length) return toast(`${blind.length} из ${chosen.length} выбранных адресов без координат — упорядочить можно только геокодированные адреса.`);
  if(chosen.length<2) return toast('Выберите хотя бы две точки.');
  const sorted = orderPoints(chosen.map(p=>({id:p.r.id,lat:p.lat,lon:p.lon,time:p.time})));
  C.sel = sorted.map(p=>p.id);
  const was = selKm(pts,chosen.map(p=>p.r.id)), now = selKm(pts,C.sel);
  toast(was&&now
    ? `Порядок пересобран по окнам приезда: ≈ ${now.toFixed(1)} км вместо ≈ ${was.toFixed(1)} км.`
    : 'Порядок пересобран по окнам приезда.');
  render();
}
function rcCreate(){
  const sel = S.rc.sel;
  if(sel.length<2) return toast('Выберите на карте хотя бы две точки — маршрут строится по последовательности.');
  const reqs = sel.map(id=>S.requests.find(x=>x.id===id)).filter(Boolean);
  const cities = [...new Set(reqs.map(r=>r.city))];
  /* Оценка длины считается здесь, по выбранным точкам, и запоминается за
     маршрутом: список маршрутов приходит с сервера счётчиками, без самих точек
     (api/map.js, placeholders), и посчитать её потом уже не по чему. */
  const km = selKm(rcPoints(S.rc.date).pts, sel);
  if(!isDemo()){
    apiCreateRoute(S.rc.date,cities[0],reqs.map(r=>r.id)).then(out=>{
      if(!out || !S.rc) return;
      S.rc.made.unshift(out.route.id); S.rc.sel = [];
      if(km) (S.rc.km ||= {})[out.route.id] = km;
      rcLoad(S.rc.date);
    });
    return;
  }
  const rt = {id:'M'+(++S.seq),date:S.rc.date,city:cities[0],cities,verifier:null,status:'черновик',
    stops:reqs.map(r=>({req:r.id,called:null,done:false})),chat:[],duty:null};
  reqs.forEach(r=>{ r.routeId = rt.id; r.status = 'в маршруте'; });
  S.routes.push(rt); S.rc.made.unshift(rt.id); S.rc.sel = [];
  if(km) (S.rc.km ||= {})[rt.id] = km;
  toast(`${rt.id}: ${reqs.length} адресов, ${cities.join(' · ')}. Назначьте поверителя справа.`);
}
function rcAssign(id,v){
  const rt = S.routes.find(r=>r.id===id); if(!rt) return;
  if(!isDemo()) return apiPatchRoute(id,{verifier_id:v||null}).then(()=>rcLoad(S.rc?.date));
  rt.verifier = v||null;
  if(rt.verifier && rt.status==='черновик') rt.status='обзвонен';
}
function rcDrop(rid,reqId){
  const rt = S.routes.find(r=>r.id===rid); if(!rt) return;
  if(!isDemo()){
    // Последний адрес — это уже не «исключить», а «расформировать»: так же, как в памяти.
    if(rt.stops.length<=1) return rcDisband(rid);
    return apiDropStop(rid,reqId).then(()=>rcLoad(S.rc?.date));
  }
  const j = rt.stops.findIndex(s=>s.req===reqId); if(j<0) return;
  rt.stops.splice(j,1);
  const r = S.requests.find(x=>x.id===reqId);
  if(r){ r.routeId=null; r.status='создана'; }
  if(!rt.stops.length) return rcDisband(rid);
  toast(`${reqId} исключена из ${rid} и вернулась в свободные.`); render();
}
function rcDisband(id){
  const rt = S.routes.find(r=>r.id===id); if(!rt) return;
  if(!isDemo()){
    if(S.rc) S.rc.made = S.rc.made.filter(x=>x!==id);
    return apiDropRoute(id).then(()=>rcLoad(S.rc?.date));
  }
  rt.stops.forEach(s=>{ const r=S.requests.find(x=>x.id===s.req);
    if(r){ r.routeId=null; r.status='создана'; } });
  S.routes = S.routes.filter(r=>r.id!==id);
  if(S.rc) S.rc.made = S.rc.made.filter(x=>x!==id);
  toast(`${id} расформирован, адреса вернулись в свободные.`); render();
}
function closeRC(){
  const ds = S.rc?.date;
  S.rc=null; S.modal=null;
  // Карту не разрушаем, а снимаем с экрана: следующее открытие конструктора
  // получит ту же, уже загруженную (ui/ymaps.js).
  hideMap(); fitKey = '';
  if(!isDemo() && ds) closeBuilder(ds).then(reload);
  render();
}
function rcModal(){
  const C = S.rc; if(!C) return '';
  const ds = C.date;
  const {pts,clusters} = rcPoints(ds);
  const crew = crewOn(ds);
  const free = pts.filter(p=>!p.taken).length;
  const selPts = C.sel.map(id=>pts.find(p=>p.r.id===id)).filter(Boolean);
  const line = selPts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const made = C.made.map(id=>S.routes.find(r=>r.id===id)).filter(Boolean);
  const cs = dayCities(ds);
  /* Настоящая карта — когда есть чем её показать и что на ней показывать.
     Ключа нет (демо-режим, контур без ключа) или координат нет (Геокодер молчал)
     — остаётся схематичная карта области. */
  const on = located(pts);
  const live = mapsOn() && on.length>0;
  const lost = pts.length - on.length;
  const dist = selKm(pts,C.sel);
  if(live) queueMicrotask(rcSync);
  return `<div class="mask" onclick="if(event.target===this)closeRC()">
    <div class="modal rcm">
      <div class="mhd"><h3>Конструктор маршрутов</h3>
        <span class="note">Выбирайте точки по порядку — между ними протянется связь. Закрытие окна не отменяет созданные маршруты.</span>
        <button class="ib" onclick="closeRC()">${svg(I.no,15)}</button></div>

      <div class="rchd">
        <div class="f" style="width:150px;margin:0"><label>Дата выезда</label>${DATE('rcDate',ds,v=>rcDate(v))}</div>
        <div class="rcst">
          <div><b class="mono">${crew.length}</b> поверителей в смене</div>
          <div class="who">${crew.length?crew.map(p=>esc(p.name)).join(' · '):'<span style="color:var(--warning)">смена не назначена — задайте её в планировании</span>'}</div>
        </div>
        <div class="rcst">
          <div><b class="mono">${free}</b> свободных из ${pts.length} заявок${cs.length?` · ${cs.map(c=>esc(c)).join(' · ')}`:''}</div>
          <div class="who">${C.sel.length
            ? `выбрано ${C.sel.length} — идут в маршрут в порядке нажатия${dist?` · объезд ≈ ${dist.toFixed(1)} км`:''}`
            : 'точка = адрес заявки, повторный клик снимает выбор'}${
            lost?` · <span style="color:var(--warning)">${lost} без координат — ${live?'на карте их нет':'адрес не геокодирован'}</span>`:''}</div>
        </div>
        <button class="g" onclick="rcOrder()" ${live&&C.sel.length>1?'':'disabled'}
          title="Разложить выбранные точки по окнам приезда, внутри окна — ближайшим соседом">Упорядочить</button>
        <button class="b" onclick="rcCreate()" ${C.sel.length>1?'':'disabled'}>Создать маршрут${C.sel.length>1?` · ${C.sel.length}`:''}</button>
      </div>

      <div class="rcbody">
        ${live?`<div class="rcmap"><div class="rcnest" id="rcnest"></div>
          <div class="rcleg"><span class="d1"></span>свободна<span class="d2"></span>выбрана — цифра это порядок объезда<span class="d3"></span>занята
            <span class="note" style="margin-left:auto">© Яндекс Карты</span></div>
        </div>`:`<div class="rcmap">
          <svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Карта Свердловской области">
            <defs><pattern id="mg" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M40 0H0v40" fill="none" stroke="var(--gridA)" stroke-width="1"/></pattern></defs>
            <rect width="600" height="600" fill="url(#mg)"/>
            <path d="${oblastPath}" fill="var(--wash)" stroke="var(--mark)" stroke-width="1.5" stroke-linejoin="round"/>
            ${(()=>{ /* подписи городов не должны наезжать друг на друга */
              const placed = [];
              return clusters.slice().sort((a,b)=>a.cy-b.cy).map(c=>{
                let ly = c.cy - c.R - 7;
                const w = 7*(c.city.length+4);
                while(placed.some(q=>Math.abs(q.x-c.cx)<(q.w+w)/2 && Math.abs(q.y-ly)<13)) ly -= 13;
                placed.push({x:c.cx,y:ly,w});
                return `<g class="mcity"><circle cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="2.5"/>
                  <text x="${c.cx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(c.city)} · ${c.n}</text></g>`;
              }).join('');
            })()}
            ${line?`<polyline points="${line}" class="mline halo"/><polyline points="${line}" class="mline"/>`:''}
            ${pts.map(p=>{const k=C.sel.indexOf(p.r.id);
              return `<g class="mp ${p.taken?'taken':''} ${k>=0?'on':''}" ${p.taken?'':`onclick="rcPick('${p.r.id}')"`}>
                <title>${esc(p.r.city)}, ${esc(addrOf(p.r))} · ${pad(p.r.time-1)}:00–${pad(p.r.time+1)}:00${p.taken?' · уже в маршруте '+p.r.routeId:''}</title>
                <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9" class="hit"/>
                <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${k>=0?5.5:4}" class="dot"/>
                ${k>=0?`<text x="${p.x.toFixed(1)}" y="${(p.y-9).toFixed(1)}" text-anchor="middle">${k+1}</text>`:''}</g>`}).join('')}
            <g class="mlg" transform="translate(12,12)">
              <rect x="0" y="0" width="330" height="26" rx="6"/>
              <circle cx="16" cy="13" r="4" class="d1"/><text x="26" y="17">свободна</text>
              <circle cx="106" cy="13" r="5" class="d2"/><text x="116" y="17">в маршруте этой сессии</text>
              <circle cx="262" cy="13" r="4" class="d3"/><text x="272" y="17">занята</text></g>
          </svg>
        </div>`}
        <div class="rclist">
          <div class="lbl" style="margin-bottom:8px">Маршруты этой сессии · ${made.length}</div>
          ${made.length?made.map(rt=>`<div class="rcr">
            <div class="rch"><b class="mono">${rt.id}</b>
              <span class="note">${rt.stops.length} адр. · ${(rt.cities||[rt.city]).join(' · ')}${
                (k=>k?` · ≈ ${k.toFixed(1)} км`:'')(C.km?.[rt.id] ?? routeKmOf(rt))}</span>
              <button class="ib sm no" title="Расформировать" onclick="rcDisband('${rt.id}')">${svg(I.no,12)}</button></div>
            <div class="f" style="margin:8px 0 0">
              ${SEL('rv'+rt.id,rt.verifier||'',[{v:'',l:'— поверитель не назначен —'},
                ...crew.map(p=>({v:p.id,l:p.name,hint:S.routes.filter(x=>x.date===ds&&x.verifier===p.id).length+' марш.'}))],
                v=>rcAssign(rt.id,v),{sm:true})}</div>
            <div class="rcs">${rt.stops.map((s,i)=>{const r=S.requests.find(x=>x.id===s.req); if(!r) return '';
              return `<div><span class="n mono">${pad(i+1)}</span>
                <span class="a">${esc(r.city)}, ${esc(r.street)}, ${r.house}</span>
                <button class="ib sm no" title="Исключить адрес" onclick="rcDrop('${rt.id}','${r.id}')">${svg(I.no,10)}</button></div>`}).join('')}</div>
          </div>`).join('')
          :`<p class="note">Маршрутов пока нет. Отметьте точки на карте и нажмите «Создать маршрут».</p>`}
        </div>
      </div>
    </div></div>`;
}

export { GEO, MV, OBLAST, clampM, closeRC, mLat, mLon, oblastPath, openRC, rcAssign, rcCreate, rcDate, rcDisband, rcDrop, rcModal, rcOrder, rcPick, rcPoints, routeKmOf, selKm };
