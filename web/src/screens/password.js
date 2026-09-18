/* Смена пароля (пункт be-users).
 *
 * Сюда попадают двумя путями: при первом входе по временному паролю — сервер
 * дальше не пускает (403 с reason «password»), и по своей воле — кнопкой с
 * ключом в левой колонке. Форма одна и та же; отличие в том, можно ли уйти,
 * не сменив. Здесь же «выйти со всех устройств»: после него эта вкладка тоже
 * выходит — сессии гасятся все разом, без исключений.
 */

import { S } from '../state.js';
import { iconAt } from '../ui/brand.js';
import { goPage, render, toast } from '../ui/render.js';
import { isDemo } from '../api/mode.js';
import { api } from '../api/client.js';
import { loadRefs } from '../api/load.js';
import { logout } from '../api/boot.js';
import { listenCalls } from '../api/calls.js';

/** Столько же, сколько требует сервер (src/password.ts): проверка здесь — чтобы
 *  не гонять заведомо короткий пароль по сети, а не вместо серверной. */
const MIN = 10;

function viewPassword(){
  const forced = !!S.mustChange;
  return `<div class="login-wrap"><form class="login" onsubmit="pwSave(event)">
    <div class="brand"><span class="logo">${iconAt(26)}</span><h1>${forced?'Придумайте свой пароль':'Смена пароля'}</h1></div>
    ${forced?'<p class="note" style="margin-bottom:14px">Вы вошли по временному паролю, который выдал руководитель. Дальше система не пустит, пока пароль не станет вашим.</p>':''}
    <div class="f"><label>${forced?'Временный пароль':'Текущий пароль'}</label><input class="fld" name="cur" type="password" required autocomplete="current-password"></div>
    <div class="f"><label>Новый пароль</label><input class="fld" name="pw" type="password" required minlength="${MIN}" autocomplete="new-password"></div>
    <div class="f"><label>Ещё раз</label><input class="fld" name="pw2" type="password" required autocomplete="new-password"></div>
    <button class="b wide" style="margin-top:14px">Сменить пароль</button>
    <div class="hint"><div class="lbl" style="margin-bottom:5px">Требования</div>
      <p class="note">Не короче ${MIN} знаков и не тот же, что был. После смены другие открытые вкладки и устройства выйдут из системы — эта останется.</p></div>
    <div class="row" style="margin-top:12px;justify-content:space-between">
      ${forced?'<span></span>':'<button type="button" class="g sm" onclick="pwBack()">Назад</button>'}
      <button type="button" class="g sm" onclick="pwLogoutAll()">Выйти со всех устройств</button>
    </div>
  </form></div>`;
}

async function pwSave(e){
  e.preventDefault();
  const f = e.target;
  const cur = f.cur.value, pw = f.pw.value, pw2 = f.pw2.value;
  if(pw.length<MIN) return toast(`Пароль не короче ${MIN} знаков.`);
  if(pw!==pw2) return toast('Пароли не совпадают.');
  if(pw===cur) return toast('Новый пароль совпадает со старым.');
  if(isDemo()){ S.mustChange = false; S.pwOpen = false; toast('Пароль изменён.'); return render(); }
  try{
    await api.post(`/staff/${S.me}/password`, {current:cur, password:pw});
  }catch(err){
    if(!err?.offline) toast(err?.message || 'Пароль не изменён.');
    return render();
  }
  const first = S.mustChange;
  S.mustChange = false; S.pwOpen = false;
  toast('Пароль изменён.');
  if(!first) return render();
  // Первый вход: справочники до смены пароля сервер не отдавал — берём их сейчас.
  try{ await loadRefs(); }catch(err){ if(!err?.offline) toast(err?.message || 'Не удалось загрузить справочники.'); }
  if(S.role!=='verifier') listenCalls();
  goPage(0);
}
function pwOpen(){ S.pwOpen = true; S.dd = null; render(); }
function pwBack(){ S.pwOpen = false; render(); }
async function pwLogoutAll(){
  if(isDemo()) return toast('В демо-режиме сессий нет.');
  try{ await api.post(`/staff/${S.me}/sessions/close`); }
  catch(err){ if(!err?.offline) toast(err?.message || 'Не получилось.'); return; }
  toast('Все устройства вышли из системы.');
  await logout();
}

export { pwBack, pwLogoutAll, pwOpen, pwSave, viewPassword };
