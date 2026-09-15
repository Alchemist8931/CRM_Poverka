# Audit Trails: кто и что делал в облаке.
#
# Журнал управляющих действий (создал ВМ, поменял права, прочитал секрет, снёс
# бакет) и журнал обращений к объектам в хранилище — то есть к фотографиям актов
# и записям разговоров. Без этого на вопрос «кто выгрузил записи разговоров»
# ответить нечем, а пункт 152-ФЗ о контроле доступа к персональным данным
# закрывается только словами.
#
# Складывается всё в отдельный бакет: в тот же, куда пишет приложение, аудит
# класть нельзя — тогда обладатель доступа к данным правит и журнал о себе.

resource "yandex_iam_service_account" "audit" {
  count = var.audit_trail_enabled ? 1 : 0

  name        = "${local.prefix}-audit"
  description = "Audit Trails: чтение событий каталога и запись их в бакет журналов"
  folder_id   = var.folder_id
}

# Право читать события каталога — это и есть то, чем трейл собирает журнал.
resource "yandex_resourcemanager_folder_iam_member" "audit_viewer" {
  count = var.audit_trail_enabled ? 1 : 0

  folder_id = var.folder_id
  role      = "audit-trails.viewer"
  member    = "serviceAccount:${yandex_iam_service_account.audit[0].id}"
}

# Событиям уровня данных в Object Storage нужен ещё и просмотр настроек бакетов.
resource "yandex_resourcemanager_folder_iam_member" "audit_storage_config" {
  count = var.audit_trail_enabled ? 1 : 0

  folder_id = var.folder_id
  role      = "storage.configViewer"
  member    = "serviceAccount:${yandex_iam_service_account.audit[0].id}"
}

# ─── Бакет журналов ──────────────────────────────────────────────────────────
# Приложение сюда не ходит: у его сервисного аккаунта прав на этот бакет нет.
# Писать может только сервисный аккаунт аудита, и только добавлять — роль
# uploader не даёт удаления.

resource "yandex_storage_bucket" "audit" {
  count = var.audit_trail_enabled ? 1 : 0

  bucket    = local.audit_bucket
  folder_id = var.folder_id

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning {
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = yandex_kms_symmetric_key.data.id
        sse_algorithm     = "aws:kms"
      }
    }
  }

  # Журналы хранятся столько, сколько сказано в audit_retain_days, и удаляются
  # сами: бесконечно копить события управления смысла нет, а срок должен быть
  # виден в коде, а не жить в чьей-то голове.
  lifecycle_rule {
    id      = "audit-retention"
    enabled = true

    transition {
      days          = var.audit_cold_after_days
      storage_class = "COLD"
    }

    expiration {
      days = var.audit_retain_days
    }

    noncurrent_version_expiration {
      days = var.audit_retain_days
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_storage_bucket_iam_binding" "audit_uploader" {
  count = var.audit_trail_enabled ? 1 : 0

  bucket = yandex_storage_bucket.audit[0].bucket
  role   = "storage.uploader"
  members = [
    "serviceAccount:${yandex_iam_service_account.audit[0].id}",
  ]
}

# ─── Сам трейл ───────────────────────────────────────────────────────────────
# management_events_filter — всё управление ресурсами каталога.
# data_events_filter для storage — обращения к объектам: загрузка, чтение,
# удаление фотографий и записей разговоров. Список событий не сужается намеренно:
# в ИСПДн интересно любое обращение, а не выбранные операции.

resource "yandex_audit_trails_trail" "main" {
  count = var.audit_trail_enabled ? 1 : 0

  name               = "${local.prefix}-trail"
  description        = "Журнал действий в каталоге ${var.env} и обращений к данным в хранилище"
  folder_id          = var.folder_id
  service_account_id = yandex_iam_service_account.audit[0].id
  labels             = local.labels

  storage_destination {
    bucket_name   = yandex_storage_bucket.audit[0].bucket
    object_prefix = local.prefix
  }

  filtering_policy {
    management_events_filter {
      resource_scope {
        resource_id   = var.folder_id
        resource_type = "resource-manager.folder"
      }
    }

    data_events_filter {
      service = "storage"

      resource_scope {
        resource_id   = var.folder_id
        resource_type = "resource-manager.folder"
      }
    }
  }

  depends_on = [
    yandex_storage_bucket_iam_binding.audit_uploader,
    yandex_resourcemanager_folder_iam_member.audit_viewer,
  ]
}
