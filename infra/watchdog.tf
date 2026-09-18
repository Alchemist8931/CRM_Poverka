# Сторож: оповещения о неполадках.
#
# Алерты самого Yandex Monitoring через Terraform и публичный API не заводятся
# (только в консоли, и почтовый канал там принимает лишь учётные записи
# облака). Заказчик — ИП без администратора, оповещение должно прийти туда,
# где его точно прочитают: в Telegram и на обычную почту, понятным языком, с
# первым шагом «что делать». Поэтому сторож — своя Cloud Function по таймеру.
#
# Раз в минуту функция снаружи контура:
#   • открывает /health — приложение отвечает?
#   • читает из Monitoring служебные метрики машины (uchetkin.*) и счётчики
#     Caddy (caddy_*): диск, возраст копии, доля 5xx;
#   • при включённом TLS проверяет срок сертификата на самом домене.
# Пороги — переменная alert_thresholds, что значит каждое оповещение и что
# делать — docs/ops.md. Состояние (какие тревоги уже подняты) лежит в бакете
# ops под префиксом watchdog/, чтобы одно и то же не приходило каждую минуту.
#
# Каналы доставки — из Lockbox, секреты заводятся пустыми (lockbox.tf) и
# наполняются в консоли:
#   <контур>-alerts: telegram_bot_token, telegram_chat_id
#   <контур>-smtp:   host, port, user, password, from  (+ alert_email в tfvars)
# Пока секрет пуст, сторож пишет текст оповещения в журнал (Cloud Logging,
# группа <контур>-app) и помечает, что канал не настроен.
#
# Проверить доставку, не дожидаясь беды:
#   yc serverless function invoke <контур>-watchdog -d '{"test": true}'

data "archive_file" "watchdog" {
  count = var.watchdog_enabled ? 1 : 0

  type        = "zip"
  source_dir  = "${path.module}/watchdog"
  output_path = "${path.module}/.terraform/${local.prefix}-watchdog.zip"
}

resource "yandex_iam_service_account" "watchdog" {
  count = var.watchdog_enabled ? 1 : 0

  name        = "${local.prefix}-watchdog"
  description = "Сторож: читает метрики и секреты каналов, хранит состояние в бакете ops"
  folder_id   = var.folder_id
}

# Читать метрики можно только каталогом целиком — роли на отдельную метрику нет.
resource "yandex_resourcemanager_folder_iam_member" "watchdog_monitoring" {
  count = var.watchdog_enabled ? 1 : 0

  folder_id = var.folder_id
  role      = "monitoring.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.watchdog[0].id}"
}

# Свой журнал функция пишет в группу приложения.
resource "yandex_resourcemanager_folder_iam_member" "watchdog_logging" {
  count = var.watchdog_enabled ? 1 : 0

  folder_id = var.folder_id
  role      = "logging.writer"
  member    = "serviceAccount:${yandex_iam_service_account.watchdog[0].id}"
}

# Секреты каналов доставки — и только они.
resource "yandex_lockbox_secret_iam_binding" "watchdog_channels" {
  for_each = var.watchdog_enabled ? toset(["alerts", "smtp"]) : toset([])

  secret_id = yandex_lockbox_secret.external[each.key].id
  role      = "lockbox.payloadViewer"
  members   = ["serviceAccount:${yandex_iam_service_account.watchdog[0].id}"]
}

# Состояние в бакете ops зашифровано тем же ключом, что и всё остальное:
# право на ключ — в общем binding в kms.tf.

resource "yandex_function" "watchdog" {
  count = var.watchdog_enabled ? 1 : 0

  name        = "${local.prefix}-watchdog"
  description = "Сторож CRM «Учёткин» ${var.env}: /health, диск, копии, 5xx, сертификат → Telegram и почта"
  folder_id   = var.folder_id
  labels      = local.labels

  runtime            = "nodejs22"
  entrypoint         = "index.handler"
  memory             = 128
  execution_timeout  = "50"
  service_account_id = yandex_iam_service_account.watchdog[0].id
  user_hash          = data.archive_file.watchdog[0].output_sha256

  content {
    zip_filename = data.archive_file.watchdog[0].output_path
  }

  # Пустых значений Cloud Functions не принимает («Illegal value of environment
  # variable»), поэтому адрес почты попадает сюда только когда задан.
  environment = merge({
    ENV                  = var.env
    APP_DOMAIN           = var.app_domain
    APP_URL              = local.public_base_url
    HEALTH_URL           = local.health_url
    FOLDER_ID            = var.folder_id
    VM_HOST              = local.vm_name
    OPS_BUCKET           = yandex_storage_bucket.ops.bucket
    ALERTS_SECRET_ID     = yandex_lockbox_secret.external["alerts"].id
    SMTP_SECRET_ID       = yandex_lockbox_secret.external["smtp"].id
    DOWN_MINUTES         = tostring(var.alert_thresholds.down_minutes)
    HTTP_5XX_PERCENT     = tostring(var.alert_thresholds.http_5xx_percent)
    DISK_PERCENT         = tostring(var.alert_thresholds.disk_percent)
    BACKUP_MAX_AGE_HOURS = tostring(var.alert_thresholds.backup_max_age_hours)
    CERT_DAYS            = tostring(var.alert_thresholds.cert_days)
    REMIND_HOURS         = tostring(var.alert_thresholds.remind_hours)
    STATUS_INTERVAL_MIN  = tostring(var.status_interval_minutes)
    TZ                   = var.timezone
  }, var.alert_email != "" ? { ALERT_EMAIL = var.alert_email } : {})

  # Без min_level: строки без уровня (например, стек необработанной ошибки)
  # иначе отбрасываются, а разбирать падение сторожа без них нечем.
  log_options {
    log_group_id = yandex_logging_group.app.id
  }
}

# Таймеру нужно право вызывать функцию — от имени того же сервисного аккаунта.
resource "yandex_function_iam_binding" "watchdog_invoker" {
  count = var.watchdog_enabled ? 1 : 0

  function_id = yandex_function.watchdog[0].id
  role        = "functions.functionInvoker"
  members     = ["serviceAccount:${yandex_iam_service_account.watchdog[0].id}"]
}

resource "yandex_function_trigger" "watchdog" {
  count = var.watchdog_enabled ? 1 : 0

  name        = "${local.prefix}-watchdog-every-minute"
  description = "Раз в минуту запускает сторожа"
  folder_id   = var.folder_id
  labels      = local.labels

  timer {
    cron_expression = "* * * * ? *"
  }

  # Без повторов: через минуту таймер и так запустит сторожа заново.
  # (retry_attempts = "0" API не принимает — допустимо только 1–5 с интервалом.)
  function {
    id                 = yandex_function.watchdog[0].id
    service_account_id = yandex_iam_service_account.watchdog[0].id
  }

  depends_on = [yandex_function_iam_binding.watchdog_invoker]
}
