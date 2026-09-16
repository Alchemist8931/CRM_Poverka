-- Связь и журнал: звонки из Новофона, переписка по маршруту, журнал действий.
-- Отдельной миграцией, потому что наполняется не приёмом заявок, а внешними
-- системами и общим обработчиком API, и сносится отдельно от рабочих данных.

-- Up Migration

-- Звонок. Строку заводит вебхук Новофона: приложение только кладёт задание в
-- очередь и отвечает 200, запись разговора докачивает worker — АТС нас не ждёт.
-- Поэтому запись файла появляется позже самой строки, и record_key обнуляем.
CREATE TABLE calls (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pbx_id       text NOT NULL UNIQUE,            -- идентификатор звонка на стороне АТС
  direction    text NOT NULL CHECK (direction IN ('входящий', 'исходящий')),
  from_number  text NOT NULL,
  to_number    text NOT NULL,
  client_phone text,                            -- нормализованный номер клиента, по нему поднимается карточка
  started      timestamptz NOT NULL,
  duration_sec integer CHECK (duration_sec IS NULL OR duration_sec >= 0),
  disposition  text CHECK (disposition IN ('отвечен', 'пропущен', 'занято', 'сброшен')),
  record_key   text,                            -- calls/{год}/{месяц}/{id}.mp3 в Object Storage
  operator_id  text REFERENCES staff (id),
  request_id   text REFERENCES requests (id) ON DELETE SET NULL,
  client_id    uuid REFERENCES clients (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Лента звонков и отчёты по нагрузке на линию читаются по времени начала.
CREATE INDEX calls_started_idx ON calls (started);
CREATE INDEX calls_operator_idx ON calls (operator_id, started);
CREATE INDEX calls_client_phone_idx ON calls (client_phone, started);

-- Переписка оператора с поверителем по маршруту: «не открывают», «снимать счётчик?».
-- Привязана к маршруту, а не к адресу: разговор идёт про выезд целиком.
CREATE TABLE route_chat (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id    text NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  author_id   text REFERENCES staff (id),
  is_verifier boolean NOT NULL,                 -- сторона разговора: поверитель или оператор
  text        text NOT NULL,
  at          timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX route_chat_route_idx ON route_chat (route_id, at);

-- Журнал действий. Нужен и руководителю (кто переставил заявку), и 152-ФЗ:
-- каждое прослушивание записи разговора и каждый просмотр карточки клиента —
-- это обращение к персональным данным, и оно должно быть видно.
--
-- Состояние «до» и «после» пишем объектом: набор полей у сущностей разный,
-- а журнал должен пережить изменение схемы, не ломаясь и не требуя миграции.
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   text REFERENCES staff (id),
  actor_role text,                              -- роль на момент действия, она могла смениться
  action     text NOT NULL,                     -- создание, изменение, удаление, просмотр, вход
  entity     text NOT NULL,                     -- requests, routes, clients, calls, staff, …
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         inet,
  user_agent text
);

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at DESC);

-- Down Migration
DROP TABLE audit_log;
DROP TABLE route_chat;
DROP TABLE calls;
