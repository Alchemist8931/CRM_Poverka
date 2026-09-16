-- Справочники и люди: города, услуги, типы приборов, сотрудники, компетенции.
-- Меняется редко и руками руководителя; всё остальное в схеме ссылается сюда.

-- Up Migration

-- Города приёма. Ключ — название: им оперирует и прототип, и планирование дня,
-- где города лежат массивом в записи дня. Числового идентификатора в этих
-- массивах не будет, поэтому уникальность названия здесь — не украшение.
CREATE TABLE cities (
  name        text PRIMARY KEY,
  short       text NOT NULL UNIQUE,          -- ЕКБ, НТ, КУ — для плиток и лент
  is_big      boolean NOT NULL DEFAULT false,-- крупный город: бригада ездит по своим дням недели
  -- Дни недели выезда и норматив адресов на поверителя: столбцы листа «Города»
  -- в справочнике, который заполняет заказчик. Планирование дня подставляет их
  -- как заготовку, руководитель правит руками.
  weekdays    smallint[] NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  norm_per_verifier integer CHECK (norm_per_verifier IS NULL OR norm_per_verifier > 0),
  sort        integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Услуги и деньги по ним. Цена зависит от того, кто платит: обычное физлицо,
-- пенсионер (скидка за счёт компании) или юрлицо. Ставки сдельной оплаты
-- поверителю и оператору от скидки не зависят — это решение прототипа.
CREATE TABLE services (
  id                 text PRIMARY KEY,            -- wv, wr, hv, hm, hd
  grp                text NOT NULL,               -- Вода / Тепло
  name               text NOT NULL,
  short              text NOT NULL,
  price_person       integer NOT NULL CHECK (price_person       >= 0),
  price_pensioner    integer NOT NULL CHECK (price_pensioner    >= 0),
  price_org          integer NOT NULL CHECK (price_org          >= 0),
  rate_verifier      integer NOT NULL CHECK (rate_verifier      >= 0),
  rate_operator      integer NOT NULL CHECK (rate_operator      >= 0),
  -- Поверка кончается решением «годен / не годен»; у замены, монтажа и демонтажа
  -- поверять нечего, и результат у их строк в акте не спрашивается.
  is_verification    boolean NOT NULL DEFAULT false,
  -- Чем меняют непригодный прибор: воду — заменой счётчика, тепло — монтажом.
  replacement_service text REFERENCES services (id),
  sort               integer NOT NULL DEFAULT 0,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Типы приборов: номер в Госреестре средств измерений и межповерочный интервал.
-- Интервал нужен, чтобы посчитать дату следующей поверки в акте и в записи «Аршина».
-- Считается в годах — в этих единицах он стоит в паспорте прибора и в столбце
-- справочника, который заполняет заказчик.
CREATE TABLE device_types (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL UNIQUE,
  grsi            text NOT NULL,                 -- номер в ФГИС «Аршин» / ГРСИ, например 32245-11
  interval_years  integer NOT NULL CHECK (interval_years > 0),
  carrier_kind    text NOT NULL CHECK (carrier_kind IN ('Вода', 'Тепло')),
  sort            integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Сотрудники. Идентификатор текстовый и осмысленный (v0, o1, sv) — тот же,
-- что в прототипе, чтобы перенос данных и разбор демо-набора читались глазами.
--
-- Учётные данные лежат здесь же, а не в отдельной таблице: по архитектурному
-- решению человек и доступ заводятся одной карточкой. Логика выдачи и сброса —
-- пункт be-users, здесь только поля. Учётка не удаляется, а блокируется:
-- человек остаётся во всей истории, но войти не может.
CREATE TABLE staff (
  id                   text PRIMARY KEY,
  full_name            text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('operator', 'senior', 'supervisor', 'verifier')),
  phone                text,
  ext                  text,                       -- внутренний номер в Новофоне
  pattern              text CHECK (pattern IN ('5/2', '2/2')),   -- график по кругу
  anchor               date,                       -- точка отсчёта графика
  extra_days           date[] NOT NULL DEFAULT '{}',-- разовые смены сверх графика
  login                text,
  password_hash        text,
  must_change_password boolean NOT NULL DEFAULT true,
  otp_hash             text,                       -- одноразовый код на первый вход
  otp_expires_at       timestamptz,
  mfa_secret           text,                       -- второй фактор, включается в cloud-sec
  blocked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Логин не чувствителен к регистру: человек введёт его как придётся.
CREATE UNIQUE INDEX staff_login_key ON staff (lower(login)) WHERE login IS NOT NULL;
CREATE INDEX staff_role_idx ON staff (role) WHERE blocked_at IS NULL;

-- Компетенции поверителя. Распределены неровно: воду умеют почти все, тепло —
-- трое, демонтаж один. Из-за этого часть услуг в отдельные даты недоступна,
-- и подбор поверителя на заявку обязан это учитывать.
CREATE TABLE staff_skills (
  staff_id   text NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  service_id text NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  PRIMARY KEY (staff_id, service_id)
);

CREATE INDEX staff_skills_service_idx ON staff_skills (service_id);

-- Down Migration
DROP TABLE staff_skills;
DROP TABLE staff;
DROP TABLE device_types;
DROP TABLE services;
DROP TABLE cities;
