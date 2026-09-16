-- Работа: планирование дня, отсутствия, клиенты, заявки, маршруты, акты и деньги.
-- Это ядро схемы — сюда пишут все четыре роли, и отсюда считается всё остальное.

-- Up Migration

-- День планирует руководитель целиком: города приёма, план по каждому городу,
-- смена поверителей и смена операторов. Всё остальное считается от этой записи,
-- поэтому дата и есть ключ.
--
-- Города и смены лежат массивами, а план — объектом «город → сколько заявок».
-- Это ровно форма прототипа, и она здесь уместна: запись дня всегда читается и
-- пишется целиком, отдельной строки состава смены никто не запрашивает.
-- Цена решения — на массивы не повесить внешний ключ; целостность состава смены
-- проверяет сервер при записи дня.
CREATE TABLE days (
  date        date PRIMARY KEY,
  cities      text[] NOT NULL DEFAULT '{}',   -- города приёма на дату
  plan        jsonb  NOT NULL DEFAULT '{}',   -- {"Екатеринбург": 25} — план по городам
  crew        text[] NOT NULL DEFAULT '{}',   -- смена поверителей, staff.id
  ops         text[] NOT NULL DEFAULT '{}',   -- смена операторов, staff.id
  note        text,
  updated_by  text REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT days_plan_is_object CHECK (jsonb_typeof(plan) = 'object')
);

