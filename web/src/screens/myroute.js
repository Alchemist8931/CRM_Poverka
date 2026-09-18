/* Мой маршрут и акт выполненных работ. */

import { CHK, SEG, SEL } from '../ui/controls.js';
import { DEV_TYPES, FAIL_REASONS, ROOMS, SERVICES, SVC, badDevs, isCheck, needSerial, replSvcOf } from '../refs.js';
import { I, svg } from '../ui/icons.js';
import { PAY_HAND, addrOf, discountOf, payInit, payMethods, priceOf, priceOfDev, rateV, setPay, worksOf } from '../rules.js';
import { S, nameOf } from '../state.js';
import { TODAY, esc, money, pad, ru } from '../util.js';
import { cap, shell } from '../ui/shell.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { addDevice as apiAddDevice, closeAct as apiCloseAct, dropDevice as apiDropDevice,
  dropPhoto as apiDropPhoto, patchDevice as apiPatchDevice, reopenAct as apiReopenAct,
  setReplacement as apiSetReplacement, uploadPhoto as apiUploadPhoto,
  flushDevices } from '../api/actions.js';
import { reload as apiReload } from '../api/load.js';
import { routeCard } from './routes.js';

/* ---------- поверитель ---------- */
function viewMyRoute(){
  const mine = S.routes.filter(r=>r.verifier===S.me).sort((a,b)=>b.date.localeCompare(a.date));
  const rt = S.routes.find(r=>r.id===S.openRoute) || mine.find(r=>r.date===TODAY) || mine[0];
  if(!rt) return shell(null,`${cap()}<div class="c"><div class="empty">Маршрутов не назначено.</div></div>`);
  /* Не обслуженные точки в акт не подставляем: по ним работает оператор, а не поверитель. */
  const stop = rt.stops.find(s=>s.req===S.openStop)
    || rt.stops.find(s=>s.called==='подтверждена'&&!s.done&&!s.unserved) || rt.stops[0];
  const done = rt.stops.filter(s=>s.done).length;
  /* Маршруты — выпадающим списком в первой строке: вся ширина уходит карточке и акту. */
  const picker = `<div class="row" style="margin-bottom:14px;align-items:flex-end">
    <div class="f" style="width:360px;margin-bottom:0"><label>Мои маршруты · ${mine.length}</label>
      ${SEL('myRt',rt.id,mine.slice(0,30).map(r=>({v:r.id,l:`${ru(r.date)} · ${r.city}`,
        hint:`${r.stops.filter(s=>s.done).length}/${r.stops.length} · ${r.status}`})),
        v=>{ S.openRoute=v; S.openStop=null; if(!isDemo()) apiReload(); })}</div>
    <span class="note" style="flex:1">Выполнено ${done} из ${rt.stops.length} точек${mine.length>1?` · всего маршрутов ${mine.length}`:''}.</span>
  </div>`;
  return shell(null, `${cap()}${picker}${routeCard(rt)}${stop?workSheet(rt,stop):''}`);
}

