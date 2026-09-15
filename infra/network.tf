resource "yandex_vpc_network" "main" {
  name        = "${local.prefix}-net"
  description = "Сеть контура ${var.env} CRM «Учёткин»"
  folder_id   = var.folder_id
  labels      = local.labels
}

resource "yandex_vpc_subnet" "main" {
  name           = "${local.prefix}-subnet-${var.zone}"
  folder_id      = var.folder_id
  network_id     = yandex_vpc_network.main.id
  zone           = var.zone
  v4_cidr_blocks = [var.subnet_cidr]
  route_table_id = local.use_alb ? yandex_vpc_route_table.nat[0].id : null
  labels         = local.labels
}

# Исходящий доступ в интернет.
# В обычном режиме у ВМ свой публичный адрес, и шлюз не нужен. В режиме alb
# адреса у неё нет — без шлюза машина не достучится ни до реестра образов,
# ни до Lockbox, ни до Новофона и «Аршина».

resource "yandex_vpc_gateway" "nat" {
  count = local.use_alb ? 1 : 0

  name      = "${local.prefix}-nat"
  folder_id = var.folder_id
  labels    = local.labels

  shared_egress_gateway {}
}

resource "yandex_vpc_route_table" "nat" {
  count = local.use_alb ? 1 : 0

  name       = "${local.prefix}-rt"
  folder_id  = var.folder_id
  network_id = yandex_vpc_network.main.id
  labels     = local.labels

  static_route {
    destination_prefix = "0.0.0.0/0"
    gateway_id         = yandex_vpc_gateway.nat[0].id
  }
}

# ─── Группа безопасности приложения ──────────────────────────────────────────
# Снаружи открыт ровно один порт одной машины. Всё остальное — внутри сети.

resource "yandex_vpc_security_group" "app" {
  name        = "${local.prefix}-sg-app"
  description = "ВМ приложения: снаружи только HTTPS, SSH по белому списку"
  folder_id   = var.folder_id
  network_id  = yandex_vpc_network.main.id
  labels      = local.labels

  dynamic "ingress" {
    # При ingress_mode = alb 443 на ВМ снаружи не нужен: трафик приходит от балансировщика.
    for_each = local.use_alb ? [] : [1]
    content {
      description    = "HTTPS снаружи"
      protocol       = "TCP"
      port           = 443
      v4_cidr_blocks = ["0.0.0.0/0"]
    }
  }

  dynamic "ingress" {
    for_each = !local.use_alb && var.open_quic_port ? [1] : []
    content {
      description    = "HTTP/3 (QUIC) снаружи"
      protocol       = "UDP"
      port           = 443
      v4_cidr_blocks = ["0.0.0.0/0"]
    }
  }

  dynamic "ingress" {
    for_each = !local.use_alb && var.open_http_port ? [1] : []
    content {
      description    = "HTTP: редирект на HTTPS и резервная проверка Let's Encrypt"
      protocol       = "TCP"
      port           = 80
      v4_cidr_blocks = ["0.0.0.0/0"]
    }
  }

  dynamic "ingress" {
    for_each = local.use_alb ? [1] : []
    content {
      description       = "Трафик и проверки здоровья от Application Load Balancer"
      protocol          = "TCP"
      port              = var.app_port
      security_group_id = yandex_vpc_security_group.alb[0].id
    }
  }

  dynamic "ingress" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      description    = "SSH по белому списку"
      protocol       = "TCP"
      port           = 22
      v4_cidr_blocks = var.ssh_allowed_cidrs
    }
  }

  ingress {
    description       = "Внутри группы — без ограничений"
    protocol          = "ANY"
    predefined_target = "self_security_group"
  }

  egress {
    description    = "Исходящие: облачные сервисы, реестр образов, Let's Encrypt, внешние API"
    protocol       = "ANY"
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─── Группа безопасности балансировщика ──────────────────────────────────────
# Создаётся только в режиме alb.

resource "yandex_vpc_security_group" "alb" {
  count = local.use_alb ? 1 : 0

  name        = "${local.prefix}-sg-alb"
  description = "Application Load Balancer: 443 снаружи, проверки здоровья из служебной сети"
  folder_id   = var.folder_id
  network_id  = yandex_vpc_network.main.id
  labels      = local.labels

  ingress {
    description    = "HTTPS снаружи"
    protocol       = "TCP"
    port           = 443
    v4_cidr_blocks = ["0.0.0.0/0"]
  }

  dynamic "ingress" {
    for_each = var.open_http_port ? [1] : []
    content {
      description    = "HTTP: редирект на HTTPS"
      protocol       = "TCP"
      port           = 80
      v4_cidr_blocks = ["0.0.0.0/0"]
    }
  }

  ingress {
    description    = "Проверки здоровья балансировщика (служебные диапазоны Яндекс Облака)"
    protocol       = "TCP"
    port           = 30080
    v4_cidr_blocks = ["198.18.235.0/24", "198.18.248.0/24"]
  }

  egress {
    description    = "К целевой группе"
    protocol       = "ANY"
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─── Группа безопасности базы ────────────────────────────────────────────────

resource "yandex_vpc_security_group" "db" {
  count = var.managed_postgres ? 1 : 0

  name        = "${local.prefix}-sg-db"
  description = "Managed PostgreSQL: доступ только с ВМ приложения, наружу не выставлен"
  folder_id   = var.folder_id
  network_id  = yandex_vpc_network.main.id
  labels      = local.labels

  ingress {
    description       = "Пул соединений PostgreSQL с ВМ приложения"
    protocol          = "TCP"
    port              = 6432
    security_group_id = yandex_vpc_security_group.app.id
  }

  ingress {
    description       = "Прямое подключение к PostgreSQL с ВМ приложения (миграции, psql)"
    protocol          = "TCP"
    port              = 5432
    security_group_id = yandex_vpc_security_group.app.id
  }

  egress {
    description    = "Служебный трафик кластера"
    protocol       = "ANY"
    v4_cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─── Внешние адреса ──────────────────────────────────────────────────────────
# Адрес статический: на него заводится A-запись, и он переживает пересоздание ВМ.

resource "yandex_vpc_address" "vm" {
  count = local.use_alb ? 0 : 1

  name      = "${local.prefix}-ip"
  folder_id = var.folder_id
  labels    = local.labels

  external_ipv4_address {
    zone_id = var.zone
  }
}

resource "yandex_vpc_address" "alb" {
  count = local.use_alb ? 1 : 0

  name      = "${local.prefix}-alb-ip"
  folder_id = var.folder_id
  labels    = local.labels

  external_ipv4_address {
    zone_id = var.zone
  }
}
