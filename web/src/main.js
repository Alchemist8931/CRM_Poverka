/* ============================================================
   CRM «Учёткин» · точка входа
   Два режима из одних и тех же экранов:
     рабочий  — данные приходят из API, действия уходят туда же;
     демо     — наполнение в памяти вкладки, как было в прототипе (?demo=1).
   ============================================================ */

import './styles.css';
import './globals.js';
import './screens/index.js';

import { CITIES } from './refs.js';
import { S, dayCities } from './state.js';
import { addDays, iso, today, TODAY } from './util.js';
import { dayLock } from './rules.js';
import { seed } from './demo/seed.js';
import { seedAudit } from './demo/audit.js';
import { render, step } from './ui/render.js';
import { closeModal } from './ui/modals.js';
import { closePrint } from './screens/print.js';
import { lbMove } from './ui/lightbox.js';
import { opTick } from './screens/op-console.js';
import { NET } from './net.js';
import { isDemo } from './api/mode.js';
import { bootApi } from './api/boot.js';

document.addEventListener('click', (e) => { if(S.dd && !e.target.closest('[data-fld]')){ S.dd=null; render(); } });
document.addEventListener('keydown', (e) => {
  if(NET.isOff()) return;   // под слоем «нет связи» клавиши тоже не работают
  if(e.key==='Escape'){
    if(S.dd){ S.dd=null; render(); return; }
    if(S.lb){ S.lb=null; render(); return; }
    if(S.print){ closePrint(); return; }
    if(S.modal){ closeModal(); return; }
  }
  if(!S.auth) return;
  if(S.lb && (e.key==='ArrowLeft'||e.key==='ArrowRight')){ e.preventDefault(); lbMove(e.key==='ArrowRight'?1:-1); return; }
  if(e.altKey && (e.key==='ArrowLeft'||e.key==='ArrowRight')){ e.preventDefault(); step(e.key==='ArrowRight'?1:-1); }
});

/** Демо-режим: наполнение в памяти, как в прототипе до переезда на API. */
function bootDemo(){
  seed();
  // Журнал действий: в демо он делается по уже разложенному наполнению, потому
  // что писать его на самом деле некому — запросов к серверу здесь не бывает.
  seedAudit();
  /* Ближайшие даты уже ушли под маршруты — приём открываем с первой свободной. */
  S.day = Array.from({length:21},(_,i)=>iso(addDays(today,i)))
    .find(ds=>dayCities(ds).length && !dayLock(ds)) || TODAY;
  S.intake.city = dayCities(S.day)[0] || CITIES[0];
  render();
  setInterval(opTick,1000);
}

if (isDemo()) bootDemo();
else {
  bootApi();
  // Секундный тик пульта нужен и в рабочем режиме: счётчики разговора и
  // постобработки, синхронизация паузы с АТС. Входящие он не выдумывает.
  setInterval(opTick,1000);
}

NET.start();