/* ---------- акт выполненных работ ---------- */
function workSheet(rt,s){
  const r = S.requests.find(x=>x.id===s.req); if(!r) return '';
  const i0 = rt.stops.indexOf(s);
  r.devices.forEach(d=>{ if(!d.photos) d.photos=[]; if(d.reading===undefined) d.reading=''; if(d.pens===undefined) d.pens=false;
    if(d.bad===undefined) d.bad=false; if(d.badWhy===undefined) d.badWhy=FAIL_REASONS[0];
    if(d.badNote===undefined) d.badNote=''; if(d.blank===undefined) d.blank=false;
    if(d.blankNo===undefined) d.blankNo=''; if(d.repl===undefined) d.repl=null; });
  const noPh = r.devices.some(d=>!d.photos.length);
  const nBad = badDevs(r).length;
  const disc = discountOf(r);
  const p = payInit(r,rt.verifier), price = priceOf(r);
  const diff = p.method==='не оплачено' ? 0 : p.amount-price;
  return `<div class="c" style="margin-top:14px">
    <div class="acthd" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:4px">
      <div><h3>Акт · точка ${pad(i0+1)} · ${esc(addrOf(r))}</h3>
        <div class="mono" style="font-size:11px;color:var(--ink3);margin-top:3px">${r.id} · ${esc(r.name)} · эт. ${r.floor||'—'} · ${r.intercom?'домофон работает':'домофон не работает'} · окно ${pad(r.time-1)}:00–${pad(r.time+1)}:00</div></div>
      <div style="display:flex;gap:6px;align-items:center">
        ${s.unserved?'<span class="tg t-err">не обслужена</span>':s.done?'<span class="tg t-ok">позиция закрыта</span>':'<span class="tg t-mut">в работе</span>'}
        ${r.lat!=null&&r.lon!=null?`<button class="g sm" onclick="openNavi(${r.lat},${r.lon})"
          title="Маршрут до адреса в Яндекс Навигаторе${r.geo&&r.geo!=='exact'?' (точка на улице, не на доме)':''}">${svg(I.nav,12)}Навигатор</button>`:''}
        <button class="g sm" onclick="startCall('${esc(r.phone)}','основной','${esc(r.name)}')">${svg(I.phone,12)}Клиент</button></div>
    </div>
    <p class="cap">Услуга, заводской номер и показания счётчика — в строке прибора. К каждому прибору — фото выполненных работ, несколько кадров.
      Результат поверки отмечается тут же: «годен» или «не годен». Акт и свидетельство о непригодности вы заполняете на бумажном бланке от руки —
      CRM пока ничего не печатает, ей нужен только результат и номер выданного бланка.</p>
    ${r.cmtVf?`<div class="actnote"><b>Комментарий для поверителей</b>${esc(r.cmtVf)}</div>`:''}
    ${r.devices.map((d,i)=>`<div class="wrow ${d.photos.length?'':'new'} ${d.bad?'bad':''} ${d.swap?'swap':''}">
      <div class="wtop">
        ${SEL('wS'+i,d.svc,SERVICES.map(x=>({v:x.id,l:x.name,hint:x.grp})),v=>{d.svc=v;},{sm:true,ph:'Услуга'})}
        ${SEL('wT'+i,d.type,DEV_TYPES.map(t=>({v:t.v,l:t.v,hint:t.grsi})),v=>{d.type=v;d.grsi=DEV_TYPES.find(t=>t.v===v).grsi;},{sm:true})}
        ${SEL('wC'+i,d.carrier,['ХВС','ГВС','Тепло'],v=>{d.carrier=v;},{sm:true})}
        <input class="fld sm mono" id="sn${r.id}_${i}" value="${esc(d.serial)}" oninput="setDev('${r.id}',${i},'serial',this.value)" placeholder="Заводской №">
        <input class="fld sm mono" id="rd${r.id}_${i}" value="${esc(d.reading)}" oninput="setDev('${r.id}',${i},'reading',this.value)"
          placeholder="Показания" title="Показания счётчика на момент поверки${d.carrier==='Тепло'?', Гкал':', м³'}">
        ${SEL('wR'+i,d.room,ROOMS,v=>{d.room=v;},{sm:true})}
        ${CHK(d.seal,'пломба УК',`setDev('${r.id}',${i},'seal',${!d.seal})`)}
        ${r.clientType==='Юрлицо'
          ? '<span class="note" style="white-space:nowrap">юрлицо</span>'
          : CHK(d.pens,'пенсионер',`setDev('${r.id}',${i},'pens',${!d.pens})`)}
        ${isCheck(d)
          ? SEG(d.bad?'bad':'ok',[{v:'ok',l:'годен'},{v:'bad',l:'не годен',c:'bad'}],`setBad('${r.id}',${i},$v)`,{sm:true})
          : '<span class="note" style="white-space:nowrap">без поверки</span>'}
        <button class="ib sm no" title="Убрать прибор" onclick="rmDev('${r.id}',${i})">${svg(I.no,13)}</button>
      </div>
      ${d.swap?`<div class="wswap">Прибор на замену вместо непригодного${d.swapOf?` №${esc(d.swapOf)}`:''} — впишите заводской номер установленного счётчика.</div>`:''}
      ${d.bad?`<div class="wbad">
        <span class="lbl">Непригоден</span>
        ${SEL('wF'+i,d.badWhy,FAIL_REASONS,v=>{d.badWhy=v; if(v!=='Другое') d.badNote='';},{sm:true})}
        ${d.badWhy==='Другое'?`<input class="fld sm" id="bn${r.id}_${i}" value="${esc(d.badNote)}"
          oninput="setDev('${r.id}',${i},'badNote',this.value)" placeholder="что именно с прибором">`:''}
        ${CHK(d.blank,'выдан бланк о непригодности',`setDev('${r.id}',${i},'blank',${!d.blank})`)}
        ${d.blank?`<input class="fld sm mono no" id="bl${r.id}_${i}" value="${esc(d.blankNo)}"
          oninput="setDev('${r.id}',${i},'blankNo',this.value)" placeholder="№ бланка"
          title="Номер бумажного бланка: нумерацию ведёт руководитель, печатных форм в CRM пока нет">`:''}
        ${d.repl==='предложена'
          ? `<span class="tg t-cold">замена предложена · строка ниже</span>
             <button class="g sm" onclick="postponeRepl('${r.id}',${i})" title="Передумал на месте: строка замены уйдёт из акта, адрес — в лист ожидания оператора">Клиент отказался</button>`
          : d.repl==='отложена'
            ? `<span class="tg t-warn">замена отложена</span>
               <button class="g sm" onclick="clearRepl('${r.id}',${i})">Снять отметку</button>`
            : `<button class="g sm" onclick="offerRepl('${r.id}',${i})">${svg(I.plus,12)}Предложить замену</button>
               <button class="g sm" onclick="postponeRepl('${r.id}',${i})" title="Клиент отказался менять сейчас — адрес уйдёт в лист ожидания оператора">Замена отложена</button>`}
      </div>`:''}
      <div class="wbot"><span class="lbl">Фото работ</span>
        ${d.photos.map((p,k)=>`<span class="phw"><img src="${p.thumb||p.src}" alt="${esc(p.name)}" title="${esc(p.name)} · ${esc(p.t)}${p.w?` · ${p.w}×${p.h}`:''}" onclick="lbOpen('${r.id}',${i},${k})">
          ${canDropPhoto()?`<button class="x" title="Убрать кадр из акта" onclick="rmPhoto('${r.id}',${i},${k})">${svg(I.no,9)}</button>`:''}</span>`).join('')}
        <input type="file" id="ph${r.id}_${i}" accept="image/*" capture="environment" multiple style="display:none" onchange="addPhotos('${r.id}',${i},this)">
        <label class="g sm addph" for="ph${r.id}_${i}">${svg(I.cam,12)}Добавить фото</label>
        ${d.photos.length?`<span class="note">${d.photos.length} кадр(ов)</span>`:'<span class="nophoto">нет фото</span>'}
      </div></div>`).join('')}
    <button class="g sm" onclick="addDev('${r.id}')">${svg(I.plus,12)}Добавить прибор</button>
    <div class="row" style="margin-top:16px">
      <span class="note">${r.devices.length?`К оплате клиенту <b class="mono" style="color:var(--ink)">${money(price)}</b>${disc?` · скидка пенсионеру ${money(disc)} за счёт компании`:''} · вам начислится <b class="mono" style="color:var(--ink)">${money(rateV(r))}</b>${nBad?` · <span style="color:var(--error)">непригодных ${nBad}</span> — поверка их всё равно оплачивается`:''}${noPh?' · <span style="color:var(--error)">есть приборы без фото</span>':''}`
        :'Приборов в акте нет. Добавьте то, что фактически обслужили на адресе.'}</span>
    </div>
    <div class="payb ${p.method==='не оплачено'?'none':''}">
      <div class="payh"><span class="lbl">Оплата</span>
        <span class="note">Онлайн-оплаты пока нет: деньги вы берёте на адресе и держите у себя как подотчёт, в конце месяца сдаёте руководителю.</span>
        ${p.at?`<span class="tg t-mut">отмечено ${esc(p.at)}${p.by?' · '+esc(nameOf(p.by)):''}</span>`:''}</div>
      <div class="payg">
        <div class="f" style="margin-bottom:0"><label>Способ</label>
          ${SEL('payM'+r.id,p.method,payMethods(r),v=>setPay(r.id,'method',v),{sm:true})}</div>
        <div class="f" style="margin-bottom:0"><label>Принято, ₽</label>
          <input class="fld sm mono" id="payA${r.id}" value="${p.method==='не оплачено'?0:p.amount}"
            ${p.method==='не оплачено'?'disabled':''} oninput="setPay('${r.id}','amount',this.value)"
            title="Подставлено из прайса — поправьте, если клиент округлил или доплатил не всё"></div>
        <div class="f" style="margin-bottom:0"><label>Примечание</label>
          <input class="fld sm" id="payN${r.id}" value="${esc(p.note||'')}" oninput="setPay('${r.id}','note',this.value)"
            placeholder="${p.method==='не оплачено'?'почему не оплачено — это увидит руководитель':'что сказал клиент про деньги'}"></div>
      </div>
      <div class="paysum">${p.method==='не оплачено'
        ? `Позицию можно закрыть и без оплаты: работа выполнена, долг <b>${money(price)}</b> останется видимым у оператора и руководителя.`
        : PAY_HAND.includes(p.method)
          ? `В ваш подотчёт уйдёт <b>${money(p.amount)}</b>${diff?` · расхождение с прайсом ${diff>0?'+':'−'}${money(Math.abs(diff))}`:''}.`
          : `Счёт юрлицу: <b>${money(p.amount)}</b> придут на расчётный счёт, в подотчёт не попадают${diff?` · расхождение с прайсом ${diff>0?'+':'−'}${money(Math.abs(diff))}`:''}.`}</div>
    </div>
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      ${s.unserved?`<button class="g" onclick="clearUnserved('${rt.id}',${i0})">Вернуть в работу</button>`
        :s.done?`<button class="g" onclick="reopenStop('${rt.id}',${i0})">Вернуть в работу</button>`
        :`<button class="b" onclick="closeStop('${rt.id}',${i0})" ${r.devices.length?'':'disabled'}>Закрыть позицию</button>`}</div>
  </div>`;
}
/* Имена полей строки прибора: слева — те, что знает экран, справа — столбцы базы. */
const DEV_FIELD = {svc:'service_id', type:'device_type', grsi:'grsi', carrier:'carrier', serial:'serial',
  reading:'reading', room:'room', seal:'seal', pens:'pensioner', bad:'bad', badWhy:'bad_reason',
  badNote:'bad_note', blank:'blank', blankNo:'blank_no'};
