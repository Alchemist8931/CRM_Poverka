/* Знак счётчика и заставка при открытии. */

import { H } from './controls.js';
import { build } from '../screens/routes.js';

/* ──────────────────────────────────────────────────────────
   ГЕОМЕТРИЯ СЧЁТЧИКА (сцена 512×512, снята с референса)
   ────────────────────────────────────────────────────────── */
const M = {
  sw: 16,
  circle:'M 391.5 255.5 A 136 136 0 1 1 119.5 255.5 A 136 136 0 1 1 391.5 255.5',
  pipeLT:'M 56 203.5 L 134 203.5',
  pipeLB:'M 56 295.5 L 128 295.5',
  pipeRT:'M 378 203.5 L 456 203.5',
  pipeRB:'M 384 295.5 L 456 295.5',
  bar:   'M 216 155.5 L 295 155.5',
  dial:  'M 335.5 315.5 A 28 28 0 1 1 279.5 315.5 A 28 28 0 1 1 335.5 315.5',
  dot:   'M 271.5 351.5 A 16 16 0 1 1 239.5 351.5 A 16 16 0 1 1 271.5 351.5',
  pills: [175.5,215.5,255.5,295.5,335.5],
  pillW: 32, pillTop: 209, pillBot: 230
};
/* иконка приложения: та же форма, упрощённая и утолщённая под мелкий размер */
const ICON = `<svg viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="255.5" cy="255.5" r="136" stroke-width="30"/>
  <path d="M56 203.5H134M56 295.5H128M378 203.5H456M384 295.5H456M216 155.5H295" stroke-width="30"/>
  <path d="M175.5 212v16M215.5 212v16M255.5 212v16M295.5 212v16M335.5 212v16" stroke-width="34"/>
  <circle cx="307.5" cy="315.5" r="28" stroke-width="28"/>
  <circle cx="255.5" cy="351.5" r="15" stroke-width="26"/></svg>`;
const iconAt = px => ICON.replace('<svg ',`<svg style="width:${px}px;height:${px}px;flex-shrink:0" `);

/* ──────────────────────────────────────────────────────────
   ИНТРО: отрисовка счётчика на canvas
   ────────────────────────────────────────────────────────── */
