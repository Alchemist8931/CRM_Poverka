/* Расчёты и правила: смены, замок даты, цены, ставки, оплата, подотчёт. */

import { S, capOf, dayCities, dayRec, staffById } from './state.js';
import { SERVICES, SVC } from './refs.js';
import { esc, money } from './util.js';
import { render } from './ui/render.js';
import { isDemo } from './api/mode.js';
import { savePayment, setSkills } from './api/actions.js';

/* ---------- расчёты ---------- */
function absentOn(id,ds){ return S.absences.some(a=>a.staff===id&&a.status==='согласовано'&&ds>=a.from&&ds<=a.to); }
/* Смена — это назначение руководителя на конкретную дату минус согласованные отсутствия. */
const onShift = (p,ds) => !!dayRec(ds) && !absentOn(p.id,ds) &&
  ((dayRec(ds).crew||[]).includes(p.id) || (dayRec(ds).ops||[]).includes(p.id));
const crewOn = ds => (dayRec(ds)?.crew||[]).map(staffById).filter(p=>p&&!absentOn(p.id,ds));
const opsOn  = ds => (dayRec(ds)?.ops||[]).map(staffById).filter(p=>p&&!absentOn(p.id,ds));
const planFor = ds => dayCities(ds).reduce((a,c)=>a+capOf(ds,c),0);
const bookedOn = ds => S.requests.filter(r=>r.date===ds&&r.status!=='отменена').length;
/* Дата уходит под маршруты: как только руководитель сел её собирать или собрал
   хотя бы один маршрут, оператор на неё больше не записывает — состав дня зафиксирован. */
function dayLock(ds){
  if(S.rc && S.rc.date===ds) return 'идёт сборка маршрутов';
  /* В рабочем режиме замок считает сервер: у него перед глазами все маршруты и
     открытые конструкторы, а во вкладке лежит только загруженный срез. */
  const d = dayRec(ds);
  if(d && 'lock' in d) return d.lock;
  if(S.routes.some(r=>r.date===ds)) return 'маршруты на дату уже собраны';
  return null;
}
/* Руководитель — исключение: он ставит заявку в готовый маршрут даже во время выезда. */
const lockedFor = (ds,role) => (role||S.role)==='supervisor' ? null : dayLock(ds);
const bookedIn = (ds,c) => S.requests.filter(r=>r.date===ds&&r.city===c&&r.status!=='отменена').length;
/* Сколько записано на дату и в город. В демо-режиме считается по заявкам в
   памяти, в рабочем — приходит счётчиком вместе с днём: во вкладке лежит срез,
   и считать по нему «сколько всего» было бы враньём. */
const countOn = ds => S.booked ? (S.booked[ds] ?? 0) : bookedOn(ds);
const countIn = (ds,c) => S.booked ? (S.booked[`${ds}#${c}`] ?? 0) : bookedIn(ds,c);
function dayTotal(ds){
  const p = planFor(ds), b = countOn(ds), pct = p?b/p:0;
  return {p,b,pct,s:p===0?'off':pct>1.1?'over':pct>=1?'full':pct>=.5?'fill':'free'};
}
/* Разрез дня по городу: у каждого города приёма свой план, заданный руководителем. */
function dayState(ds,c){
  if(!c || !dayCities(ds).includes(c)) return dayTotal(ds);
  const p = capOf(ds,c), b = countIn(ds,c), pct = p?b/p:0;
  return {p,b,pct,s:p===0?'off':pct>1.1?'over':pct>=1?'full':pct>=.5?'fill':'free'};
}
/* Услуга теперь живёт в строке прибора: две поверки на адресе — две услуги в расчёте. */
const worksOf = r => (r.devices||[]).map(d=>d.svc).filter(id=>SVC[id]);
/* Компетенции поверителя: что он умеет делать. Услуга доступна на дату,
   если в этот день в смене есть поверитель, закрывающий все выбранные услуги. */
const skillsOf = p => p?.svcs || [];
const canDoAll = (p,ids) => ids.every(id=>skillsOf(p).includes(id));
const crewFor = (ds,ids) => crewOn(ds).filter(p=>canDoAll(p,ids));
/* Что можно выполнить в этот день — объединение компетенций назначенной смены. */
function worksOn(ds){
  const have = new Set();
  crewOn(ds).forEach(p=>skillsOf(p).forEach(id=>have.add(id)));
  return SERVICES.filter(s=>have.has(s.id));
}
function tgSkill(pid,sid){
  const p = staffById(pid); if(!p) return;
  const s = skillsOf(p);
  const next = s.includes(sid) ? s.filter(x=>x!==sid) : [...s,sid];
  if(!isDemo()) return setSkills(pid,next);
  p.svcs = next;
  render();
}
const rateV = r => worksOf(r).reduce((a,id)=>a+SVC[id].rV,0);
const rateO = r => worksOf(r).reduce((a,id)=>a+SVC[id].rO,0);
/* Цена считается по строкам приборов: пенсионная скидка стоит на приборе, а не на заявке. */
const priceOfDev = (r,d) => { const s = SVC[d.svc]; if(!s) return 0;
  return r.clientType==='Юрлицо' ? s.pU : d.pens ? s.pP : s.pF; };
const priceOf = r => (r.devices||[]).reduce((a,d)=>a+priceOfDev(r,d),0);
/* Скидка пенсионеру — за счёт компании: сдельные ставки от неё не зависят. */
const discountOf = r => r.clientType==='Юрлицо' ? 0
  : (r.devices||[]).reduce((a,d)=>{ const s=SVC[d.svc]; return a + (s&&d.pens ? s.pF-s.pP : 0); },0);
