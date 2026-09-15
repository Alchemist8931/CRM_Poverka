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
