/* Режим работы вкладки.
 *
 * Демо-режим — это прежний прототип: наполнение делается в памяти, сервер не
 * нужен, ничего не сохраняется. Он включён по умолчанию в демо-сборке (та лежит
 * в корне репозитория и открывается на GitHub Pages) и доступен в рабочей
 * сборке через ?demo=1 — показать экраны, не поднимая базу. */

const params = new URLSearchParams(typeof location === 'object' ? location.search : '');

/** Собрано ли приложение как демо. Значение подставляет сборка. */
const DEMO_BUILD = typeof __DEMO_DEFAULT__ === 'boolean' ? __DEMO_DEFAULT__ : false;

export function isDemo(){
  if (params.has('demo')) return params.get('demo') !== '0';
  return DEMO_BUILD;
}

/** Куда ходить за данными. Свой адрес по умолчанию: cookie сессии помечена
 *  SameSite=Lax и на чужой адрес браузером не отправляется. */
export const API_BASE = params.get('api') || '/api';
