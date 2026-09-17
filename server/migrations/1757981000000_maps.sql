-- Координаты адреса заявки (пункт int-maps).
--
-- Новой таблицы здесь нет намеренно. Координата — не самостоятельная сущность,
-- а свойство адреса заявки: она появляется вместе с заявкой, меняется вместе с
-- адресом и умирает вместе с ней. Отдельная таблица «геокодирование» добавила бы
-- соединение к каждому чтению заявки и ничего не дала бы взамен.
--
-- Точность (`geo_precision`) хранится рядом с координатой, потому что от неё
-- зависит, можно ли этой точке верить. Геокодер Яндекса отвечает всегда: не нашёл
-- дом — вернёт середину улицы, не нашёл улицу — центр города. Без пометки о
-- точности такая «координата» выглядит как настоящая и уводит поверителя не туда.
-- Значения — те же слова, что отдаёт Геокодер (GeocoderMetaData.precision):
-- exact — до дома, number — до ближайшего дома с таким номером, near — рядом,
-- range — дом в диапазоне номеров, street — только улица, other — город и грубее.
--
-- `geocoded_at` — не украшение: по условиям использования API Яндекс Карт
-- (ред. 01.09.2026) бесплатная лицензия разрешает держать ответ Геокодера не
-- дольше 30 суток. Отметка времени — то, чем это правило исполняется: протухшая
-- координата геокодируется заново, а сколько её держать, задаётся настройкой
-- GEO_CACHE_DAYS. Разбор условий и тарифа — docs/maps.md.

-- Up Migration

ALTER TABLE requests
  ADD COLUMN lat           double precision,
  ADD COLUMN lon           double precision,
  ADD COLUMN geo_precision text CHECK (geo_precision IN ('exact', 'number', 'near', 'range', 'street', 'other')),
  ADD COLUMN geo_address   text,
  ADD COLUMN geo_error     text,
  ADD COLUMN geocoded_at   timestamptz;

COMMENT ON COLUMN requests.lat IS 'Широта точки адреса. NULL — адрес ещё не геокодирован или геокодер не ответил.';
COMMENT ON COLUMN requests.lon IS 'Долгота точки адреса.';
COMMENT ON COLUMN requests.geo_precision IS
  'Точность ответа Геокодера: exact — до дома, number/near/range — рядом с домом, '
  'street — только улица, other — город и грубее. Маршрут строится по точкам до дома; '
  'остальные конструктор помечает как сомнительные.';
COMMENT ON COLUMN requests.geo_address IS
  'Адрес в том виде, как его понял Геокодер. Нужен оператору: расхождение с введённым '
  'адресом — первый признак опечатки в улице или номере дома.';
COMMENT ON COLUMN requests.geo_error IS
  'Почему координаты нет: «ничего не найдено», отказ Геокодера, отсутствие ключа. '
  'Пустой при удачном ответе.';
COMMENT ON COLUMN requests.geocoded_at IS
  'Когда получен ответ Геокодера. По нему же считается срок хранения ответа '
  '(GEO_CACHE_DAYS, по условиям Яндекса не более 30 суток на бесплатной лицензии).';

-- Конструктор маршрутов берёт точки дня одним запросом; индекс тот же, что и
-- у остальных выборок по дате, поэтому отдельного индекса под координаты нет.
-- А вот повторный адрес ищется по городу, улице и дому — это и есть кеш,
-- который экономит обращения к Геокодеру (их лимит 1000 в сутки).
CREATE INDEX requests_addr_idx ON requests (city, street, house) WHERE lat IS NOT NULL;

-- Down Migration

DROP INDEX requests_addr_idx;

ALTER TABLE requests
  DROP COLUMN lat,
  DROP COLUMN lon,
  DROP COLUMN geo_precision,
  DROP COLUMN geo_address,
  DROP COLUMN geo_error,
  DROP COLUMN geocoded_at;
