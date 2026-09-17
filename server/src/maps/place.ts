/* Координаты заявки: когда берутся из своей же базы, а когда — у Яндекса.
 *
 * Обращений к Геокодеру у конторы должно быть примерно столько же, сколько новых
 * адресов, а не столько, сколько сохранений заявки. Поэтому перед обращением
 * наружу тот же адрес ищется среди уже геокодированных заявок: «Асбест,
 * Уральская, 77» второй раз никуда не ходит. Это и укладывает контору в
 * бесплатный лимит (1000 запросов в сутки при примерно 110 адресах), и
 * исполняет условие Яндекса о сроке хранения ответа — годными считаются только
 * ответы моложе GEO_CACHE_DAYS суток (docs/maps.md).
 *
 * Геокодирование идёт после записи заявки и намеренно не в транзакции: по той же
 * причине, что и постановка уведомлений. Упавший или медленный Геокодер не имеет
 * права отменить приём — заявка с адресом без координаты нормальна, её адрес
 * оператор видит текстом, а поверитель едет по нему же.
 */
import { type Db } from '../api/db.ts';
import { GeocoderError, addressLine, geocode } from './geocoder.ts';
import { canGeocode, mapsConfig, type MapsConfig } from './config.ts';

/** Значения, которые разрешает CHECK в миграции. Чужое слово от Геокодера
 *  становится «other»: неизвестная точность — заведомо не «до дома». */
const KNOWN = new Set(['exact', 'number', 'near', 'range', 'street', 'other']);

export interface Placed {
  /** Что сделано: из базы, у Яндекса, нечем, не найдено, отказ. */
  source: 'кеш' | 'геокодер' | 'без ключа' | 'не найдено' | 'ошибка' | 'без адреса';
  lat: number | null;
  lon: number | null;
  precision: string | null;
  address: string | null;
  error: string | null;
  /** Когда ответ получен у Яндекса. У взятого из базы — время того, первого
   *  ответа, а не сегодняшнее: иначе копия ответа жила бы вечно, а срок
   *  хранения считался бы заново при каждом сохранении заявки. */
  at: Date | null;
}

/** Поля заявки, по которым ищется адрес. */
interface Addr { city: string | null; street: string | null; house: string | null }

async function cached(db: Db, a: Addr, cfg: MapsConfig): Promise<Placed | null> {
  if (!a.street || !a.house) return null;
  const { rows } = await db.query<{ lat: number; lon: number; geo_precision: string;
    geo_address: string; geocoded_at: Date }>(
    `SELECT lat, lon, geo_precision, geo_address, geocoded_at FROM requests
      WHERE city = $1 AND street = $2 AND house = $3 AND lat IS NOT NULL
        AND ($4::int = 0 OR geocoded_at > now() - make_interval(days => $4::int))
      ORDER BY geocoded_at DESC LIMIT 1`,
    [a.city, a.street, a.house, cfg.cacheDays]);
  const hit = rows[0];
  if (!hit) return null;
  return { source: 'кеш', lat: hit.lat, lon: hit.lon, precision: hit.geo_precision,
    address: hit.geo_address, error: null, at: hit.geocoded_at };
}

/** Координаты для адреса: сначала своя база, потом Геокодер. Наружу не ходит,
 *  пока есть свежий ответ по тому же адресу. */
export async function locate(db: Db, a: Addr, cfg: MapsConfig = mapsConfig()): Promise<Placed> {
  if (!a.street || !a.house) {
    return { source: 'без адреса', lat: null, lon: null, precision: null, address: null,
      error: 'Улица или номер дома не заполнены — геокодировать нечего.', at: null };
  }
  const hit = await cached(db, a, cfg);
  if (hit) return hit;

  if (!canGeocode(cfg)) {
    return { source: 'без ключа', lat: null, lon: null, precision: null, address: null,
      error: 'Ключ Геокодера не задан — заявка сохранена без координат.', at: null };
  }
  const line = addressLine(a, cfg.region);
  try {
    const point = await geocode(line, cfg);
    if (!point) {
      return { source: 'не найдено', lat: null, lon: null, precision: null, address: null,
        error: `Геокодер не нашёл адрес «${line}».`, at: null };
    }
    return { source: 'геокодер', lat: point.lat, lon: point.lon,
      precision: KNOWN.has(point.precision) ? point.precision : 'other',
      address: point.address, error: null, at: new Date() };
  } catch (err) {
    const why = err instanceof GeocoderError ? err.message : (err as Error).message;
    return { source: 'ошибка', lat: null, lon: null, precision: null, address: null, error: why, at: null };
  }
}

