-- Клиентская база заказчика: то, что было в старом учёте до «Учёткина».
-- Пункт be-import.
--
-- Почему отдельная таблица, а не строки в `requests`. История клиента в системе —
-- это выполненные заявки: у каждой есть день, маршрут, поверитель, акт и деньги.
-- У строки из старой таблицы нет ничего из этого: есть телефон, адрес текстом,
-- дата прошлой поверки и перечень приборов. Записать её заявкой значило бы
-- сочинить выезд, которого в системе не было, и испортить любой отчёт по датам,
-- сдельной оплате и планам. Поэтому перенесённое лежит рядом с клиентом и честно
-- называется тем, что оно есть: сведения из прежнего учёта.
--
-- Ради чего это грузится: по `due_on` оператор видит, кому пора звонить —
-- межповерочный интервал истекает, и клиент должен вернуться к заказчику,
-- а не к конкуренту. Адрес нужен, чтобы подставить его при приёме звонка.

-- Up Migration

CREATE TABLE client_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id    uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  -- Адрес: разобранный по мере возможности и он же строкой, как стоял в таблице
  -- заказчика. Разбор адреса угадывает, исходник — нет, и при расхождении
  -- оператор смотрит в исходник.
  city         text REFERENCES cities (name),
  street       text NOT NULL DEFAULT '',
  house        text NOT NULL DEFAULT '',
  flat         text NOT NULL DEFAULT '',
  address_raw  text NOT NULL DEFAULT '',
  -- Прибор: название так, как его писал заказчик. Ссылки на `device_types` нет
  -- намеренно — в старых таблицах тип пишут как придётся, и строка с незнакомым
  -- названием должна загрузиться, а не отвергнуться.
  device_type  text NOT NULL DEFAULT '',
  serial       text NOT NULL DEFAULT '',
  -- Дата прошлой поверки и дата, когда пора звонить: вторая считается при импорте
  -- как первая плюс межповерочный интервал типа прибора. Тип незнакомый или даты
  -- нет — `due_on` остаётся пустым, и строка в обзвон не попадает.
  verified_on  date,
  due_on       date,
  note         text NOT NULL DEFAULT '',
  -- Ключ строки исходной таблицы: телефон + адрес + прибор. По нему повторный
  -- запуск импорта узнаёт свою же строку и не плодит копий.
  import_key   text NOT NULL UNIQUE,
  source       text NOT NULL DEFAULT '',     -- имя файла, из которого пришла строка
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_history_client_idx ON client_history (client_id);
-- Обзвон «кому пора поверяться» — главный разрез этой таблицы.
CREATE INDEX client_history_due_idx ON client_history (due_on) WHERE due_on IS NOT NULL;

-- Down Migration
DROP TABLE client_history;
