/* JavaScript API 3.0 Яндекс Карт: загрузка и живая карта под перерисовку.
 *
 * Две вещи, из-за которых этот модуль устроен именно так.
 *
 * 1. Ключ не в сборке. Он приходит с сервера справочником (GET /api/maps/config)
 *    при входе. Зашить его в сборку означало бы положить его в репозиторий, а
 *    оттуда ключ уже не вычистить — остаётся только менять его в кабинете.
 *    Прятать его при этом не от кого: ключ JS API виден в адресе загрузки
 *    библиотеки в любой вкладке, и защищает его ограничение по домену.
 *
 * 2. Карта переживает перерисовку. Экран здесь — строка HTML, и render()
 *    переписывает #root целиком (ui/render.js). Живой карте это смертельно:
 *    каждый клик по точке создавал бы карту заново и ронял бы масштаб. Поэтому
 *    контейнер карты живёт вне #root и после перерисовки переставляется в
 *    гнездо — переезд узла по DOM карту не трогает, а гнездо в разметке
 *    остаётся обычным пустым div.
 *
 * Без ключа модуль ничего не делает и ничего не грузит: конструктор рисует
 * схематичную карту области, как раньше. Это же и есть демо-режим.
 */

const SRC = 'https://api-maps.yandex.ru/v3/';

export const YM = {
  /** Ключ JS API от сервера. Пустой — карты нет и не будет. */
  key: null,
  /** Геокодирует ли сервер адреса: без этого точек с координатами не появится. */
  geocoder: false,
  /** Библиотека загрузилась. */
  ready: false,
  /** Почему не загрузилась: показывается на месте карты. */
  failed: null,
};

/** Настройки от сервера. Зовётся при входе (api/load.js). */
export function setMaps(cfg) {
  YM.key = cfg?.js_api_key || null;
  YM.geocoder = !!cfg?.geocoder;
}

/** Можно ли показывать настоящую карту. */
export const mapsOn = () => !!YM.key;

let loading = null;

/** Загрузка библиотеки — один раз на вкладку. */
export function loadMaps() {
  if (!YM.key) return Promise.resolve(null);
  if (loading) return loading;
  loading = new Promise((done, fail) => {
    const el = document.createElement('script');
    el.src = `${SRC}?apikey=${encodeURIComponent(YM.key)}&lang=ru_RU`;
    el.onerror = () => {
      YM.failed = 'Библиотека Яндекс Карт не загрузилась — проверьте связь и ограничение ключа по домену.';
      fail(new Error(YM.failed));
    };
    el.onload = () => window.ymaps3.ready.then(() => { YM.ready = true; done(window.ymaps3); });
    document.head.appendChild(el);
  });
  return loading;
}

/* ── живая карта ─────────────────────────────────────────── */

let host = null;      // контейнер карты, живёт вне #root
let map = null;       // сам YMap
let layer = null;     // слой объектов: маркеры и линия
let shown = [];       // что сейчас на карте — чтобы снимать перед новой отрисовкой

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.style.cssText = 'width:100%;height:100%';
  return host;
}

/** Рамка по точкам с полем: одна точка — просто центр. */
function frame(pts) {
  const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
  const pad = 0.012;
  return [[Math.min(...lons) - pad, Math.min(...lats) - pad],
    [Math.max(...lons) + pad, Math.max(...lats) + pad]];
}

/**
 * Показать точки в гнезде `nest`.
 *
 *   pts   — [{id, lat, lon, n, taken, title}], n — номер в выбранном порядке или 0
 *   line  — [[lon,lat], …] порядок объезда или пустой массив
 *   onPick— что делать по нажатию на точку
 *   fit   — подогнать масштаб под точки (только когда состав точек сменился)
 */
export async function showPoints(nest, { pts, line, onPick, fit }) {
  const ymaps3 = await loadMaps().catch(() => null);
  if (!ymaps3 || !nest) return;
  const { YMap, YMapDefaultSchemeLayer, YMapDefaultFeaturesLayer, YMapMarker, YMapFeature } = ymaps3;

  const box = ensureHost();
  if (box.parentNode !== nest) nest.appendChild(box);

  if (!map) {
    map = new YMap(box, { location: { center: [60.61, 56.84], zoom: 9 } });
    map.addChild(new YMapDefaultSchemeLayer());
    layer = new YMapDefaultFeaturesLayer();
    map.addChild(layer);
  }
  for (const o of shown) map.removeChild(o);
  shown = [];

  if (line.length > 1) {
    const f = new YMapFeature({
      geometry: { type: 'LineString', coordinates: line },
      style: { stroke: [{ color: '#111', width: 3, dash: [6, 4] }] },
    });
    map.addChild(f); shown.push(f);
  }
  for (const p of pts) {
    const el = document.createElement('div');
    el.className = `ympt${p.n ? ' on' : ''}${p.taken ? ' taken' : ''}`;
    el.textContent = p.n ? String(p.n) : '';
    el.title = p.title || '';
    const marker = new YMapMarker({ coordinates: [p.lon, p.lat] }, el);
    if (!p.taken && onPick) el.onclick = () => onPick(p.id);
    map.addChild(marker); shown.push(marker);
  }
  if (fit && pts.length) map.setLocation({ bounds: frame(pts), duration: 200 });
}

/** Снять карту с экрана, не разрушая её: окно конструктора закрыли. */
export function hideMap() {
  if (host && host.parentNode) host.parentNode.removeChild(host);
}
