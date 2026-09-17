/* Пульт оператора (заготовка под облачную АТС). */

import { I, svg } from '../ui/icons.js';
import { S, blankIntake, dayCities } from '../state.js';
import { SEL } from '../ui/controls.js';
import { TODAY, esc, pad, ru } from '../util.js';
import { addToRoute } from './support.js';
import { dayLock, lockedFor } from '../rules.js';
import { digitsOf, fmtPhone } from '../ui/phone.js';
import { dupGuard, dupPending, reqForm } from './intake.js';
import { randPhone, rint, rnd, rr } from '../demo/seed.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { createReq as apiCreateReq, fetchClient } from '../api/actions.js';
import { onCall, setLine } from '../api/calls.js';

/* ============ ПУЛЬТ ОПЕРАТОРА (заготовка под облачную АТС) ============ */
const hms = s => pad(Math.floor(s/3600))+':'+pad(Math.floor(s/60)%60)+':'+pad(s%60);
const ms  = s => pad(Math.floor(s/60))+':'+pad(s%60);
const shiftSec = () => S.op.shiftSec + (S.op.on&&S.op.from ? Math.floor((Date.now()-S.op.from)/1000) : 0);
const talkSec  = () => S.op.talkSec + (S.op.live ? Math.floor((Date.now()-S.op.live.t0)/1000) : 0);
/* Пока идёт разговор или постобработка, оператор системно на паузе — новые вызовы не приходят. */
const opBusy = () => !!(S.op.live || S.op.acw>0);

