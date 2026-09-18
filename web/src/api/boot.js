/* Запуск рабочего режима: вход, роль, первый срез данных.
 *
 * Роль в прототипе не выбиралась: в меню лежали подряд все двенадцать страниц
 * трёх ролей — так было удобно показывать макет. С настоящим входом роль
 * приходит из учётной записи, и в меню остаются только её страницы. Экраны от
 * этого не меняются: меняется список страниц, по которому идёт навигация.
 */

import { api } from './client.js';
import { loadRefs, loadView } from './load.js';
import { S } from '../state.js';
import { GROUPS, PAGES, ROLES } from '../refs.js';
import { goPage, onPage, render, toast } from '../ui/render.js';
import { NET } from '../net.js';
import { listenCalls, stopCalls } from './calls.js';

/** Старший оператор работает на тех же экранах, что и оператор. */
const GROUP_OF = { operator: 'operator', senior: 'operator', supervisor: 'supervisor', verifier: 'verifier' };

function applyUser(user) {
  const role = GROUP_OF[user.role] || 'operator';
  const group = GROUPS.find((g) => g.role === role);
  // Меню — страницы своей роли. Списки объявлены const и на них смотрят экраны,
  // поэтому меняем содержимое, а не ссылку.
  GROUPS.length = 0;
  GROUPS.push(group);
  PAGES.length = 0;
  PAGES.push(...group.views.map((v) => ({ v, role, short: group.short })));
  // Кто открыл страницу, знает goPage — через справочник ролей. Подставляем
  // туда вошедшего, и вся навигация остаётся прежней.
  ROLES[role].id = user.id;
  ROLES[role].who = user.full_name;
  S.auth = true;
  S.role = role;
  S.me = user.id;
  S.user = user.full_name;
  // Поток событий телефонии — только тем, у кого есть пульт: поверителю сервер
  // его не откроет (403), и просить незачем. До смены временного пароля сервер
  // не откроет его никому — подключится экран смены пароля, когда она пройдёт.
  S.mustChange = !!user.must_change_password;
  if (role !== 'verifier' && !S.mustChange) listenCalls();
}

/* Метка «в этой вкладке уже входили». Сама сессия лежит в httpOnly-cookie и
   из кода не видна — а спрашивать сервер «кто я» на каждом открытии страницы,
   когда никто не входил, значит писать в консоль по 401 на ровном месте. */
const MARK = 'uchetkin.signed-in';
const marked = () => { try { return localStorage.getItem(MARK) === '1'; } catch (e) { return false; } };
const mark = (on) => { try { on ? localStorage.setItem(MARK, '1') : localStorage.removeItem(MARK); } catch (e) { /* приватный режим */ } };

/** Вход по логину и паролю. Ответ — карточка сотрудника, роль берём из неё. */
export async function login(loginName, password) {
  try {
    const { user } = await api.post('/auth/login', { login: loginName, password });
    mark(true);
    applyUser(user);
    // Первый вход по временному паролю: справочники сервер отдаст только после
    // смены — сразу показываем форму пароля (screens/password.js).
    if (S.mustChange) return render();
    await loadRefs();
    goPage(0);
  } catch (err) {
    if (!err?.offline) toast(err?.message || 'Войти не удалось.');
    render();
  }
}

export async function logout() {
  mark(false);
  stopCalls();
  await api.post('/auth/logout').catch(() => {});
  S.auth = false; S.mustChange = false; S.pwOpen = false;
  S.requests = []; S.routes = []; S.waits = []; S.handovers = []; S.days = []; S.booked = {};
  render();
}

/** Открытая заново вкладка: сессия живёт в cookie, спрашивать пароль незачем. */
export async function bootApi() {
  onPage(() => loadView());
  render();
  if (!marked()) return;          // не входили — сразу форма входа
  try {
    const { user } = await api.get('/auth/me');
    applyUser(user);
    if (S.mustChange) return render();
    await loadRefs();
    goPage(0);
  } catch (err) {
    // Сессия кончилась, пока вкладка была закрыта: метку снимаем и спрашиваем пароль.
    if (!err?.offline) mark(false); else NET.check();
    render();
  }
}
