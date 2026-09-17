/* Сверка геокодирования адресов (пункт int-maps).
 *
 *   npx tsx scripts/check-maps.mts            — против своего приёмника
 *   npx tsx scripts/check-maps.mts --live     — против настоящего Геокодера
 *
 * Обычный прогон не ходит к Яндексу намеренно. Проверка не имеет права зависеть
 * от чужой службы, от чужого счёта и от суточного лимита в тысячу запросов:
 * она должна давать один и тот же ответ на машине разработчика, в CI и через
 * год. Поэтому на свободном порту поднимается приёмник, отвечающий тем же
 * JSON, что и Геокодер Яндекса, а клиент работает настоящий — тот самый
 * src/maps/geocoder.ts, что пойдёт в облако.
 *
 * Приёмник нарочно требует ключ и отвечает 403 без него: так проверяется, что
 * ключ действительно уходит в запрос, а не теряется в настройках.
 *
 * Чего обычный прогон не проверяет: что настоящий Яндекс на тех же адресах
 * отвечает точностью «до дома». Это проверяется отдельно и только там, где есть
 * ключ, — прогоном с `--live`:
 *
 *   YANDEX_GEOCODER_KEY=… npx tsx scripts/check-maps.mts --live
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { singleConnectionDb, type Db } from '../src/api/db.ts';
import { mapsConfig, FREE_CACHE_DAYS_MAX, type MapsConfig } from '../src/maps/config.ts';
import { addressLine, geocode } from '../src/maps/geocoder.ts';
import { locate, placeRequest, pruneStale } from '../src/maps/place.ts';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const live = process.argv.includes('--live');
let failed = 0;

function ok(what: string, good: boolean, detail = ''): void {
  if (good) {
    console.log(`  ✓ ${what}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.error(`  ✗ ${what}${detail ? ' — ' + detail : ''}`);
  }
}

/* ─────────────────────── адреса, на которых сверяемся ─────────────────────── */

/* Два настоящих адреса: контора работает в Асбесте, а Екатеринбург — самый
   большой город выезда. Координаты взяты с точностью до сотых долей градуса
   (около километра): проверка смотрит, что ответ пришёл про этот дом в этом
   городе, а не что Геокодер выдал ровно те же цифры, что год назад. */
const CASES = [
  { city: 'Асбест', street: 'Уральская', house: '77', lat: 57.0056, lon: 61.4581 },
  { city: 'Екатеринбург', street: 'Малышева', house: '51', lat: 56.8380, lon: 60.6122 },
];

/* ───────────────────────── приёмник вместо Яндекса ───────────────────────── */

/** Ответ Геокодера в том же виде, в каком его отдаёт 1.x. */
function answer(found: { lat: number; lon: number; precision: string; text: string } | null) {
  return {
    response: {
      GeoObjectCollection: {
        metaDataProperty: { GeocoderResponseMetaData: { found: found ? '1' : '0' } },
        featureMember: found ? [{
          GeoObject: {
            Point: { pos: `${found.lon} ${found.lat}` },
            metaDataProperty: {
              GeocoderMetaData: { precision: found.precision, kind: 'house', text: found.text },
            },
          },
        }] : [],
      },
    },
  };
}

function sink(): Promise<{ url: string; hits: string[]; keys: string[]; stop: () => Promise<void> }> {
  const hits: string[] = [];
  const keys: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = url.searchParams.get('apikey');
    const asked = url.searchParams.get('geocode') ?? '';
    if (!key) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"apikey is required"}');
      return;
    }
    hits.push(asked);
    keys.push(key);
    const hit = CASES.find((c) => asked.includes(c.street) && asked.includes(c.house));
    const body = hit
      ? answer({ lat: hit.lat, lon: hit.lon, precision: 'exact',
        text: `Россия, Свердловская область, ${hit.city}, улица ${hit.street}, ${hit.house}` })
      // Улицы с таким домом нет: настоящий Геокодер в этом случае отдаёт не
      // «не найдено», а середину улицы или центр города. Точность «street» —
      // это и есть та ловушка, ради которой точность вообще хранится.
      : asked.includes('Нетаковской')
        ? answer({ lat: 57.0, lon: 61.46, precision: 'street', text: 'Россия, Свердловская область, Асбест' })
        : answer(null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((done) => {
    // Порт спрашивается у системы: занятый чужим процессом порт — не та
    // поломка, которую эта проверка должна ловить.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      done({
        url: `http://127.0.0.1:${port}/1.x/`, hits, keys,
        stop: () => new Promise((shut) => server.close(() => shut())),
      });
    });
  });
}

