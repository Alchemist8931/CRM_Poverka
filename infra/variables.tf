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

variable "tls_enabled" {
  description = <<-EOT
    Держит ли Caddy сертификат на app_domain.

    true — Caddy слушает домен и сам получает сертификат Let's Encrypt.
    false — слушает :80 без шифрования.

    Выключается на то время, пока A-запись домена ещё не заведена: Let's Encrypt
    проверяет владение доменом обращением по этому же имени, и без записи
    выпуск сертификата не проходит, а Caddy остаётся без рабочего слушателя.
    Как только запись появилась — true и повторный apply.

    В режиме ingress_mode = alb не действует: сертификат держит балансировщик.
  EOT
  type        = bool
  default     = true
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

# ─── Переезд на боевой домен (пункт cloud-domain) ────────────────────────────

variable "legacy_redirect_from" {
  description = <<-EOT
    Старые адреса контура, с которых Caddy на ВМ отвечает постоянным редиректом
    (301) на https://<app_domain>: закладки сотрудников и ссылки в переписке
    должны открываться ещё не меньше 30 дней после переезда. Значение — адрес
    сайта в синтаксисе Caddy: "http://<статический адрес>" для голого IP
    (сертификат на адрес не выпускается), "<старое имя>" без схемы для имени
    (Caddy получит на него сертификат сам). Пустой список — блока редиректа нет.
    Действует только при tls_enabled = true: пока контур сам живёт на :80,
    редиректить не с чего. Убирается через 30 дней после переезда.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for a in var.legacy_redirect_from : can(regex("^(https?://)?[a-z0-9.-]+$", a))
    ])
    error_message = "legacy_redirect_from — имена или адреса без пути и порта, при необходимости со схемой http://."
  }
}

variable "mail_records_enabled" {
  description = <<-EOT
    Заводить в зоне записи почтового домена для Яндекс 360 для бизнеса: MX,
    SPF, DMARC, подтверждение владения и DKIM (когда заданы ключи ниже).
    Действует только вместе с manage_dns_zone = true.
  EOT
  type        = bool
  default     = false
}

variable "mail_verification_txt" {
  description = <<-EOT
    Строка подтверждения домена из админки Яндекс 360 («yandex-verification: …»).
    Кладётся TXT-записью на вершину зоны. Пусто — запись не заводится.
  EOT
  type        = string
  default     = ""
}

variable "mail_dkim_public_key" {
  description = <<-EOT
    Значение TXT-записи DKIM из админки Яндекс 360 целиком («v=DKIM1; k=rsa; t=s; p=…»).
    Селектор у Яндекса — mail, запись mail._domainkey.<зона>. Пусто — запись не заводится,
    и письма уходят без подписи домена.
  EOT
  type        = string
  default     = ""
}

variable "dmarc_policy" {
  description = "Политика DMARC: none — только отчёты, quarantine — в спам, reject — отклонять. Начинать с quarantine."
  type        = string
  default     = "quarantine"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy — none, quarantine или reject."
  }
}

