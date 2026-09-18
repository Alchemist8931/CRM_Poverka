/* Каркас страницы: рельса, шапка, лента ёмкости. */

import { CAPS, GROUPS, PAGES, ROLES, TITLES } from '../refs.js';
import { I, svg } from './icons.js';
import { MAX_CITIES, TODAY, addDays, esc, iso, pad, ru, ruLong, today } from '../util.js';
import { S, dayCities } from '../state.js';
import { callWindow } from './phone.js';
import { crewOn, dayState, dayTotal, lockedFor, opsOn } from '../rules.js';
import { iconAt } from './brand.js';
import { lightbox } from './lightbox.js';
import { modalLayer } from './modals.js';
import { printLayer } from '../screens/print.js';
import { render } from './render.js';
import { isDemo } from '../api/mode.js';
import { logout } from '../api/boot.js';
import { reload } from '../api/load.js';
import { waitsNew } from '../screens/wait-list.js';

/* Выход: в демо-режиме это просто возврат к форме входа, в рабочем — ещё и
   гашение сессии на сервере. */
function signOut(){
  endCall(1);
  if(!isDemo()) { S.auth=false; render(); return; }
  logout();
}
function toggleTheme(){ S.theme = S.theme==='light'?'dark':'light';
  document.documentElement.setAttribute('data-theme',S.theme); render(); }

function badgeFor(v,role){
  if(v==='support') return S.routes.filter(r=>r.date===TODAY&&r.status!=='выполнен').length + waitsNew().length;
  if(v==='routes') return S.routes.filter(r=>r.date>=TODAY&&!r.verifier).length;
  if(v==='absence') return role==='supervisor'?S.absences.filter(a=>a.status==='на согласовании').length:0;
  if(v==='myroute') return S.routes.filter(r=>r.verifier===ROLES.verifier.id&&r.date===TODAY&&r.status!=='выполнен').length;
  return 0;
}
/* Состояния загрузки и ошибки. Прототип их не знал: данные лежали в памяти и
   появлялись мгновенно. С сервером экран сначала пустой, поэтому над ним висит
   узкая полоса — «грузим» или причина отказа, — а не подменяется вся страница:
   так видно, что именно уже пришло. В демо-режиме ни того, ни другого не бывает. */
function netState(){
  if(S.loading) return `<div class="loading-screen"><span class="spin sm"></span>Загружаем данные экрана…</div>`;
  if(S.loadError) return `<div class="load-error">${esc(S.loadError)}
    <button class="g sm" onclick="reload()">Повторить</button></div>`;
  return '';
}
function shell(side,main){
  const ini = S.user.replace(/[^А-ЯA-Z]/g,'').slice(0,2);
  const crew = crewOn(S.day).length, ops = opsOn(S.day).length, need = Math.max(1,Math.ceil(crew/10));
  const now = new Date();
  let i = -1;
  return `<div class="stage"><div class="app">
    <nav class="rail">
      <div class="logo" title="CRM «Учёткин»">${iconAt(22)}</div>
      <div class="nav">${GROUPS.map(g=>`<div class="grp ${g.role===S.role?'cur':''}" data-g="${g.short}">${g.views.map(v=>{
        i++; const b=badgeFor(v,g.role), n=i;
        return `<button class="nb" title="${TITLES[v]} · ${ROLES[g.role].label}" aria-current="${S.page===n}" onclick="goPage(${n})">
          ${svg(I[v])}${b?`<span class="bdg">${b}</span>`:''}</button>`}).join('')}</div>`).join('')}</div>
      <div class="foot">
        <button class="nb" title="Переключить тему" onclick="toggleTheme()">${svg(S.theme==='light'?I.moon:I.sun,18)}</button>
        <button class="nb" title="Сменить пароль" onclick="pwOpen()">${svg(I.key,18)}</button>
        <button class="nb" title="Выйти" onclick="signOut()">${svg(I.out,18)}</button>
        <div class="ava" title="${esc(S.user)} · ${ROLES[S.role].label}">${ini}<i></i></div>
      </div>
    </nav>
    <div class="col">
      <header class="hd">
        <div class="ttl"><span class="lbl">Учёткин /</span><span class="tg t-mut">${ROLES[S.role].label}</span><b>${TITLES[S.view]}</b></div>
        <div class="step">
          <button class="ib xs" title="Предыдущая страница · Alt+←" onclick="step(-1)">${svg(I.left,13)}</button>
          <span class="mono">${pad(S.page+1)} / ${PAGES.length}</span>
          <button class="ib xs" title="Следующая страница · Alt+→" onclick="step(1)">${svg(I.right,13)}</button>
        </div>
        <div style="flex:1"></div>
        <span class="chip"><span class="dot"></span>${crew} ПОВЕРИТЕЛЕЙ</span>
        <span class="chip" ${ops<need?'style="color:var(--warning);border-color:var(--warning)"':''}>ОПЕРАТОРЫ ${ops}/${need}</span>
        <span class="mono" style="font-size:11px;letter-spacing:.08em;color:var(--ink3)">${ru(TODAY)} · <span style="color:var(--ink2)">${pad(now.getHours())}:${pad(now.getMinutes())}</span></span>
        <button class="ib" title="Уведомления">${svg(I.bell,16)}</button>
      </header>
      <div class="body">${side?`<aside class="side">${side}</aside>`:''}<div class="main">${netState()}${main}</div></div>
    </div>
  </div></div>${modalLayer()}${printLayer()}${callWindow()}${lightbox()}${S.toast?`<div class="toast">${esc(S.toast)}</div>`:''}`;
}
const cap = () => `<p class="cap">${CAPS[S.view]||''}</p>`;

