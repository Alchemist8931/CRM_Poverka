/* Приём заявки: форма, клиент по номеру, проверка дублей. */

import { CHK, DATE, SEG, SEL } from '../ui/controls.js';
import { PHONE, digitsOf, fmtPhone } from '../ui/phone.js';
import { S, dayCities } from '../state.js';
import { SERVICES, STREETS, SVC, badTag } from '../refs.js';
import { TODAY, addDays, esc, iso, pad, ru, today } from '../util.js';
import { addrOf, crewFor, dayState, dayTotal, lockedFor } from '../rules.js';
import { opConsole } from './op-console.js';
import { pickDay, ribbon, shell } from '../ui/shell.js';
import { render, toast } from '../ui/render.js';

/* ---------- форма заявки ----------
   Один и тот же набор полей работает и на первой странице, и в модальной
   карточке из поддержки маршрутов: K — объект, T — путь к нему в состоянии. */
function reqForm(K,T,p,day,onDay){
  const U = K.ctype==='Юрлицо';
  const cs = dayCities(day);
  if(cs.length && !cs.includes(K.city)) K.city = cs[0];
  const want = K.svcs || (K.svcs = []);
  /* Подсказка дат живёт внутри календаря — она нужна только когда выбраны услуги. */
  const slots = want.length ? slotsFor(want,K.city) : null;
  return `<div class="row" style="margin:2px 0 14px;flex-wrap:nowrap">
      <div class="f" style="flex:none"><label>Тип клиента</label>${SEG(K.ctype,['Физлицо','Юрлицо'],`setF('${T}','ctype',$v)`)}</div>
      <div class="f" style="flex:1;min-width:240px;max-width:700px"><label>${U?'Организация':'ФИО клиента'}</label>
        <input class="fld" id="${p}Name" value="${esc(K.name)}" oninput="${T}.name=this.value" placeholder="${U?'ООО «Стройсервис»':'Смирнова Т. А.'}"></div>
      ${U?`<div class="f" style="width:210px"><label>ИНН организации</label>
        <input class="fld mono" id="${p}Inn" value="${esc(K.inn)}" oninput="${T}.inn=this.value.replace(/\\D/g,'')" placeholder="10 или 12 цифр" maxlength="12"></div>`:''}
      <div class="f" style="width:250px"><label>Почта клиента</label>
        <input class="fld" id="${p}Mail" value="${esc(K.email||'')}" oninput="${T}.email=this.value.trim()"
          placeholder="не обязательно" title="Понадобится для чека и уведомлений, когда появится онлайн-оплата"></div>
    </div>
    <div class="g4" style="margin-bottom:14px">
      <div class="f" style="margin-bottom:0"><label>Телефон основной</label>${PHONE(p+'Phone',K.phone,'phone','основной',T)}</div>
      <div class="f" style="margin-bottom:0"><label>ФИО контакта</label>
        <input class="fld" id="${p}Contact" value="${esc(K.contact)}" oninput="${T}.contact=this.value" placeholder="кто отвечает"></div>
      <div class="f" style="margin-bottom:0"><label>Телефон дополнительный</label>${PHONE(p+'Phone2',K.phone2,'phone2','дополнительный',T)}</div>
      <div class="f" style="margin-bottom:0"><label>ФИО контакта</label>
        <input class="fld" id="${p}Contact2" value="${esc(K.contact2)}" oninput="${T}.contact2=this.value" placeholder="кто отвечает"></div>
    </div>
    ${knownClient(K,T)}
    <div class="f" style="margin-bottom:14px"><label>Услуги · ${want.length||'не выбраны'}</label>
      <div class="tgls sk">${SERVICES.map(s=>`<button type="button" class="tgl" aria-pressed="${want.includes(s.id)}"
        title="${esc(s.name)}" onclick="tgSvc('${T}','${s.id}')">${esc(s.name)}</button>`).join('')}</div></div>
    <div class="row" style="margin-bottom:14px;flex-wrap:nowrap">
      <div class="f" style="width:186px"><label>Город</label>
        ${cs.length?SEL(p+'City',K.city,cs.map(c=>({v:c,l:c,hint:dayState(day,c).b+'/'+dayState(day,c).p})),v=>K.city=v)
          :`<div class="fld" style="color:var(--ink3)">выходной день</div>`}</div>
      <div class="f" style="flex:1;min-width:170px"><label>Улица</label>${SEL(p+'Street',K.street,STREETS,v=>K.street=v)}</div>
      <div class="f" style="width:50px"><label>дом</label><input class="fld mono" id="${p}House" value="${esc(K.house)}" oninput="${T}.house=this.value" placeholder="12"></div>
      <div class="f" style="width:50px"><label>под.</label><input class="fld mono" id="${p}Ent" value="${esc(K.entrance)}" oninput="${T}.entrance=this.value" placeholder="3"></div>
      <div class="f" style="width:50px"><label>эт.</label><input class="fld mono" id="${p}Floor" value="${esc(K.floor)}" oninput="${T}.floor=this.value" placeholder="5"></div>
      <div class="f" style="width:50px"><label>кв.</label><input class="fld mono" id="${p}Flat" value="${esc(K.flat)}" oninput="${T}.flat=this.value" placeholder="45"></div>
      <div class="f" style="width:76px"><label>Домофон</label>
        <div class="chkbox">${CHK(K.intercom,K.intercom?'вкл.':'выкл.',`${T}.intercom=!${T}.intercom;render()`)}</div></div>
      <div class="f" style="width:120px"><label>Дата выезда</label>${DATE(p+'Date',day,onDay,{slots,slotsCity:K.city})}</div>
      <div class="f" style="width:150px"><label>Время прибытия</label>
        ${SEL(p+'Time',K.time,Array.from({length:11},(_,i)=>({v:10+i,l:pad(10+i)+':00',hint:'окно '+pad(9+i)+':00–'+pad(11+i)+':00'})),v=>K.time=+v)}</div>
    </div>
    <div class="g2">
      <div class="f" style="margin-bottom:0"><label>Комментарий для операторов</label>
        <textarea class="fld" id="${p}CmtOp" oninput="${T}.cmtOp=this.value" placeholder="Что важно знать при прозвонке: когда звонить, кто отвечает, как оплачивают">${esc(K.cmtOp)}</textarea></div>
      <div class="f" style="margin-bottom:0"><label>Комментарий для поверителей</label>
        <textarea class="fld" id="${p}CmtVf" oninput="${T}.cmtVf=this.value" placeholder="Что важно знать на адресе: доступ к стояку, собака, состояние пломбы">${esc(K.cmtVf)}</textarea></div>
    </div>`;
}
function tgSvc(path,id){
  const K = formOf(path), a = K.svcs || (K.svcs = []);
  const i = a.indexOf(id);
  if(i>=0) a.splice(i,1); else a.push(id);
  render();
}
/* Ближайшие даты под выбранные услуги и город: бригада едет в этот город,
   план по нему ещё не закрыт, дата не ушла под маршруты и в смене есть
   поверитель, закрывающий все выбранные услуги. */