-- Отсутствия. До согласования дни остаются рабочими по графику — поэтому статус
-- лежит в самой записи, а не выражается её наличием.
CREATE TABLE absences (
  id          text PRIMARY KEY,
  staff_id    text NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'на согласовании'
              CHECK (status IN ('на согласовании', 'согласовано', 'отклонено')),
  comment     text NOT NULL DEFAULT '',
  decided_by  text REFERENCES staff (id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT absences_range CHECK (date_to >= date_from)
);

CREATE INDEX absences_staff_idx ON absences (staff_id, date_from);
CREATE INDEX absences_approved_idx ON absences (date_from, date_to) WHERE status = 'согласовано';

-- Клиент. В прототипе отдельной карточки не было: заявки связывал только
-- совпадающий номер телефона. Здесь номер и становится ключом — в нормализованном
-- виде (+7XXXXXXXXXX), потому что один и тот же человек на приёме диктует его
-- то через восьмёрку, то со скобками, то без.
CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_norm  text NOT NULL UNIQUE CHECK (phone_norm ~ '^\+7[0-9]{10}$'),
  phone_raw   text NOT NULL,
  client_type text NOT NULL CHECK (client_type IN ('Физлицо', 'Юрлицо')),
  name        text NOT NULL,
  inn         text NOT NULL DEFAULT '',
  email       text NOT NULL DEFAULT '',
  city        text REFERENCES cities (name),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Маршрут: день, город, поверитель и дежурный оператор, который ведёт его по связи.
CREATE TABLE routes (
  id                text PRIMARY KEY,
  date              date NOT NULL,
  city              text NOT NULL REFERENCES cities (name),
  verifier_id       text REFERENCES staff (id),
  duty_operator_id  text REFERENCES staff (id),
  status            text NOT NULL DEFAULT 'черновик'
                    CHECK (status IN ('черновик', 'обзвонен', 'в работе', 'выполнен')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX routes_date_idx ON routes (date, city);
CREATE INDEX routes_verifier_idx ON routes (verifier_id, date);

-- Заявка. Адрес и контакты скопированы в неё, а не взяты из клиента ссылкой:
-- поверка идёт по конкретному адресу в конкретный день, и позднее исправление
-- карточки клиента не должно менять то, что записано в уже закрытом акте.
CREATE TABLE requests (
  id                text PRIMARY KEY,
  client_id         uuid REFERENCES clients (id) ON DELETE SET NULL,
  date              date NOT NULL,              -- на какой день записан выезд
  created_date      date NOT NULL,              -- когда оператор принял звонок
  city              text NOT NULL REFERENCES cities (name),
  client_type       text NOT NULL CHECK (client_type IN ('Физлицо', 'Юрлицо')),
  name              text NOT NULL,
  inn               text NOT NULL DEFAULT '',
  phone             text NOT NULL,              -- как продиктовали
  phone_norm        text NOT NULL,              -- по нему ищется история клиента
  contact           text NOT NULL DEFAULT '',
  phone2            text NOT NULL DEFAULT '',
  contact2          text NOT NULL DEFAULT '',
  email             text NOT NULL DEFAULT '',
  street            text NOT NULL,
  house             text NOT NULL,
  entrance          text NOT NULL DEFAULT '',
  floor             text NOT NULL DEFAULT '',
  flat              text NOT NULL DEFAULT '',
  intercom          boolean NOT NULL DEFAULT true,
  time_slot         integer NOT NULL CHECK (time_slot BETWEEN 0 AND 23), -- середина окна, ±1 час
  comment_operator  text NOT NULL DEFAULT '',   -- для оператора и обзвона
  comment_verifier  text NOT NULL DEFAULT '',   -- для поверителя на адресе
  svcs              text[] NOT NULL DEFAULT '{}', -- что попросил клиент при приёме
  status            text NOT NULL DEFAULT 'создана'
                    CHECK (status IN ('создана', 'в маршруте', 'выполнена', 'перенос', 'отменена', 'ожидание')),
  route_id          text REFERENCES routes (id) ON DELETE SET NULL,
  operator_id       text REFERENCES staff (id), -- кто принял заявку
  verifier_id       text REFERENCES staff (id), -- кто выполнил работы
  moved_from        text REFERENCES requests (id), -- заявка, из которой эта перенесена
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Основной разрез всех экранов приёма и планирования: сколько записано на дату в городе.
CREATE INDEX requests_date_city_idx ON requests (date, city);
-- История клиента и проверка дублей на приёме — по номеру.
CREATE INDEX requests_phone_idx ON requests (phone_norm);
CREATE INDEX requests_route_idx ON requests (route_id) WHERE route_id IS NOT NULL;
CREATE INDEX requests_status_idx ON requests (status, date);
CREATE INDEX requests_verifier_idx ON requests (verifier_id, date) WHERE verifier_id IS NOT NULL;

-- Точка маршрута. Порядок объезда задаётся позицией, обзвон — результатом звонка,
-- а необслуженный адрес отмечается прямо здесь: причина нужна оператору,
-- чтобы перезвонить клиенту и переставить его в другой день.
CREATE TABLE stops (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id        text NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  request_id      text NOT NULL REFERENCES requests (id) ON DELETE RESTRICT,
  position        integer NOT NULL CHECK (position > 0),
  called          text CHECK (called IN ('подтверждена', 'перенос', 'отказ')),
  done            boolean NOT NULL DEFAULT false,
  unserved_reason text CHECK (unserved_reason IN ('Нет дома', 'Отказ на месте', 'Нет доступа к прибору',
                                                  'Перенос по просьбе клиента', 'Другое')),
  unserved_note   text NOT NULL DEFAULT '',
  unserved_at     timestamptz,
  unserved_by     text REFERENCES staff (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Выполненная точка не может быть одновременно необслуженной.
  CONSTRAINT stops_done_xor_unserved CHECK (NOT (done AND unserved_reason IS NOT NULL)),
  -- «Другое» без пояснения бесполезно оператору: звонить клиенту не с чем.
  CONSTRAINT stops_other_needs_note CHECK (unserved_reason <> 'Другое' OR unserved_note <> ''),
  CONSTRAINT stops_route_position_key UNIQUE (route_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT stops_route_request_key  UNIQUE (route_id, request_id)
);

-- Маршрут всегда читается целиком, по идентификатору.
CREATE INDEX stops_route_idx ON stops (route_id);
CREATE INDEX stops_request_idx ON stops (request_id);

-- Лист ожидания: адрес, который не закрыли, и замена, которую клиент отложил.
-- Заведён сверх перечня задачи — без него демо-набор прототипа (экран необслуженных
-- адресов и отложенные замены) в базу не ложится.
CREATE TABLE wait_list (
  id          text PRIMARY KEY,
  request_id  text NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  route_id    text REFERENCES routes (id) ON DELETE SET NULL,
  city        text NOT NULL REFERENCES cities (name),
  kind        text NOT NULL DEFAULT 'адрес' CHECK (kind IN ('адрес', 'замена')),
  reason      text NOT NULL,
  note        text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL,
  by_staff    text REFERENCES staff (id),
  state       text NOT NULL DEFAULT 'не обработана'
              CHECK (state IN ('не обработана', 'перенесена', 'снята', 'отменена')),
  moved_to    text REFERENCES requests (id),   -- новая заявка, если оператор переставил адрес
  handled_by  text REFERENCES staff (id),
  handled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wait_list_open_idx ON wait_list (city, at) WHERE state = 'не обработана';
CREATE INDEX wait_list_request_idx ON wait_list (request_id);

-- Прибор в акте. Услуга стоит в строке прибора, а не в заявке: на одном адресе
-- один счётчик поверяют, второй меняют, и цены у них разные.
--
-- Цена и ставки — снимок на момент выполнения. Переписанный прайс не должен
-- менять ни прошлые акты, ни уже начисленную сдельную оплату.
CREATE TABLE devices (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id      text NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  position        integer NOT NULL CHECK (position > 0),
  service_id      text NOT NULL REFERENCES services (id),
  device_type     text NOT NULL,                -- название из device_types на момент акта
  grsi            text NOT NULL DEFAULT '',
  carrier         text NOT NULL CHECK (carrier IN ('ХВС', 'ГВС', 'Тепло')),
  serial          text NOT NULL DEFAULT '',     -- пусто, когда номер не читается
  reading         text NOT NULL DEFAULT '',     -- показания как записал поверитель
  room            text CHECK (room IN ('Кухня', 'Санузел', 'Иное')),
  seal            boolean NOT NULL DEFAULT true,-- пломба УК на месте
  pensioner       boolean NOT NULL DEFAULT false,-- скидка стоит на приборе, а не на заявке
  bad             boolean NOT NULL DEFAULT false,-- результат поверки: непригоден
  bad_reason      text CHECK (bad_reason IN ('Погрешность выше допуска', 'Механическое повреждение',
                                             'Нечитаемый номер', 'Другое')),
  bad_note        text NOT NULL DEFAULT '',
  blank           boolean NOT NULL DEFAULT false,-- выписано свидетельство о непригодности
  blank_no        text NOT NULL DEFAULT '',      -- номер бумажного бланка, нумерация сквозная у заказчика
  replacement     text CHECK (replacement IN ('предложена', 'отложена')),
  replacement_wait_id text REFERENCES wait_list (id) ON DELETE SET NULL,
  swap            boolean NOT NULL DEFAULT false,-- это строка установленного взамен прибора
  swap_of         text NOT NULL DEFAULT '',      -- заводской номер снятого
  price_charged   integer NOT NULL DEFAULT 0 CHECK (price_charged >= 0),
  rate_verifier   integer NOT NULL DEFAULT 0 CHECK (rate_verifier >= 0),
  rate_operator   integer NOT NULL DEFAULT 0 CHECK (rate_operator >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_request_position_key UNIQUE (request_id, position) DEFERRABLE INITIALLY DEFERRED,
  -- Непригодный прибор без причины не попадёт ни в свидетельство, ни в «Аршин».
  CONSTRAINT devices_bad_needs_reason CHECK (bad = (bad_reason IS NOT NULL)),
  CONSTRAINT devices_bad_other_needs_note CHECK (bad_reason IS DISTINCT FROM 'Другое' OR bad_note <> ''),
  CONSTRAINT devices_blank_no CHECK ((blank_no <> '') = blank)
);

CREATE INDEX devices_request_idx ON devices (request_id);
CREATE INDEX devices_bad_idx ON devices (request_id) WHERE bad;
CREATE INDEX devices_serial_idx ON devices (serial) WHERE serial <> '';

-- Фото выполненных работ. Сам файл лежит в Object Storage и через сервер не идёт:
-- телефон получает подписанную ссылку и льёт снимок напрямую. В базе — только ключ.
CREATE TABLE photos (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id   bigint NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,            -- acts/{год}/{заявка}/{прибор}/{uuid}.jpg
  thumb_key   text,                            -- миниатюра 320 px, её делает worker
  name        text NOT NULL DEFAULT '',        -- имя файла с телефона
  taken_at    time,                            -- время съёмки, как показал телефон
  size_bytes  integer CHECK (size_bytes IS NULL OR size_bytes > 0),
  checksum    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX photos_device_idx ON photos (device_id);

-- Оплата на месте. Эквайринга на первом этапе нет: поверитель берёт наличные или
-- перевод на карту и держит деньги у себя как подотчёт до конца месяца.
-- По счёту платит только юрлицо — эти деньги через руки поверителя не проходят.
CREATE TABLE payments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  text NOT NULL UNIQUE REFERENCES requests (id) ON DELETE CASCADE,
  method      text NOT NULL CHECK (method IN ('наличные', 'перевод на карту', 'по счёту', 'не оплачено')),
  amount      integer NOT NULL DEFAULT 0 CHECK (amount >= 0),   -- сколько взяли на самом деле
  charged     integer NOT NULL DEFAULT 0 CHECK (charged >= 0),  -- сколько стоило по прайсу
  manual      boolean NOT NULL DEFAULT false,  -- сумму поправили руками
  note        text NOT NULL DEFAULT '',
  paid_at     timestamptz,
  by_staff    text REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- «Не оплачено» — это долг, а не платёж на ноль рублей с суммой.
  CONSTRAINT payments_unpaid_is_zero CHECK (method <> 'не оплачено' OR amount = 0)
);

CREATE INDEX payments_hand_idx ON payments (by_staff, paid_at)
  WHERE method IN ('наличные', 'перевод на карту');

-- Сдача подотчёта: поверитель привозит руководителю собранное за месяц
-- за вычетом своей сдельной оплаты. Заведена сверх перечня задачи по той же
-- причине, что и лист ожидания, — иначе экран подотчёта не из чего собрать.
CREATE TABLE handovers (
  id          text PRIMARY KEY,
  staff_id    text NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
  at          date NOT NULL,                   -- день, когда деньги приняли
  period      text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'), -- за какой месяц
  amount      integer NOT NULL CHECK (amount > 0),
  accepted_by text REFERENCES staff (id),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX handovers_staff_period_idx ON handovers (staff_id, period);

-- Down Migration
DROP TABLE handovers;
DROP TABLE payments;
DROP TABLE photos;
DROP TABLE devices;
DROP TABLE wait_list;
DROP TABLE stops;
DROP TABLE requests;
DROP TABLE routes;
DROP TABLE clients;
DROP TABLE absences;
DROP TABLE days;
