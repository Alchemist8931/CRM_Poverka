/* Планирование дня. */

import { CITIES } from '../refs.js';
import { I, svg } from '../ui/icons.js';
import { MAX_CITIES, MAX_OPS, MN, TODAY, WD, addDays, esc, iso, pad, ru } from '../util.js';
import { S, capOf, dayOrNew, dayRec } from '../state.js';
import { SEG } from '../ui/controls.js';
import { absentOn, bookedOn, crewOn, dayState, dayTotal, opsOn, planFor, worksOn } from '../rules.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { saveDay as apiSaveDay } from '../api/actions.js';
import { shell } from '../ui/shell.js';

/* ---------- ПЛАН НАБОРА · календарь месяца ---------- */
/* ============ ПЛАНИРОВАНИЕ ДНЯ (руководитель) ============ */
function viewPlan(){
  const [Y,Mo] = S.pMonth.split('-').map(Number);
  const first = new Date(Y,Mo-1,1);
  const grid = new Date(first); grid.setDate(1-((first.getDay()+6)%7));
  const rows = Math.ceil(((first.getDay()+6)%7 + new Date(Y,Mo,0).getDate())/7);
  const weeks = Array.from({length:rows},(_,w)=>Array.from({length:7},(_,i)=>iso(addDays(grid,w*7+i))));
  const inM = ds => ds.slice(0,7)===S.pMonth;
  const tab = S.planTab==='ops' ? 'ops' : 'day';
  let mp=0, mb=0, mdays=0, mops=0, mopsDays=0;
  weeks.flat().forEach(ds=>{ if(!inM(ds)) return;
    const t=dayTotal(ds); mp+=t.p; mb+=t.b; if(t.p) mdays++;
    const n=opsOn(ds).length; mops+=n; if(n) mopsDays++; });

  return shell(null,`
  <div class="row" style="margin-bottom:14px;align-items:center">
    ${SEG(tab,[{v:'day',l:'План дня'},{v:'ops',l:'Смены операторов'}],'planTab($v)')}
    <div class="ptop" style="margin:0">
      <button class="ib" onclick="pMonth(-1)">${svg(I.left,14)}</button>
      <b style="min-width:150px;text-align:center">${MN[Mo-1]} ${Y}</b>
      <button class="ib" onclick="pMonth(1)">${svg(I.right,14)}</button>
      <button class="g sm" onclick="S.pMonth='${TODAY.slice(0,7)}';render()">Текущий месяц</button></div>
    <div style="flex:1"></div>
    <span class="note">${tab==='day'
      ? `Рабочих дней <b class="mono" style="color:var(--ink)">${mdays}</b> ·
         план <b class="mono" style="color:var(--ink)">${mp}</b> · набрано <b class="mono" style="color:var(--ink)">${mb}</b>`
      : `Дней со сменой <b class="mono" style="color:var(--ink)">${mopsDays}</b> ·
         смен операторов <b class="mono" style="color:var(--ink)">${mops}</b>`}</span>
  </div>
  <div class="c">
    <div class="rib4">
      <div class="wk wkd">${['пн','вт','ср','чт','пт','сб','вс'].map(d=>`<span>${d}</span>`).join('')}</div>
      ${weeks.map((days,w)=>{
        let wp=0, wc=0, wo=0;
        days.forEach(ds=>{ if(!inM(ds)) return; wp+=planFor(ds); wc+=crewOn(ds).length; wo+=opsOn(ds).length; });
        return `<div>
          <div class="wkh"><span class="lbl">Неделя ${w+1}</span>
            <span class="rg">${ru(days[0]).slice(0,5)} — ${ru(days[6]).slice(0,5)}</span>
            <span class="tot">${tab==='day'?`план ${wp} · смен ${wc}`:`смен операторов ${wo}`}</span></div>
          <div class="wk">${days.map(ds=>tab==='day'?dayCell(ds,inM(ds)):opsCell(ds,inM(ds))).join('')}</div></div>`}).join('')}
    </div>
    <p class="note" style="margin-top:12px">${tab==='day'
      ? 'В миниатюре дня видно, по каким городам идёт работа и какие виды работ в этот день закрывает назначенная смена. Клик по дню открывает карточку: города приёма, план по каждому городу и смена поверителей. Пустой день считается выходным — операторы не смогут записать на него заявку.'
      : 'Операторы на день не назначаются вместе с бригадами — у них свой график. Клик по дню открывает список операторов на смену.'}</p>
  </div>`);
}
function dayCell(ds,inM){
  const d = new Date(ds+'T00:00:00');
  const rec = dayRec(ds), t = dayTotal(ds);
  const crew = crewOn(ds).length;
  const cs = rec?.cities||[];
  const works = worksOn(ds);
  return `<button class="pcell ${inM?'':'out'} ${ds===TODAY?'tdy':''} ${t.p?'':'off'}" data-s="${t.s}"
    onclick="editDay('${ds}')" title="${ru(ds)} — настроить день">
    <span class="h"><span class="dn">${pad(d.getDate())}</span>
      ${t.p?`<span class="cr mono">${t.b}/${t.p}</span>`:'<span class="cr">выходной</span>'}</span>
    ${t.p?`<span class="pb"><i style="width:${Math.min(100,t.pct*90.9)}%"></i><s style="left:90.9%"></s></span>`:''}
    <span class="lst"><b>Города</b>
      ${cs.length?cs.map(c=>`<i>${esc(c)}</i>`).join('')
        :'<i class="none">не заданы</i>'}</span>
    <span class="lst"><b>Работы</b>
      ${works.length?works.map(w=>`<i>${esc(w.name)}</i>`).join('')
        :`<i class="none">${crew?'у смены нет компетенций':'смена не назначена'}</i>`}</span>
    <span class="crew">${crew?`<i>${svg(I.myroute,11)}${crew}</i>`:''}
      ${rec&&!crew?'<i class="none">смена не назначена</i>':''}</span>
  </button>`;
}
/* Вторая подстраница планирования: смены операторов, свой график поверх плана выездов. */
function opsCell(ds,inM){
  const d = new Date(ds+'T00:00:00');
  const list = opsOn(ds), n = list.length, crew = crewOn(ds).length;
  return `<button class="pcell ${inM?'':'out'} ${ds===TODAY?'tdy':''} ${n?'':'off'}" data-s="${n?(n>2?'full':'fill'):'off'}"
    onclick="editOps('${ds}')" title="${ru(ds)} — смена операторов">
    <span class="h"><span class="dn">${pad(d.getDate())}</span>
      ${n?`<span class="cr mono">${n}</span>`:'<span class="cr">нет смены</span>'}</span>
    <span class="lst"><b>Операторы</b>
      ${n?list.slice(0,MAX_OPS).map(p=>`<i>${esc(p.name)}</i>`).join('')
        :`<i class="none">${crew?'линия без операторов':'выходной'}</i>`}</span>
    <span class="crew">${crew?`<i>${svg(I.myroute,11)}${crew}</i>`:''}${n?`<i>${svg(I.support,11)}${n}</i>`:''}</span>
  </button>`;
}
function planTab(v){ S.planTab = v; render(); }
function editOps(ds){ dayOrNew(ds); S.modal={k:'ops',date:ds}; render(); }
function clearOps(ds){ dayOrNew(ds).ops=[]; pushDay(ds); toast(`${ru(ds)}: смена операторов снята.`); render(); }
function opsModal(ds){
  const d = dayOrNew(ds);
  const ops = S.staff.filter(p=>p.role==='operator'||p.role==='senior');
  const wd = WD[new Date(ds+'T00:00:00').getDay()];
  const crew = crewOn(ds).length, on = opsOn(ds).length, need = Math.max(1,Math.ceil(crew/10));
  return `<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="width:min(720px,96vw)">
      <div class="mhd"><h3>${ru(ds)} · ${wd}</h3>
        <span class="note">${on?`на смене ${on}`:'смена операторов не назначена'}</span>
        <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>

      <div class="f" style="margin-bottom:0"><label>Операторы на смене · ${d.ops.length} из ${MAX_OPS}</label>
        <p class="note" style="margin:0 0 8px">График операторов не привязан к выездам: линия принимает звонки и в те дни, когда бригады не работают.
          Больше ${MAX_OPS} человек на смену не ставим.</p>
        <div class="tgls">${ops.map(p=>{const ab=absentOn(p.id,ds), on=d.ops.includes(p.id), full=d.ops.length>=MAX_OPS;
          return `<button class="tgl ${ab?'ab':''}" aria-pressed="${on}" ${ab||(!on&&full)?'disabled':''}
            title="${ab?'согласованное отсутствие':!on&&full?`Уже назначено ${MAX_OPS} операторов`:p.name}"
            onclick="tgDay('${ds}','ops','${p.id}')">${esc(p.name)}</button>`}).join('')}</div></div>

      <div class="row" style="margin-top:16px;align-items:center">
        <span class="note" style="flex:1">${crew?`В этот день выезжает ${crew} поверителей — на линию нужно не меньше ${need} оператор(ов).`
          :'В этот день бригады не выезжают — смена нужна только под приём звонков.'}</span>
        <button class="g end" onclick="clearOps('${ds}')" ${d.ops.length?'':'disabled'}>Снять всех</button>
        <button class="b" onclick="closeModal()">Готово</button>
      </div>
    </div></div>`;
}
function pMonth(n){ const [y,m]=S.pMonth.split('-').map(Number); const d=new Date(y,m-1+n,1);
  S.pMonth = `${d.getFullYear()}-${pad(d.getMonth()+1)}`; render(); }