function slotsFor(ids,city,limit){
  const out = [];
  for(let i=0;i<45 && out.length<(limit||14);i++){
    const ds = iso(addDays(today,i));
    const cs = dayCities(ds);
    if(!cs.length || lockedFor(ds,'operator')) continue;
    if(city && !cs.includes(city)) continue;
    const t = city ? dayState(ds,city) : dayTotal(ds);
    if(!t.p || t.pct>=1) continue;
    const crew = crewFor(ds,ids);
    if(!crew.length) continue;
    out.push({ds,plan:t.p,free:Math.max(0,t.p-t.b),crew:crew.length});
  }
  return out;
}
/* Формой заявки пользуются три места: приём оператора, карточка правки и заявка руководителя. */
const formOf = path => path==='S.edit'?S.edit : path==='S.supReq'?S.supReq : S.intake;
function setF(path,k,v){ formOf(path)[k]=v; render(); }
/* Дата, на которую оформляется заявка: у приёма она общая для экрана, у двух
   остальных форм лежит в самой форме. */
const dayOf = path => path==='S.intake' ? S.day : (formOf(path)||{}).day;
/* Правка открытой заявки не должна считать саму себя прежним обращением. */
const selfOf = path => path==='S.edit' ? (S.modal||{}).id : null;

/* ---------- клиент по номеру телефона ---------- */
/* Карточки клиента в модели нет: справочника контактов у заказчика тоже нет,
   а телефон он и так спрашивает первым. Поэтому «тот же клиент» — это тот же
   номер, набранный в основном или в дополнительном поле любой прежней заявки. */
