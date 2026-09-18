# Дашборды Yandex Monitoring — отдельный корневой модуль.
#
# Почему не в infra/ рядом со всем остальным. Провайдер yandex начиная с
# 0.223.0 не умеет читать ответ API дашбордов: операция приходит уже
# выполненной, без metadata, и провайдер падает с «expected operation metadata
# to be CreateDashboardMetadata, but got ''» — при этом доска в облаке
# создаётся (и обновляется) успешно. Проверено 18.09.2026 перебором версий:
# 0.222.0 — работает, 0.223.0, 0.225.0, 0.228.0 — падают. Поэтому дашборды
# живут здесь с провайдером, прибитым к 0.222.0, а основной модуль остаётся
# на свежем. Когда провайдер починят — снять пин в versions.tf и, при желании,
# перенести файл обратно в infra/monitoring.tf.
#
# Три доски — по машине, по HTTP-тракту и по базе (при Managed PostgreSQL),
# плюс балансировщик при ingress_mode = alb. Открываются в консоли облака:
# Monitoring → Дашборды. Метрики приходят из трёх мест:
#   • compute.* — сама платформа облака (загрузка vCPU, диск, сеть);
#   • sys.* — агент мониторинга на ВМ (память, файловая система, нагрузка);
#   • caddy_* и uchetkin.* — тот же агент: метрики Caddy с порта
#     caddy_metrics_port и служебные метрики машины (возраст копии, дни до
#     конца сертификата), их отправляет таймер uchetkin-status.
#
# Алерты Monitoring в Terraform и через API не заводятся — только в консоли.
# Поэтому оповещения живут не здесь, а в стороже (../watchdog.tf); доски — для
# того, чтобы посмотреть, что происходило, когда сторож написал.
#
# Всё, что нужно знать о контуре (каталог, машина, кластер, пороги), берётся
# из выходов основного модуля — руками сюда ничего не переписывается.
#
# Сетка доски — 36 колонок; виджет w = 18 занимает половину ширины.

data "terraform_remote_state" "main" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = var.state_key
    region = "ru-central1"
    endpoints = {
      s3 = "https://storage.yandexcloud.net"
    }
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

locals {
  main = data.terraform_remote_state.main.outputs

  folder_id        = local.main.folder_id
  env              = local.main.env
  prefix           = local.main.prefix
  labels           = local.main.labels
  vm_id            = local.main.vm_id
  vm_name          = local.main.vm_name
  managed_postgres = local.main.postgres_cluster_id != ""
  pg_cluster_id    = local.main.postgres_cluster_id
  use_alb          = local.main.alb_id != ""
  alb_id           = local.main.alb_id
  thresholds       = local.main.alert_thresholds

  # Общая часть селекторов агента: метрики помечены именем хоста.
  sys_host = "folderId=\"${local.folder_id}\", service=\"custom\", host=\"${local.vm_name}\""
  compute  = "folderId=\"${local.folder_id}\", service=\"compute\", resource_id=\"${local.vm_id}\""
  # Метрики Caddy: код ответа несёт только гистограмма времени ответа, а один
  # запрос проходит два обработчика (request_body и subroute) — считается один.
  # Счётчики агент отдаёт уже как скорость (в секунду), derivative не нужен.
  caddy       = "${local.sys_host}, handler=\"subroute\""
  pg_selector = local.managed_postgres ? "folderId=\"${local.folder_id}\", service=\"managed-postgresql\", resource_id=\"${local.pg_cluster_id}\"" : ""
}

# ─── Машина ──────────────────────────────────────────────────────────────────

