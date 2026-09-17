/* Срок хранения ответов Геокодера (пункт int-maps).
 *
 *   npm run maps:prune
 *
 * Условия использования API Яндекс Карт (ред. 01.09.2026) разрешают бесплатной
 * лицензии держать ответ Геокодера не дольше 30 суток. Обращение снимает
 * координаты, которым срок вышел, а адресам предстоящих выездов находит их
 * заново — чтобы конструктор маршрутов и Навигатор поверителя не остались без
 * точек (src/maps/place.ts, pruneStale).
 *
 * Запускается раз в сутки по расписанию на машине приложения, рядом с
 * `audit:prune` (пункт cloud-ops). С коммерческой лицензией, дающей право на
 * хранение, выключается настройкой GEO_CACHE_DAYS=0 — тогда обращение ничего
 * не делает и говорит об этом.
 */
import { pgDb } from '../src/api/db.ts';
import { mapsConfig } from '../src/maps/config.ts';
import { pruneStale } from '../src/maps/place.ts';

const cfg = mapsConfig();
const db = pgDb();

try {
  if (!cfg.cacheDays) {
    console.log('GEO_CACHE_DAYS=0 — ответы Геокодера хранятся бессрочно, чистить нечего.');
    console.log('Так можно только с коммерческой лицензией Яндекса (docs/maps.md).');
  } else {
    const { refreshed, cleared } = await pruneStale(db, cfg);
    console.log(`Срок хранения ${cfg.cacheDays} сут.: обновлено адресов ${refreshed}, снято координат ${cleared}.`);
  }
} finally {
  await db.close();
}
