/* ФГИС «Аршин»: очередь передачи сведений о поверке (пункт int-arshin).
 *
 * Экран руководителя, и только его: передача сведений в Федеральный
 * информационный фонд лежит на аккредитованном лице, отвечает за неё оно.
 *
 * Смысл экрана в одной фразе: поверка, о которой не передали сведения, не имеет
 * юридической силы — значит, деньги с клиента взяты ни за что. Поэтому здесь на
 * первом месте не список, а счётчики просрочки, и красная полоса появляется
 * раньше, чем срок наступил, а не после.
 *
 * Сроки, по которым считается просрочка, — не наша выдумка: 40 рабочих дней с
 * даты поверки на передачу (пункт 21 приказа Минпромторга России № 2510) и
 * 5 рабочих дней на ответ реестра (пункт 30 приказа № 2906). Оба числа приходят
 * с сервера вместе с очередью, чтобы правка закона не требовала правки фронта.
 * Разбор — docs/arshin.md.
 */

import { S } from '../state.js';
import { DATE, SEL } from '../ui/controls.js';
import { esc, ru } from '../util.js';
import { cap, shell } from '../ui/shell.js';
import { render, toast } from '../ui/render.js';
import { isDemo, API_BASE } from '../api/mode.js';
import { reload } from '../api/load.js';
import { api } from '../api/client.js';

const STATUSES = ['готово', 'передано', 'принято', 'ошибка'];
/* Цвет статуса — тот же язык, что на остальных экранах: серое ждёт, синее в
   пути, зелёное готово, красное требует человека. */
const TAG = {'готово':'t-mut','передано':'t-cold','принято':'t-ok','ошибка':'t-err'};

/* ---------- отбор ---------- */
const blankArshin = () => ({status:'',from:'',to:'',q:''});
function arshinSet(k,v){
  S.arshinF = {...(S.arshinF||blankArshin()), [k]: v===undefined||v===null?'':String(v)};
  if(!isDemo()) return reload();
  render();
}
function arshinReset(){ S.arshinF = blankArshin(); if(!isDemo()) return reload(); render(); }

/* Отбор применяется и здесь, на пришедших строках: в рабочем режиме его уже
   посчитал сервер, а в демо считать некому. */
function arshinRows(){
  const F = S.arshinF || (S.arshinF = blankArshin());
  const hay = r => `${r.serial||''} ${r.request_id||''} ${r.fgis_number||''} ${r.mi_name||''}`.toLowerCase();
  return (S.arshin||[]).filter(r =>
    (!F.status || r.status===F.status) &&
    (!F.from || r.verified_on>=F.from) &&
    (!F.to || r.verified_on<=F.to) &&
    (!F.q || hay(r).includes(F.q.toLowerCase())));
}

/** Сводка приходит с сервера по всей очереди, а не по показанному куску:
 *  руководителю важно, сколько просрочено вообще. В демо её считаем сами. */
function arshinSum(){
  if(!isDemo() && S.arshinSum) return S.arshinSum;
  const all = S.arshin||[];
  const today = new Date().toISOString().slice(0,10);
  const n = f => all.filter(f).length;
  const waiting = r => r.status==='готово'||r.status==='ошибка';
  return {
    ready:n(r=>r.status==='готово'), sent:n(r=>r.status==='передано'),
    accepted:n(r=>r.status==='принято'), failed:n(r=>r.status==='ошибка'),
    overdue:n(r=>waiting(r) && r.due_date<today),
    soon:n(r=>waiting(r) && r.due_date>=today),
    silent:0};
}

/* ---------- действия ---------- */

/* Выгрузка. В файловом канале XML приходит в ответе и тут же уходит в файл:
   руководитель несёт его в личный кабинет и подписывает там УКЭП (пункт 24
   приказа № 2906 — подписать за него система не может). В канале по API
   выгрузка уезжает в реестр сама, и скачивать нечего. */