/* ---------- лента ёмкости: четыре полные недели, первая — текущая ---------- */
function ribbon(){
  const mon = addDays(today,-((today.getDay()+6)%7));   // понедельник текущей недели
  const weeks = Array.from({length:4},(_,w)=>Array.from({length:7},(_,i)=>iso(addDays(mon,w*7+i))));
  return `<div class="rib4 ribh">
    <div class="wk wkd">${['пн','вт','ср','чт','пт','сб','вс'].map(d=>`<span>${d}</span>`).join('')}</div>
    ${weeks.map((days,w)=>{
    let wp=0, wb=0;
    days.forEach(ds=>{const x=dayTotal(ds); wp+=x.p; wb+=x.b;});
    return `<div>
      <div class="wkh"><span class="lbl ${w===0?'now':''}">${w===0?'Текущая неделя':'Неделя +'+w}</span>
        <span class="rg">${ru(days[0]).slice(0,5)} — ${ru(days[6]).slice(0,5)}</span>
        <span class="tot">${wb} / ${wp}${wp?` · ${Math.round(wb/wp*100)}%`:''}</span></div>
      <div class="wk">${days.map(ds=>{
        const {p,b,pct,s} = dayTotal(ds), d = new Date(ds+'T00:00:00'), past = ds<TODAY;
        const cs = dayCities(ds);
        const tip = cs.length?cs.map(c=>{const x=dayState(ds,c);return `${c} ${x.b}/${x.p}`}).join(' · '):'выходной';
        const lk = past?null:lockedFor(ds);
        return `<button class="day ${past?'past':''} ${ds===TODAY?'tdy':''} ${lk?'lk':''}" data-s="${s}" aria-pressed="${S.day===ds}"
          title="${ru(ds)} · ${b} из ${p} · ${tip}${lk?` · приём закрыт: ${lk}`:''}" ${s==='off'||past?'disabled':`onclick="pickDay('${ds}')"`}>
          <div class="bar"><div class="fill" style="height:${Math.min(100,pct*90.9)}%"></div></div>
          <div class="inf"><div class="dt"><span class="dd">${ruLong(ds)}</span>
            <span class="pct">${p?Math.round(pct*100)+'%':'—'}</span></div>
          <div class="cts">${cs.length
            ? cs.slice(0,MAX_CITIES).map(c=>{const x = dayState(ds,c);
                return `<span class="ct"><b>${esc(c)}</b><i>${x.b}/${x.p}</i></span>`}).join('')
            : '<span class="ct"><b>выходной</b></span>'}</div></div></button>`;
      }).join('')}</div></div>`;
  }).join('')}</div>
  <div class="lg">
    <span><i style="background:var(--ink3);opacity:.3"></i>свободно</span>
    <span><i style="background:var(--cold);opacity:.45"></i>заполняется</span>
    <span><i style="background:var(--ink);opacity:.72"></i>план набран</span>
    <span><i style="background:var(--error);opacity:.6"></i>сверх 110% — приём закрыт</span>
    <span><i style="border:1px dashed var(--ink3);background:none"></i>дата ушла под маршруты</span>
    <span><i style="border-top:1px dashed var(--mark);height:0;width:14px"></i>граница +10%</span></div>`;
}
/* Выбор дня подтягивает город заявки к тем, где в этот день работает бригада. */
function pickDay(ds){
  S.day = ds;
  const cs = dayCities(ds);
  if(cs.length && !cs.includes(S.intake.city)) S.intake.city = cs[0];
  render();
  // Проверка дублей смотрит на заявки выбранного дня — значит их надо иметь.
  if(!isDemo()) reload();
}

export { badgeFor, cap, pickDay, ribbon, shell, toggleTheme, signOut };
