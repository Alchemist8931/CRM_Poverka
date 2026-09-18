/* Сотрудники и учётные записи (пункт be-users).
 *
 * Экран руководителя: список с отбором по роли и состоянию, карточка
 * сотрудника, выдача учётной записи. Временный пароль показывается один раз —
 * блоком над списком, с кнопкой «Скопировать»; закрыл блок — пароль больше
 * нигде не увидеть, только сбросить заново. Сброс устроен так же.
 *
 * Учётка не удаляется: увольнение — это блокировка. Человек пропадает из выбора
 * в смены и маршруты, но остаётся в истории и в этом списке (отбор «уволены»).
 *
 * В демо-режиме всё происходит в памяти вкладки; в рабочем — через API
 * (api/actions.js), и картинка рисуется по ответу сервера.
 */

import { S } from '../state.js';
import { SERVICES } from '../refs.js';
import { TODAY, esc } from '../util.js';
import { DATE, SEL } from '../ui/controls.js';
import { I, svg } from '../ui/icons.js';
import { cap, shell } from '../ui/shell.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { closeSessions, createStaff, patchStaff, resetPassword } from '../api/actions.js';

const ROLE_NAME = {operator:'оператор', senior:'старший оператор', supervisor:'руководитель', verifier:'поверитель'};
const ROLE_ITEMS = Object.entries(ROLE_NAME).map(([v,l])=>({v,l}));
const PATTERNS = ['5/2','2/2'];

/* ---------- состояние экрана ---------- */
const blankF = () => ({role:'', state:'active', q:''});
const blankCard = () => ({id:null, name:'', role:'operator', phone:'', ext:'', email:'', login:'', pattern:'5/2', anchor:TODAY, svcs:[]});
const cardOf = p => ({id:p.id, name:p.name, role:p.role, phone:p.phone||'', ext:p.ext||'', email:p.email||'',
  login:p.login||'', pattern:p.pattern||'5/2', anchor:p.anchor||TODAY, svcs:[...(p.svcs||[])]});
const byId = id => S.staff.find(x=>x.id===id);

function usRows(){
  const F = S.usF || (S.usF = blankF());
  const q = F.q.trim().toLowerCase();
  return S.staff.filter(p =>
    (!F.role || p.role===F.role) &&
    (F.state==='all' || (F.state==='blocked') === !!p.blocked) &&
    (!q || `${p.name} ${p.login||''} ${p.email||''} ${p.phone||''} ${p.ext||''}`.toLowerCase().includes(q)))
    .sort((a,b)=>(a.blocked?1:0)-(b.blocked?1:0) || a.name.localeCompare(b.name));
}
function usSet(k,v){ S.usF = {...(S.usF||blankF()), [k]: v===undefined||v===null?'':String(v)}; render(); }
function usOpen(id){ const p = byId(id); S.usEdit = p ? cardOf(p) : null; S.dd = null; render(); }
function usNew(){ S.usEdit = blankCard(); S.dd = null; render(); }
function usCancel(){ S.usEdit = null; render(); }
/* Текстовые поля пишут в карточку тихо (quiet): перерисовка на каждую букву
   ни к чему, а выпадающие списки перерисовку зовут сами. */
function usField(k,v,quiet){
  const K = S.usEdit; if(!K) return;
  K[k] = v;
  if(k==='role' && v!=='verifier') K.svcs = [];
  if(!quiet) render();
}
function usSkill(sid){
  const K = S.usEdit; if(!K) return;
  K.svcs = K.svcs.includes(sid) ? K.svcs.filter(x=>x!==sid) : [...K.svcs, sid];
  render();
}

