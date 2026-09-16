/* Просмотр фото. */

import { I, svg } from './icons.js';
import { S } from '../state.js';
import { esc } from '../util.js';
import { render } from './render.js';

/* ---------- просмотр фото ---------- */
function lbOpen(rid,i,k){ S.lb={rid,i,k}; render(); }
function lbMove(d){
  if(!S.lb) return;
  const ps = lbPhotos(); if(!ps.length) return;
  S.lb.k = (S.lb.k+d+ps.length)%ps.length; render();
}
function lbPhotos(){
  const r = S.lb && S.requests.find(x=>x.id===S.lb.rid);
  return r?.devices?.[S.lb.i]?.photos || [];
}
function lightbox(){
  if(!S.lb) return '';
  const ps = lbPhotos(), p = ps[S.lb.k]; if(!p){ S.lb=null; return ''; }
  return `<div class="lb" onclick="if(event.target===this){S.lb=null;render()}">
    <button class="ib cls" onclick="S.lb=null;render()">${svg(I.no,15)}</button>
    <div><img src="${p.src}" alt="">
      <div class="bar"><button class="ib" onclick="lbMove(-1)">${svg(I.left,14)}</button>
        <span class="mono">${S.lb.k+1} / ${ps.length}</span>
        <span style="color:#8D8D8D">${esc(p.name)} · ${esc(p.t)}</span>
        <button class="ib" onclick="lbMove(1)">${svg(I.right,14)}</button></div></div></div>`;
}

export { lbMove, lbOpen, lbPhotos, lightbox };
