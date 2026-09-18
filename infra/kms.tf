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
#
# Все, кому нужен ключ, — в одном binding. Binding — авторитетный список
# держателей роли: два binding на одну роль (раньше здесь были отдельные для
# приложения и аудита) перетирали друг друга при каждом apply, и plan
# предупреждал «will be removed from 1 subject». Найдено в пункте cloud-ops.
#
# Кто здесь и зачем:
#   • приложение — шифрует при записи и расшифровывает при чтении фото и записей;
#   • аккаунт Audit Trails — складывает журналы в шифрованный бакет; ему бы
#     хватило «только зашифровать», но такой роли в KMS нет;
#   • сторож (watchdog.tf) — держит своё состояние в шифрованном бакете ops.
#
# Форма — iam_member на каждого держателя, а не общий binding со списком:
# провайдер 0.228 падает на binding, в списке которого есть ещё не созданный
# аккаунт («Value Conversion Error… unknown value»), а member такого не боится.
resource "yandex_kms_symmetric_key_iam_member" "app" {
  symmetric_key_id = yandex_kms_symmetric_key.data.id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${yandex_iam_service_account.app.id}"
}

resource "yandex_kms_symmetric_key_iam_member" "audit" {
  count = var.audit_trail_enabled ? 1 : 0

  symmetric_key_id = yandex_kms_symmetric_key.data.id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${yandex_iam_service_account.audit[0].id}"
}

resource "yandex_kms_symmetric_key_iam_member" "watchdog" {
  count = var.watchdog_enabled ? 1 : 0

  symmetric_key_id = yandex_kms_symmetric_key.data.id
  role             = "kms.keys.encrypterDecrypter"
  member           = "serviceAccount:${yandex_iam_service_account.watchdog[0].id}"
}

# Прежние binding из состояния забываются, а не уничтожаются: уничтожение
# binding снимает роль с его держателей, и порядок «снять — вернуть member»
# Terraform не гарантирует. Держатели те же, и они уже описаны выше.
removed {
  from = yandex_kms_symmetric_key_iam_binding.app

  lifecycle {
    destroy = false
  }
}

removed {
  from = yandex_kms_symmetric_key_iam_binding.audit

  lifecycle {
    destroy = false
  }
}
