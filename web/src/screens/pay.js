/* Эквайринг (пункт int-pay): QR и ссылка на экране поверителя, сверка за день
   и возвраты у руководителя.

   Сумму платежа задаёт сервер по акту — поверитель её не вводит. Отметку
   «оплачено» ставит уведомление провайдера, а не рука на телефоне: пока его
   нет, платёж «ждёт», и на экране это видно. Чек пробивает онлайн-касса и
   отправляет клиенту сама; номер чека приезжает в заявку.

   В демо-режиме провайдера нет: QR рисуется заглушкой, «оплата» — кнопкой. */

import { S, nameOf } from '../state.js';
import { API_BASE, isDemo } from '../api/mode.js';
import { I, svg } from '../ui/icons.js';
import { DATE } from '../ui/controls.js';
import { TODAY, esc, money, ru } from '../util.js';
import { render, toast } from '../ui/render.js';
import { addrOf, onlineKindOf, payInit, priceOf } from '../rules.js';
import { cancelOnline as apiCancel, createOnline as apiCreate, refundOnline as apiRefund,
  retryReceipt as apiRetryReceipt, syncOnline as apiSync } from '../api/actions.js';
import { loadAcq, reload } from '../api/load.js';

const KIND_NAME = { qr: 'СБП по QR', link: 'платёжная ссылка' };
const STATE_TAG = {
  'создан': 't-mut', 'ожидает': 't-warn', 'оплачен': 't-ok', 'отменён': 't-mut', 'возвращён': 't-cold', 'ошибка': 't-err',
};
const stateTag = s => `<span class="tg ${STATE_TAG[s]||'t-mut'}">${esc(s)}</span>`;

/* ---------- поверитель: показать QR или ссылку ---------- */

/* Открыть платёж по заявке: создать у провайдера (или взять действующий) и
   показать клиенту. Сервер сам отдаёт тот же платёж на повторное нажатие. */
async function openPay(rid){
  const r = S.requests.find(x=>x.id===rid); if(!r) return;
  const p = payInit(r);
  const kind = onlineKindOf(p.method); if(!kind) return;
  if(isDemo()){
    /* Демо: провайдера нет, платёж рисуется на месте, «оплата» — кнопкой. */
    r.online = r.online && r.online.kind===kind && r.online.status!=='отменён' ? r.online
      : {id:++S.seq, kind, amount:priceOf(r), status:'ожидает', confirmation: kind==='qr'
          ? `https://qr.nspk.ru/DEMO${S.seq}?type=02&sum=${priceOf(r)*100}&cur=RUB` : `https://pay.example.org/demo/${S.seq}`,
        paidAt:null, receipt:'', receiptStatus:null, demo:true};
    S.pay = {rid, id:r.online.id};
    S.modal = {k:'qr'}; render();
    return;
  }
  const out = await apiCreate(rid, kind);
  if(!out) return;
  S.pay = {rid, id:out.payment.id};
  S.modal = {k:'qr'};
  startPoll();
  render();
}
/* Опрос состояния, пока окно открыто: уведомление провайдера приходит на сервер,
   а телефон о нём узнаёт только спросив. Раз в четыре секунды — достаточно. */
