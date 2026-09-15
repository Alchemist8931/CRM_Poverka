# Сервисный аккаунт приложения. От него работают ВМ, API и worker.
# Прав ровно столько, сколько нужно: свои два бакета, свои секреты, запись метрик
# и логов, чтение образов из реестра. Ролей на каталог целиком у него нет.

resource "yandex_iam_service_account" "app" {
  name        = "${local.prefix}-app"
  description = "Приложение CRM «Учёткин»: ВМ, API, worker"
  folder_id   = var.folder_id
}

# Метрики и логи адресуются каталогом, а не отдельным ресурсом, — уровня
# «только свой ресурс» у этих ролей в облаке просто нет.
resource "yandex_resourcemanager_folder_iam_member" "app_monitoring" {
  folder_id = var.folder_id
  role      = "monitoring.editor"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

resource "yandex_resourcemanager_folder_iam_member" "app_logging" {
  folder_id = var.folder_id
  role      = "logging.writer"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

# Нужна пункту cloud-cicd: ВМ забирает собранный образ из Container Registry.
resource "yandex_resourcemanager_folder_iam_member" "app_registry_puller" {
  folder_id = var.folder_id
  role      = "container-registry.images.puller"
  member    = "serviceAccount:${yandex_iam_service_account.app.id}"
}

# Статический ключ для S3-совместимого API: им приложение подписывает ссылки
# на загрузку и просмотр фото. Значение кладётся сразу в Lockbox и в состоянии
# Terraform не появляется.
resource "yandex_iam_service_account_static_access_key" "app_storage" {
  service_account_id = yandex_iam_service_account.app.id
  description        = "Подписанные ссылки в Object Storage"

  output_to_lockbox {
    secret_id            = yandex_lockbox_secret.storage.id
    entry_for_access_key = "access_key_id"
    entry_for_secret_key = "secret_access_key"
  }
}