async function arshinSend(){
  if(isDemo()) return toast('Демо-режим: выгрузка собирается на сервере, здесь её нет.');
  try{
    const out = await api.post('/arshin/batches', {});
    if(out.xml) saveFile(out.file_name, out.xml);
    await reload();
    toast(out.xml
      ? `Выгрузка ${out.batch_id}: записей ${out.records}. Файл сохранён — загрузите его в личном кабинете и подпишите там.`
      : `Выгрузка ${out.batch_id} ушла в реестр: принято ${out.accepted||0}, с ошибкой ${out.failed||0}.`);
  }catch(err){
    if(!err?.offline) toast(err?.message || 'Выгрузку собрать не удалось.');
  }
}

/* Выгрузка за период — отчёт, а не передача: статусы она не трогает. */
function arshinExport(){
  const F = S.arshinF || blankArshin();
  if(!F.from || !F.to) return toast('Для выгрузки за период задайте обе даты — с и по.');
  if(isDemo()) return toast('Демо-режим: файл собирает сервер.');
  location.href = `${API_BASE}/arshin/export.xml?from=${F.from}&to=${F.to}`;
  toast('Выгрузка за период пошла в файл. Статусы записей она не меняет.');
}

/** Ответ кабинета по одной записи: номер, который вернул реестр. Тот же путь,
 *  что у ответа по API, — только вносит его человек, прочитав кабинет. */
async function arshinAccept(recId, batchId){
  const number = (prompt('Номер записи в реестре, который вернул «Аршин»:') || '').trim();
  if(!number) return;
  if(isDemo()) return toast('Демо-режим: номер записи приходит от реестра.');
  try{
    await api.post(`/arshin/batches/${batchId}/result`, {accepted:[{source_id:String(recId), number}]});
    await reload();
    toast(`Запись принята реестром: ${number}. Номер ушёл в прибор и попадёт в свидетельство.`);
  }catch(err){ if(!err?.offline) toast(err?.message || 'Номер внести не удалось.'); }
}

/** Кабинет вернул запись с ошибкой: текст отказа руководитель переносит сюда,
 *  чтобы он лежал рядом с записью, а не в переписке. */
async function arshinReject(recId, batchId){
  const text = (prompt('Что ответил реестр — текст ошибки:') || '').trim();
  if(!text) return;
  if(isDemo()) return toast('Демо-режим: ответ реестра приходит с сервера.');
  try{
    await api.post(`/arshin/batches/${batchId}/result`, {failed:[{source_id:String(recId), error:text}]});
    await reload();
    toast('Ошибка записана. Исправьте акт или справочник и отправьте повторно.');
  }catch(err){ if(!err?.offline) toast(err?.message || 'Ошибку внести не удалось.'); }
}

/* Повторная отправка не шлёт прежний снимок заново, а пересобирает запись из
   акта: пока она ждала, справочник могли дозаполнить. */
async function arshinRetry(recId){
  if(isDemo()) return toast('Демо-режим: повторную отправку делает сервер.');
  try{
    const out = await api.post(`/arshin/records/${recId}/retry`, {});
    await reload();
    toast(out?.problems?.length
      ? `Записи по-прежнему не хватает: ${out.problems.join(', ')}.`
      : 'Запись пересобрана из акта и вернулась в очередь.');
  }catch(err){ if(!err?.offline) toast(err?.message || 'Повторить отправку не удалось.'); }
}

function saveFile(name, text){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type:'application/xml;charset=utf-8'}));
  a.download = name || 'arshin.xml';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- экран ---------- */

const addr = r => [r.city, r.street && `${r.street}, ${r.house||''}`, r.flat && `кв. ${r.flat}`]
  .filter(Boolean).join(', ');

/** Срок с подсказкой: просрочено — красным, на подходе — жёлтым. Переданному и
 *  принятому срок уже не важен, там он справочный. */
function dueCell(r, today){
  const waiting = r.status==='готово' || r.status==='ошибка';
  if(!waiting) return `<span class="note mono">${ru(r.due_date)}</span>`;
  const late = r.due_date < today;
  return `<span class="mono" ${late?'style="color:var(--error);font-weight:600"':''}
    title="Крайний срок передачи сведений">${ru(r.due_date)}${late?' · просрочено':''}</span>`;
}

