-- Эквайринг и фискализация (пункт int-pay): безналичная оплата через платёжного
-- провайдера — QR СБП или платёжная ссылка, — уведомления провайдера об оплате
-- и чеки онлайн-кассы.
--
-- Отдельной миграцией, потому что наполняется не руками сотрудников, а
-- внешней службой: у платежей свой жизненный путь (создан → ожидает → оплачен →
-- возвращён), свои повторы и своя сверка с выпиской банка.
--
-- Наличные и перевод на карту остаются как были: поверитель берёт деньги на
-- адресе и держит их как подотчёт. Безнал через провайдера приходит сразу на
-- расчётный счёт ИП и в подотчёт не попадает — это правило держится на списке
-- PAY_HAND в src/rules.ts, а не на этой схеме.

-- Up Migration

-- Два новых способа оплаты в отметке по заявке. Строка `payments` по-прежнему
-- одна на заявку и по-прежнему отвечает на вопрос «чем и сколько заплатили»;
-- подробности прохождения платежа у провайдера лежат в online_payments.
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('наличные', 'перевод на карту', 'по счёту', 'не оплачено', 'СБП по QR', 'платёжная ссылка'));

-- Номер чека — в заявке (в её отметке об оплате): его спрашивает клиент и
-- показывает оператор, не заглядывая в платёж провайдера.
ALTER TABLE payments ADD COLUMN receipt_number  text;
ALTER TABLE payments ADD COLUMN receipt_sent_at timestamptz;

-- Платёж у провайдера. Строк на заявку может быть несколько: QR не оплатили,
-- сделали новый; ссылка выписана, потом клиент заплатил наличными. Действующим
-- считается последний не отменённый.
--
-- Сумма — снимок цены акта на момент создания платежа. Если после этого акт
-- изменили (добавили прибор, поставили скидку), сумма разъезжается, и закрыть
-- позицию с таким платежом нельзя: сначала отменить и создать заново. Оплаченный
-- платёж с разошедшейся суммой помечается `mismatch` и виден руководителю в сверке.
CREATE TABLE online_payments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id       text NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  provider         text NOT NULL,                       -- 'yookassa'
  external_id      text,                                -- идентификатор платежа у провайдера
  kind             text NOT NULL CHECK (kind IN ('qr', 'link')),
  amount           integer NOT NULL CHECK (amount > 0), -- сумма акта на момент создания
  status           text NOT NULL DEFAULT 'создан'
                   CHECK (status IN ('создан', 'ожидает', 'оплачен', 'отменён', 'возвращён', 'ошибка')),
  confirmation     text NOT NULL DEFAULT '',            -- строка QR (СБП) или адрес страницы оплаты
  idempotence_key  uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, -- ключ повтора запроса к провайдеру
  items            jsonb NOT NULL DEFAULT '[]',         -- позиции чека снимком: услуга, цена со скидкой, признаки
  customer_email   text NOT NULL DEFAULT '',            -- куда касса шлёт чек
  customer_phone   text NOT NULL DEFAULT '',
  paid_at          timestamptz,
  paid_amount      integer CHECK (paid_amount IS NULL OR paid_amount >= 0),
  mismatch         boolean NOT NULL DEFAULT false,      -- оплаченная сумма разошлась с актом
  receipt_id       text,                                -- чек у кассы
  receipt_status   text CHECK (receipt_status IN ('ожидает', 'зарегистрирован', 'ошибка')),
  receipt_number   text,                                -- номер фискального документа
  receipt_sent_at  timestamptz,                         -- когда касса отправила чек клиенту
  refund_id        text,                                -- возврат у провайдера
  refund_amount    integer CHECK (refund_amount IS NULL OR refund_amount > 0),
  refund_reason    text NOT NULL DEFAULT '',
  refund_receipt_number text,                           -- чек возврата
  refunded_at      timestamptz,
  error            text,                                -- последняя ошибка провайдера или кассы словами
  created_by       text REFERENCES staff (id),          -- кто показал QR или ссылку
  handled_by       text REFERENCES staff (id),          -- кто отменил или вернул
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT online_payments_items_is_array CHECK (jsonb_typeof(items) = 'array'),
  -- Оплаченный платёж знает, когда и сколько; возвращённый — почему.
  CONSTRAINT online_payments_paid_has_time CHECK (status <> 'оплачен' OR paid_at IS NOT NULL),
  CONSTRAINT online_payments_refund_has_reason CHECK (status <> 'возвращён' OR refund_reason <> '')
);

