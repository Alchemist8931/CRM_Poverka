-- Телефония Новофон (пункт int-novofon).
--
-- Строка `calls` из be-schema описывала звонок как факт: кто, кому, когда,
-- сколько говорили. Работе с настоящей АТС этого мало, и вот чего не хватало.
--
--  * Запись разговора приходит не вместе со звонком, а отдельным событием —
--    иногда через минуту, иногда через час, а иногда не приходит вовсе и
--    добирается суточной сверкой. Значит у записи своё состояние и свой счётчик
--    попыток, иначе непонятно, «записи ещё нет» или «скачать не удалось».
--  * Ссылку на запись АТС даёт по своему идентификатору (`call_id_with_rec` в
--    API 1.0, `call_records` в отчёте 2.0) — его надо где-то держать.
--  * Сырые события АТС хранятся тридцать суток. Без них разбор жалобы «звонок
--    был, а карточки не было» превращается в гадание: пришло ли событие,
--    сошлась ли подпись, что в нём было.
--  * Сотрудник CRM и сотрудник АТС — разные записи в разных системах. Звонок
--    из карточки идёт методом `start.employee_call`, которому нужен `employee.id`
--    из `get.employees`, а отметка «на линии» — `employee_phone_number_id` из
--    состава группы. Оба идентификатора живут в карточке сотрудника.

-- Up Migration

ALTER TABLE calls
  ADD COLUMN platform      text,
  ADD COLUMN answered_at   timestamptz,
  ADD COLUMN ended_at      timestamptz,
  ADD COLUMN record_ref    text,
  ADD COLUMN record_status text NOT NULL DEFAULT 'нет'
    CHECK (record_status IN ('нет', 'ждёт', 'сохранена', 'ошибка')),
  ADD COLUMN record_tries  integer NOT NULL DEFAULT 0,
  ADD COLUMN record_error  text;

COMMENT ON COLUMN calls.pbx_id IS
  'Идентификатор звонка на стороне АТС: pbx_call_id в API 1.0, call_session_id на '
  'платформе 2.0. По нему события одного звонка склеиваются и по нему же подшивается запись.';
COMMENT ON COLUMN calls.record_status IS
  '«нет» — АТС записи не обещала; «ждёт» — событие о записи пришло, файл ещё не '
  'скачан; «сохранена» — лежит в бакете записей; «ошибка» — скачать не удалось, '
  'подробности в record_error.';
COMMENT ON COLUMN calls.record_ref IS
  'Идентификатор записи на стороне АТС: call_id_with_rec (1.0) или элемент '
  'call_records из get.calls_report (2.0). Нужен, чтобы запросить ссылку заново.';

-- Записи докачиваются фоновой задачей: ей нужен дешёвый ответ на вопрос
-- «что осталось». Частичный индекс держит в себе только очередь, а не весь
-- журнал звонков за годы.
CREATE INDEX calls_record_queue_idx ON calls (record_status, started)
  WHERE record_status IN ('ждёт', 'ошибка');

-- Сырые события АТС как они пришли. Пишутся и те, у которых не сошлась подпись:
-- «кто-то стучится с чужой подписью» — это то, что как раз и нужно увидеть.
CREATE TABLE call_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  platform   text NOT NULL,                  -- 'v1' (API 1.0) или 'v2' (платформа 2.0)
  kind       text NOT NULL,                  -- событие как его назвала АТС: NOTIFY_START, call_started…
  session_id text,                           -- pbx_call_id или call_session_id
  ok         boolean NOT NULL,               -- сошлась ли подпись или секрет приёмника
  source_ip  text,
  payload    jsonb NOT NULL
);

-- Чистка по возрасту (scripts/calls-prune.mts) и разбор жалобы по звонку —
-- два единственных способа читать эту таблицу.
CREATE INDEX call_events_at_idx ON call_events (at);
CREATE INDEX call_events_session_idx ON call_events (session_id, at);

COMMENT ON TABLE call_events IS
  'Входящие уведомления телефонии в исходном виде. Хранятся 30 суток '
  '(scripts/calls-prune.mts): без них жалобу «звонок был, а карточки не было» не разобрать.';

-- Кто сейчас на линии. Отметка живёт в базе, а не в браузере оператора и не в
-- памяти процесса: её спрашивает АТС при каждом входящем звонке (интерактивная
-- обработка вызова), и после перезапуска сервера она должна остаться прежней —
-- иначе смена «схлопывается» в момент, когда никто ничего не делал.
CREATE TABLE call_line (
  staff_id   text PRIMARY KEY REFERENCES staff (id) ON DELETE CASCADE,
  on_shift   boolean NOT NULL DEFAULT false,
  -- Пауза — это разговор, постобработка или перерыв: на смене, но вызовы не идут.
  paused     boolean NOT NULL DEFAULT false,
  since      timestamptz NOT NULL DEFAULT now(),
  -- Удалось ли передать отметку в АТС. «Только в CRM» — рабочее состояние:
  -- управление доступностью в кабинете может быть и недоступно.
  synced     boolean NOT NULL DEFAULT false,
  sync_error text
);

COMMENT ON TABLE call_line IS
  'Состояние линии оператора: на смене, на паузе. По ней отвечает приёмник '
  'интерактивной обработки вызова — кому из операторов АТС направит входящий.';

ALTER TABLE staff
  ADD COLUMN novofon_employee_id     bigint,
  ADD COLUMN novofon_phone_number_id bigint;

COMMENT ON COLUMN staff.novofon_employee_id IS
  'id сотрудника в АТС (get.employees). Без него звонок из карточки некому поручить.';
COMMENT ON COLUMN staff.novofon_phone_number_id IS
  'employee_phone_number_id — номер сотрудника в группе операторов. Им управляет '
  'отметка «на линии / на паузе» (update.group_employees_numbers).';

-- Down Migration

ALTER TABLE staff
  DROP COLUMN novofon_employee_id,
  DROP COLUMN novofon_phone_number_id;

DROP TABLE call_line;

DROP TABLE call_events;

DROP INDEX calls_record_queue_idx;

ALTER TABLE calls
  DROP COLUMN platform,
  DROP COLUMN answered_at,
  DROP COLUMN ended_at,
  DROP COLUMN record_ref,
  DROP COLUMN record_status,
  DROP COLUMN record_tries,
  DROP COLUMN record_error;