const INTRO = (()=>{
  const TLN = {
    pipesL:{at:0,dur:340}, body:{at:170,dur:760}, pipesR:{at:520,dur:340},
    bar:{at:820,dur:260}, pills:{at:940,dur:560}, dial:{at:1420,dur:400},
    dot:{at:1600,dur:320}, roll:{at:1780,dur:1250}, title:{at:2050,dur:520},
    dock:{at:3150,dur:820}
  };
  const END = 3970;
  const E = {out:t=>1-Math.pow(1-t,3), out4:t=>1-Math.pow(1-t,4), io:t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2};
  const clamp=(v,a,b)=>v<a?a:v>b?b:v, lerp=(a,b,t)=>a+(b-a)*t;

  let cv, ctx, W=0, H=0, dpr=1, T=0, raf=0, shapes={}, done=false, onEnd=null;
  const DIGITS = [0,0,7,4,2];

  function measure(d){
    const NS='http://www.w3.org/2000/svg';
    const s=document.createElementNS(NS,'svg'); s.setAttribute('width','0'); s.setAttribute('height','0');
    s.style.cssText='position:absolute;left:-9999px;opacity:0;pointer-events:none';
    const p=document.createElementNS(NS,'path'); p.setAttribute('d',d); s.appendChild(p);
    document.body.appendChild(s); const len=p.getTotalLength(); s.remove();
    return {p:new Path2D(d), len};
  }
  function pillPath(cx,top,bot,w){
    const r=w/2, P=new Path2D();
    P.moveTo(cx-r,top); P.arc(cx,top,r,Math.PI,0); P.lineTo(cx+r,bot);
    P.arc(cx,bot,r,0,Math.PI); P.closePath(); return P;
  }
  function build(){
    ['circle','pipeLT','pipeLB','pipeRT','pipeRB','bar','dial','dot'].forEach(k=>shapes[k]=measure(M[k]));
    shapes.pills = M.pills.map(x=>pillPath(x,M.pillTop,M.pillBot,M.pillW));
  }
  const pr=(k,e)=>{const s=TLN[k]; const p=clamp((T-s.at)/s.dur,0,1); return e?e(p):p;};
  function line(sh,p,col,w){
    if(p<=0) return;
    ctx.save(); ctx.strokeStyle=col; ctx.lineWidth=w; ctx.lineCap='round'; ctx.lineJoin='round';
    if(p<1) ctx.setLineDash([sh.len*E.out(p), sh.len]);
    ctx.stroke(sh.p); ctx.restore();
  }
  function resize(){
    dpr=Math.min(window.devicePixelRatio||1,2);
    W=cv.clientWidth||innerWidth; H=cv.clientHeight||innerHeight;
    cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr);
  }
  function frame(ts){
    if(!frame.t0) frame.t0=ts;
    T=(ts-frame.t0);
    draw();
    if(T<END+380) raf=requestAnimationFrame(frame); else finish();
  }
  function finish(){
    if(done) return; done=true; cancelAnimationFrame(raf);
    const el=document.getElementById('intro');
    if(el){ el.style.transition='opacity .35s ease'; el.style.opacity='0'; setTimeout(()=>el.remove(),380); }
    const card=document.querySelector('.login');
    if(card){ card.style.transition='opacity .45s ease, transform .45s ease'; card.style.opacity='1'; card.style.transform='none'; }
    onEnd&&onEnd();
  }
  function target(){
    const t=document.querySelector('.login .logo');
    if(!t) return null;
    const r=t.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2, s:(r.width*0.62)/512};
  }
  function draw(){
    const cs=getComputedStyle(document.documentElement);
    const bg=cs.getPropertyValue('--bg').trim()||'#F2F2F0';
    const ink=cs.getPropertyValue('--ink').trim()||'#171717';
    const ink3=cs.getPropertyValue('--ink3').trim()||'#8D8D8D';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H); ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);

    /* позиция и масштаб сцены: центр → док в плитку логотипа */
    const base=Math.min(W,H)*0.30/512;
    let cx=W/2, cy=H/2-26, sc=base, alpha=1;
    const dk=pr('dock',E.io);
    if(dk>0){
      const t=target();
      if(t){ cx=lerp(cx,t.x,dk); cy=lerp(cy,t.y,dk); sc=lerp(base,t.s,dk); }
      alpha=1-clamp((dk-0.55)/0.45,0,1);
    }
    ctx.globalAlpha=alpha;
    ctx.setTransform(dpr*sc,0,0,dpr*sc, dpr*(cx-256*sc), dpr*(cy-256*sc));

    const pL=pr('pipesL'), pB=pr('body'), pR=pr('pipesR'), pBar=pr('bar');
    line(shapes.pipeLT,pL,ink,M.sw); line(shapes.pipeLB,clamp(pL*1.15-0.12,0,1),ink,M.sw);
    line(shapes.circle,pB,ink,M.sw);
    line(shapes.pipeRT,pR,ink,M.sw); line(shapes.pipeRB,clamp(pR*1.15-0.12,0,1),ink,M.sw);
    line(shapes.bar,pBar,ink,M.sw);

    /* ролики: раскрываются сверху вниз со сдвигом */
    const pp=pr('pills');
    shapes.pills.forEach((path,i)=>{
      const k=clamp(pp*5 - i*0.62, 0, 1); if(k<=0) return;
      const e=E.out4(k), midY=(M.pillTop+M.pillBot)/2, h=(M.pillBot-M.pillTop)/2*e;
      ctx.save(); ctx.fillStyle=ink;
      ctx.fill(pillPath(M.pills[i], midY-h, midY+h, M.pillW));
      ctx.restore();
    });

    /* цифры в роликах — «прокрутка» и остановка слева направо */
    const rl=pr('roll');
    if(rl>0 && pp>=1){
      ctx.save(); ctx.fillStyle=bg; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.font='600 30px "SN Pro", sans-serif';
      const cellH=40, midY=(M.pillTop+M.pillBot)/2+1;
      M.pills.forEach((x,i)=>{
        const k=clamp(rl*1.9 - i*0.16, 0, 1);
        const spins=5+i*1.4, off=(1-E.out4(k))*spins*cellH*10;
        ctx.save();
        ctx.beginPath(); ctx.rect(x-M.pillW/2, M.pillTop-M.pillW/2+3, M.pillW, (M.pillBot-M.pillTop)+M.pillW-6); ctx.clip();
        for(let j=-1;j<=1;j++){
          const raw=DIGITS[i]+Math.round(off/cellH)+j;
          const y=midY + j*cellH - (off%cellH);
          ctx.fillText(String(((raw%10)+10)%10), x, y);
        }
        ctx.restore();
      });
      ctx.restore();
    }

    line(shapes.dial,pr('dial'),ink,M.sw);
    line(shapes.dot,pr('dot'),ink,M.sw);

    /* стрелка в большом циферблате — крутится, пока идут ролики */
    if(pr('dial')>=1){
      const spin=clamp((T-TLN.dial.at-TLN.dial.dur)/1500,0,1);
      const a=-Math.PI/2 + E.io(spin)*Math.PI*4.6;
      ctx.save(); ctx.strokeStyle=ink3; ctx.lineWidth=9; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(307.5,315.5);
      ctx.lineTo(307.5+Math.cos(a)*17, 315.5+Math.sin(a)*17); ctx.stroke(); ctx.restore();
    }

    /* подпись */
    const tt=pr('title',E.out);
    if(tt>0 && dk<0.25){
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.save(); ctx.globalAlpha=alpha*tt*(1-clamp(dk/0.25,0,1));
      ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle=ink;
      ctx.font='600 26px "SN Pro", sans-serif';
      ctx.fillText('CRM «Учёткин»', W/2, H/2 + Math.min(W,H)*0.20 + 22 + (1-tt)*8);
      ctx.restore();
    }
    ctx.globalAlpha=1;
  }
  function skip(){ if(!done){ T=END; draw(); finish(); } }
  function start(cb){
    onEnd=cb;
    cv=document.getElementById('introCv'); if(!cv){cb&&cb();return;}
    ctx=cv.getContext('2d');
    if(matchMedia('(prefers-reduced-motion:reduce)').matches){ skip(); return; }
    build(); resize(); addEventListener('resize',resize);
    document.getElementById('intro').addEventListener('click',skip);
    addEventListener('keydown',e=>{ if(e.key==='Escape'||e.key===' ') skip(); },{once:true});
    raf=requestAnimationFrame(frame);
  }
  return {start, skip};
})();

export { ICON, INTRO, M, iconAt };
