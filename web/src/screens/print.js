/* Печатные формы: акт выполненных работ и свидетельство о поверке (пункт fe-forms).
 *
 * До запуска заказчик заполнял бланки от руки на адресе — оригинал оставался у
 * клиента, и печатать из системы было незачем. Теперь обе формы собираются из
 * закрытого акта поверителя. Печатная версия — отдельный слой поверх экрана:
 * на бумагу браузер отправляет только лист (@media print в styles.css), а сам
 * вызов — window.print(), там же сохраняется PDF.
 *
 * Своих бланков заказчик не прислал, поэтому форма типовая: реквизиты
 * исполнителя, клиент и адрес, номер акта (он же номер заявки), таблица
 * приборов, итог со скидкой пенсионеру и способом оплаты, подписи сторон.
 * Свидетельство выписывается на каждый прибор с результатом «годен»:
 * «действительно до» считается от даты поверки по межповерочному интервалу
 * типа прибора (DEV_TYPES.mpi), номер записи в реестре — из ответа
 * ФГИС «Аршин» (пункт int-arshin). Свидетельство о непригодности по-прежнему
 * заполняется на бумажном бланке заказчика — в CRM хранится только его номер.
 */

import { S, nameOf } from '../state.js';
import { DEV_TYPES, SVC, isCheck } from '../refs.js';
import { addrOf, discountOf, priceOf, priceOfDev } from '../rules.js';
import { esc, money, ru, ruLong } from '../util.js';
import { render, toast } from '../ui/render.js';
import { I, svg } from '../ui/icons.js';
import { fmtPhone } from '../ui/phone.js';

/* Реквизиты исполнителя — из карточки предприятия, присланной заказчиком.
   Адрес фактический: по нему работают в Асбесте, он же на бланках. */
const ORG = {
  name:'Индивидуальный предприниматель Бердинских Арина Андреевна',
  short:'ИП Бердинских А.А.',
  inn:'660309757337', ogrnip:'321665800085370',
  addr:'624260, Свердловская обл., г. Асбест, ул. Ленинградская, 1а, пом. 109',
  phones:'+7 992 009-51-00, +7 922 133-68-14',
  email:'Arina.Berdinskikh@yandex.ru'
};

/* ---------- расчёты ---------- */
/** Межповерочный интервал типа прибора в годах; в справочнике не задан — null. */
const mpiOf = type => { const t = DEV_TYPES.find(x=>x.v===type); return t && t.mpi>0 ? t.mpi : null; };
/** Дата плюс годы — тот же счёт, что у сервера в записи для «Аршина»
 *  (server/src/arshin/records.ts, addYears): поверка 29 февраля в невисокосном
 *  году упирается в последний день февраля, а не перескакивает на март. */
function addYears(from,years){
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear()+years);
  if(d.getUTCDate()!==Number(from.slice(8,10))) d.setUTCDate(0);
  return d.toISOString().slice(0,10);
}
/** «Действительно до» свидетельства: дата поверки плюс интервал типа прибора. */
const validTo = (date,type) => { const y = mpiOf(type); return y ? addYears(date,y) : null; };
const yearsRu = n => { const a=n%10, b=n%100; return `${n} ${a===1&&b!==11?'год':a>=2&&a<=4&&(b<10||b>=20)?'года':'лет'}`; };

/* Свидетельство положено только пригодному поверенному прибору: замене,
   монтажу и демонтажу поверять нечего, непригодному — отдельный бланк. */
const certDevs = r => (r.devices||[]).map((d,i)=>({d,i})).filter(({d})=>isCheck(d) && !d.bad);
/** Печатается закрытый акт: до закрытия результат и деньги ещё меняются. */
const canPrint = r => !!r && r.status==='выполнена' && (r.devices||[]).length>0;

/* ---------- открыть, напечатать, закрыть ---------- */
function openPrint(k,rid,i){
  const r = S.requests.find(x=>x.id===rid);
  if(!canPrint(r)) return toast('Печатная форма собирается по закрытому акту — сначала закройте позицию.');
  if(k==='cert'){
    const d = r.devices[i];
    if(!d || !isCheck(d) || d.bad) return toast('Свидетельство о поверке выписывается только на прибор с результатом «годен».');
  }
  S.print = {k, id:rid, i:k==='cert'?i:null};
  render();
}
function closePrint(){ S.print = null; render(); }
function printNow(){ window.print(); }

