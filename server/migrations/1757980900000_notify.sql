-- Уведомления клиентам: шаблоны, очередь отправки и журнал доставки.
--
-- Отдельной миграцией по той же причине, что и связь с журналом: наполняется не
-- работой операторов, а внешними службами (почта, СМС-шлюз), живёт своим сроком
-- и сносится отдельно от рабочих данных.
--
-- Уведомления никого не заменяют: подтверждение даты по-прежнему собирает
-- оператор обзвоном накануне (пункт плана int-novofon и экран маршрута).
-- Письмо и СМС — второй канал к тому же разговору, и их отсутствие не должно
-- ломать ни приём заявки, ни выезд.

-- Up Migration

-- Шаблон сообщения. Ключ — событие и канал: у письма есть тема и место для
-- подробностей, у СМС — одна строка, и текст у них разный по необходимости,
-- а не по прихоти. Правит их руководитель на экране «Услуги и ставки»;
-- подстановки в фигурных скобках проверяются при сохранении, чтобы опечатка
-- в имени поля не уехала клиенту как «{имя_поверителя}».
CREATE TABLE notify_templates (
  event      text NOT NULL CHECK (event IN ('заявка', 'напоминание', 'выезд', 'перенос')),
  channel    text NOT NULL CHECK (channel IN ('email', 'sms')),
  subject    text NOT NULL DEFAULT '',        -- тема письма; у СМС пустая
  body       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,   -- выключенный шаблон = канал по событию молчит
  updated_by text REFERENCES staff (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event, channel)
);

-- Очередь отправки и итог по каждому сообщению.
--
-- Текст складывается в строку на момент постановки, а не при отправке: шаблон
-- руководитель может поправить в любую минуту, а клиент должен получить то,
-- что было обещано в момент события. По той же причине здесь лежит и адрес:
-- смена телефона в карточке не должна переадресовать уже поставленное СМС.
--
-- Ключ разбора (dedup_key) — «событие + заявка + канал + повод»: планировщик
-- ходит по кругу и обязан уметь не поставить одно и то же дважды.
CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event       text NOT NULL CHECK (event IN ('заявка', 'напоминание', 'выезд', 'перенос')),
  channel     text NOT NULL CHECK (channel IN ('email', 'sms')),
  request_id  text REFERENCES requests (id) ON DELETE CASCADE,
  client_id   uuid REFERENCES clients (id) ON DELETE SET NULL,
  dedup_key   text NOT NULL UNIQUE,
  address     text NOT NULL,                  -- адрес почты или номер в E.164
  subject     text NOT NULL DEFAULT '',
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'в очереди'
              CHECK (status IN ('в очереди', 'отправлено', 'ошибка', 'отменено')),
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  send_after  timestamptz NOT NULL DEFAULT now(),  -- раньше этого времени не берём
  sent_at     timestamptz,
  last_error  text,
  provider_id text,                           -- идентификатор сообщения у шлюза
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Проход очереди: что пора отправлять. Частичный индекс — потому что
-- отправленное из выборки уходит навсегда, а копится именно оно.
CREATE INDEX notifications_due_idx ON notifications (send_after)
  WHERE status IN ('в очереди', 'ошибка');
CREATE INDEX notifications_request_idx ON notifications (request_id, created_at);
CREATE INDEX notifications_status_idx ON notifications (status, created_at DESC);

-- Журнал доставки: по строке на попытку. Очередь показывает, чем дело
-- кончилось, журнал — сколько раз и обо что споткнулись по дороге.
-- Ответ шлюза храним как есть: разбирать чужую ошибку задним числом можно
-- только по её тексту.
CREATE TABLE notification_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  at              timestamptz NOT NULL DEFAULT now(),
  ok              boolean NOT NULL,
  response        text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_attempts_notification_idx ON notification_attempts (notification_id, at);

-- Согласие клиента. Спрашивает оператор при приёме заявки, галочка в форме.
-- Без него не уходит ничего: ни письма, ни СМС.
ALTER TABLE requests ADD COLUMN notify_consent boolean NOT NULL DEFAULT false;
-- В карточке клиента согласие держится как последнее сказанное: оператор
-- видит его при следующем звонке и не спрашивает второй раз.
ALTER TABLE clients ADD COLUMN notify_consent boolean NOT NULL DEFAULT false;

-- Тексты по умолчанию. Это заготовка, а не окончательный текст: руководитель
-- правит их на экране и в миграцию не возвращается.
INSERT INTO notify_templates (event, channel, subject, body) VALUES
  ('заявка', 'email', 'Заявка на {дата}: поверка счётчиков',
   E'Здравствуйте, {имя}!\n\n'
   'Ваша заявка принята на {дата}, ожидайте мастера с {окно_с} до {окно_до}.\n'
   'Адрес: {адрес}.\n'
   'Услуги: {услуги}.\n'
   'Предварительная стоимость: {сумма} ₽. Оплата на месте: {оплата}.\n\n'
   'Накануне мы позвоним и подтвердим время. Если планы изменились — '
   'сообщите нам по телефону {телефон_конторы}.\n\n'
   '{подпись}'),
  ('заявка', 'sms',  '',
   'Заявка принята: {дата}, с {окно_с} до {окно_до}, {адрес}. Предварительно {сумма} р, оплата на месте. {контора}'),
  ('напоминание', 'email', 'Напоминание: мастер приедет {дата}',
   E'Здравствуйте, {имя}!\n\n'
   'Напоминаем: завтра, {дата}, с {окно_с} до {окно_до} к вам приедет мастер '
   'по адресу {адрес}.\n'
   'Подготовьте, пожалуйста, доступ к приборам.\n\n'
   'Если время не подходит — позвоните нам по телефону {телефон_конторы}, перенесём.\n\n'
   '{подпись}'),
  ('напоминание', 'sms', '',
   'Завтра {дата} с {окно_с} до {окно_до} мастер по адресу {адрес}. Перенести: {телефон_конторы}. {контора}'),
  ('выезд', 'email', 'Сегодня к вам приедет {поверитель}',
   E'Здравствуйте, {имя}!\n\n'
   'Сегодня, {дата}, к вам приедет наш поверитель {поверитель}.\n'
   'Окно прибытия: с {окно_с} до {окно_до}. Адрес: {адрес}.\n\n'
   '{подпись}'),
  ('выезд', 'sms', '',
   'Сегодня с {окно_с} до {окно_до} приедет {поверитель}, {адрес}. {контора}'),
  ('перенос', 'email', 'Заявка перенесена на {дата}',
   E'Здравствуйте, {имя}!\n\n'
   'Ваша заявка перенесена с {прежняя_дата} на {дата}, '
   'окно прибытия с {окно_с} до {окно_до}.\n'
   'Адрес прежний: {адрес}.\n\n'
   'Если новая дата не подходит — позвоните по телефону {телефон_конторы}.\n\n'
   '{подпись}'),
  ('перенос', 'sms', '',
   'Заявка перенесена на {дата}, с {окно_с} до {окно_до}, {адрес}. {контора}');

-- Down Migration
ALTER TABLE clients DROP COLUMN notify_consent;
ALTER TABLE requests DROP COLUMN notify_consent;
DROP TABLE notification_attempts;
DROP TABLE notifications;
DROP TABLE notify_templates;
