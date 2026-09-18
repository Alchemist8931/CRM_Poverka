locals {
  prefix = "${var.project}-${var.env}"

  # Имя ВМ и её имя хоста. У принятой в состояние машины имя задаётся явно:
  # hostname — поле пересоздания, вычислять его из префикса там нельзя.
  vm_name = var.vm_name != "" ? var.vm_name : "${local.prefix}-app"

  # Образ загрузочного диска: либо явный, либо последний в семействе.
  vm_image_id = var.vm_image_id != "" ? var.vm_image_id : data.yandex_compute_image.vm[0].id

  labels = merge(
    {
      project = var.project
      env     = var.env
      managed = "terraform"
    },
    var.labels,
  )

  # Имена бакетов глобальны на всё Object Storage, поэтому допускают добавку.
  bucket_suffix = var.bucket_suffix == "" ? "" : "-${var.bucket_suffix}"
  acts_bucket   = "${local.prefix}-acts${local.bucket_suffix}"
  calls_bucket  = "${local.prefix}-calls${local.bucket_suffix}"
  audit_bucket  = "${local.prefix}-audit${local.bucket_suffix}"

  use_alb = var.ingress_mode == "alb"

  # Сертификат на ВМ держит Caddy — но только когда есть чему подтверждать
  # владение доменом. Пока A-записи нет, tls_enabled = false, и Caddy слушает
  # :80 (cloud-init пишет это в /etc/uchetkin/caddy.env).
  tls_by_caddy = !local.use_alb && var.tls_enabled

  # Smart Web Security привязывается только к виртуальному хосту ALB.
  # Без балансировщика профиль не к чему прикрепить, поэтому он не создаётся.
  use_sws = local.use_alb && var.enable_sws

  # Зона DNS: по умолчанию совпадает с адресом системы.
  dns_zone_domain = var.dns_zone_domain != "" ? var.dns_zone_domain : var.app_domain
  dns_zone_fqdn   = "${trimsuffix(local.dns_zone_domain, ".")}."
  app_domain_fqdn = "${trimsuffix(var.app_domain, ".")}."

  # Имя A-записи внутри зоны: "@" для самой зоны, иначе левая часть имени.
  app_record_name = local.app_domain_fqdn == local.dns_zone_fqdn ? "@" : trimsuffix(
    trimsuffix(local.app_domain_fqdn, local.dns_zone_fqdn), "."
  )

  # Всё, что знает про адрес системы, собирается здесь и уезжает на ВМ файлом
  # окружения. В коде приложения доменов нет — это условие, а не пожелание.
  public_base_url  = "https://${var.app_domain}"
  api_base_url     = "https://${var.app_domain}${var.api_path_prefix}"
  webhook_base_url = "https://${var.app_domain}${var.webhook_path_prefix}"
  cookie_domain    = var.app_domain

  external_ip = local.use_alb ? yandex_vpc_address.alb[0].external_ipv4_address[0].address : yandex_vpc_address.vm[0].external_ipv4_address[0].address

  pg_host_fqdn = var.managed_postgres ? yandex_mdb_postgresql_cluster.main[0].host[0].fqdn : "postgres"
  pg_port      = var.managed_postgres ? 6432 : 5432
}
