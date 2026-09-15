# Application Load Balancer с сертификатом из Certificate Manager.
#
# По архитектурному решению (раздел 3) при одной ВМ балансировщик не ставится:
# две ресурсные единицы в зоне — это около 3 977 ₽ в месяц, больше, чем стоит
# кластер базы, а отказоустойчивости за одной ВМ он не добавляет. TLS, HTTP/3
# и сертификат Let's Encrypt делает Caddy на самой ВМ.
#
# Всё описание балансировщика лежит здесь готовым и включается одной переменной
# ingress_mode = "alb" — когда появится вторая ВМ, понадобится Smart Web Security
# или выкладка без простоя.

resource "yandex_cm_certificate" "app" {
  count = local.use_alb ? 1 : 0

  name        = "${local.prefix}-cert"
  description = "Let's Encrypt для ${var.app_domain}"
  folder_id   = var.folder_id
  domains     = [var.app_domain]
  labels      = local.labels

  managed {
    challenge_type = "DNS_CNAME"
  }
}

# Запись для подтверждения владения доменом. Если зоной управляет не Terraform
# (manage_dns_zone = false), запись из выхода cert_validation_record заводится
# у регистратора руками — один раз на домен.
resource "yandex_dns_recordset" "cert_challenge" {
  count = local.use_alb && var.manage_dns_zone ? 1 : 0

  zone_id = yandex_dns_zone.main[0].id
  name    = yandex_cm_certificate.app[0].challenges[0].dns_name
  type    = yandex_cm_certificate.app[0].challenges[0].dns_type
  ttl     = 60
  data    = [yandex_cm_certificate.app[0].challenges[0].dns_value]
}

resource "yandex_alb_target_group" "app" {
  count = local.use_alb ? 1 : 0

  name      = "${local.prefix}-tg"
  folder_id = var.folder_id
  labels    = local.labels

  target {
    subnet_id  = yandex_vpc_subnet.main.id
    ip_address = yandex_compute_instance.app.network_interface[0].ip_address
  }
}

resource "yandex_alb_backend_group" "app" {
  count = local.use_alb ? 1 : 0

  name      = "${local.prefix}-bg"
  folder_id = var.folder_id
  labels    = local.labels

  http_backend {
    name             = "app"
    weight           = 1
    port             = var.app_port
    target_group_ids = [yandex_alb_target_group.app[0].id]

    healthcheck {
      timeout             = "2s"
      interval            = "5s"
      healthy_threshold   = 2
      unhealthy_threshold = 3

      http_healthcheck {
        # /health отвечает плоским 200 без обращения к базе (arch, раздел 4).
        path = var.health_check_path
      }
    }
  }
}

resource "yandex_alb_http_router" "app" {
  count = local.use_alb ? 1 : 0

  name      = "${local.prefix}-router"
  folder_id = var.folder_id
  labels    = local.labels
}

resource "yandex_alb_virtual_host" "app" {
  count = local.use_alb ? 1 : 0

  name           = "${local.prefix}-vh"
  http_router_id = yandex_alb_http_router.app[0].id
  authority      = [var.app_domain]

  # Профиль Smart Web Security (sws.tf) — запросы проходят проверку до того,
  # как попадут на ВМ.
  dynamic "route_options" {
    for_each = local.use_sws ? [1] : []

    content {
      security_profile_id = yandex_sws_security_profile.app[0].id
    }
  }

  route {
    name = "all"

    http_route {
      http_route_action {
        backend_group_id = yandex_alb_backend_group.app[0].id
        timeout          = "60s"
      }
    }
  }
}

# Отдельный роутер под редирект с http:// — сам он ничего не проксирует.
resource "yandex_alb_http_router" "redirect" {
  count = local.use_alb && var.open_http_port ? 1 : 0

  name      = "${local.prefix}-redirect"
  folder_id = var.folder_id
  labels    = local.labels
}

resource "yandex_alb_virtual_host" "redirect" {
  count = local.use_alb && var.open_http_port ? 1 : 0

  name           = "${local.prefix}-redirect-vh"
  http_router_id = yandex_alb_http_router.redirect[0].id

  route {
    name = "to-https"

    http_route {
      redirect_action {
        replace_scheme = "https"
        response_code  = "moved_permanently"
      }
    }
  }
}

resource "yandex_alb_load_balancer" "app" {
  count = local.use_alb ? 1 : 0

  name               = "${local.prefix}-alb"
  folder_id          = var.folder_id
  network_id         = yandex_vpc_network.main.id
  security_group_ids = [yandex_vpc_security_group.alb[0].id]
  labels             = local.labels

  allocation_policy {
    location {
      zone_id   = var.zone
      subnet_id = yandex_vpc_subnet.main.id
    }
  }

  listener {
    name = "https"

    endpoint {
      address {
        external_ipv4_address {
          address = yandex_vpc_address.alb[0].external_ipv4_address[0].address
        }
      }
      ports = [443]
    }

    tls {
      default_handler {
        certificate_ids = [yandex_cm_certificate.app[0].id]

        http_handler {
          http_router_id = yandex_alb_http_router.app[0].id
        }
      }
    }
  }

  dynamic "listener" {
    for_each = var.open_http_port ? [1] : []

    content {
      name = "http"

      endpoint {
        address {
          external_ipv4_address {
            address = yandex_vpc_address.alb[0].external_ipv4_address[0].address
          }
        }
        ports = [80]
      }

      http {
        handler {
          http_router_id = yandex_alb_http_router.redirect[0].id
        }
      }
    }
  }
}
