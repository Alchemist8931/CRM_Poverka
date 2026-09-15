# ─────────────────────────────────────────────────────────────────────────────
# Облако и контур
# ─────────────────────────────────────────────────────────────────────────────

variable "cloud_id" {
  description = "Идентификатор облака (пункт cloud-account)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{20}$", var.cloud_id))
    error_message = "cloud_id — 20 символов из консоли облака. В tfvars лежит заглушка, её нужно заменить."
  }
}

variable "folder_id" {
  description = "Идентификатор каталога контура: свой для dev, свой для prod."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{20}$", var.folder_id))
    error_message = "folder_id — 20 символов из консоли облака. В tfvars лежит заглушка, её нужно заменить."
  }
}

variable "env" {
  description = "Имя контура. Входит в имена ресурсов и в метки."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env может быть только dev или prod."
  }
}

variable "project" {
  description = "Короткое имя продукта в именах ресурсов."
  type        = string
  default     = "uchetkin"
}

variable "zone" {
  description = "Зона доступности. ВМ и кластер базы стоят в одной зоне (arch, раздел 2)."
  type        = string
  default     = "ru-central1-a"
}

variable "timezone" {
  description = "Часовой пояс ВМ. Асбест — Свердловская область, UTC+5."
  type        = string
  default     = "Asia/Yekaterinburg"
}

variable "labels" {
  description = "Дополнительные метки на все ресурсы, которые их поддерживают."
  type        = map(string)
  default     = {}
}

# ─────────────────────────────────────────────────────────────────────────────
# Адрес системы. Ни одно имя не зашито в код: и временное, и боевое живут здесь.
# ─────────────────────────────────────────────────────────────────────────────

variable "app_domain" {
  description = <<-EOT
    Имя, по которому открывается система в этом контуре. На время разработки и первых
    недель эксплуатации — временное (см. README, раздел «Что меняется при переезде
    на боевой домен»). Переезд = смена этой переменной и перевыпуск сертификата.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.app_domain))
    error_message = "app_domain — доменное имя без схемы и без слэша, например app.example.ru."
  }
}

variable "api_path_prefix" {
  description = "Префикс, на котором Caddy или балансировщик проксирует API. Фронт собирает адрес API из него."
  type        = string
  default     = "/api"
}

variable "webhook_path_prefix" {
  description = "Префикс адресов вебхуков (Новофон, позже платёжный провайдер)."
  type        = string
  default     = "/api/webhooks"
}

variable "manage_dns_zone" {
  description = <<-EOT
    Создавать публичную зону Cloud DNS для dns_zone_domain.
    false — имя живёт в чужом DNS (например, поддомен домена подрядчика у регистратора):
    Terraform зону не трогает, A-запись заводится один раз руками на статический адрес
    из выхода vm_external_ip.
  EOT
  type        = bool
  default     = false
}

variable "dns_zone_domain" {
  description = "Зона, которой владеет этот контур, с точкой на конце: example.ru. Пусто — берётся app_domain."
  type        = string
  default     = ""
}

variable "dns_ttl" {
  description = "TTL записей зоны. Перед переездом на боевой домен имеет смысл снизить до 60."
  type        = number
  default     = 300
}

# ─────────────────────────────────────────────────────────────────────────────
# Сеть и доступ снаружи
# ─────────────────────────────────────────────────────────────────────────────

variable "subnet_cidr" {
  description = "Диапазон подсети контура."
  type        = string
  default     = "10.10.0.0/24"
}

variable "ssh_allowed_cidrs" {
  description = <<-EOT
    Белый список адресов для SSH на ВМ. Пустой список — правила 22/tcp нет вовсе,
    и это рабочее состояние по умолчанию: вход через серийную консоль в консоли облака.
  EOT
  type        = list(string)
  default     = []
}

variable "ssh_public_keys" {
  description = "Открытые ключи SSH для пользователя vm_user. Открытый ключ секретом не является."
  type        = list(string)
  default     = []
}