resource "yandex_monitoring_dashboard" "vm" {
  name        = "${local.prefix}-vm"
  title       = "Учёткин ${local.env}: машина"
  description = "ВМ ${local.vm_name}: процессор, память, диск, сеть, служебные метрики"
  folder_id   = local.folder_id
  labels      = local.labels

  widgets {
    position {
      x = 0
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "cpu"
      title          = "Процессор, % (норма — до 70)"
      display_legend = true
      queries {
        target {
          query = "alias(\"cpu_utilization\"{${local.compute}}, \"vCPU\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
        yaxis_settings {
          left {
            min = "0"
            max = "100"
          }
        }
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "memory"
      title          = "Память занята, %"
      display_legend = true
      queries {
        target {
          query = "alias(100 * (1 - series_sum(\"sys.memory.MemAvailable\"{${local.sys_host}}) / series_sum(\"sys.memory.MemTotal\"{${local.sys_host}})), \"занято\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
        yaxis_settings {
          left {
            min = "0"
            max = "100"
          }
        }
      }
    }
  }

  widgets {
    position {
      x = 0
      y = 8
      w = 18
      h = 8
    }
    chart {
      chart_id       = "disk"
      title          = "Диск занят, % (тревога с ${local.thresholds.disk_percent})"
      display_legend = true
      queries {
        target {
          query = "alias(100 * series_sum(\"sys.filesystem.UsedB\"{${local.sys_host}, mountpoint=\"/\"}) / series_sum(\"sys.filesystem.SizeB\"{${local.sys_host}, mountpoint=\"/\"}), \"корень /\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_MAX"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
        yaxis_settings {
          left {
            min = "0"
            max = "100"
          }
        }
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 8
      w = 18
      h = 8
    }
    chart {
      chart_id       = "load"
      title          = "Нагрузка (load average, ядер — 2)"
      display_legend = true
      queries {
        target {
          query = "alias(\"sys.proc.LoadAverage1min\"{${local.sys_host}}, \"1 мин\")"
        }
        target {
          query = "alias(\"sys.proc.LoadAverage5min\"{${local.sys_host}}, \"5 мин\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 0
      y = 16
      w = 18
      h = 8
    }
    chart {
      chart_id       = "disk-io"
      title          = "Диск: операции в секунду"
      display_legend = true
      queries {
        target {
          query = "alias(series_sum(\"disk.read_ops\"{${local.compute}}), \"чтение\")"
        }
        target {
          query = "alias(series_sum(\"disk.write_ops\"{${local.compute}}), \"запись\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 16
      w = 18
      h = 8
    }
    chart {
      chart_id       = "network"
      title          = "Сеть, байт/с"
      display_legend = true
      queries {
        target {
          query = "alias(series_sum(\"network_received_bytes\"{${local.compute}}), \"входящий\")"
        }
        target {
          query = "alias(series_sum(\"network_sent_bytes\"{${local.compute}}), \"исходящий\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 0
      y = 24
      w = 18
      h = 8
    }
    chart {
      chart_id       = "backup-age"
      title          = "Возраст последней резервной копии, часов (тревога с ${local.thresholds.backup_max_age_hours})"
      display_legend = true
      queries {
        target {
          query = "alias(\"uchetkin.backup_age_hours\"{${local.sys_host}}, \"часов с последней копии\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_MAX"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
        yaxis_settings {
          left {
            min = "0"
          }
        }
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 24
      w = 18
      h = 8
    }
    chart {
      chart_id       = "cert-days"
      title          = "Дней до конца сертификата (−1 — TLS выключен; тревога с ${local.thresholds.cert_days})"
      display_legend = true
      queries {
        target {
          query = "alias(\"uchetkin.cert_days_left\"{${local.sys_host}}, \"дней\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_MIN"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }
}

# ─── HTTP-тракт: Caddy ───────────────────────────────────────────────────────
# Запросы в секунду, доля 5xx, среднее время ответа. Всё — из счётчиков Caddy
# (гистограмма caddy_http_request_duration_seconds: только у неё есть код ответа), которые
# агент забирает с порта caddy_metrics_port.

resource "yandex_monitoring_dashboard" "http" {
  name        = "${local.prefix}-http"
  title       = "Учёткин ${local.env}: HTTP"
  description = "Запросы, ошибки и время ответа на входе в систему (Caddy)"
  folder_id   = local.folder_id
  labels      = local.labels

  widgets {
    position {
      x = 0
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "rps"
      title          = "Запросов в секунду"
      display_legend = true
      queries {
        target {
          query = "alias(series_sum(\"caddy_http_request_duration_seconds_count\"{${local.caddy}}), \"все\")"
        }
        target {
          query = "alias(series_sum(\"caddy_http_request_duration_seconds_count\"{${local.caddy}, code=\"5*\"}), \"5xx\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "5xx"
      title          = "Доля ответов 5xx, % (тревога с ${local.thresholds.http_5xx_percent})"
      display_legend = true
      queries {
        target {
          query = "alias(100 * series_sum(\"caddy_http_request_duration_seconds_count\"{${local.caddy}, code=\"5*\"}) / series_sum(\"caddy_http_request_duration_seconds_count\"{${local.caddy}}), \"5xx\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
        yaxis_settings {
          left {
            min = "0"
          }
        }
      }
    }
  }

  widgets {
    position {
      x = 0
      y = 8
      w = 18
      h = 8
    }
    chart {
      chart_id       = "latency"
      title          = "Среднее время ответа, с"
      display_legend = true
      queries {
        target {
          query = "alias(series_sum(\"caddy_http_request_duration_seconds_sum\"{${local.caddy}}) / series_sum(\"caddy_http_request_duration_seconds_count\"{${local.caddy}}), \"среднее\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 8
      w = 18
      h = 8
    }
    chart {
      chart_id       = "by-code"
      title          = "Ответы по кодам, в секунду"
      display_legend = true
      queries {
        target {
          query = "series_sum(\"code\", \"caddy_http_request_duration_seconds_count\"{${local.caddy}})"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_STACK"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }
}

# ─── Балансировщик ───────────────────────────────────────────────────────────
# Только при ingress_mode = "alb": метрики самого балансировщика — запросы,
# ответы по кодам, время ответа бэкенда. Пока балансировщика нет (решение
# arch, раздел 3), те же цифры даёт доска HTTP по метрикам Caddy.

resource "yandex_monitoring_dashboard" "alb" {
  count = local.use_alb ? 1 : 0

  name        = "${local.prefix}-alb"
  title       = "Учёткин ${local.env}: балансировщик"
  description = "Application Load Balancer: RPS, 5xx, задержка"
  folder_id   = local.folder_id
  labels      = local.labels

  widgets {
    position {
      x = 0
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "alb-rps"
      title          = "Запросов в секунду"
      display_legend = true
      queries {
        target {
          query = "alias(series_sum(\"load_balancer.requests_per_second\"{folderId=\"${local.folder_id}\", service=\"application-load-balancer\", load_balancer=\"${local.alb_id}\"}), \"все\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "alb-5xx"
      title          = "Ответов 5xx в секунду"
      display_legend = true
      queries {
        target {
          query = "series_sum(\"code\", \"load_balancer.requests_per_second\"{folderId=\"${local.folder_id}\", service=\"application-load-balancer\", load_balancer=\"${local.alb_id}\", code=\"5*\"})"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 0
      y = 8
      w = 18
      h = 8
    }
    chart {
      chart_id       = "alb-latency"
      title          = "Время ответа бэкенда, мс"
      display_legend = true
      queries {
        target {
          query = "series_avg(\"load_balancer.backend_latency\"{folderId=\"${local.folder_id}\", service=\"application-load-balancer\", load_balancer=\"${local.alb_id}\"})"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }
}

# ─── База ────────────────────────────────────────────────────────────────────
# Только при managed_postgres = true: метрики Managed PostgreSQL. В dev база
# контейнером на ВМ, и её место на диске видно на доске машины.

resource "yandex_monitoring_dashboard" "postgres" {
  count = local.managed_postgres ? 1 : 0

  name        = "${local.prefix}-postgres"
  title       = "Учёткин ${local.env}: база"
  description = "Managed PostgreSQL: соединения, место, медленные запросы"
  folder_id   = local.folder_id
  labels      = local.labels

  widgets {
    position {
      x = 0
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "pg-connections"
      title          = "Соединения (лимит пользователя приложения — 50)"
      display_legend = true
      queries {
        target {
          query = "alias(series_sum(\"postgres_conn_active\"{${local.pg_selector}}), \"активные\")"
        }
        target {
          query = "alias(series_sum(\"postgres_conn_idle\"{${local.pg_selector}}), \"простаивают\")"
        }
        target {
          query = "alias(series_sum(\"postgres_conn_waiting\"{${local.pg_selector}}), \"ждут\")"
        }
        target {
          query = "alias(series_sum(\"postgres_total_connections\"{${local.pg_selector}}), \"всего\")"
        }
        target {
          query = "alias(series_min(\"postgres_max_connections\"{${local.pg_selector}}), \"лимит кластера\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_MAX"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 0
      w = 18
      h = 8
    }
    chart {
      chart_id       = "pg-disk"
      title          = "Диск базы занят, % (тревога с ${local.thresholds.disk_percent})"
      display_legend = true
      queries {
        target {
          query = "alias(100 * series_sum(\"disk.used_bytes\"{${local.pg_selector}}) / series_sum(\"disk.total_bytes\"{${local.pg_selector}}), \"занято\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_MAX"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
        yaxis_settings {
          left {
            min = "0"
            max = "100"
          }
        }
      }
    }
  }

  widgets {
    position {
      x = 0
      y = 8
      w = 18
      h = 8
    }
    chart {
      chart_id       = "pg-slow"
      title          = "Медленные запросы: 99-й перцентиль и самый долгий, с"
      display_legend = true
      queries {
        target {
          query = "alias(series_max(\"pooler-query_0.99\"{${local.pg_selector}}), \"99 % запросов быстрее\")"
        }
        target {
          query = "alias(series_max(\"postgres_oldest_query_duration\"{${local.pg_selector}}), \"самый долгий сейчас\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_MAX"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
      }
    }
  }

  widgets {
    position {
      x = 18
      y = 8
      w = 18
      h = 8
    }
    chart {
      chart_id       = "pg-cpu-mem"
      title          = "Процессор и память хоста базы, %"
      display_legend = true
      queries {
        target {
          query = "alias(100 - series_avg(\"cpu.idle\"{${local.pg_selector}}), \"процессор\")"
        }
        target {
          query = "alias(100 * series_sum(\"mem.used_bytes\"{${local.pg_selector}}) / series_sum(\"mem.total_bytes\"{${local.pg_selector}}), \"память\")"
        }
        downsampling {
          # Явно, иначе провайдер видит расхождение с ответом API на каждом plan.
          gap_filling      = "GAP_FILLING_UNSPECIFIED"
          grid_aggregation = "GRID_AGGREGATION_AVG"
          max_points       = 300
        }
      }
      visualization_settings {
        type        = "VISUALIZATION_TYPE_LINE"
        interpolate = "INTERPOLATE_LINEAR"
        yaxis_settings {
          left {
            min = "0"
            max = "100"
          }
        }
      }
    }
  }
}

