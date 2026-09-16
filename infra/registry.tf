# Container Registry: куда GitHub Actions кладёт собранные образы и откуда ВМ
# их забирает (пункт плана cloud-cicd, порядок релиза — docs/release.md).
#
# Реестр один на контур, как и всё остальное в этом описании: образ, собранный
# для dev, в prod не попадает случайно — он туда просто не виден. Цена решения —
# один и тот же коммит собирается дважды; это дешевле, чем общий реестр с
# правами на запись из обоих контуров.

resource "yandex_container_registry" "main" {
  name      = local.prefix
  folder_id = var.folder_id
  labels    = local.labels
}

# Репозитории заводятся явно ради правила очистки: без него в реестре копятся
# образы каждого коммита в main, а платится за их объём каждый месяц.
resource "yandex_container_repository" "api" {
  name = "${yandex_container_registry.main.id}/uchetkin-api"
}

resource "yandex_container_repository" "web" {
  name = "${yandex_container_registry.main.id}/uchetkin-web"
}

resource "yandex_container_repository_lifecycle_policy" "api" {
  name          = "${local.prefix}-api-cleanup"
  status        = "active"
  repository_id = yandex_container_repository.api.id

  rule {
    description   = "Старые сборки: последние ${var.registry_keep_images} тегов остаются — этого хватает на откат"
    tag_regexp    = ".*"
    expire_period = var.registry_expire_period
    retained_top  = var.registry_keep_images
  }
}

resource "yandex_container_repository_lifecycle_policy" "web" {
  name          = "${local.prefix}-web-cleanup"
  status        = "active"
  repository_id = yandex_container_repository.web.id

  rule {
    description   = "Старые сборки: последние ${var.registry_keep_images} тегов остаются — этого хватает на откат"
    tag_regexp    = ".*"
    expire_period = var.registry_expire_period
    retained_top  = var.registry_keep_images
  }
}

# ─── Сервисный аккаунт выкладки ──────────────────────────────────────────────
# От него работает GitHub Actions. Прав ровно два: писать образы в этот реестр
# и ничего больше — ни в базу, ни в Lockbox, ни на ВМ он не ходит. Доступ на
# машину идёт отдельным ключом SSH, секреты приложение читает само.
#
# Ключ этого аккаунта Terraform не создаёт намеренно: попав в ресурс, он попал
# бы и в состояние. Он выпускается руками один раз и кладётся в секрет GitHub:
#
#   yc iam key create --service-account-name <имя> --output key.json
#
resource "yandex_iam_service_account" "deployer" {
  name        = "${local.prefix}-deployer"
  description = "GitHub Actions: публикация образов в Container Registry"
  folder_id   = var.folder_id
}

resource "yandex_container_registry_iam_binding" "deployer_pusher" {
  registry_id = yandex_container_registry.main.id
  role        = "container-registry.images.pusher"
  members     = ["serviceAccount:${yandex_iam_service_account.deployer.id}"]
}

# Чтение — сервисному аккаунту приложения, но уже не на весь каталог, а на этот
# реестр. Роль на каталог (iam.tf) остаётся: её выдача не зависит от того,
# создан ли реестр, и убирать её здесь — значит ломать порядок применения.
resource "yandex_container_registry_iam_binding" "app_puller" {
  registry_id = yandex_container_registry.main.id
  role        = "container-registry.images.puller"
  members     = ["serviceAccount:${yandex_iam_service_account.app.id}"]
}