variable "vm_user" {
  description = "Пользователь на ВМ, от которого работает Docker Compose."
  type        = string
  default     = "uchetkin"
}

variable "open_http_port" {
  description = <<-EOT
    Открыть снаружи 80/tcp. Нужен для редиректа с http:// и для резервной проверки
    Let's Encrypt по HTTP-01. Выключается одной переменной: при закрытом 80 Caddy
    выпускает сертификат через TLS-ALPN-01 на 443.
  EOT
  type        = bool
  default     = true
}

variable "open_quic_port" {
  description = "Открыть 443/udp — HTTP/3. Заметно помогает поверителю на мобильном интернете (arch, раздел 4)."
  type        = bool
  default     = true
}

variable "ingress_mode" {
  description = <<-EOT
    Как система принимает запросы снаружи.
      vm  — публичный адрес на ВМ, TLS и сертификат Let's Encrypt делает Caddy.
            Это решение arch, раздел 3: ALB при одной ВМ стоит почти как сама ВМ.
      alb — Application Load Balancer с сертификатом из Certificate Manager
            и проверкой здоровья /health. Полностью описан, включается этой переменной.
  EOT
  type        = string
  default     = "vm"

  validation {
    condition     = contains(["vm", "alb"], var.ingress_mode)
    error_message = "ingress_mode может быть только vm или alb."
  }
}

variable "health_check_path" {
  description = "Путь проверки здоровья для балансировщика и мониторинга."
  type        = string
  default     = "/health"
}

variable "app_port" {
  description = "Порт, на котором Caddy слушает HTTP внутри контура (используется целевой группой ALB)."
  type        = number
  default     = 80
}

# ─────────────────────────────────────────────────────────────────────────────
# Виртуальная машина
# ─────────────────────────────────────────────────────────────────────────────

variable "vm_image_family" {
  description = "Семейство образа ВМ."
  type        = string
  default     = "ubuntu-2404-lts-oslogin"
}

variable "vm_platform_id" {
  description = "Платформа ВМ. standard-v3 — Intel Ice Lake (arch, раздел 2)."
  type        = string
  default     = "standard-v3"
}

variable "vm_cores" {
  description = "Число vCPU."
  type        = number
  default     = 2
}

variable "vm_core_fraction" {
  description = "Гарантированная доля vCPU в процентах. prod — 100, dev — 20."
  type        = number
  default     = 100
}

variable "vm_memory" {
  description = "Память ВМ, ГБ."
  type        = number
  default     = 4
}

variable "vm_disk_size" {
  description = "Загрузочный диск, ГБ."
  type        = number
  default     = 30
}

variable "vm_disk_type" {
  description = "Тип загрузочного диска."
  type        = string
  default     = "network-ssd"
}

variable "vm_snapshot_schedule" {
  description = "Еженедельные снимки загрузочного диска (в смете prod — 110 ₽/мес)."
  type        = bool
  default     = true
}

variable "vm_snapshot_expression" {
  description = "Расписание снимков в формате cron, время UTC. По умолчанию — воскресенье, 21:00 UTC (2:00 по Екатеринбургу)."
  type        = string
  default     = "0 21 * * SUN"
}

variable "vm_snapshot_retain_count" {
  description = "Сколько снимков диска хранить."
  type        = number
  default     = 4
}

variable "monitoring_agent_image" {
  description = "Образ агента мониторинга, который поднимается на ВМ через Docker Compose."
  type        = string
  default     = "cr.yandex/yc/unified-agent:latest"
}

variable "monitoring_agent_enabled" {
  description = "Поднимать агент мониторинга на ВМ."
  type        = bool
  default     = true
}

# ─────────────────────────────────────────────────────────────────────────────
# База данных
# ─────────────────────────────────────────────────────────────────────────────

variable "managed_postgres" {
  description = <<-EOT
    Поднимать Managed Service for PostgreSQL. В dev по решению arch базы как сервиса нет —
    PostgreSQL контейнером на той же ВМ, это экономит около 2 600 ₽ в месяц.
  EOT
  type        = bool
  default     = true
}

