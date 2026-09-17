-- Хранилище снимков акта (пункт be-photos).
--
-- Сам кадр лежит в Object Storage, в базе — только ключ, размер, время и
-- миниатюра. Что понадобилось сверх строки из be-schema:
--
--  * размеры кадра — их считает сервер, когда делает миниатюру. Поверителю в
--    акте видно «1600×1200», и по ним же видно, что сжатие на телефоне сработало;
--  * пометка об удалении. Удаляет только руководитель, и удаление — это пометка,
--    а не стирание: срок хранения фото не меньше шести лет (arch, раздел 7), а
--    у приложения на бакет и нет права удалять (storage.viewer + storage.uploader,
--    infra/storage.tf). Из акта кадр уходит, из хранилища — нет, и в журнале
--    остаётся, кто и когда его убрал.

-- Up Migration

ALTER TABLE photos
  ADD COLUMN width      integer CHECK (width IS NULL OR width > 0),
  ADD COLUMN height     integer CHECK (height IS NULL OR height > 0),
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by text REFERENCES staff (id);

COMMENT ON COLUMN photos.storage_key IS
  'Ключ оригинала: acts/год/месяц/заявка/прибор/кадр.jpg. Год и месяц в начале — '
  'правила жизненного цикла бакета работают по префиксу.';
COMMENT ON COLUMN photos.thumb_key IS
  'Ключ миниатюры 320 px: thumbs/год/месяц/заявка/прибор/кадр.jpg. Отдельная ветка, '
  'чтобы миниатюры не уезжали в холодное хранилище вместе с оригиналами.';
COMMENT ON COLUMN photos.deleted_at IS
  'Кадр убран из акта. Файл в хранилище остаётся: срок хранения — не меньше шести лет.';

-- Пометка об удалении не должна оставаться без имени того, кто её поставил.
ALTER TABLE photos
  ADD CONSTRAINT photos_deleted_needs_actor
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));

-- Кадры прибора всегда читаются без удалённых — частичный индекс ровно под это.
DROP INDEX photos_device_idx;
CREATE INDEX photos_device_idx ON photos (device_id, id) WHERE deleted_at IS NULL;

-- Down Migration

DROP INDEX photos_device_idx;
CREATE INDEX photos_device_idx ON photos (device_id);

ALTER TABLE photos
  DROP CONSTRAINT photos_deleted_needs_actor,
  DROP COLUMN deleted_by,
  DROP COLUMN deleted_at,
  DROP COLUMN height,
  DROP COLUMN width;
