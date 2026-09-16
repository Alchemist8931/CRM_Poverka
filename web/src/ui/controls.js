/* Общие контролы: SEL, DATE, CHK, SEG. */

import { I, svg } from './icons.js';
import { MN, TODAY, addDays, esc, iso, ru, ruLong } from '../util.js';
import { S } from '../state.js';
import { render } from './render.js';

/* ============ КОМПОНЕНТЫ ПОЛЕЙ ============ */
const H = {};
function dd(id){ S.dd = S.dd===id?null:id; render(); }
function pick(id,v){ S.dd=null; H[id]?.(v); render(); }
function SEL(id,val,items,fn,o={}){
  H[id] = fn;
  const list = items.map(x=>typeof x==='object'?x:{v:x,l:x});
  const cur = list.find(x=>String(x.v)===String(val));
  const open = S.dd===id;
  return `<div class="sel ${open?'open':''}" data-fld>
    <button type="button" class="fld ${o.sm?'sm':''}" onclick="dd('${id}')" aria-expanded="${open}" aria-haspopup="listbox">
      <span class="v ${cur?'':'ph'}">${cur?esc(cur.l):esc(o.ph||'Выберите')}</span>${svg(I.chev,14).replace('style="','class="cv" style="')}</button>
    ${open?`<div class="pop ${o.right?'right':''}" role="listbox">${list.map(x=>
      `<button type="button" class="o" role="option" aria-selected="${cur&&String(cur.v)===String(x.v)}"
        data-v="${esc(x.v)}" onclick="pick('${id}',this.dataset.v)">
        <span>${esc(x.l)}</span><span class="tail">${x.hint?`<span class="hint">${esc(x.hint)}</span>`:''}<span class="ck">${svg(I.ok,13)}</span></span></button>`).join('')}</div>`:''}
  </div>`;
}
function DATE(id,val,fn,o={}){
  H[id] = fn;
  const open = S.dd===id;
  const cur = new Date((S.ddM||val||TODAY)+'T00:00:00'); cur.setDate(1);
  const first = new Date(cur); first.setDate(1-((cur.getDay()+6)%7));
  const cells = Array.from({length:42},(_,i)=>addDays(first,i));
  return `<div class="sel ${open?'open':''}" data-fld>
    <button type="button" class="fld ${o.sm?'sm':''}" onclick="S.ddM='${val}';dd('${id}')" aria-expanded="${open}">
      <span class="v mono">${val?ru(val):'—'}</span>${svg(I.cal,14).replace('style="','class="cv" style="')}</button>
    ${open?`<div class="pop cal ${o.slots?'wide right':''}">
      <div class="cal-c">
        <div class="cal-h"><button type="button" class="ib sm" onclick="calMove(-1)">${svg(I.left,13)}</button>
          <b>${MN[cur.getMonth()]} ${cur.getFullYear()}</b>
          <button type="button" class="ib sm" onclick="calMove(1)">${svg(I.right,13)}</button></div>
        <div class="cal-w">${['пн','вт','ср','чт','пт','сб','вс'].map(d=>`<span>${d}</span>`).join('')}</div>
        <div class="cal-g">${cells.map(d=>{const s=iso(d);
          return `<button type="button" class="${d.getMonth()!==cur.getMonth()?'out':''} ${s===TODAY?'tdy':''} ${s===val?'on':''}"
            onclick="pick('${id}','${s}')">${d.getDate()}</button>`}).join('')}</div>
        <button type="button" class="g sm" style="width:100%;margin-top:8px" onclick="pick('${id}','${TODAY}')">Сегодня</button>
      </div>
      ${o.slots?`<div class="cal-s">
        <div class="lbl">Когда можно записать${o.slotsCity?` · ${esc(o.slotsCity)}`:''}</div>
        <div class="slotlist">${o.slots.length?o.slots.map(s=>`<button type="button" class="slot ${s.ds===val?'on':''}"
          title="${ruLong(s.ds)} · свободно ${s.free} из ${s.plan} · поверителей с этими услугами ${s.crew}"
          onclick="pick('${id}','${s.ds}')"><b>${ruLong(s.ds)}</b><i>${s.crew} пов. · ${s.free}</i></button>`).join('')
          :`<span class="none">${o.slotsCity?`По городу «${esc(o.slotsCity)}» на ближайшие дни нет смены, где закрыты все выбранные услуги.`
            :'На ближайшие дни нет смен, где закрыты все выбранные услуги.'} Снимите часть услуг, выберите другой город или поставьте дату вручную.</span>`}</div>
      </div>`:''}
    </div>`:''}
  </div>`;
}
function calMove(n){ const d=new Date((S.ddM||TODAY)+'T00:00:00'); d.setDate(1); d.setMonth(d.getMonth()+n); S.ddM=iso(d); render(); }
const CHK = (on,label,fn) => `<button type="button" class="chk" role="checkbox" aria-checked="${!!on}" onclick="${fn}">
  <i>${svg(I.ok,11)}</i>${label?`<span>${esc(label)}</span>`:''}</button>`;
const SEG = (val,items,fn,z={}) => `<div class="seg ${z.sm?'sm':''}">${items.map(x=>{const o=typeof x==='object'?x:{v:x,l:x};
  return `<button type="button" class="${o.c||''}" aria-pressed="${String(val)===String(o.v)}" onclick="${fn.replace('$v',`'${o.v}'`)}">${esc(o.l)}</button>`}).join('')}</div>`;

export { CHK, DATE, H, SEG, SEL, calMove, dd, pick };