/* ---------- оплата на месте и подотчёт ----------
   Эквайринга на первом этапе нет. Поверитель берёт с клиента наличные или перевод
   на карту и до конца месяца держит деньги у себя как подотчёт; в конце месяца сдаёт
   собранное руководителю за вычетом своей сдельной оплаты. CRM только учитывает суммы:
   ни QR, ни чеков, ни фискализации здесь нет — они появятся вместе с эквайрингом. */
const PAY_METHODS = ['наличные','перевод на карту','по счёту','не оплачено'];
/* Счёт выставляется только юрлицу — физлицу этот способ не показываем. */
const payMethods = r => PAY_METHODS.filter(m=>m!=='по счёту' || r.clientType==='Юрлицо');
/* В подотчёт попадает лишь то, что поверитель забрал лично: деньги по счёту идут
   сразу на расчётный счёт и через его руки не проходят. */
const PAY_HAND = ['наличные','перевод на карту'];
const paidWith = (r,m) => r.pay && r.pay.method===m ? (r.pay.amount||0) : 0;
const handCash = r => r.pay && PAY_HAND.includes(r.pay.method) ? (r.pay.amount||0) : 0;
const noPay = r => !r.pay || r.pay.method==='не оплачено';
/* Отметка оплаты заводится при первом открытии акта: способ подставляется по типу
   клиента, сумма — из прайса, пока её не поправили руками. */
function payInit(r,by){
  if(!r.pay) r.pay = {method:r.clientType==='Юрлицо'?'по счёту':'наличные',
    amount:priceOf(r),at:null,by:by||null,note:'',manual:false};
  const p = r.pay;
  if(!p.manual) p.amount = p.method==='не оплачено' ? 0 : priceOf(r);
  return p;
}
function setPay(rid,k,v){
  const r = S.requests.find(x=>x.id===rid); if(!r) return;
  const p = payInit(r);
  if(k==='amount'){ p.amount = Math.max(0,parseInt(String(v).replace(/\D/g,''))||0); p.manual = true; }
  else if(k==='method'){ p.method = v; if(!p.manual) p.amount = v==='не оплачено' ? 0 : priceOf(r); }
  else p[k] = v;
  /* Пока акт не закрыт, отметка живёт в форме: на сервер она уедет вместе с
     закрытием позиции. У закрытого акта правка суммы или способа — это уже
     отдельная запись, и она уходит сразу. */
  if(!isDemo() && r.status==='выполнена') savePayment(r);
  render();
}
const payTag = r => !r.pay ? '<span class="tg t-mut">оплата не отмечена</span>'
  : r.pay.method==='не оплачено' ? '<span class="tg t-err">без оплаты</span>'
  : `<span class="tg ${r.pay.method==='по счёту'?'t-cold':'t-ok'}">${r.pay.method} · ${money(r.pay.amount)}</span>`;
const payLine = r => !r.pay ? 'оплата не отмечена'
  : r.pay.method==='не оплачено' ? 'без оплаты'+(r.pay.note?' · '+r.pay.note:'')
  : `${r.pay.method} · ${money(r.pay.amount)}`;
/* Подотчёт поверителя за месяц: что собрал на адресах, что ему начислено сдельной
   и что уже сдал руководителю. Сдача привязана к месяцу, за который её принесли,
   а не к дню приёмки: деньги за август обычно везут в первых числах сентября. */
function subReport(vid,m){
  const done = S.requests.filter(r=>r.status==='выполнена' && r.verifier===vid && r.date.slice(0,7)===m);
  const cash = done.reduce((a,r)=>a+paidWith(r,'наличные'),0);
  const card = done.reduce((a,r)=>a+paidWith(r,'перевод на карту'),0);
  const acct = done.reduce((a,r)=>a+paidWith(r,'по счёту'),0);
  const unpaid = done.filter(noPay);
  const wage = done.reduce((a,r)=>a+rateV(r),0);
  const hos = S.handovers.filter(h=>h.staff===vid && h.period===m).sort((a,b)=>a.at.localeCompare(b.at));
  const given = hos.reduce((a,h)=>a+h.amount,0);
  const last = S.handovers.filter(h=>h.staff===vid).sort((a,b)=>b.at.localeCompare(a.at))[0] || null;
  const got = cash+card;
  return {done,cash,card,acct,unpaid,wage,hos,given,got,left:got-wage-given,last};
}
function svcNames(r){
  const w = worksOf(r); if(!w.length) return '<span class="note">по факту</span>';
  const c = {}; w.forEach(id=>c[id]=(c[id]||0)+1);
  return Object.entries(c).map(([id,n])=>esc(SVC[id].name)+(n>1?` <b class="mono">×${n}</b>`:'')).join(', ');
}
const photoCount = r => (r.devices||[]).reduce((a,d)=>a+(d.photos?.length||0),0);
const addrOf = r => `${r.street}, ${r.house}${r.entrance?', под. '+r.entrance:''}${r.flat?', кв. '+r.flat:''}`;

export { PAY_HAND, PAY_METHODS, absentOn, addrOf, bookedIn, bookedOn, canDoAll, crewFor, crewOn, dayLock, dayState, dayTotal, discountOf, handCash, lockedFor, noPay, onShift, opsOn, paidWith, payInit, payLine, payMethods, payTag, photoCount, planFor, priceOf, priceOfDev, rateO, rateV, setPay, skillsOf, subReport, svcNames, tgSkill, worksOf, worksOn };
