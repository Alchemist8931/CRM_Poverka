/* Вход.
 *
 * В демо-режиме входа по существу нет: роль не выбирается, в меню лежат все
 * страницы подряд — так удобно показывать макет. В рабочем логин и пароль
 * уходят на сервер, и меню собирается по роли учётной записи.
 */

import { GROUPS, PAGES, ROLES } from '../refs.js';
import { S } from '../state.js';
import { goPage } from '../ui/render.js';
import { iconAt } from '../ui/brand.js';
import { isDemo } from '../api/mode.js';
import { login } from '../api/boot.js';

/* Форма проявляется один раз — при открытии. Перерисовка экрана (неверный
 * пароль, возврат после выхода) её не повторяет: мигание на каждой ошибке
 * читалось бы как перезагрузка. */
let appeared = false;

function viewLogin(){
  const appear = appeared ? '' : ' appear';
  appeared = true;
  const demo = isDemo();
  return `<div class="login-wrap"><form class="login${appear}" onsubmit="doLogin(event)">
    <div class="brand"><span class="logo">${iconAt(26)}</span><h1>CRM «Учёткин»</h1></div>
    <div class="f"><label>Логин</label><input class="fld" name="login" value="${demo?'operator':''}" required></div>
    <div class="f"><label>Пароль</label><input class="fld" name="pw" type="password" value="${demo?'1234':''}" required></div>
    <button class="b wide" style="margin-top:14px">Войти</button>
    ${demo?`<div class="hint"><div class="lbl" style="margin-bottom:5px">Режим разработки</div>
      <p class="note">Роль не выбирается. В меню открыты все ${PAGES.length} страниц подряд, сгруппированные по ролям:
      ${GROUPS.map(g=>ROLES[g.role].label.toLowerCase()).join(' → ')}. Стрелки в шапке или Alt + ←/→ листают их по порядку.</p></div>`
    :`<div class="hint"><div class="lbl" style="margin-bottom:5px">Вход по учётной записи</div>
      <p class="note">Страницы в меню — по роли: оператор, руководитель или поверитель.
      Учётные записи заводит руководитель.</p></div>`}
  </form></div>`;
}
function doLogin(e){
  e.preventDefault();
  if(!isDemo()) return login(e.target.login.value.trim(), e.target.pw.value);
  S.auth = true; goPage(0);
}

export { doLogin, viewLogin };
