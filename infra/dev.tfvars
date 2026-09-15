# Контур разработки. Заполнить cloud_id и folder_id значениями из пункта cloud-account:
# с заглушками terraform plan остановится на проверке формата идентификатора.
cloud_id  = "PUT-CLOUD-ID-HERE"
folder_id = "PUT-DEV-FOLDER-ID-HERE"

env  = "dev"
zone = "ru-central1-a"

# Временное имя. Боевой домен подключается в самом конце проекта (пункт cloud-domain):
# переезд — это смена значения здесь и перевыпуск сертификата, ничего больше.
app_domain = "dev.uchetkin.elpa.systems"

# Зона живёт у стороннего регистратора: A-запись на app_external_ip заводится один раз руками.
manage_dns_zone = false

# ВМ послабее и с долей vCPU 20 %: контур выключается на ночь и выходные.
vm_cores             = 2
vm_core_fraction     = 20
vm_memory            = 4
vm_disk_size         = 20
vm_snapshot_schedule = false

# Базы как сервиса в dev нет: PostgreSQL контейнером на той же ВМ (arch, раздел 2).
managed_postgres = false

# Сроки перехода в холодное хранение в dev укорочены — правило должно
# проверяться, а не ждать три месяца.
acts_cold_after_days  = 30
calls_cold_after_days = 30
calls_ice_after_days  = 90

# Белый список для SSH. Пустой список — правила 22/tcp нет вовсе,
# вход остаётся через серийную консоль в консоли облака.
ssh_allowed_cidrs = []
ssh_public_keys   = []

# Безопасность (пункт cloud-sec, сводка — docs/security.md).
# Журнал аудита в dev живёт три месяца: правило должно проверяться,
# а хранить годами события тестового контура незачем.
audit_trail_enabled   = true
audit_retain_days     = 90
audit_cold_after_days = 15

# Ключ шифрования dev удаляется вместе с контуром — данных, которые нельзя
# потерять, здесь нет.
kms_deletion_protection = false

labels = {
  contour = "dev"
}