/* ────────────────────────────── временная база ────────────────────────────── */

async function stand(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  const dir = join(serverDir, 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await pg.exec(sql.split('-- Down Migration')[0]!.split('-- Up Migration')[1] ?? '');
  }
  const db = singleConnectionDb({
    query: (text, params) => pg.query(text, params as never[]) as never,
    close: () => pg.close(),
  });
  await db.query(
    `INSERT INTO cities (name, short, sort) VALUES ('Асбест', 'АСБ', 1), ('Екатеринбург', 'ЕКБ', 2)`);
  await db.query(
    `INSERT INTO staff (id, full_name, role, login, password_hash, must_change_password)
     VALUES ('o1', 'Ефимова О. В.', 'operator', 'o1', 'x', false)`);
  return { db, close: () => db.close() };
}

let seq = 0;
async function addRequest(db: Db, a: { city: string; street: string; house: string }): Promise<string> {
  const id = `R-${++seq}`;
  await db.query(
    `INSERT INTO requests (id, date, created_date, city, client_type, name, phone, phone_norm,
        street, house, time_slot, svcs, status, operator_id)
     VALUES ($1, current_date, current_date, $2, 'Физлицо', 'Иванов И. И.', '+7 912 345-67-89',
        '+79123456789', $3, $4, 12, ARRAY['wv'], 'создана', 'o1')`,
    [id, a.city, a.street, a.house]);
  return id;
}

/* ──────────────────────────────── прогон ──────────────────────────────── */

const gate = await sink();
const { db, close } = await stand();
const cfg = (over: Partial<MapsConfig> = {}): MapsConfig => ({
  ...mapsConfig({ YANDEX_GEOCODER_KEY: 'проверочный-ключ' } as NodeJS.ProcessEnv),
  geocoderUrl: gate.url, ...over,
});