function viewArshin(){
  const F = S.arshinF || (S.arshinF = blankArshin());
  const rows = arshinRows();
  const sum = arshinSum();
  const total = isDemo() ? rows.length : (S.arshinTotal ?? rows.length);
  const today = new Date().toISOString().slice(0,10);
  const channel = S.arshinCh || 'файл';
  const dueDays = S.arshinDue ?? 40;
  const answerDays = S.arshinAnswer ?? 5;
  const code = S.arshinCode || '';

  /* Полоса напоминания. Их три, и порядок не случаен: просрочка важнее
     подходящего срока, а тот важнее молчания реестра. */
  const alarms = [];
  if(sum.overdue) alarms.push(`<div class="warn err"><b>Просрочено записей: ${sum.overdue}.</b>
    Срок передачи — ${dueDays} рабочих дней с даты поверки (пункт 21 приказа № 2510).
    Пока сведения не в реестре, эти поверки юридической силы не имеют.</div>`);
  if(sum.soon) alarms.push(`<div class="warn">Подходит срок у ${sum.soon} записей.
    Соберите выгрузку, не дожидаясь последнего дня.</div>`);
  if(sum.silent) alarms.push(`<div class="warn">Реестр молчит по ${sum.silent} записям дольше
    ${answerDays} рабочих дней — оператор фонда обязан ответить быстрее (пункт 30 приказа № 2906).
    Загляните в личный кабинет.</div>`);
  if(!code) alarms.push(`<div class="warn err">Условный шифр организации не задан
    (<span class="mono">ARSHIN_ORG_CODE</span>). Без него реестр не примет ни одной записи —
    шифр присваивает Росстандарт, запросите его у заказчика.</div>`);

  return shell(null,`${cap()}
  ${alarms.join('')}
  <div class="kpi">
    <div><div class="v">${sum.ready}</div><div class="k">готовы к передаче</div></div>
    <div><div class="v">${sum.sent}</div><div class="k">переданы, ждут ответа</div></div>
    <div><div class="v">${sum.accepted}</div><div class="k">приняты реестром</div></div>
    <div><div class="v" ${sum.failed?'style="color:var(--error)"':''}>${sum.failed}</div>
      <div class="k">с ошибкой</div></div>
    <div><div class="v" ${sum.overdue?'style="color:var(--error)"':''}>${sum.overdue}</div>
      <div class="k">просрочено</div></div>
  </div>

  <div class="c"><h3>Передача сведений</h3>
    <p class="cap">Канал обмена: <b>${esc(channel)}</b>.
      ${channel==='файл'
        ? 'Система собирает файл, вы загружаете его в личном кабинете ФГИС и подписываете там усиленной квалифицированной подписью — подписать за вас система не может (пункт 24 приказа № 2906). Ответ кабинета внесите кнопками в строках.'
        : 'Выгрузка уходит в реестр сама, ответ раскладывается по записям.'}</p>
    <div class="row" style="align-items:center">
      <button class="b sm" onclick="arshinSend()" ${sum.ready?'':'disabled'}
        title="${sum.ready?'Собрать выгрузку из готовых записей':'Готовых к передаче записей нет'}">
        Собрать выгрузку${sum.ready?` · ${sum.ready}`:''}</button>
      <button class="g sm" onclick="arshinExport()">Выгрузить за период</button>
      <div style="flex:1"></div>
      <span class="note">Срок передачи — ${dueDays} рабочих дней с даты поверки.</span>
    </div>
  </div>

  <div class="c"><h3>Отбор</h3>
    <div class="row">
      <div class="f" style="width:170px"><label>Статус</label>
        ${SEL('ar-st',F.status,[{v:'',l:'Любой'},...STATUSES.map(s=>({v:s,l:s}))],v=>arshinSet('status',v))}</div>
      <div class="f" style="width:150px"><label>Поверка с</label>${DATE('ar-from',F.from,v=>arshinSet('from',v))}</div>
      <div class="f" style="width:150px"><label>по</label>${DATE('ar-to',F.to,v=>arshinSet('to',v))}</div>
      <div class="f" style="flex:1;min-width:190px"><label>Заводской номер, заявка или номер реестра</label>
        <input id="ar-q" class="fld mono" value="${esc(F.q)}" placeholder="41230001"
          onchange="arshinSet('q',this.value)"></div>
    </div>
    <div class="row" style="margin-top:2px;align-items:center">
      <button class="g sm" onclick="arshinReset()">Сбросить отбор</button>
      <div style="flex:1"></div>
      <span class="note">Показано ${rows.length} из ${total}.</span>
    </div>
  </div>

  <div class="c"><h3>Записи о поверке</h3>
    <p class="cap">Одна строка прибора в акте — одна запись, включая непригодные:
      отрицательный результат передаётся в фонд наравне с положительным.</p>
    ${rows.length?`<table class="audit"><thead><tr><th>Прибор</th><th>Заводской №</th>
      <th>Адрес</th><th>Поверка</th><th>Срок</th><th>Статус</th><th>Номер в реестре</th>
      <th>Что не так</th><th></th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td>${esc(r.mi_name||'')}${r.applicable?'':' <span class="tg t-err">не годен</span>'}
          <div class="note mono">${esc(r.request_id||'')}</div></td>
        <td class="mono">${esc(r.serial||'—')}</td>
        <td>${esc(addr(r))}</td>
        <td class="mono">${ru(r.verified_on)}</td>
        <td>${dueCell(r,today)}</td>
        <td><span class="tg ${TAG[r.status]||'t-mut'}">${esc(r.status)}</span></td>
        <td class="mono">${esc(r.fgis_number||'—')}</td>
        <td>${r.error_text?`<span style="color:var(--error)">${esc(r.error_text)}</span>`:'<span class="note">—</span>'}</td>
        <td style="white-space:nowrap">
          ${r.status==='передано'&&r.batch_id?`
            <button class="g sm" onclick="arshinAccept('${r.id}','${esc(r.batch_id)}')"
              title="Реестр принял запись — внести её номер">Номер</button>
            <button class="g sm" onclick="arshinReject('${r.id}','${esc(r.batch_id)}')"
              title="Реестр вернул запись — записать ошибку">Отказ</button>`:''}
          ${r.status==='ошибка'?`<button class="b sm" onclick="arshinRetry('${r.id}')"
            title="Пересобрать запись из акта и вернуть в очередь">Повторить</button>`:''}
        </td></tr>`).join('')}
    </tbody></table>`
    :'<div class="empty">По этому отбору записей нет.</div>'}</div>

  ${(S.arshinBatches||[]).length?`<div class="c"><h3>Выгрузки</h3>
    <p class="cap">Файл, который вы загружали в кабинет, скачивается заново — его можно приложить к отчёту.</p>
    <table class="audit"><thead><tr><th>Выгрузка</th><th>Когда</th><th>Канал</th>
      <th>Записей</th><th>Принято</th><th>С ошибкой</th><th>Состояние</th><th></th></tr></thead><tbody>
      ${S.arshinBatches.map(b=>`<tr>
        <td class="mono">${esc(b.id)}</td>
        <td class="mono">${ru(String(b.created_at).slice(0,10))}</td>
        <td>${esc(b.channel)}</td>
        <td class="mono">${b.records}</td>
        <td class="mono">${b.accepted||0}</td>
        <td class="mono">${b.failed||0}</td>
        <td><span class="tg ${b.status==='ошибка'?'t-err':b.status==='принята'?'t-ok':'t-cold'}">${esc(b.status)}</span>
          ${b.error_text?`<div class="note" style="color:var(--error)">${esc(b.error_text)}</div>`:''}</td>
        <td><a class="g sm" href="${API_BASE}/arshin/batches/${encodeURIComponent(b.id)}/file.xml">Файл</a></td>
      </tr>`).join('')}
    </tbody></table></div>`:''}`);
}

export { arshinAccept, arshinExport, arshinReject, arshinReset, arshinRetry, arshinRows,
  arshinSend, arshinSet, blankArshin, viewArshin };