function setDev(rid,i,k,v){
  const r=S.requests.find(x=>x.id===rid);
  const d=r.devices[i]; if(!d) return;
  d[k]=v;
  /* Поле правится на месте, на сервер уходит с задержкой: перерисовывать страницу
     на каждую букву нельзя — каретка уедет из поля. */
  if(!isDemo() && d.id && DEV_FIELD[k]) apiPatchDevice(d.id,{[DEV_FIELD[k]]:v});
  render();
}
/** Новая строка акта в том виде, в каком её принимает сервер. */
const devBody = d => ({service_id:d.svc, device_type:d.type, grsi:d.grsi, carrier:d.carrier,
  serial:d.serial||'', reading:d.reading||'', room:d.room, seal:!!d.seal, pensioner:!!d.pens,
  swap:!!d.swap, swap_of:d.swapOf||''});
function addDev(rid){
  const r = S.requests.find(x=>x.id===rid);
  if(!isDemo()) return apiAddDevice(rid,devBody({svc:'wv',type:DEV_TYPES[0].v,grsi:DEV_TYPES[0].grsi,
    carrier:'ХВС',room:'Кухня',seal:false,pens:false}));
  r.devices.push({svc:'wv',type:DEV_TYPES[0].v,grsi:DEV_TYPES[0].grsi,carrier:'ХВС',serial:'',reading:'',room:'Кухня',
    seal:false,pens:false,photos:[],bad:false,badWhy:FAIL_REASONS[0],badNote:'',blank:false,blankNo:'',repl:null});
  render();
}
function rmDev(rid,i){
  const r = S.requests.find(x=>x.id===rid), d = r.devices[i];
  if(!isDemo()) return d && d.id ? apiDropDevice(d.id) : undefined;
  /* Убрали непригодный прибор — вместе с ним уходят его строка замены и запись в листе ожидания.
     Убрали саму строку замены — у непригодного прибора снимается отметка «замена предложена»,
     иначе в акте осталась бы ссылка на строку, которой больше нет. */
  if(d){ dropReplWait(d); if(r.devices[i+1] && r.devices[i+1].swap) r.devices.splice(i+1,1); }
  if(d && d.swap && r.devices[i-1] && r.devices[i-1].repl==='предложена') r.devices[i-1].repl = null;
  r.devices.splice(i,1); render();
}
/* ---------- непригодный прибор и замена ----------
   Поверка непригодного прибора всё равно выполнена и оплачивается: работа сделана,
   результат отрицательный. Свидетельство о непригодности поверитель выписывает на
   бумажном бланке от руки — CRM хранит только номер бланка, нумерацию заказчик ведёт
   сам. Дальше поверителю остаётся предложить замену: согласился клиент — в акте
   появляется строка замены того же носителя, отказался — адрес уходит оператору
   в лист ожидания с причиной «нужна замена». */