function opConsole(){
  const O = S.op;
  const state = O.live?'live' : O.inc?'ring' : '';
  return `<div class="opbar ${state}">
    <button class="opsw" role="switch" aria-pressed="${O.on}" onclick="toggleShift()">
      <span class="tr"><i></i></span>
      <span><b>${O.on?'На смене':'Не на смене'}</b>
        <small>${O.on?(opBusy()?'пауза':'принимает вызовы'):'вызовы уходят другим'}</small></span>
    </button>
    ${opLine()}</div>`;
}
function opLine(){
  const O = S.op;
  /* Имя клиента рядом с номером — из карточки, которую сервер прислал вместе с
     событием: оператор видит, кто звонит, до того как снял трубку. */
  const who = c => (c && c.client && c.client.name) ? ` · ${esc(c.client.name)}` : '';
  if(O.live){
    const sec = Math.floor((Date.now()-O.live.t0)/1000);
    return `<div class="opline">
      <span class="ic">${svg(I.phone,18)}</span>
      <div class="info"><div class="st">вызов принят</div>
        <div class="no">${esc(fmtPhone(O.live.num)||O.live.num)}${who(O.live)}</div></div>
      <div class="tm mono" id="opLive">${ms(sec)}</div>
      <div class="acts">
        <button class="g" onclick="toast('Перевод на старшего оператора — в интеграции с облачной АТС.')">Перевести</button>
        <button class="g end" onclick="hangup()">${svg(I.hang,13)}Завершить</button></div></div>`;
  }
  if(O.acw>0){
    return `<div class="opline">
      <span class="ic">${svg(I.act,18)}</span>
      <div class="info"><div class="st">постобработка</div>
        <div class="no idle">Заполните заявку — сохранение снимет паузу</div></div>
      <div class="tm mono" id="opAcw">${ms(O.acw)}</div>
      <div class="acts"><button class="g" onclick="S.op.acw=0;S.op.next=rint(5,12);render()">Готов</button></div></div>`;
  }
  if(O.inc){
    const sec = Math.floor((Date.now()-O.inc.t0)/1000);
    return `<div class="opline">
      <span class="ic">${svg(I.phone,18)}</span>
      <div class="info"><div class="st">входящий вызов</div>
        <div class="no">${esc(fmtPhone(O.inc.num)||O.inc.num)}${who(O.inc)}</div></div>
      <div class="tm mono" id="opRing">${ms(sec)}</div>
      <div class="acts">
        <button class="b ans" onclick="answer()">${svg(I.phone,13)}Принять</button>
        <button class="g end" onclick="reject()">Отклонить</button></div></div>`;
  }
  return `<div class="opline">
    <span class="ic">${svg(I.phone,18)}</span>
    <div class="info"><div class="st">${S.op.on?'линия свободна':'линия отключена'}</div>
      <div class="no idle">${S.op.on?'Ждём входящий с облачной АТС':'Включите смену, чтобы принимать вызовы'}</div></div></div>`;
}
function toggleShift(){
  const O = S.op;
  if(O.on && O.live) return toast('Идёт разговор. Завершите вызов, потом снимайтесь со смены.');
  if(O.on){ O.shiftSec = shiftSec(); O.on=false; O.from=null; O.inc=null; O.acw=0;
    toast('Смена закрыта. Вызовы уходят другим операторам.'); }
  else { O.on=true; O.from=Date.now(); O.next=rint(3,8); toast('Вы на смене. Входящие пойдут на вашу линию.'); }
  /* Рабочий режим: отметка живёт на сервере, а он передаёт её в АТС. Не дошла
     до АТС — работа не останавливается (входящие распределяет ответ на
     «кому звонить», а он читает ту же отметку), но оператор об этом знает. */
  if(!isDemo()){
    O.sentPause = false;
    setLine(O.on,false).then(out=>{ if(out && O.on && !out.synced && out.error) toast('В АТС отметка не дошла, действует только в CRM: '+out.error); })
      .catch(e=>toast(e?.message||'Отметка линии не сохранилась.'));
  }
  render();
}
function ringIn(){
  const prev = S.requests.filter(r=>r.phone).slice(-60);
  const known = rr()<.3 && prev.length ? rnd(prev) : null;
  S.op.inc = {num:known?known.phone:randPhone(),t0:Date.now()};
  render();
}
function answer(){
  const c = S.op.inc; if(!c) return;
  S.op.inc = null;
  S.op.live = {num:c.num,t0:Date.now()};
  S.op.calls++;
  /* Из звонка берём только номер — и тот оператор может заменить:
     звонят с городского, а для связи оставляют сотовый. */
  S.intake.phone = fmtPhone(c.num);
  if(!isDemo()) fetchClient(c.num);
  render();
}
/* Рабочий режим: ответ пришёл от АТС (трубку снял софтфон) — номер в форму
   приёма, история клиента подтянется тем же путём, что при ручном наборе. */
onCall({ answered: live => { S.intake.phone = fmtPhone(live.num); if(digitsOf(live.num).length===10) fetchClient(live.num); } });
function reject(){ S.op.inc=null; S.op.missed++; S.op.next=rint(4,10);
  toast('Вызов отклонён — уходит следующему свободному оператору.'); }
function hangup(){
  const L = S.op.live; if(!L) return;
  S.op.talkSec += Math.floor((Date.now()-L.t0)/1000);
  S.op.live = null; S.op.acw = 12;
  toast('Разговор завершён. Заполните заявку — сохранение снимет паузу.');
}
/* Тик раз в секунду. Числа обновляются точечно, полный render — только на смене состояния.
   Счётчики смены и разговоров копятся в состоянии, оператору их не показываем. */
