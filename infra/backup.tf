# Резервные копии базы и служебный бакет контура.
#
# Три слоя копий:
#   1. Автоматические копии Managed PostgreSQL — pg_backup_retain_days (14) в
#      postgres.tf, плюс восстановление на момент времени (PITR). Только там,
#      где кластер есть, то есть в prod.
#   2. Ежедневный pg_dump с машины в этот бакет, префикс pg/daily/, хранится
#      backup_daily_retain_days. В dev база контейнером, и этот дамп — её
#      единственная копия; в prod — независимая от облачного механизма копия,
#      которую можно развернуть где угодно.
#   3. Еженедельный (воскресный) дамп, префикс pg/weekly/, хранится год.
#
# Снимает и отправляет дамп таймер systemd на ВМ (cloud-init.yaml.tftpl,
# uchetkin-backup.timer): без ключей на диске, по IAM-токену сервисного
# аккаунта машины. Право — только storage.uploader: дописать можно, стереть
# нельзя, даже если на машине ошибка или чужие руки. Возраст последней удачной
# копии машина отдаёт метрикой, и сторож (watchdog.tf) поднимает тревогу, когда
# копия старше backup_max_age_hours.
#
# Восстановление и замеренное время — docs/ops.md.
#
# Здесь же, под префиксом watchdog/, сторож держит своё состояние: какие
# тревоги уже подняты, чтобы не слать одно и то же каждую минуту.

resource "yandex_storage_bucket" "ops" {
  bucket    = local.ops_bucket
  folder_id = var.folder_id

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  # Дамп базы — это все персональные данные клиентов разом: тот же ключ KMS,
  # что и у бакетов с фото и записями (kms.tf).
  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = yandex_kms_symmetric_key.data.id
        sse_algorithm     = "aws:kms"
      }
    }
  }

  lifecycle_rule {
    id      = "pg-daily"
    enabled = true
    prefix  = "pg/daily/"

    expiration {
      days = var.backup_daily_retain_days
    }
  }

  lifecycle_rule {
    id      = "pg-weekly"
    enabled = true
    prefix  = "pg/weekly/"

    transition {
      days          = var.noncurrent_cold_after_days
      storage_class = "COLD"
    }

    expiration {
      days = var.backup_weekly_retain_days
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Машина только дописывает копии.
resource "yandex_storage_bucket_iam_binding" "ops_uploader" {
  bucket = yandex_storage_bucket.ops.bucket
  role   = "storage.uploader"
  members = concat(
    ["serviceAccount:${yandex_iam_service_account.app.id}"],
    var.watchdog_enabled ? ["serviceAccount:${yandex_iam_service_account.watchdog[0].id}"] : [],
  )
}

# Сторож читает своё состояние; машине читать бакет незачем.
resource "yandex_storage_bucket_iam_binding" "ops_viewer" {
  count = var.watchdog_enabled ? 1 : 0

  bucket = yandex_storage_bucket.ops.bucket
  role   = "storage.viewer"
  members = [
    "serviceAccount:${yandex_iam_service_account.watchdog[0].id}",
  ]
}
