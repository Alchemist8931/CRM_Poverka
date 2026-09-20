/* Заработок, сдельная оплата и подотчёт. */

import { CUR_M, MN, TODAY, addDays, esc, iso, money, pad, ru } from '../util.js';
import { DATE, SEG } from '../ui/controls.js';
import { I, svg } from '../ui/icons.js';
import { S, nameOf, staffById } from '../state.js';
import { addrOf, noPay, payTag, priceOf, rateO, rateV, subReport, svcNames } from '../rules.js';
import { badTag } from '../refs.js';
import { cap, shell } from '../ui/shell.js';
import { render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { takeHandover as apiTakeHandover } from '../api/actions.js';
import { reqTag } from './intake.js';
import { acqCard } from './pay.js';

/* ---------- заработок ---------- */
function viewMe(){
  const isV = S.role==='verifier';
  const val = r => isV?rateV(r):rateO(r);
  const mine = r => isV ? r.verifier===S.me : r.operator===S.me;
  const [Y,Mo] = S.mMonth.split('-').map(Number);
  const inMonth = ds => ds.slice(0,7)===S.mMonth;

  const done = S.requests.filter(r=>r.status==='выполнена' && mine(r));
  const mDone = done.filter(r=>inMonth(r.date)).sort((a,b)=>b.date.localeCompare(a.date));
  const sum = mDone.reduce((a,r)=>a+val(r),0);
  const td = done.filter(r=>r.date===TODAY).reduce((a,r)=>a+val(r),0);
  /* Обработано, но до выполнения ещё не дошло: начисления нет, а работа сделана. */
  const wip = S.requests.filter(r=>mine(r) && ['создана','в маршруте','перенос'].includes(r.status))
    .sort((a,b)=>a.date.localeCompare(b.date));

  const byDay = {}; mDone.forEach(r=>byDay[r.date]=(byDay[r.date]||0)+val(r));
  const mx = Math.max(1,...Object.values(byDay));
  const first = new Date(Y,Mo-1,1);
  const grid = new Date(first); grid.setDate(1-((first.getDay()+6)%7));
  const rows = Math.ceil(((first.getDay()+6)%7 + new Date(Y,Mo,0).getDate())/7);
  const weeks = Array.from({length:rows},(_,w)=>Array.from({length:7},(_,i)=>iso(addDays(grid,w*7+i))));
  const tab = S.meTab||'done';

  return shell(null,`${cap()}
  <div class="row" style="margin-bottom:14px;align-items:center">
    ${SEG(tab,[{v:'done',l:'Начислено'},{v:'wip',l:`В работе · ${wip.length}`}],"S.meTab=$v;render()")}
    <div style="flex:1"></div>
    ${tab==='done'?`<div class="ptop" style="margin:0">
      <button class="ib" onclick="mMonth(-1)">${svg(I.left,14)}</button>
      <b style="min-width:150px;text-align:center">${MN[Mo-1]} ${Y}</b>
      <button class="ib" onclick="mMonth(1)">${svg(I.right,14)}</button>
      <button class="g sm" onclick="S.mMonth='${TODAY.slice(0,7)}';render()">Текущий месяц</button></div>`
     :`<span class="note">Здесь все даты: заявка ждёт выезда и может уехать в следующий месяц.</span>`}
  </div>
  ${tab==='wip'?`
  <div class="kpi">
    <div><div class="v">${wip.length}</div><div class="k">заявок в работе</div></div>
    <div><div class="v">${wip.filter(r=>r.status==='создана').length}</div><div class="k">ждут маршрута</div></div>
    <div><div class="v">${wip.filter(r=>r.status==='в маршруте').length}</div><div class="k">в маршруте</div></div>
    <div><div class="v" ${wip.filter(r=>r.status==='перенос').length?'style="color:var(--warning)"':''}>${wip.filter(r=>r.status==='перенос').length}</div><div class="k">перенесены</div></div></div>
  <div class="c"><h3>Обработано, но ещё не выполнено</h3>
    <p class="cap">Начисление появится, когда поверитель закроет акт. Здесь видно, что именно ещё в пути.</p>
    ${wip.length?`<table><thead><tr><th>Заявка</th><th class="num">Создана</th><th class="num">Выезд</th><th>Город</th><th>Адрес</th><th>Клиент</th><th>Маршрут</th><th>Статус</th></tr></thead><tbody>
      ${wip.slice(0,40).map(r=>`<tr><td class="mono">${r.id}</td><td class="num mono">${ru(r.created||r.date)}</td>
        <td class="num mono">${ru(r.date)}</td><td>${r.city}</td><td><b>${esc(addrOf(r))}</b></td>
        <td>${esc(r.name)}</td><td class="mono">${r.routeId||'<span class="note">—</span>'}</td>
        <td>${reqTag(r.status)}</td></tr>`).join('')}</tbody></table>
      ${wip.length>40?`<p class="note" style="margin-top:10px">Показаны первые 40 из ${wip.length}.</p>`:''}`
      :`<div class="empty">Всё, что вы обработали, уже дошло до выполнения.</div>`}</div>`
  :`
  <div class="kpi">
    <div><div class="v">${money(td)}</div><div class="k">начислено сегодня</div></div>
    <div><div class="v">${money(sum)}</div><div class="k">за ${MN[Mo-1]}</div></div>
    <div><div class="v">${mDone.length}</div><div class="k">${isV?'выполнено работ':'заявок дошло до выполнения'}</div></div>
    <div><div class="v">${mDone.length?money(sum/mDone.length):'—'}</div><div class="k">средний чек начисления</div></div></div>
  ${isV?subCard(S.me,S.mMonth):''}
  <div class="c"><h3>По неделям · ${MN[Mo-1]} ${Y}</h3>
    <div class="rib4">
      <div class="wk wkd">${['пн','вт','ср','чт','пт','сб','вс'].map(d=>`<span>${d}</span>`).join('')}</div>
      ${weeks.map((days,w)=>{const ws=days.reduce((a,ds)=>a+(byDay[ds]||0),0);
        return `<div>
          <div class="wkh"><span class="lbl">Неделя ${w+1}</span>
            <span class="rg">${ru(days[0]).slice(0,5)} — ${ru(days[6]).slice(0,5)}</span>
            <span class="tot">${money(ws)}</span></div>
          <div class="wk">${days.map(ds=>{const d=new Date(ds+'T00:00:00'), out=d.getMonth()!==Mo-1, v=byDay[ds]||0;
            return `<button class="day ${out?'past':''} ${ds===TODAY?'tdy':''}" data-s="${v?'full':'free'}" style="cursor:default">
              <div class="bar"><div class="fill" style="height:${v/mx*90}%"></div>
              <span class="pct">${v?(v>=1000?Math.round(v/1000)+'к':v):'—'}</span></div>
              <div class="dd">${pad(d.getDate())}.${pad(d.getMonth()+1)}</div>
              <div class="cts">${v?money(v):'—'}</div></button>`}).join('')}</div></div>`}).join('')}
    </div></div>
  <div class="c"><h3>Детализация · ${MN[Mo-1]}</h3>
    <p class="cap">${isV?'Ставка поверителя за выполненную услугу.':'Ставка оператора за принятую заявку, дошедшую до выполнения.'}</p>
    ${mDone.length?`<table><thead><tr><th>Заявка</th><th class="num">Дата</th><th>Город</th><th>Адрес</th><th>Клиент</th><th>Услуги</th><th class="num">Сумма работ</th><th>Оплата</th><th class="num">Начислено</th></tr></thead><tbody>
      ${mDone.slice(0,35).map(r=>`<tr><td class="mono">${r.id}</td><td class="num">${ru(r.date)}</td>
        <td>${r.city}</td><td><b>${esc(addrOf(r))}</b></td><td>${esc(r.name)}</td>
        <td>${svcNames(r)} ${badTag(r)}</td><td class="num">${money(priceOf(r))}</td>
        <td>${payTag(r)}</td>
        <td class="num"><b>${money(val(r))}</b></td></tr>`).join('')}</tbody></table>
      ${mDone.length>35?`<p class="note" style="margin-top:10px">Показаны первые 35 из ${mDone.length}.</p>`:''}`
      :`<div class="empty">За этот месяц начислений нет.</div>`}</div>`}`);
}
/* Подотчёт поверителя: сколько денег он собрал на адресах, сколько из них его
   собственная сдельная оплата и сколько остаётся привезти руководителю. */
function subCard(vid,m){
  const R = subReport(vid,m);
  const mi = +m.slice(5)-1, mn = `${MN[mi]} ${m.slice(0,4)}`;
  const back = R.left >= 0;
  const unpaidSum = R.unpaid.reduce((a,r)=>a+priceOf(r),0);
  /* Месяц без выездов: считать не из чего, показываем только сдачу, если она была. */
  if(!R.done.length) return `<div class="c"><h3>Подотчёт · ${mn}</h3>
    <p class="cap">За этот месяц выполненных работ нет — денег с клиентов вы не брали.</p>
    ${R.last?`<p class="note">Последняя сдача: <b style="color:var(--ink)">${money(R.last.amount)}</b>
      от ${ru(R.last.at)} за ${MN[+R.last.period.slice(5)-1]}${R.last.by?` · принял ${esc(nameOf(R.last.by))}`:''}.</p>`
      :`<p class="note">Сдач ещё не было.</p>`}</div>`;
  return `<div class="c"><h3>Подотчёт · ${mn}</h3>
    <p class="cap">Наличные и переводы вы забираете на адресе и держите у себя; в конце месяца сдаёте руководителю
      собранное за вычетом своей сдельной оплаты. Оплаты по QR и ссылке сюда не входят — они ушли на счёт компании.</p>
    <div class="kpi" style="margin-bottom:12px">
      <div><div class="v">${money(R.cash)}</div><div class="k">принято наличными</div></div>
      <div><div class="v">${money(R.card)}</div><div class="k">принято переводом</div></div>
      <div><div class="v">${money(R.wage)}</div><div class="k">начислено сдельной</div></div>
      <div><div class="v">${money(R.given)}</div><div class="k">сдано руководителю</div></div>
      <div><div class="v" style="color:var(--${back?'success':'warning'})">${money(Math.abs(R.left))}</div>
        <div class="k">${back?'к возврату с вас':'к доплате вам'}</div></div>
    </div>
    <p class="note">Принято ${money(R.got)} − начислено ${money(R.wage)}${R.given?` − сдано ${money(R.given)}`:''}
      = <b style="color:var(--ink)">${money(Math.abs(R.left))}</b> ${back?'привезти руководителю':'компания доплачивает вам'}.
      ${R.acct?`Ещё ${money(R.acct)} клиенты оплатили по счёту — эти деньги через вас не проходят. `:''}
      ${R.unpaid.length?`Без оплаты закрыто адресов: ${R.unpaid.length} на ${money(unpaidSum)} — их видит руководитель.`:''}</p>
    ${R.last?`<p class="note" style="margin-top:6px">Последняя сдача: <b style="color:var(--ink)">${money(R.last.amount)}</b>
      от ${ru(R.last.at)}${R.last.period!==m?` за ${MN[+R.last.period.slice(5)-1]}`:''}${R.last.by?` · принял ${esc(nameOf(R.last.by))}`:''}.</p>`
      :`<p class="note" style="margin-top:6px">Сдач ещё не было.</p>`}
  </div>`;
}
function mMonth(n){ const [y,m]=S.mMonth.split('-').map(Number); const d=new Date(y,m-1+n,1);
  S.mMonth = `${d.getFullYear()}-${pad(d.getMonth()+1)}`; render(); }
function viewPayroll(){
  const done = S.requests.filter(r=>r.status==='выполнена');
  const byV = {}, byO = {}, cV = {}, cO = {};
  done.forEach(r=>{
    if(r.verifier){ byV[r.verifier]=(byV[r.verifier]||0)+rateV(r); cV[r.verifier]=(cV[r.verifier]||0)+1; }
    if(r.operator){ byO[r.operator]=(byO[r.operator]||0)+rateO(r); cO[r.operator]=(cO[r.operator]||0)+1; }
  });
  const tbl = (o,cnt,l) => Object.keys(o).length?`<table><thead><tr><th>${l}</th><th>Вн. номер</th><th class="num">Работ</th><th class="num">Начислено</th><th class="num">Средняя</th></tr></thead><tbody>
    ${Object.entries(o).sort((a,b)=>b[1]-a[1]).map(([k,v])=>
      `<tr><td><b>${esc(nameOf(k))}</b></td><td class="mono">${staffById(k)?.ext||'—'}</td>
      <td class="num">${cnt[k]}</td><td class="num"><b>${money(v)}</b></td><td class="num">${money(v/cnt[k])}</td></tr>`).join('')}</tbody></table>`
    :`<div class="empty">Нет начислений за период.</div>`;
  const tV = Object.values(byV).reduce((a,b)=>a+b,0), tO = Object.values(byO).reduce((a,b)=>a+b,0);
  const rev = done.reduce((a,r)=>a+priceOf(r),0) || 1;
  return shell(null,`${cap()}
  <div class="kpi">
    <div><div class="v">${money(rev)}</div><div class="k">выручка по выполненным</div></div>
    <div><div class="v">${money(tV)}</div><div class="k">фонд поверителей</div></div>
    <div><div class="v">${money(tO)}</div><div class="k">фонд операторов</div></div>
    <div><div class="v">${Math.round((tV+tO)/rev*100)}%</div><div class="k">доля сдельной оплаты</div></div></div>
  <div class="g2">
    <div class="c"><h3>Поверители</h3><p class="cap">По закрытым маршрутам.</p>${tbl(byV,cV,'Сотрудник')}</div>
    <div class="c"><h3>Операторы</h3><p class="cap">По заявкам, дошедшим до выполнения.</p>${tbl(byO,cO,'Сотрудник')}</div></div>
  ${subTable()}
  ${acqCard()}
  ${unpaidCard()}`);
}
/* Подотчёт бригады за текущий месяц: у поверителя на руках наличные и переводы,
   он сдаёт их за вычетом своей сдельной оплаты. Безнал по эквайрингу сюда не
   входит — он в соседней карточке, своим потоком. */
function subTable(){
  const m = CUR_M, mn = `${MN[+m.slice(5)-1]} ${m.slice(0,4)}`;
  const rows = S.staff.filter(p=>p.role==='verifier').map(p=>({p,R:subReport(p.id,m)}))
    .filter(x=>x.R.done.length || x.R.hos.length)
    .sort((a,b)=>b.R.left-a.R.left);
  const T = rows.reduce((a,x)=>({cash:a.cash+x.R.cash,card:a.card+x.R.card,got:a.got+x.R.got,
    wage:a.wage+x.R.wage,given:a.given+x.R.given,left:a.left+x.R.left}),{cash:0,card:0,got:0,wage:0,given:0,left:0});
  return `<div class="c"><h3>Подотчёт бригады · ${mn}</h3>
    <p class="cap">Наличные и переводы на адресе берёт поверитель и держит у себя до конца месяца; безнал по QR и ссылке
      идёт мимо него — на счёт компании — и считается отдельно, ниже.
      «Принять возврат» — это приход денег в кассу: поверитель привёз собранное за вычетом своей сдельной оплаты.</p>
    ${rows.length?`<table><thead><tr><th>Поверитель</th><th class="num">Наличными</th><th class="num">Переводом</th>
      <th class="num">Принято</th><th class="num">Начислено</th><th class="num">Сдано</th><th class="num">Остаток</th>
      <th>Последняя сдача</th><th></th></tr></thead><tbody>
      ${rows.map(({p,R})=>`<tr><td><b>${esc(p.name)}</b></td>
        <td class="num">${money(R.cash)}</td><td class="num">${money(R.card)}</td>
        <td class="num">${money(R.got)}</td><td class="num">${money(R.wage)}</td><td class="num">${money(R.given)}</td>
        <td class="num"><b style="color:var(--${R.left>0?'warning':R.left<0?'cold':'success'})">${R.left<0?'−'+money(-R.left):money(R.left)}</b></td>
        <td class="note" style="white-space:nowrap">${R.last?`${money(R.last.amount)} · ${ru(R.last.at)}`:'не было'}</td>
        <td style="text-align:right"><button class="g sm" onclick="openHo('${p.id}')" ${R.left>0?'':'disabled'}
          title="${R.left>0?'Принять деньги от поверителя':R.left<0?'Компания должна поверителю — возврата нет':'Подотчёт закрыт'}">Принять возврат</button></td></tr>`).join('')}
      </tbody><tfoot><tr><td>Итого по бригаде</td>
        <td class="num">${money(T.cash)}</td><td class="num">${money(T.card)}</td><td class="num">${money(T.got)}</td>
        <td class="num">${money(T.wage)}</td><td class="num">${money(T.given)}</td>
        <td class="num">${T.left<0?'−'+money(-T.left):money(T.left)}</td><td colspan="2"></td></tr></tfoot></table>`
      :`<div class="empty">За ${mn} выполненных работ и сдач нет.</div>`}</div>`;
}
/* Долги: работа сделана, денег нет. Оператор звонит и добивает оплату. */
function unpaidCard(){
  const list = S.requests.filter(r=>r.status==='выполнена' && noPay(r))
    .sort((a,b)=>b.date.localeCompare(a.date));
  const sum = list.reduce((a,r)=>a+priceOf(r),0);
  return `<div class="c"><h3>Выполнено без оплаты · ${list.length}</h3>
    <p class="cap">Акт закрыт, деньги не взяты: клиент обещал перевести, просит счёт или платит через УК.
      Общая сумма долга — <b style="color:var(--ink)">${money(sum)}</b>.</p>
    ${list.length?`<table><thead><tr><th class="num">Дата</th><th>Заявка</th><th>Город</th><th>Адрес</th><th>Клиент</th>
      <th class="num">Сумма</th><th>Поверитель</th><th>Что сказал клиент</th></tr></thead><tbody>
      ${list.slice(0,30).map(r=>`<tr><td class="num mono">${ru(r.date)}</td><td class="mono">${r.id}</td>
        <td>${esc(r.city)}</td><td><b>${esc(addrOf(r))}</b></td><td>${esc(r.name)}</td>
        <td class="num"><b>${money(priceOf(r))}</b></td><td>${esc(nameOf(r.verifier))}</td>
        <td class="note">${r.pay&&r.pay.note?esc(r.pay.note):'—'}</td></tr>`).join('')}</tbody></table>
      ${list.length>30?`<p class="note" style="margin-top:10px">Показаны первые 30 из ${list.length}.</p>`:''}`
      :`<div class="empty">Все выполненные работы оплачены.</div>`}</div>`;
}
/* Приём возврата: сумма по умолчанию — остаток подотчёта, дату можно поставить задним числом. */
function openHo(vid){
  const R = subReport(vid,CUR_M);
  S.ho = {staff:vid,amount:Math.max(0,Math.round(R.left)),at:TODAY,period:CUR_M,note:''};
  S.modal = {k:'ho'}; render();
}
function setHo(k,v){
  if(!S.ho) return;
  S.ho[k] = k==='amount' ? Math.max(0,parseInt(String(v).replace(/\D/g,''))||0) : v;
  render();
}
function takeHo(){
  const K = S.ho; if(!K) return;
  const amount = Math.round(K.amount)||0;
  if(amount<=0) return toast('Сумма возврата должна быть больше нуля.');
  if(!isDemo()){
    S.ho = null;
    return apiTakeHandover(K.staff,K.period,amount,K.at,(K.note||'').trim());
  }
  S.handovers.push({id:'H'+(++S.seq),staff:K.staff,at:K.at,period:K.period,amount,by:S.me,note:(K.note||'').trim()});
  const R = subReport(K.staff,K.period);
  S.modal = null; S.ho = null;
  toast(`${nameOf(K.staff)}: принято ${money(amount)} от ${ru(K.at)}. Остаток подотчёта — ${R.left<0?'−'+money(-R.left):money(R.left)}.`);
}
function hoModal(){
  const K = S.ho; if(!K){ S.modal=null; return ''; }
  const R = subReport(K.staff,K.period);
  const after = R.left - (K.amount||0);
  return `<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="width:min(620px,94vw)">
      <div class="mhd"><h3>Принять возврат подотчёта</h3>
        <span class="note">${esc(nameOf(K.staff))} · ${MN[+K.period.slice(5)-1]} ${K.period.slice(0,4)}</span>
        <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>
      <p class="cap">Поверитель привёз наличные и переводы, собранные на адресах, за вычетом своей сдельной оплаты.
        Принято ${money(R.got)} · начислено ${money(R.wage)}${R.given?` · уже сдано ${money(R.given)}`:''} · остаток <b style="color:var(--ink)">${money(R.left)}</b>.</p>
      <div class="row" style="flex-wrap:nowrap;align-items:flex-end">
        <div class="f" style="width:170px;margin-bottom:0"><label>Сумма, ₽</label>
          <input class="fld mono" id="hoAmt" value="${K.amount}" oninput="setHo('amount',this.value)"></div>
        <div class="f" style="width:170px;margin-bottom:0"><label>Дата приёмки</label>${DATE('hoDate',K.at,v=>{S.ho.at=v;})}</div>
        <div class="f" style="flex:1;margin-bottom:0"><label>Примечание</label>
          <input class="fld" id="hoNote" value="${esc(K.note)}" oninput="S.ho.note=this.value" placeholder="например: остальное довезёт в пятницу"></div>
      </div>
      <p class="note" style="margin-top:10px">После подтверждения остаток станет
        <b style="color:var(--ink)">${after<0?'−'+money(-after):money(after)}</b>, запись уйдёт в историю сдач.</p>
      <div class="row" style="margin-top:12px;justify-content:flex-end">
        <button class="g" onclick="closeModal()">Отмена</button>
        <button class="b" onclick="takeHo()">Принять ${money(K.amount||0)}</button></div>
    </div></div>`;
}

export { hoModal, mMonth, openHo, setHo, subCard, subTable, takeHo, unpaidCard, viewMe, viewPayroll };
