# Ключ шифрования данных в Object Storage.
#
# Object Storage шифрует объекты и без этого ключа, но ключом облака и без
# отдельного журнала обращений. Свой ключ в KMS даёт три вещи, которых иначе нет:
# доступ к расшифровке выдаётся ролью на сам ключ, обращения к ключу попадают в
# Audit Trails, и ключ можно отозвать, не трогая бакеты. Для ИСПДн это и есть
# «применение средств криптографической защиты» из приказа ФСТЭК № 21.
#
# Ключ один на контур: фото актов, записи разговоров и журналы аудита шифруются
# им же. Разделять ключи по бакетам смысла нет — доступ к ним всё равно у одного
# сервисного аккаунта.

resource "yandex_kms_symmetric_key" "data" {
  name                = "${local.prefix}-data"
  description         = "Шифрование бакетов контура ${var.env}: фото актов, записи разговоров, журналы аудита"
  folder_id           = var.folder_id
  default_algorithm   = var.kms_algorithm
  rotation_period     = var.kms_rotation_period
  deletion_protection = var.kms_deletion_protection
  labels              = local.labels
}

# Приложению нужно и зашифровать при записи, и расшифровать при чтении.
# Роль выдана на сам ключ, а не на каталог: другими ключами каталога
# приложение пользоваться не может.
resource "yandex_kms_symmetric_key_iam_binding" "app" {
  symmetric_key_id = yandex_kms_symmetric_key.data.id
  role             = "kms.keys.encrypterDecrypter"
  members = [
    "serviceAccount:${yandex_iam_service_account.app.id}",
  ]
}

# Сервисный аккаунт Audit Trails складывает журналы в шифрованный бакет —
# значит, ему тоже нужно право шифровать. Расшифровывать ему не нужно,
# но отдельной роли «только зашифровать» в KMS нет.
resource "yandex_kms_symmetric_key_iam_binding" "audit" {
  count = var.audit_trail_enabled ? 1 : 0

  symmetric_key_id = yandex_kms_symmetric_key.data.id
  role             = "kms.keys.encrypterDecrypter"
  members = [
    "serviceAccount:${yandex_iam_service_account.audit[0].id}",
  ]
}
