/* График смен. */

import { S, dayRec } from '../state.js';
import { TODAY, WD, addDays, esc, iso, pad, today } from '../util.js';
import { absentOn, onShift } from '../rules.js';
import { cap, shell } from '../ui/shell.js';

/* ---------- график ---------- */
function viewSchedule(){
  const days = Array.from({length:14},(_,i)=>iso(addDays(today,i)));
  const cnt = p => days.filter(ds=>onShift(p,ds)).length;
  return shell(null,`${cap()}<div class="c"><h3>Смены на две недели</h3>
    <table><thead><tr><th>Сотрудник</th><th>Роль</th><th class="num">Смен</th>
      ${days.map(ds=>{const d=new Date(ds+'T00:00:00');
        return `<th class="num" style="text-align:center;${ds===TODAY?'color:var(--cold)':''}">${pad(d.getDate())}<br>${WD[d.getDay()]}</th>`}).join('')}</tr></thead><tbody>
    ${S.staff.filter(p=>p.role!=='supervisor').map(p=>{
      const isV = p.role==='verifier', field = isV?'crew':'ops';
      return `<tr><td><b>${esc(p.name)}</b></td>
      <td><span class="tg t-mut">${isV?'поверитель':p.role==='senior'?'старший':'оператор'}</span></td>
      <td class="num mono">${cnt(p)}</td>
      ${days.map(ds=>{const ab=absentOn(p.id,ds), on=(dayRec(ds)?.[field]||[]).includes(p.id);
        return `<td style="text-align:center;padding:6px 2px;${ab?'':'cursor:pointer'}" ${ab?'':`onclick="tgDay('${ds}','${field}','${p.id}')"`}
          title="${ab?'согласованное отсутствие':on?'в смене — клик снимает':'выходной — клик ставит в смену'}">
          ${ab?'<b style="color:var(--error)">О</b>':on?'<span style="color:var(--cold)">●</span>':'<span style="color:var(--border)">·</span>'}</td>`}).join('')}
    </tr>`}).join('')}</tbody></table>
    <p class="note" style="margin-top:12px"><span style="color:var(--cold)">●</span> в смене · <b style="color:var(--error)">О</b> согласованное отсутствие · <span style="color:var(--border)">·</span> выходной.
      Это та же смена, что в планировании дня — правки видны в обоих местах.</p></div>`);
}

export { viewSchedule };