/* ---------- демо-режим: то же, что делает сервер, но в памяти ---------- */
const demoPw = () => Array.from({length:12},()=>'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*54)]).join('');
function demoId(role){
  const prefix = role==='verifier'?'v':role==='supervisor'?'sv':'o';
  const re = new RegExp(`^${prefix}(\\d*)$`);
  let max = -1;
  for(const p of S.staff){ const m = re.exec(p.id); if(m) max = Math.max(max, m[1]?Number(m[1]):0); }
  return `${prefix}${max+1}`;
}

/* ---------- действия ---------- */
function usBody(K){
  const b = {full_name:K.name.trim(), role:K.role, phone:K.phone.trim(), ext:K.ext.trim(), email:K.email.trim(),
    pattern:K.pattern, anchor:K.anchor, svcs:K.role==='verifier'?K.svcs:[]};
  // Пустой логин на сервер не шлём: при выдаче он соберётся из почты, а у
  // существующей карточки пустой логин — это отказ правила, не правка.
  if(K.login.trim()) b.login = K.login.trim().toLowerCase();
  return b;
}
async function usSave(){
  const K = S.usEdit; if(!K) return;
  if(!K.name.trim()) return toast('Укажите ФИО сотрудника.');
  const b = usBody(K);
  if(!isDemo()){
    if(K.id){
      const out = await patchStaff(K.id, b, 'Карточка сохранена.');
      if(out) S.usEdit = null;
      return render();
    }
    const out = await createStaff(b);
    if(!out) return;
    S.usEdit = null;
    S.usPw = {kind:'new', name:out.staff.full_name, login:out.staff.login, password:out.temporary_password};
    return render();
  }
  if(K.id){
    const p = byId(K.id); if(!p) return;
    Object.assign(p, {name:b.full_name, role:b.role, phone:b.phone||undefined, ext:b.ext||undefined,
      email:b.email||null, login:b.login||p.login, pattern:b.pattern, anchor:b.anchor, svcs:b.svcs});
    S.usEdit = null; return toast('Карточка сохранена.');
  }
  const login = b.login || (b.email.includes('@') ? b.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g,'') : '');
  if(!login) return toast('Укажите почту или логин — иначе сотруднику нечем войти.');
  if(S.staff.some(p=>(p.login||'').toLowerCase()===login)) return toast(`Логин «${login}» уже занят.`);
  S.staff.push({id:demoId(b.role), name:b.full_name, role:b.role, phone:b.phone||undefined, ext:b.ext||undefined,
    email:b.email||null, login, pattern:b.pattern, anchor:b.anchor, extra:[], svcs:b.svcs, blocked:false, mustChange:true});
  S.usEdit = null;
  S.usPw = {kind:'new', name:b.full_name, login, password:demoPw()};
  render();
}
async function usReset(id){
  const p = byId(id); if(!p) return;
  if(!isDemo()){
    const out = await resetPassword(id);
    if(!out) return;
    S.usPw = {kind:'reset', name:p.name, login:p.login, password:out.temporary_password};
    return render();
  }
  p.mustChange = true;
  S.usPw = {kind:'reset', name:p.name, login:p.login||'—', password:demoPw()};
  render();
}
async function usBlock(id,on){
  const p = byId(id); if(!p) return;
  const said = on ? `${p.name}: вход закрыт, из новых смен и маршрутов убран.` : `${p.name}: снова в работе.`;
  if(!isDemo()){
    const out = await patchStaff(id, {blocked:on}, said);
    if(out) S.usEdit = null;
    return render();
  }
  p.blocked = on; S.usEdit = null; toast(said);
}
async function usClose(id){
  if(!isDemo()) return closeSessions(id, 'Все устройства сотрудника вышли из системы.');
  toast('В демо-режиме сессий нет.');
}
function usCopy(){
  const pw = S.usPw?.password; if(!pw) return;
  const fallback = () => { document.getElementById('us-pw')?.select(); toast('Скопировать не удалось — пароль выделен, нажмите Ctrl+C.'); };
  if(!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(pw).then(()=>toast('Пароль скопирован.'), fallback);
}
function usPwOk(){ S.usPw = null; render(); }

/* ---------- разметка ---------- */
const hhmm = at => { const d = new Date(at); const p = n => String(n).padStart(2,'0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
const stateTag = p => p.blocked ? '<span class="tg t-err">уволен</span>'
  : p.lockedUntil && new Date(p.lockedUntil) > new Date() ? `<span class="tg t-warn">вход закрыт до ${hhmm(p.lockedUntil)}</span>`
  : p.mustChange ? '<span class="tg t-cold">временный пароль</span>'
  : '<span class="tg t-ok">в работе</span>';

const pwBlock = P => `<div class="c"><h3>${P.kind==='new'?'Учётная запись выдана':'Пароль сброшен'}</h3>
  <p class="cap">${esc(P.name)} · логин <b class="mono">${esc(P.login||'—')}</b>. Передайте временный пароль сотруднику:
    он показывается только сейчас, в системе хранится лишь его отпечаток. При первом входе система потребует придумать свой.</p>
  <div class="row" style="align-items:center">
    <input id="us-pw" class="fld mono" style="width:260px;font-size:16px;letter-spacing:.08em" value="${esc(P.password)}" readonly onclick="this.select()">
    <button class="b" onclick="usCopy()">Скопировать</button>
    <button class="g" onclick="usPwOk()">Пароль передан, закрыть</button>
  </div></div>`;

function cardBlock(K){
  const p = K.id ? byId(K.id) : null;
  return `<div class="c"><h3>${p?`${esc(p.name)} <span class="tg t-mut">${esc(p.id)}</span>`:'Новый сотрудник'}</h3>
    <p class="cap">${p
      ? 'Правки применяются сразу. Смена роли меняет набор экранов при следующем входе; компетенции есть только у поверителя.'
      : 'Логин можно не указывать — он соберётся из почты (часть до «@»). Без почты и логина учётную запись не выдать: человеку нечем войти.'}</p>
    <div class="row">
      <div class="f" style="flex:2;min-width:220px"><label>ФИО</label><input id="us-name" class="fld" value="${esc(K.name)}" oninput="usField('name',this.value,1)"></div>
      <div class="f" style="width:190px"><label>Роль</label>${SEL('us-crole',K.role,ROLE_ITEMS,v=>usField('role',v))}</div>
      <div class="f" style="width:150px"><label>Телефон</label><input id="us-phone" class="fld mono" value="${esc(K.phone)}" oninput="usField('phone',this.value,1)"></div>
      <div class="f" style="width:110px"><label>Вн. номер</label><input id="us-ext" class="fld mono" value="${esc(K.ext)}" oninput="usField('ext',this.value,1)"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <div class="f" style="flex:2;min-width:220px"><label>Почта</label><input id="us-email" class="fld" value="${esc(K.email)}" oninput="usField('email',this.value,1)"></div>
      <div class="f" style="width:190px"><label>Логин</label><input id="us-login" class="fld mono" value="${esc(K.login)}" placeholder="из почты" oninput="usField('login',this.value,1)"></div>
      <div class="f" style="width:120px"><label>График</label>${SEL('us-pat',K.pattern,PATTERNS,v=>usField('pattern',v))}</div>
      <div class="f" style="width:150px"><label>Отсчёт графика</label>${DATE('us-anchor',K.anchor,v=>usField('anchor',v))}</div>
    </div>
    ${K.role==='verifier'?`<div class="f" style="margin-top:10px"><label>Компетенции по услугам</label>
      <div class="tgls sk">${SERVICES.map(s=>`<button type="button" class="tgl" aria-pressed="${K.svcs.includes(s.id)}"
        title="${esc(s.name)}" onclick="usSkill('${s.id}')">${esc(s.sh)}</button>`).join('')}</div></div>`:''}
    <div class="row" style="margin-top:14px;align-items:center">
      <button class="b" onclick="usSave()">${p?'Сохранить':'Выдать учётную запись'}</button>
      <button class="g" onclick="usCancel()">${p?'Закрыть':'Отмена'}</button>
      ${p?`<div style="flex:1"></div>
        <button class="g" onclick="usReset('${p.id}')" title="Новый временный пароль; открытые сессии гаснут">Сбросить пароль</button>
        <button class="g" onclick="usClose('${p.id}')" title="Погасить все открытые сессии сотрудника">Выйти со всех устройств</button>
        ${p.blocked
          ? `<button class="g" onclick="usBlock('${p.id}',false)">Разблокировать</button>`
          : `<button class="g" style="color:var(--error)" onclick="usBlock('${p.id}',true)">Уволен — заблокировать</button>`}`:''}
    </div></div>`;
}

function viewStaff(){
  const F = S.usF || (S.usF = blankF());
  const rows = usRows();
  const K = S.usEdit, P = S.usPw;
  const total = S.staff.length, active = S.staff.filter(p=>!p.blocked).length;
  return shell(null,`${cap()}
  ${P?pwBlock(P):''}
  ${K?cardBlock(K):''}
  <div class="c"><h3>Сотрудники</h3>
    <p class="cap">Учётные записи заводит руководитель: карточка → «Выдать учётную запись» → временный пароль показывается один раз.
      Уволенный сотрудник блокируется, а не удаляется: он остаётся в истории заявок и маршрутов.</p>
    <div class="row">
      <div class="f" style="width:190px"><label>Роль</label>${SEL('us-role',F.role,[{v:'',l:'Все роли'},...ROLE_ITEMS],v=>usSet('role',v))}</div>
      <div class="f" style="width:170px"><label>Состояние</label>${SEL('us-state',F.state,[{v:'active',l:'Работают'},{v:'blocked',l:'Уволены'},{v:'all',l:'Все'}],v=>usSet('state',v))}</div>
      <div class="f" style="flex:1;min-width:190px"><label>Имя, логин, почта, телефон</label>
        <input id="us-q" class="fld" value="${esc(F.q)}" placeholder="Иванова" oninput="usSet('q',this.value)"></div>
      <div class="f"><label>&nbsp;</label><button class="b" onclick="usNew()">${svg(I.plus,14)} Новый сотрудник</button></div>
    </div>
    <p class="note" style="margin:8px 0 0">Показано ${rows.length} из ${total}; работают ${active}.</p>
  </div>
  <div class="c">
    ${rows.length?`<table class="audit"><thead><tr><th>Сотрудник</th><th>Роль</th><th>Логин</th><th>Почта</th>
      <th>Телефон</th><th>Вн. номер</th><th>График</th><th>Состояние</th></tr></thead><tbody>
      ${rows.map(p=>`<tr class="ln ${K&&K.id===p.id?'on':''}" onclick="usOpen('${p.id}')" title="Открыть карточку">
        <td><b>${esc(p.name)}</b></td>
        <td><span class="tg t-mut">${ROLE_NAME[p.role]||esc(p.role)}</span></td>
        <td class="mono">${esc(p.login||'—')}</td>
        <td>${esc(p.email||'—')}</td>
        <td class="mono">${esc(p.phone||'—')}</td>
        <td class="mono">${esc(p.ext||'—')}</td>
        <td class="mono">${esc(p.pattern||'—')}</td>
        <td>${stateTag(p)}</td></tr>`).join('')}
    </tbody></table>`:'<div class="empty">По этому отбору сотрудников нет.</div>'}
  </div>`);
}

export { usBlock, usCancel, usClose, usCopy, usField, usNew, usOpen, usPwOk, usReset, usRows, usSave, usSet, usSkill, viewStaff };
