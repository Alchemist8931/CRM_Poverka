/* Перерисовка и переход по страницам.
 *
 * Подход прототипа сохранён: экран — это функция, возвращающая строку HTML,
 * render() кладёт её в #root целиком. Разница только в том, что список экранов
 * не написан здесь именами: экраны регистрируются сами (screens/index.js),
 * иначе модуль перерисовки и модули экранов замкнулись бы в кольцо импортов. */

import { PAGES, ROLES } from '../refs.js';
import { S } from '../state.js';
import { routesToday } from '../screens/support.js';
import { waitsNew } from '../screens/wait-list.js';

const VIEWS = {};
/** Экран кладёт себя в список под своим именем страницы. */
function addViews(map){ Object.assign(VIEWS, map); }

/* Переход на страницу — это ещё и повод сходить за её данными. Кто именно
   ходит, перерисовка не знает: в демо-режиме никто, в рабочем — api/load.js. */
const pageHooks = [];
function onPage(fn){ pageHooks.push(fn); }

function toast(m){ S.toast=m; render(); clearTimeout(S._t); S._t=setTimeout(()=>{S.toast=null;render();},3000); }

/* Навигация идёт по индексу страницы: одна и та же страница может встречаться
   в разных ролевых группах и показывать разное (например «Отсутствия»). */
function goPage(n){
  const p = PAGES[(n+PAGES.length)%PAGES.length];
  S.page = (n+PAGES.length)%PAGES.length;
  S.view = p.v; S.role = p.role; S.me = ROLES[p.role].id; S.user = ROLES[p.role].who;
  S.dd = null; S.openStop = null; S.modal = null; S.edit = null;
  /* Открываем конкретный маршрут: общий режим на 200 точек тяжело перерисовывать. */
  if(p.v==='support') S.openRoute = routesToday()[0]?.id || null;
  if(p.v==='myroute') S.openRoute = null;
  /* Оператор входит в поддержку — сразу говорим, сколько адресов ждёт решения. */
  if(p.v==='support'){ const n = waitsNew().length;
    if(n) toast(`Лист ожидания: ${n} адрес(ов) ждут решения — перенос, маршрут сегодня, отмена или замена непригодного прибора.`); }
  render();
  pageHooks.forEach(f=>f(p.v));
}
function step(d){ goPage(S.page+d); }
function go(v){
  const here = PAGES.findIndex(p=>p.v===v && p.role===S.role);
  goPage(here>=0?here:Math.max(0,PAGES.findIndex(p=>p.v===v)));
}
/* Перерисовка целиком, поэтому фокус и каретку в поле возвращаем руками:
   входящий звонок может прийти, пока оператор печатает адрес. */
function render(){
  const a = document.activeElement;
  const id = a && a.id, ss = a && a.selectionStart, se = a && a.selectionEnd;
  /* Смена пароля стоит перед экранами: при первом входе по временному паролю
     сервер ничего другого и не отдаст (пункт be-users). */
  document.getElementById('root').innerHTML = !S.auth ? VIEWS.login()
    : (S.mustChange||S.pwOpen) ? VIEWS.password() : (VIEWS[S.view]||VIEWS.intake)();
  if(!id) return;
  const el = document.getElementById(id);
  if(!el || typeof el.focus!=='function') return;
  el.focus();
  if(ss!=null && typeof el.setSelectionRange==='function'){ try{ el.setSelectionRange(ss,se); }catch(e){} }
}

export { VIEWS, addViews, go, goPage, onPage, render, step, toast };
