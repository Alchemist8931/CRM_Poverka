# Smart Web Security перед балансировщиком: WAF и защита от ботов.
#
# Профиль встаёт в тракт только вместе с Application Load Balancer
# (ingress_mode = "alb"): привязка у Smart Web Security одна — виртуальный хост
# ALB. В режиме vm, который сейчас включён по умолчанию, трафик приходит прямо
# на Caddy, и профиль не создаётся: платить за сервис, которого нет в тракте,
# незачем. Что защищает периметр в режиме vm — сказано в docs/security.md.
#
# Порядок правил: меньше priority — раньше проверка.
#   10    вебхуки Новофона, «Аршина» и платёжного провайдера — пропускаем всегда:
#         это машины, браузерную проверку они не проходят, а подлинность у них
#         своя, по подписи запроса.
#   1100  WAF: базовый набор OWASP.
#   99999 умная защита от ботов на всё остальное.

resource "yandex_sws_waf_profile" "app" {
  count = local.use_sws ? 1 : 0

  name        = "${local.prefix}-waf"
  description = "Базовый набор OWASP для CRM «Учёткин», контур ${var.env}"
  folder_id   = var.folder_id
  labels      = local.labels

  core_rule_set {
    inbound_anomaly_score = var.waf_anomaly_score
    paranoia_level        = var.waf_paranoia_level

    rule_set {
      name    = "OWASP Core Ruleset"
      version = "4.0.0"
    }
  }
}

resource "yandex_sws_security_profile" "app" {
  count = local.use_sws ? 1 : 0

  name        = "${local.prefix}-sws"
  description = "Периметр CRM «Учёткин», контур ${var.env}"
  folder_id   = var.folder_id
  labels      = local.labels

  # Запрос, не подошедший ни под одно правило, пропускается: система рабочая,
  # а не публичный сайт, и ломать вход операторам ради строгости нельзя.
  default_action = "ALLOW"

  # Данные запросов в Яндекс Облако для обучения моделей не передаются.
  # Через систему проходят персональные данные — это условие, а не настройка.
  disallow_data_processing = true

  security_rule {
    name     = "webhooks-allow"
    priority = 10

    rule_condition {
      action = "ALLOW"

      condition {
        request_uri {
          path {
            prefix_match = var.webhook_path_prefix
          }
        }
      }
    }
  }

  security_rule {
    name     = "waf-owasp"
    priority = 1100

    waf {
      mode           = "FULL"
      waf_profile_id = yandex_sws_waf_profile.app[0].id
    }
  }

  security_rule {
    name     = "smart-protection"
    priority = 99999

    smart_protection {
      mode = var.sws_smart_protection_mode
    }
  }
}