/** Кнопки печати у закрытого акта: сам акт и по свидетельству на каждый годный прибор. */
function printButtons(r){
  if(!canPrint(r)) return '';
  const certs = certDevs(r);
  return `<div class="prtb">
    <button class="g sm" onclick="openPrint('act','${r.id}')" title="Печатная версия акта выполненных работ">${svg(I.print,12)}Печать акта</button>
    ${certs.map(({d,i})=>`<button class="g sm" onclick="openPrint('cert','${r.id}',${i})"
      title="Свидетельство о поверке · ${esc(d.type)}${d.serial?' № '+esc(d.serial):''}">${svg(I.act,12)}Свидетельство${certs.length>1?` · ${esc(d.serial||'прибор '+(i+1))}`:''}</button>`).join('')}
  </div>`;
}

/* ---------- листы ---------- */
const clientLine = r => r.clientType==='Юрлицо'
  ? `${esc(r.name)}${r.inn?', ИНН '+esc(r.inn):''}${r.contact?' · представитель '+esc(r.contact):''}`
  : esc(r.name);
const fullAddr = r => `${esc(r.city)}, ${esc(addrOf(r))}`;
const resultOf = d => !isCheck(d) ? 'выполнено' : d.bad ? 'не годен' : 'годен';
const unitOf = d => d.carrier==='Тепло' ? 'Гкал' : 'м³';
const whoOf = r => r.verifier ? nameOf(r.verifier) : '';
const orgHead = () => `<div class="org">
  <div><b>${esc(ORG.name)}</b><br>ИНН ${ORG.inn} · ОГРНИП ${ORG.ogrnip}</div>
  <div class="r">${esc(ORG.addr)}<br>${esc(ORG.phones)} · ${esc(ORG.email)}</div></div>`;
const sigBlock = (r,left) => `<div class="sig">
  <div><b>Исполнитель</b><span>${left}</span><i>подпись</i></div>
  <div><b>Заказчик</b><span>${esc(r.name)}</span><i>подпись</i></div></div>`;

/** Акт выполненных работ: номер — номер заявки, дата — дата выезда. */
function actSheet(r){
  const devs = r.devices||[];
  const total = priceOf(r), disc = discountOf(r);
  const p = r.pay;
  const payLine = !p || p.method==='не оплачено' ? 'не оплачено' : `${p.method} · ${money(p.amount)}`;
  const who = whoOf(r);
  return `<div class="sheet act">
    ${orgHead()}
    <h1>Акт выполненных работ № ${esc(r.id)}</h1>
    <div class="sub">от ${ruLong(r.date)}</div>
    <div class="kv">
      <b>Заказчик</b><span>${clientLine(r)}</span>
      <b>Телефон</b><span>${esc(fmtPhone(r.phone))}</span>
      <b>Адрес работ</b><span>${fullAddr(r)}</span>
      <b>Исполнитель</b><span>${esc(ORG.name)}, ИНН ${ORG.inn}</span>
    </div>
    <table>
      <thead><tr><th>№</th><th>Прибор</th><th>Заводской №</th><th>Показания</th><th>Место</th><th>Услуга</th><th>Результат</th><th class="n">Цена, ₽</th></tr></thead>
      <tbody>${devs.map((d,i)=>`<tr>
        <td>${i+1}</td>
        <td>${esc(d.type)}${d.grsi?`<div class="dim">ГРСИ ${esc(d.grsi)}</div>`:''}${d.carrier?`<div class="dim">${esc(d.carrier)}</div>`:''}</td>
        <td class="mono">${esc(d.serial||'—')}</td>
        <td class="mono">${d.reading?esc(d.reading)+' '+unitOf(d):'—'}</td>
        <td>${esc(d.room||'—')}</td>
        <td>${esc(SVC[d.svc]?.name||d.svc||'—')}${d.pens?'<div class="dim">пенсионер</div>':''}</td>
        <td>${resultOf(d)}${d.bad&&d.badWhy?`<div class="dim">${esc(d.badWhy)}${d.badNote?': '+esc(d.badNote):''}</div>`:''}</td>
        <td class="n mono">${priceOfDev(r,d).toLocaleString('ru-RU')}</td></tr>`).join('')}</tbody>
    </table>
    <div class="tot">
      ${disc?`<span>Стоимость по прайсу</span><b class="mono">${money(total+disc)}</b>
      <span>Скидка пенсионеру, за счёт исполнителя</span><b class="mono">− ${money(disc)}</b>`:''}
      <span>Итого к оплате</span><b class="mono big">${money(total)}</b>
      <span>Оплата</span><b>${esc(payLine)}</b>
    </div>
    <p class="txt">Работы выполнены в полном объёме. Заказчик претензий по объёму, качеству и срокам оказания услуг не имеет.
      Сведения о результатах поверки передаются в ФГИС «Аршин»; на каждый прибор с результатом «годен» выдаётся свидетельство о поверке.</p>
    ${sigBlock(r, who?`${esc(who)}, поверитель`:'поверитель')}
    <div class="foot">${esc(ORG.short)} · ${esc(ORG.addr)} · ${esc(ORG.phones)} · ${esc(ORG.email)}</div>
  </div>`;
}

