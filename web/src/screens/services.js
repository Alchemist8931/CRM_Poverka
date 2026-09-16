/* Услуги и ставки. */

import { S } from '../state.js';
import { SERVICES } from '../refs.js';
import { TODAY, addDays, esc, iso, today } from '../util.js';
import { absentOn, onShift, skillsOf } from '../rules.js';
import { cap, shell } from '../ui/shell.js';
import { render } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { patchService as apiPatchService } from '../api/actions.js';

function viewServices(){
  return shell(null,`${cap()}<div class="c"><h3>Прайс и сдельные ставки</h3>
    <p class="cap">Значения редактируются на месте — изменение сразу отражается в расчёте начислений.
      Пенсионный прайс влияет только на счёт клиенту: сдельные ставки поверителя и оператора остаются полными, скидку берёт на себя компания.</p>
    <table><thead><tr><th>Группа</th><th>Услуга</th><th class="num">Физлицо</th><th class="num">Пенсионер</th><th class="num">Юрлицо</th>
      <th class="num">Поверителю</th><th class="num">Оператору</th><th class="num">Доля ФОТ</th></tr></thead><tbody>
      ${SERVICES.map((s,i)=>`<tr><td><span class="tg t-mut">${s.grp}</span></td><td><b>${s.name}</b></td>
        ${['pF','pP','pU','rV','rO'].map(k=>`<td class="num"><input class="fld sm mono" style="width:80px;display:inline-flex;text-align:right" value="${s[k]}" onchange="setSvc(${i},'${k}',this.value)"></td>`).join('')}
        <td class="num">${Math.round((s.rV+s.rO)/s.pF*100)}%</td></tr>`).join('')}</tbody></table></div>
  <div class="c"><h3>Сотрудники</h3><p class="cap">Внутренние номера АТС и загрузка. Персональный номер оператора нужен для всплывающей карточки звонка.
    Услуги поверителя — его компетенции: если он в смене, эти услуги в этот день оказываются, и оператор видит дату в подсказке при приёме заявки.</p>
    <table><thead><tr><th>Сотрудник</th><th>Роль</th><th>Оказывает услуги</th><th class="num">Смен за 14 дней</th><th>Вн. номер</th><th class="num">Телефон</th><th>Сегодня</th></tr></thead><tbody>
      ${S.staff.map(p=>`<tr><td><b>${esc(p.name)}</b></td>
        <td><span class="tg t-mut">${p.role==='verifier'?'поверитель':p.role==='senior'?'старший':p.role==='supervisor'?'руководитель':'оператор'}</span></td>
        <td>${p.role==='verifier'
          ? `<div class="tgls sk">${SERVICES.map(s=>`<button class="tgl" aria-pressed="${skillsOf(p).includes(s.id)}"
              title="${esc(s.name)}" onclick="tgSkill('${p.id}','${s.id}')">${esc(s.sh)}</button>`).join('')}</div>`
          : '<span class="note">не выезжает</span>'}</td>
        <td class="num mono">${Array.from({length:14},(_,i)=>iso(addDays(today,i))).filter(ds=>onShift(p,ds)).length}</td>
        <td class="mono">${p.ext||'—'}</td><td class="num mono">${p.phone||'—'}</td>
        <td>${absentOn(p.id,TODAY)?'<span class="tg t-err">отсутствие</span>':onShift(p,TODAY)?'<span class="tg t-ok">в смене</span>':'<span class="tg t-mut">выходной</span>'}</td></tr>`).join('')}
    </tbody></table></div>`);
}
/* Прайс и ставки правит руководитель прямо в таблице. Имена полей на экране
   свои (pF, rV), в базе — свои: перевод один и тот же, что при чтении. */
const SVC_FIELD = {pF:'price_person', pP:'price_pensioner', pU:'price_org',
  rV:'rate_verifier', rO:'rate_operator'};
function setSvc(i,k,v){
  const value = Math.max(0,parseInt(v)||0);
  if(!isDemo()) return apiPatchService(SERVICES[i].id,{[SVC_FIELD[k]]:value});
  SERVICES[i][k] = value; render();
}

export { setSvc, viewServices, SVC_FIELD };
