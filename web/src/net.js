/* Связь: опрос /health и слой «нет связи». */

import { ms } from './screens/op-console.js';
import { toast } from './ui/render.js';
import { isDemo } from './api/mode.js';

/* ──────────────────────────────────────────────────────────
   СВЯЗЬ
   Офлайн-режима нет: без сети работать нельзя, поэтому интерфейс просто
   запирается под размытием до восстановления. Ничего не сбрасывается —
   открытое модальное окно и введённые значения ждут под слоем.
   ────────────────────────────────────────────────────────── */
const NET = (()=>{
  const PING = 10000;      // опрос раз в 10 секунд
  const GRACE = 3000;      // первые 3 секунды после открытия молчим
  const START = Date.now();
  let off=false, since=0, busy=false;

  /* Опрос связи. В рабочем режиме спрашиваем у сервера /health — тот же адрес,
     который опрашивает балансировщик; в демо-режиме сервера нет вовсе, поэтому
     щупаем собственную страницу.
     Опрос — не единственный источник правды: слой поднимает и снимает ещё и
     api/client.js, на каждом запросе. Опрос нужен для случая, когда человек
     ничего не нажимает, — иначе восстановление заметили бы только по клику. */
  async function probe(){
    if(typeof navigator==='object' && navigator && navigator.onLine===false) return false;
    if(typeof fetch!=='function') return true;
    const url = isDemo() ? location.pathname+'?ping='+Date.now() : '/health?ping='+Date.now();
    try{
      const r = await fetch(url,{method:isDemo()?'HEAD':'GET',cache:'no-store'});
      return !!r && r.ok;
    }catch(e){ return false; }
  }

  function paint(){
    const el = document.getElementById('offline'); if(!el) return;
    if(!off){ el.hidden=true; el.innerHTML=''; return; }
    el.hidden=false;
    el.innerHTML = `<div class="offw"><div class="offc">
      <div class="spin"></div>
      <h3>Нет связи</h3>
      <p class="note">Ждём восстановления соединения…</p>
      <div class="ago mono" id="offAgo">Без связи ${ms(0)}</div>
      <button class="b" onclick="NET.check()">Проверить сейчас</button>
    </div></div>`;
  }
  /* Раз в секунду обновляем только строку времени: перерисовывать всю
     страницу нельзя — под слоем может быть заполненная форма акта. */
  function tick(){
    if(!off) return;
    const el = document.getElementById('offAgo');
    if(el) el.textContent = 'Без связи '+ms(Math.floor((Date.now()-since)/1000));
  }
  function down(){
    if(off || Date.now()-START < GRACE) return;   // окно тишины после открытия
    off=true; since=Date.now(); paint();
  }
  /* down() и up() зовёт ещё и слой api: запрос, не доехавший до сервера, — это
     и есть потеря связи, а любой ответ означает, что связь снова есть. */
  function up(){
    if(!off) return;
    off=false; paint();
    toast('Связь восстановлена.');                // toast сам перерисовывает экран
  }
  async function check(){
    if(busy) return;
    busy=true;
    let ok; try{ ok = await probe(); } finally { busy=false; }
    ok?up():down();
  }
  function start(){
    if(typeof window!=='object' || !window || !window.addEventListener) return;
    window.addEventListener('offline',()=>{ down(); });
    window.addEventListener('online',()=>{ check(); });
    setInterval(check,PING);
    setInterval(tick,1000);
    setTimeout(check,GRACE);   // если связи нет с самого открытия — покажем сразу после окна тишины
  }
  return {start,check,down,up,isOff:()=>off};
})();

export { NET };
