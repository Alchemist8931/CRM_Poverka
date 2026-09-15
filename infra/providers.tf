provider "yandex" {
  cloud_id  = var.cloud_id
  folder_id = var.folder_id
  zone      = var.zone

  # Аутентификация берётся из окружения и никогда из файлов репозитория:
  #   YC_TOKEN                   — OAuth или IAM-токен, либо
  #   YC_SERVICE_ACCOUNT_KEY_FILE — путь к авторизованному ключу сервисного аккаунта.

  # Ключи для S3-совместимого API нужны только операциям над бакетами.
  # Пусты — провайдер работает по IAM-токену вызывающего.
  storage_access_key = var.storage_access_key != "" ? var.storage_access_key : null
  storage_secret_key = var.storage_secret_key != "" ? var.storage_secret_key : null
}