function dropReplWait(d){
  if(!d || !d.replW) return;
  S.waits = S.waits.filter(x=>x.id!==d.replW);
  d.replW = null;
}
function setBad(rid,i,v){
  const r = S.requests.find(x=>x.id===rid); if(!r) return;
  const d = r.devices[i]; if(!d) return;
  const bad = v==='bad';
  if(bad===!!d.bad) return render();
  if(!isDemo()){
    /* Годен или нет — одна правка строки: причина, бланк и отметка о замене
       снимаются вместе с непригодностью. Строку замены убирает сервер. */
    return apiPatchDevice(d.id,{bad, bad_reason: bad?(d.badWhy||FAIL_REASONS[0]):null,
      bad_note:'', blank:false, blank_no:''}, 0);
  }
  d.bad = bad; d.badNote=''; d.blank=false; d.blankNo=''; d.repl=null;
  if(bad){ d.badWhy = d.badWhy || FAIL_REASONS[0]; }
  else {
    /* Вернули «годен» — снимаем всё, что тянулось за непригодностью. */
    dropReplWait(d);
    if(r.devices[i+1] && r.devices[i+1].swap) r.devices.splice(i+1,1);
    d.badWhy = FAIL_REASONS[0];
  }
  render();
}
function offerRepl(rid,i){
  const r = S.requests.find(x=>x.id===rid); if(!r) return;
  const d = r.devices[i]; if(!d || !d.bad) return;
  const svc = replSvcOf(d);
  const nd = {svc,type:d.type,grsi:d.grsi,carrier:d.carrier,serial:'',reading:'',room:d.room,
    seal:false,pens:d.pens,photos:[],bad:false,badWhy:FAIL_REASONS[0],badNote:'',blank:false,blankNo:'',
    repl:null,swap:true,swapOf:d.serial||''};
  if(!isDemo()){
    /* Отметка на непригодном приборе и строка установленного взамен — две записи:
       первая объясняет, почему появилась вторая. */
    return apiSetReplacement(d.id,'предложена').then(out=>out && apiAddDevice(rid,devBody(nd)));
  }
  dropReplWait(d);
  d.repl = 'предложена';
  r.devices.splice(i+1,0,nd);
  toast(`Добавлена строка замены: ${SVC[svc].name} · ${money(priceOfDev(r,nd))} клиенту, вам ${money(SVC[svc].rV)}. `
    + 'Впишите заводской номер установленного прибора — без него позицию не закрыть.');
}
function postponeRepl(rid,i){
  const r = S.requests.find(x=>x.id===rid); if(!r) return;
  const d = r.devices[i]; if(!d || !d.bad) return;
  if(!isDemo()){
    /* Клиент отказался менять сейчас — строку замены из акта убираем: работа не выполнена.
       Запись в лист ожидания заводит сервер: у неё сквозной номер. */
    const swap = r.devices[i+1] && r.devices[i+1].swap ? r.devices[i+1] : null;
    return (swap && swap.id ? apiDropDevice(swap.id) : Promise.resolve(1))
      .then(()=>apiSetReplacement(d.id,'отложена'));
  }
  /* Клиент отказался менять сейчас — строку замены из акта убираем: работа не выполнена. */
  if(r.devices[i+1] && r.devices[i+1].swap) r.devices.splice(i+1,1);
  dropReplWait(d);
  d.repl = 'отложена';
  const now = new Date();
  const w = {id:'W'+(++S.seq),req:r.id,route:r.routeId,city:r.city,kind:'замена',reason:'Нужна замена',
    note:`${d.serial?'Прибор №'+d.serial:'Прибор без читаемого номера'} непригоден · ${d.badWhy.toLowerCase()}`
      + (d.badNote?' · '+d.badNote:'') + '. Клиент отложил замену.',
    at:`${TODAY} ${pad(now.getHours())}:${pad(now.getMinutes())}`,by:r.verifier||S.me,state:'не обработана',to:null};
  S.waits.push(w); d.replW = w.id;
  toast(`${r.id}: замена отложена. Адрес ушёл в лист ожидания оператора с причиной «нужна замена» — он перезвонит клиенту.`);
}
function clearRepl(rid,i){
  const r = S.requests.find(x=>x.id===rid); if(!r) return;
  const d = r.devices[i]; if(!d) return;
  if(!isDemo()) return apiSetReplacement(d.id,null);
  dropReplWait(d); d.repl = null;
  toast('Отметка об отложенной замене снята, адрес убран из листа ожидания.');
}
/* Кадр из акта убирает только руководитель, и только пометкой: файл в
   хранилище остаётся, срок хранения — не меньше шести лет. Поверителю кнопки
   не показываем вовсе, чтобы не предлагать несделуемое. */
