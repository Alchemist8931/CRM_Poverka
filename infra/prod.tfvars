# Боевой контур. Заполнить cloud_id и folder_id значениями из пункта cloud-account.
cloud_id  = "PUT-CLOUD-ID-HERE"
folder_id = "PUT-PROD-FOLDER-ID-HERE"

env  = "prod"
zone = "ru-central1-a"

# Временное имя, на котором система работает всю разработку и первые недели
# эксплуатации. Боевой домен — пункт cloud-domain: меняется эта строка,
# сертификат перевыпускается сам.
app_domain = "uchetkin.elpa.systems"

# Зона живёт у стороннего регистратора: A-запись на app_external_ip заводится один раз руками.
# При переезде на собственный домен — manage_dns_zone = true и делегирование NS.
manage_dns_zone = false

# ВМ по арх. решению: 2 vCPU (100 %), 4 ГБ, 30 ГБ SSD, еженедельный снимок диска.
vm_cores             = 2
vm_core_fraction     = 100
vm_memory            = 4
vm_disk_size         = 30
vm_snapshot_schedule = true

# Managed PostgreSQL: один хост b3-c1-m4, автоматические копии 14 дней.
managed_postgres       = true
pg_resource_preset     = "b3-c1-m4"
pg_disk_size           = 20
pg_backup_retain_days  = 14
pg_environment         = "PRODUCTION"
pg_deletion_protection = true

# Сроки хранения по арх. решению, раздел 7.
acts_cold_after_days  = 90
calls_cold_after_days = 30
calls_ice_after_days  = 365

# Белый список для SSH: сюда вписываются реальные адреса, с которых ведётся
# обслуживание. Пустой список — порт 22 снаружи закрыт.
ssh_allowed_cidrs = []
ssh_public_keys   = []

labels = {
  contour = "prod"
}