function histFor(phone,exceptId){
  const d = digitsOf(phone);
  if(d.length!==10) return [];
  return S.requests.filter(r=>r.id!==exceptId && (digitsOf(r.phone)===d || digitsOf(r.phone2)===d))
    .sort((a,b)=> b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}
const sameAddr = (a,b) => nrm(a.street)===nrm(b.street) && nrm(a.house)===nrm(b.house)
  && nrm(a.flat)===nrm(b.flat) && nrm(a.entrance)===nrm(b.entrance);
const nrm = v => String(v==null?'':v).trim().toLowerCase();
/* Что заказано: у выполненной заявки — услуги из акта, у остальных — то, что записал оператор. */
const svcShort = r => {
  const ids = (r.services && r.services.length ? r.services : (r.svcs||[])).filter(id=>SVC[id]);
  return ids.length ? ids.map(id=>SVC[id].sh).join(', ') : '—';
};
/* Плашка под телефоном: как только номер набран целиком, оператор видит,
   что этот клиент уже обращался, и может не переспрашивать адрес заново. */
function knownClient(K,T){
  const h = histFor(K.phone,selfOf(T));
  if(!h.length) return '';
  const last = h[0];
  return `<div class="known">
    <span><b>Клиент уже обращался:</b> ${h.length} ${plural(h.length,'заявка','заявки','заявок')} с этого номера.
      <span class="last">Последняя ${ru(last.date)} · ${esc(last.city)}, ${esc(addrOf(last))} · ${esc(last.name)}</span></span>
    <button type="button" class="g sm" onclick="fillClient('${T}')"
      title="Подставит ФИО, тип клиента, ИНН, адрес и контакты из последней заявки">Подставить данные</button>
  </div>`;
}
const plural = (n,a,b,c) => { const d=n%100, e=n%10;
  return d>10&&d<20 ? c : e===1 ? a : e>1&&e<5 ? b : c; };
/* Подставляем всё, что у клиента не меняется от обращения к обращению.
   Дату, услуги и комментарии не трогаем — они у нового обращения свои. */
function fillClient(T){
  const K = formOf(T);
  const h = histFor(K.phone,selfOf(T));
  if(!h.length) return toast('Прежних заявок с этого номера нет — подставлять нечего.');
  const s = h[0];
  K.ctype = s.clientType; K.name = s.name; K.inn = s.inn || '';
  K.contact = s.contact || ''; K.phone2 = s.phone2 || ''; K.contact2 = s.contact2 || '';
  K.email = s.email || '';
  K.street = s.street; K.house = s.house; K.entrance = s.entrance;
  K.floor = s.floor; K.flat = s.flat; K.intercom = !!s.intercom;
  /* Город подставляем только если бригада в этот день туда едет: иначе форма
     всё равно вернёт его к городу дня, и оператор не поймёт, что произошло. */
  const cs = dayCities(dayOf(T));
  if(cs.includes(s.city)) K.city = s.city;
  toast(`Данные из ${s.id} подставлены: ${s.name}, ${s.city}, ${addrOf(s)}. Проверьте адрес — клиент мог переехать.`);
}
/* История клиента в карточке заявки: чем этот номер занимался раньше.
   Оператор смотрит сюда перед звонком — видно, что уже делали, где и чем кончилось. */
function clientHistory(r){
  const h = histFor(r.phone,r.id);
  if(!h.length) return `<div class="chist"><b>История клиента</b>
    <p class="note">Других заявок с номера ${esc(fmtPhone(r.phone))} нет — клиент обратился впервые.</p></div>`;
  const rows = h.slice(0,12);
  return `<div class="chist"><b>История клиента · ${h.length} ${plural(h.length,'заявка','заявки','заявок')} с номера ${esc(fmtPhone(r.phone))}</b>
    <table><thead><tr><th>Заявка</th><th class="num">Дата</th><th>Город</th><th>Адрес</th><th>Услуги</th><th>Статус</th></tr></thead><tbody>
      ${rows.map(q=>`<tr><td class="mono"><b>${q.id}</b></td><td class="num mono">${ru(q.date)}</td>
        <td>${esc(q.city)}</td>
        <td>${esc(addrOf(q))}${sameAddr(q,r)?' <span class="same">· тот же адрес</span>':''}</td>
        <td>${esc(svcShort(q))}</td><td>${reqTag(q.status)} ${badTag(q)}</td></tr>`).join('')}</tbody></table>
    ${h.length>rows.length?`<p class="note" style="margin-top:8px">Показаны последние ${rows.length} из ${h.length}.</p>`:''}</div>`;
}

/* ---------- дубль при приёме ---------- */
/* Тот же телефон, тот же адрес, та же дата — это либо клиент позвонил второй раз
   и попал к другому оператору, либо первое сохранение уже прошло. Молча не пишем:
   первое нажатие предупреждает, второе сохраняет как есть — бывает и правда две
   заявки на день, например поверка в квартире и в офисе того же человека. */
function dupOf(K,ds,exceptId){
  const d = digitsOf(K.phone);
  if(d.length!==10 || !ds) return null;
  const city = K.city || dayCities(ds)[0] || '';
  return S.requests.find(r=>r.id!==exceptId && r.date===ds && r.status!=='отменена'
    && digitsOf(r.phone)===d && r.city===city && sameAddr(r,K)) || null;
}
const dupKey = (K,ds,exceptId) => [exceptId||'',ds,digitsOf(K.phone),K.city||'',
  nrm(K.street),nrm(K.house),nrm(K.entrance),nrm(K.flat)].join('|');
/* Ждём ли сейчас повторного нажатия по этой самой форме. */
const dupPending = (K,ds,exceptId) => !!S.dupAsk && S.dupAsk===dupKey(K,ds,exceptId);
function dupGuard(K,ds,exceptId){
  const dup = dupOf(K,ds,exceptId);
  if(!dup){ S.dupAsk = null; return false; }
  if(dupPending(K,ds,exceptId)){ S.dupAsk = null; return false; }
  S.dupAsk = dupKey(K,ds,exceptId);
  toast(`Похоже на дубль: ${dup.id} на ${ru(ds)}, тот же телефон и адрес, статус «${dup.status}». `
    + 'Заявка не сохранена. Нажмите ещё раз, если обращение всё-таки второе.');
  return true;
}

/* ---------- приём заявки ---------- */
function viewIntake(){
  const K = S.intake;
  const t = dayTotal(S.day), lock = lockedFor(S.day);
  /* Причина закрытия показывается прямо на кнопке — оператору не нужно гадать. */
  const why = lock || (t.p===0 ? 'день не запланирован' : t.pct>1.1 ? 'план перебран' : null);
  const closed = !!why;
  const mine = S.requests.filter(r=>r.operator===S.me && r.created===TODAY)
    .sort((a,b)=>b.id.localeCompare(a.id));
  return shell(null, `
  <div class="c"><h3>Ёмкость</h3>
    ${ribbon()}</div>

  <div class="c"><h3>Линия оператора</h3>
    ${opConsole()}</div>

  <div class="c"><h3>Новая заявка</h3>
    ${reqForm(K,'S.intake','in',S.day,v=>{pickDay(v);})}
    <div class="row" style="margin-top:14px;align-items:center;justify-content:flex-end">
      ${lock?`<span class="note" style="flex:1">Состав дня зафиксирован: ${lock}. Заявку на ${ru(S.day)} теперь добавляет только руководитель — он же ставит её в нужный маршрут.</span>`:''}
      <button class="b long" onclick="createReq()" ${closed?'disabled':''}>${closed?'Приём закрыт: '+why
        : dupPending(K,S.day,null)?'Сохранить как вторую заявку':'Сохранить заявку'}</button></div>
  </div>

  <div class="c"><h3>Мои заявки за сегодня · ${mine.length}</h3>
    ${mine.length?`<table><thead><tr><th>Заявка</th><th class="num">Создана</th><th class="num">Выполнение</th><th>Город</th><th>Тип</th><th>Статус</th></tr></thead><tbody>
      ${mine.slice(0,25).map(r=>`<tr><td class="mono"><b>${r.id}</b></td><td class="num mono">${ru(r.created)}</td>
        <td class="num mono">${r.status==='отменена'?'<span class="note">—</span>':ru(r.date)}</td>
        <td>${r.city}</td>
        <td><span class="tg ${r.clientType==='Юрлицо'?'t-ink':'t-mut'}">${r.clientType==='Юрлицо'?'юрлицо':'физлицо'}</span></td>
        <td>${reqTag(r.status)} ${badTag(r)}</td></tr>`).join('')}</tbody></table>
      ${mine.length>25?`<p class="note" style="margin-top:10px">Показаны последние 25 из ${mine.length}.</p>`:''}`
      :`<div class="empty">Сегодня вы ещё не приняли ни одной заявки.</div>`}</div>`);
}
const reqTag = s => `<span class="tg ${s==='выполнена'?'t-ok':s==='отменена'?'t-err':s==='перенос'||s==='ожидание'?'t-warn':s==='в маршруте'?'t-cold':'t-mut'}">${s}</span>`;
function setIn(k,v){ S.intake[k]=v; render(); }

export { clientHistory, dayOf, dupGuard, dupKey, dupOf, dupPending, fillClient, formOf, histFor, knownClient, nrm, plural, reqForm, reqTag, sameAddr, selfOf, setF, setIn, slotsFor, svcShort, tgSvc, viewIntake };