-- Уведомление провайдера ищет платёж по его идентификатору.
CREATE UNIQUE INDEX online_payments_external_idx ON online_payments (provider, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX online_payments_request_idx ON online_payments (request_id, id);
-- Сверка за день у руководителя — по времени оплаты.
CREATE INDEX online_payments_paid_idx ON online_payments (paid_at) WHERE paid_at IS NOT NULL;
-- Действующий (ещё не оплаченный) платёж по заявке.
CREATE INDEX online_payments_open_idx ON online_payments (request_id) WHERE status IN ('создан', 'ожидает');

-- Уведомления провайдера как они пришли. Пишутся все, включая непринятые:
-- «кто-то стучится без секрета» — это то, что нужно увидеть, а не отбросить.
-- Ключ повтора держит идемпотентность: провайдер доставляет уведомление
-- повторно, пока не получит 200, и второе такое же не должно ни второй раз
-- отметить оплату, ни пробить второй чек.
CREATE TABLE payment_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     text NOT NULL,
  event        text NOT NULL,                 -- имя события как его назвал провайдер
  external_id  text,                          -- платёж или возврат, о котором речь
  dedup_key    text UNIQUE,                   -- провайдер + событие + идентификатор + состояние
  ok           boolean NOT NULL,
  reason       text NOT NULL DEFAULT '',      -- почему не принято
  source_ip    text,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_events_external_idx ON payment_events (external_id, created_at);

-- Событие уведомлений «чек»: чек зарегистрирован кассой и отправлен клиенту.
ALTER TABLE notify_templates DROP CONSTRAINT notify_templates_event_check;
ALTER TABLE notify_templates ADD CONSTRAINT notify_templates_event_check
  CHECK (event IN ('заявка', 'напоминание', 'выезд', 'перенос', 'чек'));
ALTER TABLE notifications DROP CONSTRAINT notifications_event_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_check
  CHECK (event IN ('заявка', 'напоминание', 'выезд', 'перенос', 'чек'));

INSERT INTO notify_templates (event, channel, subject, body) VALUES
  ('чек', 'email', 'Чек за поверку от {дата}',
   E'Здравствуйте, {имя}!\n\n'
   'Оплата {сумма_оплаты} ₽ за услуги по адресу {адрес} получена.\n'
   'Кассовый чек № {номер_чека} отправлен вам на эту почту отдельным письмом от оператора фискальных данных.\n\n'
   '{подпись}'),
  ('чек', 'sms', '',
   'Оплата {сумма_оплаты} р получена, чек № {номер_чека} отправлен на {почта}. {контора}');

-- Down Migration
DELETE FROM notifications WHERE event = 'чек';
DELETE FROM notify_templates WHERE event = 'чек';
ALTER TABLE notifications DROP CONSTRAINT notifications_event_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_check
  CHECK (event IN ('заявка', 'напоминание', 'выезд', 'перенос'));
ALTER TABLE notify_templates DROP CONSTRAINT notify_templates_event_check;
ALTER TABLE notify_templates ADD CONSTRAINT notify_templates_event_check
  CHECK (event IN ('заявка', 'напоминание', 'выезд', 'перенос'));
DROP TABLE payment_events;
DROP TABLE online_payments;
ALTER TABLE payments DROP COLUMN receipt_sent_at;
ALTER TABLE payments DROP COLUMN receipt_number;
UPDATE payments SET method = 'не оплачено', amount = 0 WHERE method IN ('СБП по QR', 'платёжная ссылка');
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('наличные', 'перевод на карту', 'по счёту', 'не оплачено'));
