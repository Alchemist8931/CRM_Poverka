# Два приватных бакета: фото актов и записи разговоров.
# Публичного доступа нет ни на чтение, ни на список — всё только подписанными
# ссылками. Версионирование включено, автоудаления нет: срок хранения фото —
# не менее шести лет, записей разговоров — бессрочно (arch, раздел 7).

resource "yandex_storage_bucket" "acts" {
  bucket    = local.acts_bucket
  folder_id = var.folder_id

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning {
    enabled = true
  }

  lifecycle_rule {
    id      = "acts-to-cold"
    enabled = true

    transition {
      days          = var.acts_cold_after_days
      storage_class = "COLD"
    }

    noncurrent_version_transition {
      days          = var.noncurrent_cold_after_days
      storage_class = "COLD"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_storage_bucket" "calls" {
  bucket    = local.calls_bucket
  folder_id = var.folder_id

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  versioning {
    enabled = true
  }

  lifecycle_rule {
    id      = "calls-to-cold-then-ice"
    enabled = true

    transition {
      days          = var.calls_cold_after_days
      storage_class = "COLD"
    }

    transition {
      days          = var.calls_ice_after_days
      storage_class = "ICE"
    }

    noncurrent_version_transition {
      days          = var.noncurrent_cold_after_days
      storage_class = "COLD"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Доступ приложения к бакетам выдаётся на сам бакет, а не на каталог.
# viewer + uploader — это чтение и запись без удаления: объект, попавший в акт,
# приложение стереть не может даже при ошибке в коде.

resource "yandex_storage_bucket_iam_binding" "acts_viewer" {
  bucket = yandex_storage_bucket.acts.bucket
  role   = "storage.viewer"
  members = [
    "serviceAccount:${yandex_iam_service_account.app.id}",
  ]
}

resource "yandex_storage_bucket_iam_binding" "acts_uploader" {
  bucket = yandex_storage_bucket.acts.bucket
  role   = "storage.uploader"
  members = [
    "serviceAccount:${yandex_iam_service_account.app.id}",
  ]
}

resource "yandex_storage_bucket_iam_binding" "calls_viewer" {
  bucket = yandex_storage_bucket.calls.bucket
  role   = "storage.viewer"
  members = [
    "serviceAccount:${yandex_iam_service_account.app.id}",
  ]
}

resource "yandex_storage_bucket_iam_binding" "calls_uploader" {
  bucket = yandex_storage_bucket.calls.bucket
  role   = "storage.uploader"
  members = [
    "serviceAccount:${yandex_iam_service_account.app.id}",
  ]
}