const canDropPhoto = () => isDemo() || S.role==='supervisor';
function rmPhoto(rid,i,k){
  const r=S.requests.find(x=>x.id===rid);
  const p = r?.devices?.[i]?.photos?.[k]; if(!p) return;
  S.lb=null;
  if(!isDemo()){
    if(S.role!=='supervisor') return toast('Убрать кадр из акта может только руководитель.');
    return apiDropPhoto(p.id);
  }
  r.devices[i].photos.splice(k,1); render();
}
/* ---------- фото работ ----------
   Кнопка «Добавить фото» на телефоне открывает камеру (capture="environment").
   Кадр с телефона — это 3–5 МБ и 12 Мп, в акте столько не нужно: заказчик просил
   «чтобы читаемо», не больше. Поэтому перед добавлением жмём прямо в браузере —
   canvas, длинная сторона 1600 px, JPEG 0.82. На сервер потом уйдёт уже сжатое. */
const PHOTO_MAX = 1600, PHOTO_Q = .82;
/* Те же потолки, что и на сервере (server/src/storage.ts): на телефоне их видно
   сразу, до загрузки, а сервер всё равно проверяет заново — он тут главный. */
const PHOTO_MAX_BYTES = 5*1024*1024, PHOTO_MAX_PER_DEVICE = 10;
function shrinkPhoto(src){
  return new Promise(res=>{
    const img = new Image();
    img.onload = () => {
      const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
      if(!w0 || !h0) return res({src,w:0,h:0});
      const k = Math.min(1, PHOTO_MAX/Math.max(w0,h0));
      const w = Math.max(1,Math.round(w0*k)), h = Math.max(1,Math.round(h0*k));
      try{
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.fillStyle = '#FFFFFF'; cx.fillRect(0,0,w,h);   /* под прозрачность PNG — белый лист */
        cx.drawImage(img,0,0,w,h);
        res({src:cv.toDataURL('image/jpeg',PHOTO_Q),w,h});
      }catch(e){ res({src,w:w0,h:h0}); }                  /* не вышло сжать — кладём как есть */
    };
    img.onerror = () => res({src,w:0,h:0});
    img.src = src;
  });
}
/* Сжатый кадр из canvas приходит строкой data:image/jpeg;base64,… — в хранилище
   нужен сам файл. Перегоняем без сети: fetch по data-адресу этим и занимается. */