variable "dmarc_rua" {
  description = "Куда слать сводные отчёты DMARC. Пусто — postmaster@<зона>."
  type        = string
  default     = ""
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

  validation {
    condition     = !contains(var.ssh_allowed_cidrs, "0.0.0.0/0")
    error_message = "SSH открытым всему интернету не бывает: 0.0.0.0/0 в ssh_allowed_cidrs запрещён. Нужен доступ откуда угодно — серийная консоль или OS Login."
  }
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

variable "vm_name" {
  description = <<-EOT
    Имя и внутреннее имя хоста ВМ. Пусто — "<project>-<env>-app".
    Задаётся там, где Terraform принял уже существующую машину: имя хоста
    менять нельзя, это пересоздание ВМ, а не правка.
  EOT
  type        = string
  default     = ""
}

variable "vm_image_family" {
  description = "Семейство образа ВМ. Не действует, когда задан vm_image_id."
  type        = string
  default     = "ubuntu-2404-lts-oslogin"
}

variable "vm_image_id" {
  description = <<-EOT
    Образ загрузочного диска по идентификатору. Пусто — берётся последний
    образ семейства vm_image_family.

    Задаётся у принятой в состояние машины: в семействе каждые пару недель
    появляется новый образ, а образ загрузочного диска — поле пересоздания.
    Со «последним из семейства» plan предлагал бы заменить работающую ВМ
    при каждом обновлении образа в облаке.
  EOT
  type        = string
  default     = ""
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
# Реестр образов (пункт cloud-cicd)
# ─────────────────────────────────────────────────────────────────────────────

variable "registry_keep_images" {
  description = <<-EOT
    Сколько последних сборок хранить в каждом репозитории реестра. Откат делается
    тегом предыдущего релиза, поэтому запас нужен: десяти хватает на неделю правок.
  EOT
  type        = number
  default     = 10
}

variable "registry_expire_period" {
  description = "Через сколько удалять сборки сверх запаса. Облако принимает только кратное 24h."
  type        = string
  default     = "720h"

  validation {
    condition     = can(regex("^[0-9]+h$", var.registry_expire_period)) && tonumber(trimsuffix(var.registry_expire_period, "h")) % 24 == 0
    error_message = "Срок задаётся часами и кратен 24h — например 168h или 720h."
  }
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
  description = <<-EOT
    Класс хоста базы. В arch (раздел 2) записан b3-c1-m4, но такого класса в
    Managed PostgreSQL нет — API отвечает «not available», проверено на учениях
    cloud-ops 18.09.2026 (yc managed-postgresql resource-preset list). Ближайший
    существующий burstable-класс — b2.medium: 2 vCPU (доля 20 %), 4 ГБ.
  EOT
  type        = string
  default     = "b2.medium"
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

variable "extra_cors_origins" {
  description = <<-EOT
    Дополнительные источники, которым бакет снимков разрешает класть кадры из
    браузера, кроме https://<app_domain>. Нужно только dev, пока он открыт по
    http и IP (docs/uat.md, замечание 6а); в prod оставлять пустым.
  EOT
  type        = list(string)
  default     = []
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
    maps    = "Яндекс Карты: записи geocoder_key (только сервер) и jsapi_key (ограничен доменом)"
    alerts  = "Оповещения сторожа (watchdog.tf): записи telegram_bot_token и telegram_chat_id"
  }
}

variable "lockbox_deletion_protection" {
  description = "Защита секретов от удаления."
  type        = bool
  default     = false
}

# ─────────────────────────────────────────────────────────────────────────────
# Безопасность: ключи шифрования, аудит, периметр, правила входа
# Пункт плана cloud-sec. Подробности — в docs/security.md.
# ─────────────────────────────────────────────────────────────────────────────

variable "kms_algorithm" {
  description = "Алгоритм ключа шифрования данных в KMS."
  type        = string
  default     = "AES_256"

  validation {
    condition     = contains(["AES_128", "AES_192", "AES_256"], var.kms_algorithm)
    error_message = "kms_algorithm может быть AES_128, AES_192 или AES_256."
  }
}

variable "kms_rotation_period" {
  description = <<-EOT
    Как часто KMS сам меняет версию ключа. Старые версии никуда не деваются —
    объекты, зашифрованные прежней версией, читаются по-прежнему.
    Формат Terraform: 8760h — год.
  EOT
  type        = string
  default     = "8760h"
}

variable "kms_deletion_protection" {
  description = "Защита ключа от удаления. Удалить ключ — значит потерять всё, что им зашифровано."
  type        = bool
  default     = true
}

variable "audit_trail_enabled" {
  description = <<-EOT
    Собирать журнал действий в облаке и обращений к объектам в хранилище
    (Audit Trails). Выключать имеет смысл только в dev ради экономии.
  EOT
  type        = bool
  default     = true
}

variable "audit_retain_days" {
  description = "Сколько дней хранится журнал аудита облака."
  type        = number
  default     = 365

  validation {
    condition     = var.audit_retain_days >= 90
    error_message = "Журнал аудита короче трёх месяцев бесполезен: к моменту вопроса в нём уже ничего нет."
  }
}

variable "audit_cold_after_days" {
  description = "Через сколько дней журнал аудита уходит в холодное хранилище."
  type        = number
  default     = 30
}

variable "enable_sws" {
  description = <<-EOT
    Ставить перед балансировщиком профиль Smart Web Security: WAF и защита от ботов.
    Работает только вместе с ingress_mode = "alb" — привязка у профиля одна,
    виртуальный хост ALB.
  EOT
  type        = bool
  default     = true
}

variable "sws_smart_protection_mode" {
  description = "Режим умной защиты от ботов: FULL — с браузерной проверкой, API — только оценка запроса."
  type        = string
  default     = "FULL"

  validation {
    condition     = contains(["FULL", "API"], var.sws_smart_protection_mode)
    error_message = "sws_smart_protection_mode может быть FULL или API."
  }
}

variable "waf_paranoia_level" {
  description = <<-EOT
    Уровень строгости базового набора OWASP, 1–4. Выше уровень — больше правил
    и больше ложных срабатываний на живых пользователях.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.waf_paranoia_level >= 1 && var.waf_paranoia_level <= 4
    error_message = "waf_paranoia_level — целое от 1 до 4."
  }
}

variable "waf_anomaly_score" {
  description = "Порог аномальности, при котором WAF считает запрос атакой. Рекомендуемое значение — 25."
  type        = number
  default     = 25
}

variable "enable_oslogin" {
  description = <<-EOT
    Вход по SSH через учётные записи облака (OS Login): ключ берётся из профиля
    пользователя, право входа — из роли compute.osLogin, вместе с обязательной
    двухфакторной аутентификацией вход на машину тоже становится двухфакторным.
    При включении ключи из ssh_public_keys перестают действовать —
    переключаться на OS Login нужно осознанно и не вслепую.
  EOT
  type        = bool
  default     = false
}

variable "serial_port_enable" {
  description = <<-EOT
    Серийная консоль — запасной вход на машину, когда белый список для SSH пуст.
    Идёт не по сети, а через API облака и закрывается ролями. Когда ключи
    и адреса выданы, её стоит выключить.
  EOT
  type        = bool
  default     = true
}

variable "app_auth_policy" {
  description = <<-EOT
    Правила входа и журналирования в самом приложении. Уезжают на ВМ в
    /etc/uchetkin/app.env и оттуда читаются сервером — реализуют их пункты
    плана be-api (вход, пароли, сессии) и be-audit (журнал действий).
    Значения — из политики обработки персональных данных, раздел «Меры защиты».
  EOT
  type = object({
    password_min_length    = number
    password_classes       = number
    password_max_age_days  = number
    max_failed_attempts    = number
    lockout_minutes        = number
    session_idle_minutes   = number
    session_absolute_hours = number
    audit_retain_days      = number
  })

  default = {
    password_min_length    = 10
    password_classes       = 3
    password_max_age_days  = 180
    max_failed_attempts    = 5
    lockout_minutes        = 15
    session_idle_minutes   = 30
    session_absolute_hours = 12
    audit_retain_days      = 1095
  }

  validation {
    condition     = var.app_auth_policy.password_min_length >= 8
    error_message = "Пароль короче восьми знаков не проходит ни по одному требованию к ИСПДн."
  }

  validation {
    condition     = var.app_auth_policy.max_failed_attempts >= 1 && var.app_auth_policy.max_failed_attempts <= 10
    error_message = "Порог блокировки — от 1 до 10 неудачных попыток; в политике заявлено 5."
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Эксплуатация: логи, резервные копии, сторож с оповещениями
# Пункт плана cloud-ops. Что значит каждый алерт и что делать — docs/ops.md.
# ─────────────────────────────────────────────────────────────────────────────

variable "logs_retention_days" {
  description = "Сколько дней Cloud Logging хранит журналы приложения (caddy, api, worker, база)."
  type        = number
  default     = 30

  validation {
    condition     = var.logs_retention_days >= 1 && var.logs_retention_days <= 90
    error_message = "Cloud Logging хранит журналы от 1 до 90 дней; для разбора инцидентов нужно не меньше двух недель."
  }
}

variable "backup_daily_retain_days" {
  description = <<-EOT
    Сколько дней лежит ежедневный pg_dump в бакете ops. В prod рядом есть ещё
    автоматические копии Managed PostgreSQL (pg_backup_retain_days); в dev база
    контейнером, и этот дамп — единственная её копия.
  EOT
  type        = number
  default     = 14
}

variable "backup_weekly_retain_days" {
  description = "Сколько дней лежит еженедельный (воскресный) pg_dump. Год — по постановке cloud-ops."
  type        = number
  default     = 365
}

variable "backup_schedule" {
  description = <<-EOT
    Когда снимать pg_dump: выражение OnCalendar таймера systemd в местном
    времени машины (timezone). 02:30 по Екатеринбургу — после окна
    автоматических копий облака (pg_backup_window_hour, UTC) и до рабочего дня.
  EOT
  type        = string
  default     = "*-*-* 02:30:00"
}

variable "status_interval_minutes" {
  description = <<-EOT
    Как часто машина отправляет в Monitoring свои служебные метрики: возраст
    последней копии, занятость диска, дни до конца сертификата, живость
    контейнеров. По ним сторож поднимает оповещения.
  EOT
  type        = number
  default     = 5
}

variable "caddy_metrics_port" {
  description = <<-EOT
    Порт, на котором Caddy отдаёт метрики Prometheus (deploy/Caddyfile, сайт
    :2020). Публикуется только на 127.0.0.1 машины — агент мониторинга
    забирает их оттуда и отправляет в Monitoring как метрики caddy_*.
  EOT
  type        = number
  default     = 2020
}

variable "watchdog_enabled" {
  description = <<-EOT
    Поднимать сторожа — Cloud Function по таймеру раз в минуту, которая снаружи
    контура проверяет /health и служебные метрики и шлёт оповещения. Алерты
    самого Monitoring через Terraform и API не заводятся (только консоль),
    поэтому оповещения живут здесь.
  EOT
  type        = bool
  default     = true
}

variable "alert_email" {
  description = <<-EOT
    Куда сторож шлёт оповещения по почте. Пусто — почтовый канал выключен,
    остаётся Telegram. Отправка идёт через SMTP из секрета Lockbox
    <контур>-smtp (записи host, port, user, password, from).
  EOT
  type        = string
  default     = ""
}

variable "alert_thresholds" {
  description = <<-EOT
    Пороги оповещений сторожа. Что значит каждое и что делать — docs/ops.md.
      down_minutes         — сколько минут подряд /health не отвечает, чтобы поднять тревогу
      http_5xx_percent     — доля ответов 5xx за последние пять минут
      disk_percent         — занятость корневого диска ВМ
      backup_max_age_hours — возраст последней удачной резервной копии
      cert_days            — за сколько дней до конца сертификата предупреждать
      remind_hours         — через сколько часов повторить напоминание о нерешённой проблеме
  EOT
  type = object({
    down_minutes         = number
    http_5xx_percent     = number
    disk_percent         = number
    backup_max_age_hours = number
    cert_days            = number
    remind_hours         = number
  })

  default = {
    down_minutes         = 2
    http_5xx_percent     = 2
    disk_percent         = 80
    backup_max_age_hours = 26
    cert_days            = 14
    remind_hours         = 6
  }
}