function opTick(){
  const O = S.op;
  if(!S.auth) return;
  const here = S.view==='intake';
  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  /* Рабочий режим: разговор и постобработка для АТС — пауза. Уходит только на
     смене состояния, а не каждую секунду. */
  if(!isDemo() && O.on){ const p = opBusy(); if(p!==!!O.sentPause){ O.sentPause=p; setLine(true,p).catch(()=>{}); } }
  if(O.live){ if(here) set('opLive',ms(Math.floor((Date.now()-O.live.t0)/1000))); return; }
  if(O.acw>0){ O.acw--;
    if(O.acw<=0){ O.next=rint(5,12); if(here) render(); } else if(here) set('opAcw',ms(O.acw));
    return; }
  if(O.inc){
    const sec = Math.floor((Date.now()-O.inc.t0)/1000);
    if(sec>=25){ O.inc=null; O.missed++; O.next=rint(6,14);
      if(here) toast('Вызов не принят за 25 секунд — ушёл в очередь.'); return; }
    if(here) set('opRing',ms(sec));
    return;
  }
  if(!here) return;   // вызов приходит только когда оператор смотрит на линию
  // Имитация входящих — только в демо: в рабочем режиме их присылает АТС (api/calls.js).
  if(isDemo() && O.on && O.next>0 && --O.next<=0) ringIn();
}
/* Проверки формы одни и те же у оператора и у руководителя — держим их в одном месте. */
/* Почта не обязательна, но если её ввели — она должна быть похожа на адрес:
   по ней потом уйдёт чек, исправлять задним числом будет некому. */
const mailOk = v => { const s = String(v||'').trim(); return !s || /^[^@\s]+@[^@\s]+\.[A-Za-zА-Яа-я]{2,}$/.test(s); };
function reqProblem(K,ds){
  if(!K.name.trim()) return K.ctype==='Юрлицо'?'Укажите название организации.':'Укажите ФИО клиента.';
  if(K.ctype==='Юрлицо'){
    const inn = String(K.inn).replace(/\D/g,'');
    if(!inn) return 'Для юрлица ИНН обязателен — без него не выставить счёт и закрывающие.';
    if(inn.length!==10 && inn.length!==12) return 'ИНН — 10 цифр у организации или 12 у ИП. Сейчас '+inn.length+'.';
  }
  if(!K.phone.trim()) return 'Укажите телефон — по нему пойдёт прозвонка маршрута.';
  if(digitsOf(K.phone).length!==10) return 'Телефон неполный: нужно 10 цифр после +7.';
  if(K.phone2 && digitsOf(K.phone2).length!==10) return 'Дополнительный телефон неполный: нужно 10 цифр после +7.';
  if(!mailOk(K.email)) return 'Почта клиента введена с ошибкой — поправьте или очистите поле.';
  if(!(K.city || dayCities(ds)[0])) return 'В этот день бригада не выезжает — выберите другую дату.';
  if(!K.house.trim()) return 'Укажите номер дома.';
  return null;
}
const reqFrom = (K,ds,operator) => ({id:'R'+(++S.seq),date:ds,created:TODAY,city:K.city||dayCities(ds)[0],
  clientType:K.ctype,name:K.name,inn:K.ctype==='Юрлицо'?K.inn:'',
  phone:K.phone,contact:K.contact,phone2:K.phone2,contact2:K.contact2,email:(K.email||'').trim(),
  street:K.street,house:K.house,entrance:K.entrance,floor:K.floor,
  flat:K.flat,intercom:K.intercom,time:K.time,cmtOp:K.cmtOp,cmtVf:K.cmtVf,
  svcs:[...(K.svcs||[])],services:[],devices:[],status:'создана',routeId:null,operator});
function createReq(){
  const K = S.intake;
  const lock = lockedFor(S.day);
  if(lock) return toast(`${ru(S.day)}: приём закрыт — ${lock}. Добавить заявку на эту дату может только руководитель.`);
  const bad = reqProblem(K,S.day); if(bad) return toast(bad);
  if(dupGuard(K,S.day,null)) return;
  /* Те же правила сервер проверит ещё раз и на своих данных: здесь они стоят,
     чтобы оператор увидел отказ, не дожидаясь ответа. */
  if(!isDemo()){
    const city = K.city || dayCities(S.day)[0];
    apiCreateReq(K,S.day).then(out=>{ if(out){ S.intake = blankIntake(); S.intake.city = city;
      if(S.op.acw>0){ S.op.acw=0; S.op.next=rint(5,12); } render(); } });
    return;
  }
  const r = reqFrom(K,S.day,S.me);
  S.requests.push(r);
  const wasAcw = S.op.acw>0;
  if(wasAcw){ S.op.acw=0; S.op.next=rint(5,12); }
  S.intake = blankIntake(); S.intake.city = r.city;
  toast('Заявка сохранена: '+r.city+', '+ru(S.day)+', окно '+pad(K.time-1)+':00–'+pad(K.time+1)+':00.'
    + (wasAcw?' Постобработка закрыта, линия снова принимает вызовы.':''));
}