const asBlob = (src) => fetch(src).then(r=>r.blob());

/** Кадры в хранилище: по одному, чтобы на мобильной связи не глохло всё сразу. */
async function sendPhotos(rid,i,list){
  const r = S.requests.find(x=>x.id===rid);
  const d = r?.devices?.[i]; if(!d) return;
  const left = PHOTO_MAX_PER_DEVICE - d.photos.length;
  if(left<=0) return toast(`На прибор в акте принимается не больше ${PHOTO_MAX_PER_DEVICE} кадров.`);
  const take = list.slice(0,left);
  if(take.length<list.length) toast(`Взято ${take.length} из ${list.length}: на прибор не больше ${PHOTO_MAX_PER_DEVICE} кадров.`);
  toast(take.length>1?`Кадры уходят в хранилище — ${take.length} шт.`:'Кадр уходит в хранилище…');
  for(const f of take){
    try{
      const shrunk = await new Promise(res=>{
        const rd = new FileReader();
        rd.onload = () => shrinkPhoto(rd.result).then(res);
        rd.onerror = () => res(null);
        rd.readAsDataURL(f);
      });
      if(!shrunk) throw new Error('Кадр не прочитался.');
      const blob = await asBlob(shrunk.src);
      if(blob.size > PHOTO_MAX_BYTES){
        toast(`Кадр «${f.name}» весит больше ${PHOTO_MAX_BYTES/1024/1024} МБ — снимите заново.`);
        continue;
      }
      await apiUploadPhoto(d.id, blob, f.name);
    }catch(err){
      toast(err?.message || 'Кадр не загрузился.');
      break;
    }
  }
  await apiReload();
}