/** Найти координаты заявки и записать их в неё. Возвращает то, что записано. */
export async function placeRequest(db: Db, id: string, cfg: MapsConfig = mapsConfig()): Promise<Placed> {
  const { rows } = await db.query<Addr>('SELECT city, street, house FROM requests WHERE id = $1', [id]);
  const a = rows[0];
  if (!a) throw new Error(`Нет заявки «${id}».`);
  const out = await locate(db, a, cfg);
  await db.query(
    `UPDATE requests SET lat = $2, lon = $3, geo_precision = $4, geo_address = $5,
        geo_error = $6, geocoded_at = $7
      WHERE id = $1`,
    [id, out.lat, out.lon, out.precision, out.address, out.error, out.at]);
  return out;
}

/**
 * Выкинуть ответы Геокодера, которым вышел срок хранения.
 *
 * Бесплатная лицензия Яндекса разрешает держать ответ не дольше 30 суток
 * (условия, ред. 01.09.2026), и «не переиспользовать протухшее» — это ещё не
 * «не хранить»: координата так и лежала бы в строке годами. Поэтому сроку нужен
 * тот, кто его исполняет, — как `audit:prune` исполняет срок хранения журнала.
 *
 * Заявки, до которых ещё ехать, при этом не теряют точку: их адреса
 * геокодируются заново тем же обращением. Их немного — это выезды сегодняшним
 * днём и вперёд, — и в суточный лимит они укладываются с большим запасом.
 * У прошедших заявок координата просто снимается: маршрут по ним уже проехали.
 *
 * С коммерческой лицензией, которая право на хранение даёт, обращение
 * выключается настройкой GEO_CACHE_DAYS=0 (docs/maps.md).
 */
export async function pruneStale(db: Db, cfg: MapsConfig = mapsConfig()): Promise<{ refreshed: number; cleared: number }> {
  if (!cfg.cacheDays) return { refreshed: 0, cleared: 0 };
  const { rows } = await db.query<{ id: string; ahead: boolean }>(
    `SELECT id, date >= current_date AS ahead FROM requests
      WHERE geocoded_at IS NOT NULL AND geocoded_at < now() - make_interval(days => $1::int)
      ORDER BY date`, [cfg.cacheDays]);
  let refreshed = 0;
  let cleared = 0;
  for (const row of rows) {
    // Сначала снимаем, потом ищем заново: иначе своя же протухшая строка
    // ответит кешем на собственный запрос.
    await db.query(
      `UPDATE requests SET lat = NULL, lon = NULL, geo_precision = NULL, geo_address = NULL,
          geocoded_at = NULL, geo_error = $2 WHERE id = $1`,
      [row.id, `Срок хранения ответа Геокодера (${cfg.cacheDays} сут.) истёк.`]);
    cleared++;
    if (!row.ahead || !canGeocode(cfg)) continue;
    const out = await placeRequest(db, row.id, cfg);
    if (out.lat !== null) { refreshed++; cleared--; }
  }
  return { refreshed, cleared };
}

/** Адресные поля заявки: правка любого из них означает новый адрес. */
export const ADDRESS_FIELDS = ['city', 'street', 'house'] as const;

/** Менялся ли адрес в правке заявки. */
export const addressChanged = (body: Record<string, unknown>, cur: Record<string, unknown>): boolean =>
  ADDRESS_FIELDS.some((f) => body[f] !== undefined && String(body[f]) !== String(cur[f] ?? ''));

/** Геокодирование «в фоне»: медленный или упавший Геокодер не должен
 *  отражаться на приёме заявки. Причина доедет до журнала приложения, а на
 *  экране это видно как заявка без точки на карте. */
export function placeQuietly(db: Db, id: string, log?: { error(o: unknown, m: string): void }): void {
  placeRequest(db, id).catch((err: Error) => {
    log?.error({ err, id }, 'адрес заявки не геокодирован');
  });
}
