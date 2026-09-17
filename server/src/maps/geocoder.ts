/* HTTP Геокодер Яндекса: адрес строкой → точка на карте.
 *
 * Геокодер отвечает всегда и почти никогда не говорит «не знаю»: не нашёл дом —
 * отдаст середину улицы, не нашёл улицу — центр города, а на совсем мусорный
 * адрес — область целиком. Поэтому ответ без разбора точности бесполезен: точка
 * есть, а везти по ней некуда. Точность приходит отдельным полем
 * (`GeocoderMetaData.precision`) и хранится вместе с координатой.
 *
 * Координаты в ответе идут долготой вперёд («60.61 56.84» — это lon lat). Это
 * порядок Яндекса и у JS API он тот же, а вот в базе и в ссылках Навигатора
 * широта первая. Перепутать их — получить точку в Индийском океане, поэтому
 * разбор здесь один на всю систему.
 */
import { type MapsConfig } from './config.ts';

export interface GeoPoint {
  lat: number;
  lon: number;
  /** exact | number | near | range | street | other — как у Геокодера. */
  precision: string;
  /** Что за объект нашёлся: house, street, locality… */
  kind: string;
  /** Адрес в том виде, как его понял Геокодер. */
  address: string;
}

interface GeocoderResponse {
  response?: {
    GeoObjectCollection?: {
      featureMember?: {
        GeoObject?: {
          Point?: { pos?: string };
          metaDataProperty?: {
            GeocoderMetaData?: {
              precision?: string;
              kind?: string;
              text?: string;
            };
          };
        };
      }[];
    };
  };
}

/** Адрес заявки одной строкой — тем видом, который Геокодер понимает лучше всего:
 *  от крупного к мелкому. Квартира, подъезд и этаж не передаются: до подъезда
 *  Геокодер не считает, а лишние слова сбивают поиск дома. */
export function addressLine(
  r: { city?: string | null; street?: string | null; house?: string | null },
  region: string,
): string {
  return [region, r.city, r.street, r.house]
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** Отказ Геокодера: код ответа нужен вызывающему, чтобы отличить «кончился
 *  лимит» (403) от «ключ не тот» и от временной беды на той стороне. */
export class GeocoderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GeocoderError';
  }
}

const REASON: Record<number, string> = {
  400: 'Геокодер не принял запрос (400): проверьте адрес и параметры.',
  403: 'Геокодер отказал (403): ключ недействителен или исчерпан суточный лимит 1000 запросов.',
  429: 'Геокодер отказал (429): слишком часто, лимит запросов исчерпан.',
};

/**
 * Точка по адресу. `null` — Геокодер ничего не нашёл (это не ошибка: бывают
 * адреса, которых в карте нет). Отказ самого Геокодера — исключение.
 */
export async function geocode(address: string, cfg: MapsConfig): Promise<GeoPoint | null> {
  if (!cfg.geocoderKey) throw new GeocoderError('Не задан ключ Геокодера (YANDEX_GEOCODER_KEY).', 0);

  const url = new URL(cfg.geocoderUrl);
  url.searchParams.set('apikey', cfg.geocoderKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('lang', 'ru_RU');
  url.searchParams.set('results', '1');
  // Окно предпочтения, а не фильтр: `rspn` намеренно не ставится. Жёсткое
  // ограничение окном отсекало бы адреса на границе области, а мягкое лишь
  // поднимает свердловские улицы над одноимёнными в других регионах.
  url.searchParams.set('bbox', cfg.bbox);
  url.searchParams.set('geocode', address);

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (err) {
    throw new GeocoderError(`Геокодер не ответил: ${(err as Error).message}`, 0);
  }
  if (!res.ok) throw new GeocoderError(REASON[res.status] ?? `Геокодер ответил ${res.status}.`, res.status);

  const body = await res.json() as GeocoderResponse;
  const found = body.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject;
  const pos = found?.Point?.pos;
  if (!found || !pos) return null;

  const [lon, lat] = pos.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const meta = found.metaDataProperty?.GeocoderMetaData;
  return {
    lat: lat!,
    lon: lon!,
    precision: meta?.precision ?? 'other',
    kind: meta?.kind ?? '',
    address: meta?.text ?? address,
  };
}