try {
  console.log('Адрес заявки → координаты:');
  for (const c of CASES) {
    const id = await addRequest(db, c);
    const out = await placeRequest(db, id, cfg());
    const { rows } = await db.query<{ lat: number; lon: number; geo_precision: string;
      geo_address: string; geocoded_at: Date | null }>(
      'SELECT lat, lon, geo_precision, geo_address, geocoded_at FROM requests WHERE id = $1', [id]);
    const row = rows[0]!;
    ok(`${c.city}, ${c.street}, ${c.house} — точность до дома`,
      out.source === 'геокодер' && row.geo_precision === 'exact', `${row.geo_precision}`);
    ok('координаты записаны в заявку и не перепутаны местами',
      Math.abs(row.lat - c.lat) < 0.05 && Math.abs(row.lon - c.lon) < 0.05,
      `${row.lat} ${row.lon}`);
    ok('адрес от Геокодера сохранён рядом с координатой', !!row.geo_address, row.geo_address);
    ok('отметка времени ответа проставлена', !!row.geocoded_at);
  }

  ok('в запросе к Геокодеру есть ключ', gate.keys.every((k) => k === 'проверочный-ключ'));
  ok('адрес уходит от крупного к мелкому, с областью',
    gate.hits[0] === 'Свердловская область, Асбест, Уральская, 77', gate.hits[0]);
  ok('квартира и подъезд в Геокодер не уходят',
    addressLine({ city: 'Асбест', street: 'Уральская', house: '77' }, 'Свердловская область')
      === 'Свердловская область, Асбест, Уральская, 77');

  console.log('\nПовторный адрес не стоит нового запроса:');
  const before = gate.hits.length;
  const again = await addRequest(db, CASES[0]!);
  const cachedOut = await placeRequest(db, again, cfg());
  ok('тот же адрес взят из своей базы', cachedOut.source === 'кеш', cachedOut.source);
  ok('к Геокодеру за ним не ходили', gate.hits.length === before, `запросов ${gate.hits.length - before}`);
  ok('координаты у повторной заявки те же',
    Math.abs((cachedOut.lat ?? 0) - CASES[0]!.lat) < 0.05);

  console.log('\nСрок хранения ответа (условия Яндекса — не дольше 30 суток):');
  ok('по умолчанию берётся предел бесплатной лицензии',
    mapsConfig({} as NodeJS.ProcessEnv).cacheDays === FREE_CACHE_DAYS_MAX);
  // Стареет весь адрес, а не одна строка: кеш ищет по городу, улице и дому, и
  // свежий ответ у соседней заявки того же дома — это тот же самый ответ.
  await db.query(`UPDATE requests SET geocoded_at = now() - interval '40 days' WHERE street = $1`,
    [CASES[0]!.street]);
  const stale = gate.hits.length;
  const third = await addRequest(db, CASES[0]!);
  const staleOut = await placeRequest(db, third, cfg());
  ok('протухший ответ геокодируется заново', staleOut.source === 'геокодер', staleOut.source);
  ok('и это стоило ровно одного запроса', gate.hits.length === stale + 1);
  // «Не переиспользовать протухшее» — ещё не «не хранить»: координата так и
  // лежала бы в строке годами. Срок исполняет отдельное обращение, как и у
  // журнала действий (npm run maps:prune).
  const wasLying = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM requests WHERE geocoded_at < now() - interval '30 days'`);
  ok('до чистки просроченные ответы в базе есть', wasLying.rows[0]!.n !== '0', `строк ${wasLying.rows[0]!.n}`);
  const pruned = await pruneStale(db, cfg());
  const fresh = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM requests WHERE geocoded_at < now() - interval '30 days'`);
  ok('после чистки хранимых ответов старше 30 суток не остаётся', fresh.rows[0]!.n === '0',
    `обновлено ${pruned.refreshed}, снято ${pruned.cleared}`);
  const { rows: kept } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM requests WHERE date >= current_date AND lat IS NOT NULL`);
  ok('адреса предстоящих выездов точку не потеряли', Number(kept[0]!.n) > 0, `с координатами ${kept[0]!.n}`);

  console.log('\nЧего система не выдаёт за координаты:');
  const vague = await addRequest(db, { city: 'Асбест', street: 'Нетаковской', house: '999' });
  const vagueOut = await placeRequest(db, vague, cfg());
  ok('ответ «до улицы» сохранён с честной точностью', vagueOut.precision === 'street', String(vagueOut.precision));
  const missing = await addRequest(db, { city: 'Асбест', street: 'Такой улицы нет', house: '1' });
  const missingOut = await placeRequest(db, missing, cfg());
  ok('ненайденный адрес остаётся без координат и с причиной',
    missingOut.lat === null && !!missingOut.error, missingOut.error ?? '');
  const noHouse = await locate(db, { city: 'Асбест', street: 'Уральская', house: '' }, cfg());
  ok('адрес без дома в Геокодер не отправляется', noHouse.source === 'без адреса');

  console.log('\nБез ключа система работает:');
  const blind = await addRequest(db, { city: 'Екатеринбург', street: 'Мира', house: '1' });
  const blindOut = await placeRequest(db, blind, cfg({ geocoderKey: null }));
  ok('заявка сохраняется, координат нет, причина названа',
    blindOut.source === 'без ключа' && blindOut.lat === null && !!blindOut.error);
  const { rows: alive } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM requests WHERE id = $1', [blind]);
  ok('заявка при этом на месте', alive[0]!.n === '1');

  if (live) {
    console.log('\nНастоящий Геокодер Яндекса:');
    const real = mapsConfig();
    if (!real.geocoderKey) {
      failed++;
      console.error('  ✗ прогон с --live без YANDEX_GEOCODER_KEY: проверять нечем');
    } else {
      for (const c of CASES) {
        const point = await geocode(addressLine(c, real.region), real);
        ok(`${c.city}, ${c.street}, ${c.house} — точность до дома у Яндекса`,
          point?.precision === 'exact', point ? `${point.precision} · ${point.address}` : 'ответа нет');
        ok('координаты совпали с ожидаемыми в пределах километра',
          !!point && Math.abs(point.lat - c.lat) < 0.05 && Math.abs(point.lon - c.lon) < 0.05,
          point ? `${point.lat} ${point.lon}` : '');
      }
    }
  }
} finally {
  await close();
  await gate.stop();
}

console.log('');
if (!live) {
  console.log('Чего этот прогон не проверяет: что настоящий Яндекс отвечает на те же адреса');
  console.log('точностью «до дома». Для этого нужен ключ:');
  console.log('  YANDEX_GEOCODER_KEY=… npx tsx scripts/check-maps.mts --live');
}

if (failed) {
  console.error(`\nСверка геокодирования не сошлась: расхождений ${failed}.`);
  process.exit(1);
}
console.log(`Геокодирование: адреса превращаются в точки, повторы берутся из базы,${
  live ? ' настоящий Геокодер отвечает до дома,' : ''} без ключа система работает.`);
