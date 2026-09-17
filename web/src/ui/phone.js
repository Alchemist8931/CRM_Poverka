/* Поле телефона и мини-окно вызова. */

import { I, svg } from './icons.js';
import { S, staffById } from '../state.js';
import { esc, pad } from '../util.js';
import { formOf } from '../screens/intake.js';
import { render, toast } from './render.js';
import { isDemo } from '../api/mode.js';
import { fetchClient } from '../api/actions.js';
import { dial, explainDial, onCall } from '../api/calls.js';

/* ---------- телефон и мини-окно вызова ---------- */
/* Маска: оператор набирает только цифры, поле само собирает +7 (963) 441-45-30. */
const digitsOf = v => String(v||'').replace(/\D/g,'').replace(/^[78]/,'').slice(0,10);
function fmtPhone(v){
  const d = digitsOf(v);
  if(!d) return '';
  let s = '+7 ('+d.slice(0,3);
  if(d.length>3) s += ') '+d.slice(3,6);
  if(d.length>6) s += '-'+d.slice(6,8);
  if(d.length>8) s += '-'+d.slice(8,10);
  return s;
}
function phoneIn(el,k,T){
  const O = formOf(T);
  const prev = O[k]||'';
  let d = digitsOf(el.value);
  /* Backspace съел разделитель, а не цифру — убираем цифру сами, иначе каретка встанет колом. */
  if(el.value.length < prev.length && d === digitsOf(prev)) d = d.slice(0,-1);
  const out = fmtPhone(d);
  O[k] = out; el.value = out;
  const end = out.length;
  if(typeof el.setSelectionRange==='function'){ try{ el.setSelectionRange(end,end); }catch(e){} }
  const btn = el.parentElement.querySelector('.call');
  if(btn) btn.disabled = d.length<10;
  /* Обычный набор идёт без перерисовки — иначе каретка прыгает. Но на границе
     «номер собран целиком» под полем появляется или исчезает плашка о прежних
     обращениях, а её рисует сама форма: здесь перерисовываем один раз,
     фокус и каретку render() возвращает на место. */
  if(k==='phone' && d!==digitsOf(prev) && (d.length===10 || digitsOf(prev).length===10)){
    /* Номер собран — спрашиваем сервер, обращался ли этот клиент раньше.
       Ответ доложится к заявкам, и плашка появится следующей перерисовкой. */
    if(!isDemo() && d.length===10) fetchClient(d);
    render();
  }
}
function PHONE(id,val,key,kind,T){
  const full = digitsOf(val).length===10;
  return `<div class="phone">
    <input class="mono" id="${id}" value="${esc(val||'')}" inputmode="tel" maxlength="18"
      oninput="phoneIn(this,'${key}','${T||'S.intake'}')" placeholder="+7 (___) ___-__-__">
    <button type="button" class="call" ${full?'':'disabled'} title="Позвонить клиенту"
      onclick="startCall(document.getElementById('${id}').value,'${kind}')">${svg(I.phone,12)}Вызов</button></div>`;
}
function startCall(num,kind,who){
  num = String(num||'').trim(); if(num.length<5) return toast('Телефон не заполнен — набирать нечего.');
  const open = () => {
    S.call = {num,kind:kind||'основной',who:who||(S.intake.name.trim()||'Клиент'),st:'набор',t0:Date.now()};
    clearInterval(S._call); S._call = setInterval(tickCall,500); render();
  };
  if(isDemo()) return open();
  /* Рабочий режим: соединяет АТС — сначала звонит оператору, потом клиенту.
     Окно открывается, когда АТС приняла заявку на звонок; дальше его ведут
     события с сервера (api/calls.js), а не таймер. */
  dial(num).then(open).catch(err=>toast(explainDial(err,num)));
}
/* Разговор кончился — событие от АТС, а не кнопка: в телефоне положили трубку. */
onCall({ hangup: (c,ev) => {
  clearInterval(S._call); S.call=null;
  const sec = ev.duration_sec ?? Math.floor((Date.now()-c.t0)/1000);
  toast(ev.kind==='завершение' ? `Звонок завершён · ${pad(Math.floor(sec/60))}:${pad(sec%60)}.` : 'Клиент не ответил.');
} });
function tickCall(){
  if(!S.call) return clearInterval(S._call);
  const sec = Math.floor((Date.now()-S.call.t0)/1000);
  // Демо: соединение «наступает» само через две секунды. В рабочем режиме
  // «разговор» приходит событием от АТС.
  if(isDemo() && S.call.st==='набор' && sec>=2){ S.call.st='разговор'; S.call.t0=Date.now();
    const st=document.getElementById('callSt'), dt=document.getElementById('callDot');
    if(st) st.textContent='разговор'; if(dt) dt.style.background='var(--success)'; return; }
  const el = document.getElementById('callSec');
  if(el) el.textContent = pad(Math.floor(sec/60))+':'+pad(sec%60);
}
function endCall(silent){
  clearInterval(S._call);
  const c = S.call; S.call = null;
  if(silent) return;
  if(!c) return render();
  /* Рабочий режим: положить трубку из CRM нельзя — у АТС нет такой команды.
     Окно закрывается, звонок живёт в телефоне и закончится своим событием. */
  if(!isDemo()){
    toast(c.st==='разговор' ? 'Окно закрыто, разговор продолжается в телефоне.' : 'Окно закрыто, вызов сбрасывается в телефоне.');
    return;
  }
  const sec = Math.floor((Date.now()-c.t0)/1000);
  toast(c.st==='разговор'
    ? `Звонок завершён · ${pad(Math.floor(sec/60))}:${pad(sec%60)}. В боевой версии длительность и запись прилетают из облачной АТС в карточку заявки.`
    : 'Вызов сброшен до соединения.');
}
function callWindow(){
  const c = S.call; if(!c) return '';
  return `<div class="callw">
    <div class="top"><span class="dot" id="callDot" ${c.st==='разговор'?'style="background:var(--success)"':''}></span>
      <span class="st" id="callSt">${c.st}</span><span class="sec mono" id="callSec">00:00</span></div>
    <b>${esc(c.who)}</b>
    <div class="num mono">${esc(c.num)}</div>
    <div class="who">${c.kind} номер · линия ${esc(staffById(S.me)?.ext||'—')} · ${esc(S.user)}</div>
    <div class="acts">
      <button class="g" onclick="toast('Перевод на другого оператора — в интеграции с облачной АТС.')">Перевести</button>
      <button class="g end" onclick="endCall()">${svg(I.hang,13)}Завершить</button></div>
  </div>`;
}

export { PHONE, callWindow, digitsOf, endCall, fmtPhone, phoneIn, startCall, tickCall };