function editDay(ds){ dayOrNew(ds); S.modal={k:'day',date:ds}; render(); }
/* День в базе — одна запись, и правится он целиком: города, план, обе смены.
   Переключатель на экране отзывается сразу, а запись уходит следом, с короткой
   задержкой — руководитель обычно щёлкает несколько человек подряд. */
const dayTimers = new Map();
function pushDay(ds){
  if(isDemo()) return;
  clearTimeout(dayTimers.get(ds));
  dayTimers.set(ds, setTimeout(()=>{
    dayTimers.delete(ds);
    const d = dayOrNew(ds);
    apiSaveDay(ds,{cities:d.cities, plan:d.caps, crew:d.crew, ops:d.ops});
  }, 400));
}
function tgDay(ds,field,val){
  const d = dayOrNew(ds), a = d[field];
  const off = a.includes(val);
  /* Больше пяти городов не помещается в ячейку дня на ленте ёмкости у оператора. */
  if(field==='cities' && !off && a.length>=MAX_CITIES)
    return toast(`На день можно назначить не больше ${MAX_CITIES} городов — иначе они не поместятся в ленту ёмкости. Снимите лишний.`);
  if(field==='ops' && !off && a.length>=MAX_OPS)
    return toast(`На смену можно поставить не больше ${MAX_OPS} операторов. Снимите кого-то из назначенных.`);
  d[field] = off ? a.filter(x=>x!==val) : [...a,val];
  /* Город сняли — его план уходит вместе с ним; добавили — подставляем прикидку по смене, руководитель поправит. */
  if(field==='cities'){
    if(off) delete d.caps[val];
    else if(!d.caps[val]) d.caps[val] = evenCap(d);
  }
  pushDay(ds);
  render();
}
/* Подсказка по смене: 25 адресов на поверителя, разложенные по городам дня. */
const evenCap = d => Math.max(5,Math.round(d.crew.length*25/Math.max(1,d.cities.length)/5)*5);
function setCap(ds,c,v){ dayOrNew(ds).caps[c] = Math.max(0,parseInt(v)||0); pushDay(ds); render(); }
function spreadCaps(ds){
  const d = dayOrNew(ds), per = evenCap(d);
  d.cities.forEach(c=>d.caps[c]=per);
  pushDay(ds);
  toast(`План разложен по смене: ${d.cities.length} город(ов) по ${per} — всего ${per*d.cities.length}.`);
}
function clearDay(ds){
  const d = dayOrNew(ds);
  const booked = bookedOn(ds);
  if(booked) return toast(`На ${ru(ds)} уже записано ${booked} заявок — сначала перенесите их.`);
  d.cities=[]; d.crew=[]; d.ops=[]; d.caps={};
  pushDay(ds);
  toast(`${ru(ds)} снят с работы: приём закрыт, смены сняты.`); render();
}
function dayModal(ds){
  const d = dayOrNew(ds), t = dayTotal(ds);
  const vers = S.staff.filter(p=>p.role==='verifier');
  const wd = WD[new Date(ds+'T00:00:00').getDay()];
  return `<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="width:min(900px,96vw)">
      <div class="mhd"><h3>${ru(ds)} · ${wd}</h3>
        <span class="note">${t.p?`план ${t.p}, записано ${t.b}`:'день не запланирован'}</span>
        <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>

      <div class="f"><label>Города приёма · ${d.cities.length} из ${MAX_CITIES}</label>
        <p class="note" style="margin:0 0 8px">Оператор сможет записать заявку только в эти города.
          Больше ${MAX_CITIES} на день не ставим — столько строк помещается в ленту ёмкости у оператора.</p>
        <div class="tgls">${CITIES.map(c=>{const on = d.cities.includes(c), full = d.cities.length>=MAX_CITIES;
          return `<button class="tgl" aria-pressed="${on}" ${!on&&full?'disabled':''}
            title="${!on&&full?`Уже выбрано ${MAX_CITIES} городов`:esc(c)}"
            onclick="tgDay('${ds}','cities','${c}')">${esc(c)}</button>`}).join('')}</div></div>

      ${d.cities.length?`<div class="f" style="margin-top:14px"><label>План приёма по городам · всего ${t.p}</label>
        <p class="note" style="margin:0 0 8px">Сколько заявок готовы принять по каждому городу. Приём по городу закрывается при превышении плана на 10%.</p>
        <table><thead><tr><th>Город</th><th class="num" style="width:110px">План</th>
          <th class="num" style="width:110px">Записано</th><th style="width:150px">Загрузка</th></tr></thead><tbody>
          ${d.cities.map(c=>{const x = dayState(ds,c);
            return `<tr><td><b>${esc(c)}</b></td>
              <td class="num"><input class="fld sm mono" style="text-align:right" value="${capOf(ds,c)}"
                onchange="setCap('${ds}','${c}',this.value)" title="План приёма по городу ${esc(c)}"></td>
              <td class="num mono">${x.b}</td>
              <td>${x.p?`<span class="tg ${x.s==='over'?'t-err':x.s==='full'?'t-ink':x.s==='fill'?'t-cold':'t-mut'}">${Math.round(x.pct*100)}%</span>`
                :'<span class="note">план не задан</span>'}</td></tr>`}).join('')}
        </tbody></table>
        <div class="row" style="margin-top:8px;align-items:center">
          <button class="g sm" onclick="spreadCaps('${ds}')">Разложить по смене: ${d.crew.length} × 25</button>
          <span class="note" style="flex:1">Записано на день ${t.b} из ${t.p}${t.p?` · приём встанет на ${Math.ceil(t.p*1.1)}`:''}.</span></div></div>`
        :'<p class="note" style="margin-top:14px">Пока не выбран ни один город, план задавать не на что.</p>'}

      <div class="f" style="margin-top:14px;margin-bottom:0"><label>Поверители на дату · ${d.crew.length}</label>
        <p class="note" style="margin:0 0 8px">Операторы на день не назначаются — они работают по отдельному графику, на соседней подстранице.</p>
        <div class="tgls">${vers.map(p=>{const ab=absentOn(p.id,ds);
          return `<button class="tgl ${ab?'ab':''}" aria-pressed="${d.crew.includes(p.id)}" ${ab?'disabled':''}
            title="${ab?'согласованное отсутствие':p.name}" onclick="tgDay('${ds}','crew','${p.id}')">${esc(p.name)}</button>`}).join('')}</div></div>

      <div class="row" style="margin-top:16px;align-items:center">
        <span class="note" style="flex:1">Смена ${d.crew.length} поверителей — это ориентир ${d.crew.length*25} адресов за день.</span>
        <button class="g end" onclick="clearDay('${ds}')">Сделать выходным</button>
        <button class="b" onclick="closeModal()">Готово</button>
      </div>
    </div></div>`;
}

export { clearDay, clearOps, dayCell, dayModal, editDay, editOps, evenCap, opsCell, opsModal, pMonth, planTab, setCap, spreadCaps, tgDay, viewPlan };
