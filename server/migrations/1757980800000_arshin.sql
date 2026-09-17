-- Записи о поверке для ФГИС «Аршин» и очередь их передачи (пункт int-arshin).
--
-- Поверка получает юридическую силу не тогда, когда поверитель закрыл акт, а
-- тогда, когда сведения о ней легли в Федеральный информационный фонд по
-- обеспечению единства измерений (ФГИС «Аршин»). Поэтому запись о поверке —
-- отдельная сущность со своей очередью и своим сроком, а не поле в акте:
-- у неё свой жизненный путь (готово → передано → принято либо ошибка),
-- который к состоянию заявки отношения не имеет.
--
-- Состав сведений — подпункты «а»–«у» пункта 26 Порядка создания и ведения
-- Федерального информационного фонда (приказ Минпромторга России от 28.08.2020
-- № 2906 в редакции приказа от 13.01.2022 № 37). Разбор состава и что из него
-- чем закрывается — в docs/arshin.md.
--
-- Сведения кладутся снимком, а не читаются ссылками из справочников: запись
-- уходит в государственный реестр, и переписанная через полгода строка
-- справочника приборов не должна менять то, что уже передано.

-- Up Migration

-- Методика поверки и эталоны — подпункты «з» и «ж» пункта 26: они одинаковы для
-- всех приборов одного типа и потому стоят в справочнике типов. Пустое значение
-- допустимо: справочник заказчика придёт заполненным не сразу, а запись о
-- поверке должна собираться и до этого — с видимой ошибкой в очереди, а не с
-- молчаливым пропуском поля.
ALTER TABLE device_types
  ADD COLUMN method_doc text NOT NULL DEFAULT '',
  ADD COLUMN etalons    text NOT NULL DEFAULT '';

-- Номер записи в реестре возвращается «Аршином» после приёма сведений и живёт
-- в приборе: он печатается в свидетельстве о поверке и в извещении о
-- непригодности (пункты 26 и требования к содержанию свидетельства приказа
-- Минпромторга России от 31.07.2020 № 2510), то есть нужен акту, а не очереди.
ALTER TABLE devices ADD COLUMN arshin_number text NOT NULL DEFAULT '';

-- Выгрузка: пачка записей, ушедшая в «Аршин» одним файлом или одним обращением
-- к API. Нужна, чтобы по ответу реестра было понятно, какие именно записи он
-- принял, а какие вернул с ошибкой, и чтобы руководитель мог повторно скачать
-- ровно тот файл, который загружал в личный кабинет.
CREATE TABLE arshin_batches (
  id          text PRIMARY KEY,                  -- A-2026-0001
  channel     text NOT NULL CHECK (channel IN ('файл', 'API')),
  status      text NOT NULL DEFAULT 'передана'
              CHECK (status IN ('передана', 'принята', 'ошибка')),
  records     integer NOT NULL DEFAULT 0 CHECK (records >= 0),
  file_name   text NOT NULL DEFAULT '',
  error_text  text NOT NULL DEFAULT '',
  by_staff    text REFERENCES staff (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

-- Запись о поверке одного прибора. Одна строка акта — одна запись, включая
-- «не годен»: отрицательный результат передаётся в фонд наравне с
-- положительным (пункт 26 приказа № 2906, подпункты «м» и «у»).
CREATE TABLE arshin_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id       bigint NOT NULL UNIQUE REFERENCES devices (id) ON DELETE CASCADE,
  request_id      text NOT NULL REFERENCES requests (id) ON DELETE CASCADE,

  -- ── снимок сведений о результате поверки (пункт 26 приказа № 2906) ──
  mi_name         text NOT NULL,                      -- «а» наименование и обозначение типа
  mi_modification text NOT NULL DEFAULT '',           -- «б» модификация или исполнение
  grsi            text NOT NULL DEFAULT '',           -- «в» регистрационный номер типа в Фонде
  serial          text NOT NULL DEFAULT '',           -- «г» заводской номер
  etalons         text NOT NULL DEFAULT '',           -- «ж» применяемые эталоны
  method_doc      text NOT NULL DEFAULT '',           -- «з» документ, по которому поверяли
  verified_on     date NOT NULL,                      -- «к» дата поверки
  valid_to        date,                               -- «л» срок действия; NULL — только первичная
  applicable      boolean NOT NULL,                   -- «м» заключение: годен / не годен
  org_name        text NOT NULL DEFAULT '',           -- «п» наименование аккредитованного лица
  org_code        text NOT NULL DEFAULT '',           -- «п» условный шифр, присвоенный Росстандартом
  verifier_id     text REFERENCES staff (id),
  verifier_name   text NOT NULL DEFAULT '',           -- «р» поверитель: фамилия и инициалы
  owner_name      text NOT NULL DEFAULT '',           -- «т» владелец — только с его согласия
  fail_reason     text NOT NULL DEFAULT '',           -- «у» причины непригодности

  -- ── очередь передачи ──
  status          text NOT NULL DEFAULT 'готово'
                  CHECK (status IN ('готово', 'передано', 'принято', 'ошибка')),
  -- Крайний срок передачи: дата поверки плюс 40 рабочих дней, для эталонов — 20
  -- (пункт 21 Порядка проведения поверки, приказ Минпромторга России
  -- от 31.07.2020 № 2510). Считается при создании записи и дальше не меняется:
  -- срок отсчитывается от поверки, а не от попыток её передать.
  due_date        date NOT NULL,
  batch_id        text REFERENCES arshin_batches (id) ON DELETE SET NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_text      text NOT NULL DEFAULT '',
  fgis_number     text NOT NULL DEFAULT '',           -- номер записи в реестре
  sent_at         timestamptz,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Принято — значит реестр вернул номер записи: без номера нечего печатать
  -- в свидетельстве, и «принято» в этом случае означало бы неправду.
  CONSTRAINT arshin_accepted_has_number CHECK (status <> 'принято' OR fgis_number <> ''),
  -- Ошибка без текста бесполезна: руководителю нечего читать и нечего править.
  CONSTRAINT arshin_error_has_text CHECK (status <> 'ошибка' OR error_text <> ''),
  -- Непригодный прибор без причины в фонд не уходит (подпункт «у»).
  CONSTRAINT arshin_bad_has_reason CHECK (applicable OR fail_reason <> '')
);

-- Очередь всегда читается разрезом «что не передано» и «что с ошибкой»,
-- а напоминание — разрезом «чему вышел срок».
CREATE INDEX arshin_records_status_idx ON arshin_records (status, due_date);
CREATE INDEX arshin_records_due_idx ON arshin_records (due_date) WHERE status IN ('готово', 'ошибка');
CREATE INDEX arshin_records_batch_idx ON arshin_records (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX arshin_records_request_idx ON arshin_records (request_id);
-- Выгрузка за период у руководителя идёт по дате поверки.
CREATE INDEX arshin_records_verified_idx ON arshin_records (verified_on);

COMMENT ON TABLE arshin_records IS
  'Сведения о результатах поверки для ФГИС «Аршин» и очередь их передачи. '
  'Состав полей — пункт 26 приказа Минпромторга России от 28.08.2020 № 2906, '
  'срок передачи — пункт 21 приказа от 31.07.2020 № 2510.';

-- Down Migration

DROP TABLE arshin_records;
DROP TABLE arshin_batches;
ALTER TABLE devices DROP COLUMN arshin_number;
ALTER TABLE device_types DROP COLUMN method_doc, DROP COLUMN etalons;
