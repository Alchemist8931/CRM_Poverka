-- Очистка рабочего контура от демо-данных (пункт live-ip, 18.09.2026).
--
-- Контур на временном адресе стал рабочим, а в базе лежал демо-сид прототипа
-- (npm run seed) и следы приёмочных испытаний: вымышленные клиенты, заявки,
-- маршруты, акты, сотрудники без логина, учётки uat.* и autotest.
--
-- Что остаётся: справочники — города, услуги и прайс, типы приборов, шаблоны
-- уведомлений — они из книги пункта req-refs, не демо; и учётные записи с
-- логином, кроме испытательных. Что уходит — всё, что накопилось поверх
-- справочников. Снимки в бакете скриптом не трогаются: строки photos исчезают,
-- объекты остаются до срока хранения (be-photos).
--
-- Повторный запуск безопасен: TRUNCATE и DELETE по уже пустым таблицам ничего
-- не делают, счётчики «после» те же. Перед запуском — копия базы:
--   sudo systemctl start uchetkin-backup && sudo journalctl -u uchetkin-backup -n 3
-- Запуск на машине контура:
--   sudo docker exec -i uchetkin-postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < purge-demo.sql

\echo 'до:'
SELECT 'requests' AS t, count(*) FROM requests
UNION ALL SELECT 'clients', count(*) FROM clients
UNION ALL SELECT 'routes', count(*) FROM routes
UNION ALL SELECT 'photos', count(*) FROM photos
UNION ALL SELECT 'audit_log', count(*) FROM audit_log
UNION ALL SELECT 'staff', count(*) FROM staff
UNION ALL SELECT 'staff с логином', count(*) FROM staff WHERE coalesce(login, '') <> '';

BEGIN;

TRUNCATE TABLE
  requests, clients, client_history,
  routes, stops, route_chat, route_builder, wait_list,
  devices, photos, payments, handovers,
  days, absences,
  calls, call_events, call_line,
  audit_log,
  arshin_records, arshin_batches,
  notifications, notification_attempts
  RESTART IDENTITY CASCADE;

-- Сотрудники демо-набора логина не имеют; испытания заводили uat.op, uat.ver,
-- uat.new-* и техническую autotest. Компетенции уходят вместе с ними.
DELETE FROM staff_skills
 WHERE staff_id IN (SELECT id FROM staff
                     WHERE coalesce(login, '') = '' OR login LIKE 'uat.%' OR login = 'autotest');
DELETE FROM staff
 WHERE coalesce(login, '') = '' OR login LIKE 'uat.%' OR login = 'autotest';

COMMIT;

\echo 'после:'
SELECT 'requests' AS t, count(*) FROM requests
UNION ALL SELECT 'clients', count(*) FROM clients
UNION ALL SELECT 'routes', count(*) FROM routes
UNION ALL SELECT 'photos', count(*) FROM photos
UNION ALL SELECT 'audit_log', count(*) FROM audit_log
UNION ALL SELECT 'staff', count(*) FROM staff
UNION ALL SELECT 'staff с логином', count(*) FROM staff WHERE coalesce(login, '') <> ''
UNION ALL SELECT 'cities', count(*) FROM cities
UNION ALL SELECT 'services', count(*) FROM services
UNION ALL SELECT 'device_types', count(*) FROM device_types;
