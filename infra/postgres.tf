# Managed Service for PostgreSQL: один хост, бэкапы и PITR делает облако —
# своего администратора у заказчика нет (arch, раздел 2).
# В dev кластера нет: managed_postgres = false, база поднимается контейнером
# на той же ВМ — около 2 600 ₽ в месяц экономии.

resource "yandex_mdb_postgresql_cluster" "main" {
  count = var.managed_postgres ? 1 : 0

  name                = "${local.prefix}-pg"
  description         = "База CRM «Учёткин», контур ${var.env}"
  folder_id           = var.folder_id
  environment         = var.pg_environment
  network_id          = yandex_vpc_network.main.id
  security_group_ids  = [yandex_vpc_security_group.db[0].id]
  deletion_protection = var.pg_deletion_protection
  labels              = local.labels

  config {
    version = var.pg_version

    resources {
      resource_preset_id = var.pg_resource_preset
      disk_type_id       = var.pg_disk_type
      disk_size          = var.pg_disk_size
    }

    # Окно снятия копии — ночь по Екатеринбургу. Хранение — pg_backup_retain_days.
    backup_window_start {
      hours   = var.pg_backup_window_hour
      minutes = 0
    }

    backup_retain_period_days = var.pg_backup_retain_days

    access {
      # Наружу база не смотрит: ходит только ВМ приложения по внутреннему адресу.
      web_sql   = false
      data_lens = false
    }

    performance_diagnostics {
      enabled                      = true
      sessions_sampling_interval   = 60
      statements_sampling_interval = 600
    }
  }

  host {
    zone             = var.zone
    subnet_id        = yandex_vpc_subnet.main.id
    assign_public_ip = false
  }

  maintenance_window {
    type = "WEEKLY"
    day  = "MON"
    hour = 21
  }
}

resource "yandex_mdb_postgresql_user" "app" {
  count = var.managed_postgres ? 1 : 0

  cluster_id = yandex_mdb_postgresql_cluster.main[0].id
  name       = var.pg_user_name
  password   = random_password.db.result
  conn_limit = 50
}

resource "yandex_mdb_postgresql_database" "app" {
  count = var.managed_postgres ? 1 : 0

  cluster_id = yandex_mdb_postgresql_cluster.main[0].id
  name       = var.pg_db_name
  owner      = yandex_mdb_postgresql_user.app[0].name
  lc_collate = "ru_RU.UTF-8"
  lc_type    = "ru_RU.UTF-8"

  extension {
    name = "pg_trgm"
  }

  extension {
    name = "uuid-ossp"
  }
}
