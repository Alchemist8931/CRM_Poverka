output "app_url" {
  description = "Адрес системы в этом контуре."
  value       = local.public_base_url
}

output "api_base_url" {
  description = "Адрес API. Его же получает фронт файлом конфигурации."
  value       = local.api_base_url
}

output "webhook_base_url" {
  description = "Основа адресов вебхуков: Новофон сейчас, платёжный провайдер позже."
  value       = local.webhook_base_url
}

output "app_external_ip" {
  description = "Статический внешний адрес. На него заводится A-запись домена."
  value       = local.external_ip
}

output "dns_zone" {
  description = "Зона, которой управляет Terraform. NS для делегирования у регистратора — ns1.yandexcloud.net и ns2.yandexcloud.net."
  value       = var.manage_dns_zone ? yandex_dns_zone.main[0].zone : null
}

output "dns_record_to_create" {
  description = "Что завести в чужом DNS, когда зоной Terraform не управляет."
  value       = var.manage_dns_zone ? null : "${var.app_domain}. A ${local.external_ip}"
}

output "cert_validation_record" {
  description = "Запись подтверждения домена для Certificate Manager (только при ingress_mode = alb)."
  value       = local.use_alb ? yandex_cm_certificate.app[0].challenges : null
}

output "vm_name" {
  description = "Имя ВМ приложения."
  value       = yandex_compute_instance.app.name
}

output "vm_internal_ip" {
  description = "Внутренний адрес ВМ."
  value       = yandex_compute_instance.app.network_interface[0].ip_address
}

output "postgres_host" {
  description = "Хост базы: FQDN кластера или контейнер на самой ВМ в dev."
  value       = local.pg_host_fqdn
}

output "postgres_port" {
  description = "Порт базы: 6432 — пул соединений Managed PostgreSQL, 5432 — контейнер в dev."
  value       = local.pg_port
}

output "acts_bucket" {
  description = "Бакет фото актов."
  value       = yandex_storage_bucket.acts.bucket
}

output "calls_bucket" {
  description = "Бакет записей разговоров."
  value       = yandex_storage_bucket.calls.bucket
}

output "app_service_account_id" {
  description = "Сервисный аккаунт приложения."
  value       = yandex_iam_service_account.app.id
}

output "registry_id" {
  description = "Container Registry контура. Его значение кладётся в переменную GitHub YC_REGISTRY_ID."
  value       = yandex_container_registry.main.id
}

output "deployer_service_account_id" {
  description = "Сервисный аккаунт выкладки. Ключ к нему выпускается руками: yc iam key create."
  value       = yandex_iam_service_account.deployer.id
}

output "images" {
  description = "Имена образов, которые публикует сборка."
  value = {
    api = "cr.yandex/${yandex_container_registry.main.id}/uchetkin-api"
    web = "cr.yandex/${yandex_container_registry.main.id}/uchetkin-web"
  }
}

output "lockbox_secret_ids" {
  description = "Идентификаторы секретов. Значения внешних секретов вносятся в консоли."
  value = merge(
    {
      db      = yandex_lockbox_secret.db.id
      app     = yandex_lockbox_secret.app.id
      storage = yandex_lockbox_secret.storage.id
    },
    { for name, secret in yandex_lockbox_secret.external : name => secret.id },
  )
}

# ─── Эксплуатация (cloud-ops) ────────────────────────────────────────────────

output "ops_bucket" {
  description = "Бакет резервных копий базы (pg/daily, pg/weekly) и состояния сторожа."
  value       = yandex_storage_bucket.ops.bucket
}

output "log_group_id" {
  description = "Группа Cloud Logging с журналами приложения и сторожа."
  value       = yandex_logging_group.app.id
}

output "watchdog_function_id" {
  description = "Сторож. Проверить каналы: yc serverless function invoke <id> -d '{\"test\": true}'."
  value       = var.watchdog_enabled ? yandex_function.watchdog[0].id : null
}

output "health_url" {
  description = "Что именно проверяет сторож раз в минуту."
  value       = local.health_url
}

# ─── Для модуля дашбордов (dashboards/) — он читает эти выходы из состояния ──

output "folder_id" {
  description = "Каталог контура."
  value       = var.folder_id
}

output "env" {
  description = "Имя контура."
  value       = var.env
}

output "prefix" {
  description = "Префикс имён ресурсов."
  value       = local.prefix
}

output "labels" {
  description = "Метки контура."
  value       = local.labels
}

output "vm_id" {
  description = "Идентификатор ВМ приложения (метрики compute.* адресуются им)."
  value       = yandex_compute_instance.app.id
}

# Пустая строка, а не null: выход со значением null Terraform в состояние не
# пишет, и модуль дашбордов не нашёл бы атрибута вовсе.
output "postgres_cluster_id" {
  description = "Кластер Managed PostgreSQL, пусто — база контейнером на ВМ."
  value       = var.managed_postgres ? yandex_mdb_postgresql_cluster.main[0].id : ""
}

output "alb_id" {
  description = "Балансировщик, пусто — ingress_mode = vm."
  value       = local.use_alb ? yandex_alb_load_balancer.app[0].id : ""
}

output "alert_thresholds" {
  description = "Пороги сторожа — доски показывают их в заголовках."
  value       = var.alert_thresholds
}
