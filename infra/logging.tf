# Cloud Logging: журналы приложения с ВМ.
#
# На машине Docker пишет журналы контейнеров в json-файлы (ротация — в
# /etc/docker/daemon.json из cloud-init), и живут они там пять файлов по 50 МБ.
# Для разбора «что было в четверг» этого мало: журнал уезжает с машины в группу
# Cloud Logging и хранится logs_retention_days. Отправляет его тот же агент
# мониторинга (cloud-init.yaml.tftpl, маршрут docker_logs): читает файлы
# контейнеров, берёт из строки Docker поле log и время, и пишет в группу по
# сервисному аккаунту машины — роль logging.writer выдана в iam.tf.
#
# Сюда же пишет свой журнал сторож (watchdog.tf): текст каждого оповещения
# виден в группе, даже если каналы доставки ещё не настроены.

resource "yandex_logging_group" "app" {
  name        = "${local.prefix}-app"
  description = "Журналы CRM «Учёткин», контур ${var.env}: caddy, api, worker, база, сторож"
  folder_id   = var.folder_id
  labels      = local.labels

  retention_period = "${var.logs_retention_days * 24}h"
}