function addPhotos(rid,i,el){
  const list = [...el.files].slice(0,8); if(!list.length) return;
  if(!isDemo()){
    /* Снимок идёт в хранилище напрямую, минуя сервер: сервер только выдал
       подписанную ссылку и потом запишет кадр в акт (api/actions.js). */
    const files = [...list]; el.value = '';
    return sendPhotos(rid,i,files);
  }
  Promise.all(list.map(f=>new Promise(res=>{
    const rd = new FileReader();
    rd.onload = () => shrinkPhoto(rd.result).then(p=>res({...p,name:f.name}));
    rd.onerror = () => res(null);
    rd.readAsDataURL(f);
  }))).then(ps=>{
    const r = S.requests.find(x=>x.id===rid);
    const t = new Date().toTimeString().slice(0,5);
    if(r && r.devices[i]) ps.filter(Boolean).forEach(p=>
      r.devices[i].photos.push({src:p.src,name:p.name,t,w:p.w,h:p.h}));
    el.value = ''; render();
  });
}
function closeStop(id,i){
  const rt = S.routes.find(r=>r.id===id), s = rt.stops[i], r = S.requests.find(x=>x.id===s.req);
  if(s.unserved) return toast('Точка отмечена не обслуженной — сначала верните её в работу.');
  if(!r.devices.length) return toast('В акте нет приборов — закрывать нечего.');
  if(r.devices.some(d=>!d.svc)) return toast('В каждой строке прибора выберите услугу.');
  if(r.devices.some(d=>needSerial(d) && !String(d.serial).trim()))
    return toast('Заполните заводские номера приборов — они уходят в реестр УК. Пустым номер остаётся только у прибора с причиной «нечитаемый номер».');
  if(r.devices.some(d=>d.bad && d.badWhy==='Другое' && !String(d.badNote||'').trim()))
    return toast('Причина непригодности «другое» — опишите словами: это уйдёт в свидетельство и в «Аршин».');
  if(r.devices.some(d=>d.bad && d.blank && !String(d.blankNo||'').trim()))
    return toast('Укажите номер выданного бланка о непригодности — по нему руководитель сверяет бумажную нумерацию.');
  const bad = badDevs(r);
  const noBlank = bad.filter(d=>!d.blank).length;
  const post = bad.filter(d=>d.repl==='отложена').length;
  const noPh = r.devices.filter(d=>!d.photos.length).length;
  const noSeal = r.devices.filter(d=>!d.seal).length;
  const noRd = r.devices.filter(d=>!String(d.reading||'').trim()).length;
  if(!isDemo()){
    /* Деньги уходят вместе с закрытием: сервер записывает и акт, и отметку оплаты
       одной транзакцией. Правки полей, не успевшие уехать, дописываем до неё. */
    const p = payInit(r,rt.verifier);
    return flushDevices().then(()=>apiCloseAct(r.id,{method:p.method,amount:p.amount||0,note:p.note||''}));
  }
  s.done = true; s.called = s.called || 'подтверждена';
  r.status = 'выполнена'; r.verifier = rt.verifier; r.services = [...new Set(worksOf(r))];
  if(rt.status==='обзвонен'||rt.status==='черновик') rt.status='в работе';
  /* Деньги фиксируются в момент закрытия позиции: закрыть можно и без оплаты —
     тогда адрес останется в долгах, видимых оператору и руководителю. */
  const p = payInit(r,rt.verifier);
  const now2 = new Date();
  p.at = `${TODAY} ${pad(now2.getHours())}:${pad(now2.getMinutes())}`; p.by = rt.verifier;
  toast(`Позиция закрыта: ${r.devices.length} прибор(ов) на ${money(priceOf(r))}, вам начислено ${money(rateV(r))}.`
    + (p.method==='не оплачено' ? ' Оплата не принята — адрес уйдёт в список «выполнено без оплаты».'
      : PAY_HAND.includes(p.method) ? ` Принято ${p.method}: ${money(p.amount)} — сумма легла в ваш подотчёт.`
      : ` Оплата по счёту: ${money(p.amount)} — деньги придут на расчётный счёт.`)
    + (bad.length?` Непригодных приборов: ${bad.length} — поверка по ним оплачена.`:'')
    + (noBlank?` Без бланка о непригодности: ${noBlank} — выпишите свидетельство и отметьте его номер.`:'')
    + (post?` Отложенных замен: ${post} — адрес ждёт оператора в листе ожидания.`:'')
    + (noRd?` Без показаний: ${noRd} — их ждёт УК, допишите в акте.`:'')
    + (noPh?` Без фото: ${noPh} — оператор увидит подсветку.`:'')
    + (noSeal?` Без пломбы УК: ${noSeal} — в отчёт УК не пойдут.`:''));
}
function reopenStop(id,i){
  const rt = S.routes.find(r=>r.id===id), s = rt.stops[i], r = S.requests.find(x=>x.id===s.req);
  if(!isDemo()) return apiReopenAct(r.id);
  s.done = false; r.status = 'в маршруте'; r.verifier = null;
  /* Способ и сумму оставляем — снимаем только отметку о принятии денег. */
  if(r.pay) r.pay.at = null;
  toast('Позиция вернулась в работу. Начисления и отметка об оплате сняты до повторного закрытия.');
}

export { PHOTO_MAX, PHOTO_MAX_BYTES, PHOTO_MAX_PER_DEVICE, PHOTO_Q, addDev, addPhotos, canDropPhoto, clearRepl, closeStop, dropReplWait, offerRepl, postponeRepl, reopenStop, rmDev, rmPhoto, sendPhotos, setBad, setDev, shrinkPhoto, viewMyRoute, workSheet };