variable "pg_version" {
  description = "Версия PostgreSQL."
  type        = string
  default     = "16"
}

variable "pg_resource_preset" {
  description = "Класс хоста базы. b3-c1-m4 — 1 vCPU (50 %), 4 ГБ (arch, раздел 2)."
  type        = string
  default     = "b3-c1-m4"
}

variable "pg_disk_size" {
  description = "Диск базы, ГБ."
  type        = number
  default     = 20
}

variable "pg_disk_type" {
  description = "Тип диска базы."
  type        = string
  default     = "network-ssd"
}

variable "pg_environment" {
  description = "Окружение кластера: PRODUCTION или PRESTABLE."
  type        = string
  default     = "PRODUCTION"
}

variable "pg_backup_retain_days" {
  description = "Срок хранения автоматических резервных копий, дней."
  type        = number
  default     = 14
}

variable "pg_backup_window_hour" {
  description = "Час начала окна резервного копирования, UTC."
  type        = number
  default     = 20
}

variable "pg_db_name" {
  description = "Имя базы приложения."
  type        = string
  default     = "uchetkin"
}

variable "pg_user_name" {
  description = "Пользователь базы, от которого работает приложение."
  type        = string
  default     = "uchetkin_app"
}

variable "pg_deletion_protection" {
  description = "Защита кластера от удаления."
  type        = bool
  default     = true
}

# ─────────────────────────────────────────────────────────────────────────────
# Object Storage
# ─────────────────────────────────────────────────────────────────────────────

variable "bucket_suffix" {
  description = <<-EOT
    Хвост в именах бакетов. Имена в Object Storage глобальные: если
    uchetkin-prod-acts уже занят кем-то в облаке, сюда пишется короткая добавка.
  EOT
  type        = string
  default     = ""
}

variable "acts_cold_after_days" {
  description = "Через сколько дней фото актов уходят в холодное хранилище (arch, раздел 7 — 90 дней)."
  type        = number
  default     = 90
}

variable "calls_cold_after_days" {
  description = "Через сколько дней записи разговоров уходят в холодное хранилище (arch — 30 дней)."
  type        = number
  default     = 30
}

variable "calls_ice_after_days" {
  description = "Через сколько дней записи разговоров уходят в ледяное хранилище (arch — год)."
  type        = number
  default     = 365
}

variable "noncurrent_cold_after_days" {
  description = "Через сколько дней в холодное хранилище уходят неактуальные версии объектов."
  type        = number
  default     = 30
}

variable "storage_access_key" {
  description = "Статический ключ сервисного аккаунта Terraform для S3-совместимого API. Только через TF_VAR_storage_access_key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "storage_secret_key" {
  description = "Секретная часть того же ключа. Только через TF_VAR_storage_secret_key."
  type        = string
  default     = ""
  sensitive   = true
}

# ─────────────────────────────────────────────────────────────────────────────
# Lockbox
# ─────────────────────────────────────────────────────────────────────────────

variable "lockbox_external_secrets" {
  description = <<-EOT
    Секреты внешних сервисов, которые заводятся пустыми и наполняются человеком
    (или отдельным пунктом плана) уже в консоли: ключ туда не попадает ни в код,
    ни в состояние Terraform. Ключ карты — суффикс имени, значение — описание.
  EOT
  type        = map(string)
  default = {
    novofon = "Телефония Новофон: API-ключ, секрет подписи вебхуков, номера"
    arshin  = "ФГИС «Аршин»: ключ доступа и реквизиты аккредитации"
    payment = "Эквайринг и касса: ключи платёжного провайдера (подключается последним)"
    smtp    = "Отправка почты и СМС: логин, пароль, адрес отправителя"
    maps    = "Яндекс Карты: ключ API с ограничением по домену"
  }
}

variable "lockbox_deletion_protection" {
  description = "Защита секретов от удаления."
  type        = bool
  default     = false
}
