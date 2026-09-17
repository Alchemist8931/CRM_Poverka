-- Журнал действий: неизменяемость и срок хранения (пункт be-audit).
--
-- Строку в audit_log пишет промежуточный слой API (server/src/api/audit.ts), и
-- это единственный способ туда попасть: править и удалять записи через API
-- нельзя — журнал по 152-ФЗ и по деньгам ценен ровно тем, что задним числом его
-- не переписать. Запрет держится не на дисциплине обработчиков, а на базе:
-- забыть триггер нельзя так же, как забыть проверку роли в обработчике.
--
-- Срок хранения — три года (docs/security.md, раздел о журналах). Пока он не
-- вышел, запись не удаляется вовсе; после — её убирает `npm run audit:prune`.
-- Поэтому запрет на DELETE и сделан условным: иначе чистку пришлось бы делать
-- суперпользователем, то есть тем же правом, которым журнал и подчищают.

-- Up Migration

CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Журнал действий не правится: запись % уже записана.', OLD.id;
  END IF;
  IF OLD.at > now() - interval '3 years' THEN
    RAISE EXCEPTION 'Журнал действий хранится три года: запись % от % удалять рано.', OLD.id, OLD.at;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

COMMENT ON TABLE audit_log IS
  'Журнал действий. Пишется промежуточным слоем API, правке и удалению не подлежит: '
  'триггер audit_log_immutable запрещает UPDATE всегда, а DELETE — до истечения трёх лет.';

-- Экран руководителя фильтрует по сотруднику, сущности и датам, а ищет по
-- номеру заявки — то есть по entity_id и по содержимому снимков «до» и «после».
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC);

-- Down Migration

DROP INDEX audit_log_action_idx;
DROP TRIGGER audit_log_immutable ON audit_log;
DROP FUNCTION audit_log_immutable();