/* Заявка от руководителя: единственный способ добавить адрес на дату, ушедшую под маршруты. */
function openSupReq(ds){
  const K = blankIntake();
  K.city = dayCities(ds)[0] || '';
  S.supReq = {...K, day:ds, route:''};
  S.modal = {k:'supreq'}; render();
}
function supDay(v){
  const K = S.supReq; if(!K) return;
  K.day = v; K.route = '';
  const cs = dayCities(v);
  if(cs.length && !cs.includes(K.city)) K.city = cs[0];
  render();
}
function createSupReq(){
  const K = S.supReq; if(!K) return;
  const ds = K.day;
  const bad = reqProblem(K,ds); if(bad) return toast(bad);
  if(dupGuard(K,ds,null)) return;
  const rt = K.route ? S.routes.find(r=>r.id===K.route && r.date===ds) : null;
  if(K.route && !rt) return toast('Этого маршрута на дату больше нет — выберите другой.');
  if(!isDemo()){
    apiCreateReq(K,ds).then(out=>{
      if(!out) return;
      S.supReq = null; S.modal = null;
      if(rt) addToRoute(rt.id,out.request.id); else render();
    });
    return;
  }
  const r = reqFrom(K,ds,S.me);
  S.requests.push(r);
  if(rt) addToRoute(rt.id,r.id);
  else toast(`${r.id} создана на ${ru(ds)}, ${r.city}. Маршрут не выбран — заявка ждёт в свободных.`);
  S.supReq = null; S.modal = null; render();
}
function supReqModal(){
  const K = S.supReq; if(!K) return '';
  const ds = K.day, lock = dayLock(ds);
  const rts = S.routes.filter(r=>r.date===ds).sort((a,b)=>a.id.localeCompare(b.id));
  const items = [{v:'',l:'— оставить без маршрута —'},...rts.map(rt=>({v:rt.id,
    l:`${rt.id} · ${(rt.cities||[rt.city]).join(', ')}`,
    hint:`${rt.stops.length} точек · ${rt.status}`}))];
  return `<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="width:min(1120px,96vw)">
      <div class="mhd"><h3>Заявка на ${ru(ds)}</h3>
        <span class="note">${lock?`для операторов дата закрыта: ${lock}`:'дата ещё открыта для операторов'}</span>
        <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>
      ${reqForm(K,'S.supReq','sq',ds,v=>supDay(v))}
      <div class="row" style="margin-top:14px;align-items:flex-end">
        <div class="f" style="width:300px;margin-bottom:0"><label>Включить в маршрут</label>
          ${SEL('sqRoute',K.route,items,v=>{S.supReq.route=v;})}</div>
        <span class="note" style="flex:1">${rts.length
          ? 'Точка встанет в маршрут по времени прибытия — даже если маршрут уже в работе.'
          : 'На эту дату маршрутов ещё нет — заявка останется в свободных.'}</span>
        <button class="b" onclick="createSupReq()">${dupPending(K,ds,null)?'Создать как вторую':'Создать заявку'}</button>
      </div>
    </div></div>`;
}

export { answer, createReq, createSupReq, hangup, hms, mailOk, ms, opBusy, opConsole, opLine, opTick, openSupReq, reject, reqFrom, reqProblem, ringIn, shiftSec, supDay, supReqModal, talkSec, toggleShift };