/** Свидетельство о поверке на один прибор: номер — запись в реестре «Аршина»,
 *  пока её нет — внутренний «заявка-строка». */
function certSheet(r,d,i){
  if(!d) return '';
  const till = validTo(r.date,d.type), years = mpiOf(d.type);
  const num = d.arshin || `${r.id}-${i+1}`;
  const who = whoOf(r);
  return `<div class="sheet cert">
    ${orgHead()}
    <h1>Свидетельство о поверке</h1>
    <div class="sub">№ ${esc(num)}${d.arshin?'':' · внутренний номер, запись в реестре ещё не присвоена'} · ${ruLong(r.date)}</div>
    <div class="kv">
      <b>Средство измерений</b><span>${esc(d.type)}${d.carrier?` · ${esc(d.carrier)}`:''}</span>
      <b>Номер в ГРСИ</b><span class="mono">${esc(d.grsi||'—')}</span>
      <b>Заводской номер</b><span class="mono">${esc(d.serial||'—')}</span>
      <b>Место установки</b><span>${fullAddr(r)}${d.room?', '+esc(d.room.toLowerCase()):''}</span>
      <b>Показания при поверке</b><span class="mono">${d.reading?esc(d.reading)+' '+unitOf(d):'—'}</span>
      <b>Владелец</b><span>${clientLine(r)}</span>
      <b>Результат поверки</b><span>пригоден к применению</span>
      <b>Дата поверки</b><span class="mono">${ru(r.date)}</span>
      <b>Действительно до</b><span class="mono till">${till?ru(till):'—'}</span>
      <b>Межповерочный интервал</b><span>${years?yearsRu(years):'в справочнике типов приборов не задан'}</span>
      <b>Запись во ФГИС «Аршин»</b><span class="mono arshin">${d.arshin?esc(d.arshin):'номер записи будет присвоен после приёма сведений реестром'}</span>
      <b>Поверитель</b><span>${who?esc(who):'—'}</span>
    </div>
    <p class="txt">Поверка выполнена по методике, указанной в описании типа средства измерений. Сведения о результатах
      передаются в Федеральный информационный фонд по обеспечению единства измерений (ФГИС «Аршин»); юридическую силу
      имеет запись в реестре, номер которой указан выше.</p>
    ${sigBlock(r, who?`${esc(who)}, поверитель`:'поверитель')}
    <div class="foot">${esc(ORG.short)} · ${esc(ORG.addr)} · ${esc(ORG.phones)} · ${esc(ORG.email)}</div>
  </div>`;
}

/* ---------- слой ---------- */
function printLayer(){
  const P = S.print; if(!P) return '';
  const r = S.requests.find(x=>x.id===P.id);
  if(!canPrint(r)){ S.print = null; return ''; }
  const cert = P.k==='cert';
  const sheet = cert ? certSheet(r, r.devices[P.i], P.i) : actSheet(r);
  if(!sheet){ S.print = null; return ''; }
  return `<div class="prt" onclick="if(event.target===this)closePrint()">
    <div class="bar">
      <span>${cert?'Свидетельство о поверке':'Акт выполненных работ'} · ${esc(r.id)} · один лист А4. Кнопка откроет печать браузера — там же сохраняется PDF.</span>
      <button class="b sm" onclick="printNow()">${svg(I.print,12)}Печать</button>
      <button class="g sm" onclick="closePrint()">Закрыть</button>
    </div>
    ${sheet}
  </div>`;
}

export { ORG, addYears, canPrint, certDevs, closePrint, mpiOf, openPrint, printButtons, printLayer, printNow, validTo };
