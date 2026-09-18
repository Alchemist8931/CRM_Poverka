# Ни одного пароля в репозитории и в образе (arch, раздел 2).
# Приложение читает секреты при старте по сервисному аккаунту ВМ.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "random_password" "refresh" {
  length  = 48
  special = false
}

resource "random_password" "password_pepper" {
  length  = 48
  special = false
}

# ─── Доступ к базе ───────────────────────────────────────────────────────────

resource "yandex_lockbox_secret" "db" {
  name                = "${local.prefix}-db"
  description         = "PostgreSQL: хост, база, пользователь, пароль"
  folder_id           = var.folder_id
  labels              = local.labels
  deletion_protection = var.lockbox_deletion_protection
}

resource "yandex_lockbox_secret_version" "db" {
  secret_id = yandex_lockbox_secret.db.id

  entries {
    key        = "host"
    text_value = local.pg_host_fqdn
  }

  entries {
    key        = "port"
    text_value = tostring(local.pg_port)
  }

  entries {
    key        = "database"
    text_value = var.pg_db_name
  }

  entries {
    key        = "username"
    text_value = var.pg_user_name
  }

  entries {
    key        = "password"
    text_value = random_password.db.result
  }
}

# ─── Ключи самого приложения ─────────────────────────────────────────────────

resource "yandex_lockbox_secret" "app" {
  name                = "${local.prefix}-app"
  description         = "Ключи подписи токенов и перец для хешей паролей"
  folder_id           = var.folder_id
  labels              = local.labels
  deletion_protection = var.lockbox_deletion_protection
}

resource "yandex_lockbox_secret_version" "app" {
  secret_id = yandex_lockbox_secret.app.id

  entries {
    key        = "jwt_secret"
    text_value = random_password.jwt.result
  }

  entries {
    key        = "refresh_secret"
    text_value = random_password.refresh.result
  }

  entries {
    key        = "password_pepper"
    text_value = random_password.password_pepper.result
  }
}

# ─── Ключ к Object Storage ───────────────────────────────────────────────────
# Версию в этот секрет пишет сам ресурс статического ключа
# (yandex_iam_service_account_static_access_key.app_storage, файл iam.tf),
# поэтому yandex_lockbox_secret_version здесь нет и значение ключа
# не попадает в состояние Terraform.

resource "yandex_lockbox_secret" "storage" {
  name                = "${local.prefix}-storage"
  description         = "Статический ключ сервисного аккаунта для подписанных ссылок"
  folder_id           = var.folder_id
  labels              = local.labels
  deletion_protection = var.lockbox_deletion_protection
}

# ─── Секреты внешних сервисов ────────────────────────────────────────────────
# Заводятся пустыми: значения вносит человек в консоли, когда доступы получены.
# Так ключ Новофона или «Аршина» не проходит ни через репозиторий, ни через
# состояние Terraform.

resource "yandex_lockbox_secret" "external" {
  for_each = var.lockbox_external_secrets

  name                = "${local.prefix}-${each.key}"
  description         = each.value
  folder_id           = var.folder_id
  labels              = local.labels
  deletion_protection = var.lockbox_deletion_protection
}

# ─── Кто имеет право читать ──────────────────────────────────────────────────

resource "yandex_lockbox_secret_iam_binding" "app_db" {
  secret_id = yandex_lockbox_secret.db.id
  role      = "lockbox.payloadViewer"
  members   = ["serviceAccount:${yandex_iam_service_account.app.id}"]
}

resource "yandex_lockbox_secret_iam_binding" "app_app" {
  secret_id = yandex_lockbox_secret.app.id
  role      = "lockbox.payloadViewer"
  members   = ["serviceAccount:${yandex_iam_service_account.app.id}"]
}

resource "yandex_lockbox_secret_iam_binding" "app_storage" {
  secret_id = yandex_lockbox_secret.storage.id
  role      = "lockbox.payloadViewer"
  members   = ["serviceAccount:${yandex_iam_service_account.app.id}"]
}

resource "yandex_lockbox_secret_iam_binding" "app_external" {
  # Перебор идёт по самой переменной, а не по yandex_lockbox_secret.external:
  # ключи набора обязаны быть известны до применения, а набор ресурсов целиком
  # до первого apply неизвестен — с ним Terraform отказывается даже строить план.
  for_each = var.lockbox_external_secrets

  secret_id = yandex_lockbox_secret.external[each.key].id
  role      = "lockbox.payloadViewer"
  members   = ["serviceAccount:${yandex_iam_service_account.app.id}"]
}
