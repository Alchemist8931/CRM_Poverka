# Боевой контур. Облако — то же, что у dev (пункт cloud-account); каталог —
# отдельный, crm-prod: его заводит владелец в консоли и выдаёт сервисному
# аккаунту deploy (ajej12f1qn934ja0pmof) роль admin на каталог — у этого
# аккаунта нет прав на облако целиком, каталог он создать не может.
# Заглушка ниже не проходит проверку формата: применить не тот каталог нельзя.
cloud_id  = "b1gq9bdjmkdml2pguse6"
folder_id = "PUT-PROD-FOLDER-ID-HERE"

env = "prod"

# Та же зона, что у dev: в ней проверены и платформа standard-v3, и класс
# b2.medium Managed PostgreSQL (учения cloud-ops, 18.09.2026). Зона ВМ и
# кластера — поле пересоздания, менять после apply нельзя.
zone = "ru-central1-b"

# Временное имя, на котором система работает всю разработку и первые недели
# эксплуатации. Боевой домен — пункт cloud-domain: меняется эта строка,
# сертификат перевыпускается сам.
app_domain = "uchetkin.elpa.systems"

# Зона живёт у стороннего регистратора: A-запись на app_external_ip заводится один раз руками.
# При переезде на собственный домен — manage_dns_zone = true и делегирование NS.
manage_dns_zone = false

# Пока A-записи uchetkin.elpa.systems нет, Let's Encrypt домен не подтвердит:
# первый apply — с выключенным TLS, Caddy слушает :80. Как только владелец
# завёл запись на адрес из вывода app_external_ip — true и повторный apply.
tls_enabled = false

# ВМ по арх. решению: 2 vCPU (100 %), 4 ГБ, 30 ГБ SSD, еженедельный снимок диска.
vm_cores             = 2
vm_core_fraction     = 100
vm_memory            = 4
vm_disk_size         = 30
vm_snapshot_schedule = true

# Managed PostgreSQL: один хост, автоматические копии 14 дней. Класс b3-c1-m4
# из arch в облаке не существует (учения cloud-ops, 18.09.2026): взят b2.medium —
# 2 vCPU с долей 20 %, 4 ГБ, network-ssd; на нём же прошли учения по восстановлению.
# Снаружи кластер слушает только 6432 и только по TLS: приложение ходит с
# sslmode=verify-full и корневым сертификатом облака из образа (cloud-init
# пишет PGSSLMODE и PGSSLROOTCERT в app.env, когда managed_postgres = true).
managed_postgres       = true
pg_version             = "16"
pg_resource_preset     = "b2.medium"
pg_disk_size           = 20
pg_backup_retain_days  = 14
pg_environment         = "PRODUCTION"
pg_deletion_protection = true

# Имена бакетов глобальны на всё Object Storage. Свободность uchetkin-prod-acts,
# -calls, -audit, -ops проверяется перед apply (HEAD по S3-адресу — 404);
# занято — короткая добавка сюда, например "asb".
bucket_suffix = ""

# Секреты боевого контура от случайного удаления защищены: снять защиту —
# осознанное действие в консоли, а не побочный эффект terraform destroy.
lockbox_deletion_protection = true

# Сроки хранения по арх. решению, раздел 7.
acts_cold_after_days  = 90
calls_cold_after_days = 30
calls_ice_after_days  = 365

# Белый список для SSH: сюда вписываются реальные адреса, с которых ведётся
# обслуживание. Пустой список — порт 22 снаружи закрыт.
ssh_allowed_cidrs = []
ssh_public_keys   = []

# Безопасность (пункт cloud-sec, сводка — docs/security.md).
# Журнал аудита облака хранится три года: столько же живут события в журнале
# действий пользователей, чтобы разбирать спорный случай по обеим лентам сразу.
audit_trail_enabled     = true
audit_retain_days       = 1095
audit_cold_after_days   = 30
kms_deletion_protection = true

# Профиль Smart Web Security описан и включён, но в тракт встаёт только вместе
# с балансировщиком: ingress_mode = "alb". Сейчас режим vm — защиту периметра
# держат группа безопасности и Caddy, см. docs/security.md.
enable_sws = true

# Серийная консоль — запасной вход, пока не выданы ключи и адреса для SSH.
# После выдачи выключить: serial_port_enable = false.
serial_port_enable = true

labels = {
  contour = "prod"
}