function startPoll(){
  stopPoll();
  S._payPoll = setInterval(()=>{ if(!S.pay || !S.modal || S.modal.k!=='qr') return stopPoll(); checkPay(false); }, 4000);
}
function stopPoll(){ if(S._payPoll){ clearInterval(S._payPoll); S._payPoll=null; } }
/* «Клиент говорит, что заплатил»: спросить провайдера напрямую. */
async function checkPay(loud=true){
  if(!S.pay) return;
  const r = S.requests.find(x=>x.id===S.pay.rid);
  if(isDemo()){
    if(!r || !r.online) return;
    if(loud) toast('Демо: провайдера нет — нажмите «Оплата прошла», чтобы увидеть, что происходит после оплаты.');
    return;
  }
  try{
    const { payment } = await apiSync(S.pay.id);
    const was = r && r.online ? r.online.status : null;
    await reload();
    if(payment.status==='оплачен'){
      stopPoll();
      if(was!=='оплачен') toast(`Оплата ${money(payment.paid_amount||payment.amount)} получена${payment.receipt_number?`, чек № ${payment.receipt_number} отправлен клиенту`:''}.`);
    } else if(loud) toast(payment.status==='ожидает' ? 'Провайдер оплату ещё не подтвердил — попросите клиента проверить приложение банка.'
      : `Платёж в состоянии «${payment.status}».`);
  }catch(err){ if(loud && !err?.offline) toast(err?.message||'Состояние платежа не прочиталось.'); }
}
/* Демо-оплата: то, что в рабочем режиме делает уведомление провайдера. */
function demoPaid(){
  const r = S.pay && S.requests.find(x=>x.id===S.pay.rid); if(!r || !r.online) return;
  const now = new Date();
  r.online.status='оплачен'; r.online.paidAt=`${TODAY} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  r.online.paidAmount=r.online.amount; r.online.receipt=String(1000+r.online.id); r.online.receiptStatus='зарегистрирован';
  const p = payInit(r); p.amount=r.online.amount; p.at=r.online.paidAt; p.receipt=r.online.receipt;
  toast(`Демо: оплата ${money(r.online.amount)} получена, чек № ${r.online.receipt} «отправлен» клиенту.`);
  render();
}
function closePay(){ stopPoll(); S.pay=null; S.modal=null; render(); }
function copyLink(){
  const r = S.pay && S.requests.find(x=>x.id===S.pay.rid); const o = r && r.online; if(!o) return;
  (navigator.clipboard?.writeText(o.confirmation) || Promise.reject()).then(()=>toast('Ссылка скопирована — отправьте клиенту в мессенджер.'),
    ()=>toast('Скопируйте ссылку вручную: она выделена в окне.'));
}
/* Окно с QR или ссылкой. Картинку QR рисует сервер (SVG) — телефону остаётся показать. */
function qrModal(){
  const r = S.pay && S.requests.find(x=>x.id===S.pay.rid);
  const o = r && r.online;
  if(!r || !o){ S.modal=null; S.pay=null; return ''; }
  const paid = o.status==='оплачен';
  const src = isDemo() ? '' : `${API_BASE}/online-payments/${o.id}/qr.svg`;
  return `<div class="mask" onclick="if(event.target===this)closePay()">
    <div class="modal" style="width:min(520px,94vw)">
      <div class="mhd"><h3>${o.kind==='qr'?'Оплата по QR СБП':'Платёжная ссылка'}</h3>
        <span class="note">${r.id} · ${esc(addrOf(r))}</span>
        <button class="ib" onclick="closePay()">${svg(I.no,15)}</button></div>
      <div class="qrbox ${paid?'paid':''}">
        ${o.kind==='qr'
          ? (isDemo() ? `<div class="qrdemo">QR<br><small>демо</small></div>` : `<img src="${src}" alt="QR-код для оплаты ${money(o.amount)}">`)
          : `<div class="qrlink"><a href="${esc(o.confirmation)}" target="_blank" rel="noopener">${esc(o.confirmation)}</a></div>`}
        <div class="qrsum">${money(o.amount)}</div>
        <div class="qrstate">${paid
          ? `<span class="tg t-ok">оплачено${o.paidAt?' · '+esc(o.paidAt.slice(11)):''}</span>
             ${o.receipt?`<span class="tg t-mut">чек № ${esc(o.receipt)}</span>`:o.receiptStatus==='ошибка'?'<span class="tg t-err">чек не пробит</span>':'<span class="tg t-mut">чек пробивается</span>'}`
          : `<span class="tg t-warn">ждёт оплаты</span>`}</div>
      </div>
      <p class="cap">${o.kind==='qr'
        ? 'Клиент открывает приложение своего банка, сканирует код и подтверждает платёж. Деньги приходят на счёт компании, чек уходит клиенту на почту, отметка «оплачено» появится здесь сама.'
        : 'Отправьте ссылку клиенту в мессенджер или откройте у него на телефоне: оплата картой или через СБП на странице провайдера. Клиент может заплатить и после вашего ухода — отметка появится в заявке.'}
        ${r.email?'':' У клиента нет почты в заявке — чек уйдёт по номеру телефона.'}</p>
      <div class="row" style="margin-top:12px;justify-content:flex-end">
        ${o.kind==='link' && !paid ? `<button class="g" onclick="copyLink()">Копировать ссылку</button>`:''}
        ${!paid ? (isDemo() ? `<button class="g" onclick="demoPaid()">Оплата прошла (демо)</button>` : `<button class="g" onclick="checkPay()">Проверить оплату</button>`) : ''}
        <button class="${paid?'b':'g'}" onclick="closePay()">${paid?'Готово':'Закрыть'}</button></div>
    </div></div>`;
}
/* Строка состояния безнала в блоке оплаты акта: что показано клиенту и что с этим стало. */
function onlineLine(r){
  const o = r.online; if(!o) return '';
  if(o.status==='оплачен') return `<span class="tg t-ok">оплачено ${money(o.paidAmount||o.amount)}${o.paidAt?' · '+esc(o.paidAt.slice(11)):''}</span>
    ${o.receipt?`<span class="tg t-mut" title="Номер кассового чека — отправлен клиенту">чек № ${esc(o.receipt)}</span>`
      :o.receiptStatus==='ошибка'?`<span class="tg t-err" title="${esc(o.error||'')}">чек не пробит — руководитель повторит</span>`:'<span class="tg t-mut">чек пробивается</span>'}
    ${o.mismatch?'<span class="tg t-err" title="Оплаченная сумма не совпала с актом — видно руководителю в сверке">сумма разошлась</span>':''}`;
  if(o.status==='возвращён') return `<span class="tg t-cold">возврат ${money(o.refundAmount||o.amount)}</span>`;
  if(o.status==='ожидает' || o.status==='создан') return `<span class="tg t-warn">${KIND_NAME[o.kind]} на ${money(o.amount)} · ждёт оплаты</span>`;
  return '';
}

/* ---------- руководитель: сверка за день, возврат, отмена ---------- */

function setAcqDay(v){ S.acqDay=v; if(isDemo()) return render(); loadAcq().then(render); }
/* Демо: сверка собирается из заявок во вкладке. */
function demoAcq(){
  const list = S.requests.filter(r=>r.online && r.pay && (r.online.paidAt||'').slice(0,10)===S.acqDay)
    .map(r=>({id:r.online.id, request_id:r.id, kind:r.online.kind, amount:r.online.amount, paid_amount:r.online.paidAmount,
      status:r.online.status, paid_at:r.online.paidAt, receipt_number:r.online.receipt, receipt_status:r.online.receiptStatus,
      refund_amount:r.online.refundAmount, refund_reason:r.online.refundReason, mismatch:r.online.mismatch, error:'',
      name:r.name, street:r.street, house:r.house, flat:r.flat, created_by_name:nameOf(r.verifier)}));
  const sum = (st,f) => list.filter(p=>p.status===st).reduce((a,p)=>a+(p[f]||0),0);
  return {payments:list, totals:{paid:sum('оплачен','paid_amount'), refunded:sum('возвращён','refund_amount'), pending:sum('ожидает','amount'),
    n_paid:list.filter(p=>p.status==='оплачен').length, n_receipts:list.filter(p=>p.receipt_status==='зарегистрирован').length,
    n_mismatch:list.filter(p=>p.mismatch).length}};
}
/* Карточка на экране «Сдельная оплата»: безнал по эквайрингу отдельно от подотчёта —
   эти деньги пришли на счёт компании, поверитель их в руках не держал. */
function acqCard(){
  const enabled = isDemo() || (S.payCfg && S.payCfg.enabled);
  const A = isDemo() ? demoAcq() : S.acq;
  const day = S.acqDay || TODAY;
  const T = A ? A.totals : {paid:0,refunded:0,pending:0,n_paid:0,n_receipts:0,n_mismatch:0};
  const list = A ? A.payments : [];
  const time = v => v ? esc(String(v).replace('T',' ').slice(11,16)) : '—';
  return `<div class="c"><h3>Безнал по эквайрингу · сверка за день</h3>
    <p class="cap">Оплаты по QR СБП и по ссылке приходят на расчётный счёт компании и в подотчёт поверителей не попадают.
      Здесь — что пришло за день, по каким заявкам и с какими чеками; выгрузка — бухгалтеру для сверки с выпиской банка.
      Возврат и отмена — только отсюда, с записью в журнал.${enabled?'':' <b>Эквайринг к этому контуру не подключён</b> — ключи провайдера ещё не заведены.'}</p>
    <div class="row" style="align-items:flex-end;margin-bottom:12px">
      <div class="f" style="width:170px;margin-bottom:0"><label>День</label>${DATE('acqDay',day,v=>setAcqDay(v))}</div>
      <button class="g sm" onclick="setAcqDay('${TODAY}')">Сегодня</button>
      <div style="flex:1"></div>
      ${isDemo()?'':`<a class="g sm" href="${API_BASE}/online-payments/export.csv?date=${day}" download>${svg(I.down||I.right,12)}Выгрузка для бухгалтера (CSV)</a>`}
    </div>
    <div class="kpi" style="margin-bottom:12px">
      <div><div class="v">${money(T.paid)}</div><div class="k">оплачено · ${T.n_paid}</div></div>
      <div><div class="v">${T.n_receipts}</div><div class="k">чеков зарегистрировано</div></div>
      <div><div class="v" ${T.pending?'style="color:var(--warning)"':''}>${money(T.pending)}</div><div class="k">ждёт оплаты</div></div>
      <div><div class="v" ${T.refunded?'style="color:var(--cold)"':''}>${money(T.refunded)}</div><div class="k">возвращено</div></div>
      <div><div class="v" ${T.n_mismatch?'style="color:var(--error)"':''}>${T.n_mismatch}</div><div class="k">расхождений с актом</div></div>
    </div>
    ${list.length?`<table><thead><tr><th class="num">Время</th><th>Заявка</th><th>Адрес</th><th>Клиент</th><th>Способ</th>
      <th class="num">Акт</th><th class="num">Оплачено</th><th>Состояние</th><th>Чек</th><th>Поверитель</th><th></th></tr></thead><tbody>
      ${list.map(p=>`<tr><td class="num mono">${time(p.paid_at)}</td><td class="mono">${esc(p.request_id)}</td>
        <td><b>${esc(p.street)}, ${esc(p.house)}${p.flat?', кв. '+esc(p.flat):''}</b></td><td>${esc(p.name)}</td>
        <td>${KIND_NAME[p.kind]||p.kind}</td><td class="num">${money(p.amount)}</td>
        <td class="num">${p.paid_amount!=null?`<b>${money(p.paid_amount)}</b>`:'—'}${p.mismatch?' <span class="tg t-err" title="Сумма платежа не совпала с актом">≠</span>':''}</td>
        <td>${stateTag(p.status)}${p.status==='возвращён'&&p.refund_reason?`<div class="note">${esc(p.refund_reason)}</div>`:''}${p.error&&p.status!=='возвращён'&&p.status!=='отменён'?`<div class="note" style="color:var(--error)">${esc(p.error)}</div>`:''}</td>
        <td class="mono">${p.receipt_number?`№ ${esc(p.receipt_number)}`:p.receipt_status==='ошибка'?'<span class="tg t-err">не пробит</span>':p.status==='оплачен'?'<span class="note">пробивается</span>':'—'}</td>
        <td class="note">${esc(p.created_by_name||'—')}</td>
        <td style="text-align:right;white-space:nowrap">
          ${p.status==='оплачен'?`<button class="g sm" onclick="openRefund(${p.id})">Возврат</button>`:''}
          ${p.status==='оплачен'&&p.receipt_status!=='зарегистрирован'&&!isDemo()?` <button class="g sm" onclick="retryReceiptUi(${p.id})">Чек повторно</button>`:''}
          ${p.status==='ожидает'||p.status==='создан'?`<button class="g sm" onclick="cancelAcq(${p.id})">Отменить</button>`:''}
        </td></tr>`).join('')}</tbody></table>`
      :`<div class="empty">За ${ru(day)} безналичных оплат нет.</div>`}</div>`;
}
function cancelAcq(id){
  if(isDemo()){ const r=S.requests.find(x=>x.online&&x.online.id===id); if(r){ r.online.status='отменён'; if(r.pay&&!r.pay.at){ r.pay.method='не оплачено'; r.pay.amount=0; } }
    return render(); }
  apiCancel(id).then(()=>loadAcq().then(render));
}
function retryReceiptUi(id){ apiRetryReceipt(id).then(()=>loadAcq().then(render)); }
function openRefund(id){ S.refund={id,reason:''}; S.modal={k:'refund'}; render(); }
function doRefund(){
  const K = S.refund; if(!K) return;
  const reason = (K.reason||'').trim();
  if(!reason) return toast('Укажите причину возврата — она попадёт в журнал и в чек возврата.');
  if(isDemo()){
    const r=S.requests.find(x=>x.online&&x.online.id===K.id);
    if(r){ r.online.status='возвращён'; r.online.refundAmount=r.online.paidAmount||r.online.amount; r.online.refundReason=reason;
      if(r.pay){ r.pay.method='не оплачено'; r.pay.amount=0; r.pay.at=null; r.pay.note=`возврат по эквайрингу: ${reason}`; } }
    S.refund=null; S.modal=null; toast('Демо: возврат проведён, чек возврата «отправлен» клиенту.'); return render();
  }
  apiRefund(K.id, reason).then(()=>{ S.refund=null; loadAcq().then(render); });
}
function refundModal(){
  const K = S.refund; if(!K){ S.modal=null; return ''; }
  const A = isDemo() ? demoAcq() : S.acq;
  const p = A && A.payments.find(x=>x.id===K.id);
  if(!p){ S.modal=null; S.refund=null; return ''; }
  return `<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="width:min(560px,94vw)">
      <div class="mhd"><h3>Возврат оплаты</h3>
        <span class="note">${esc(p.request_id)} · ${esc(p.name)} · ${money(p.paid_amount||p.amount)}</span>
        <button class="ib" onclick="closeModal()">${svg(I.no,15)}</button></div>
      <p class="cap">Деньги уйдут на тот же счёт, с которого платил клиент; касса пробьёт чек возврата и отправит его клиенту.
        Заявка станет «не оплачено» с причиной, действие попадёт в журнал.</p>
      <div class="f"><label>Причина · обязательно</label>
        <textarea class="fld" id="refundReason" placeholder="например: услуга не оказана — прибор не подлежит поверке"
          oninput="S.refund.reason=this.value">${esc(K.reason)}</textarea></div>
      <div class="row" style="margin-top:4px;justify-content:flex-end">
        <button class="g" onclick="closeModal()">Отмена</button>
        <button class="b" onclick="doRefund()">Вернуть ${money(p.paid_amount||p.amount)}</button></div>
    </div></div>`;
}

export { acqCard, cancelAcq, checkPay, closePay, copyLink, demoPaid, doRefund, onlineLine, openPay, openRefund, qrModal, refundModal, retryReceiptUi, setAcqDay };
