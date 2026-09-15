data "yandex_compute_image" "vm" {
  family = var.vm_image_family
}

resource "yandex_compute_instance" "app" {
  name        = "${local.prefix}-app"
  description = "CRM «Учёткин»: caddy, api, worker под Docker Compose"
  folder_id   = var.folder_id
  zone        = var.zone
  platform_id = var.vm_platform_id
  hostname    = "${local.prefix}-app"
  labels      = local.labels

  service_account_id        = yandex_iam_service_account.app.id
  allow_stopping_for_update = true

  resources {
    cores         = var.vm_cores
    core_fraction = var.vm_core_fraction
    memory        = var.vm_memory
  }

  boot_disk {
    initialize_params {
      image_id = data.yandex_compute_image.vm.id
      size     = var.vm_disk_size
      type     = var.vm_disk_type
    }
  }

  network_interface {
    subnet_id          = yandex_vpc_subnet.main.id
    nat                = !local.use_alb
    nat_ip_address     = local.use_alb ? null : yandex_vpc_address.vm[0].external_ipv4_address[0].address
    security_group_ids = [yandex_vpc_security_group.app.id]
  }

  metadata = {
    user-data          = local.cloud_init
    ssh-keys           = join("\n", [for key in var.ssh_public_keys : "${var.vm_user}:${key}"])
    serial-port-enable = "1"
  }
}

locals {
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    vm_user                   = var.vm_user
    timezone                  = var.timezone
    env                       = var.env
    folder_id                 = var.folder_id
    app_domain                = var.app_domain
    public_base_url           = local.public_base_url
    api_base_url              = local.api_base_url
    webhook_base_url          = local.webhook_base_url
    cookie_domain             = local.cookie_domain
    api_path_prefix           = var.api_path_prefix
    health_check_path         = var.health_check_path
    tls_by_caddy              = !local.use_alb
    acts_bucket               = local.acts_bucket
    calls_bucket              = local.calls_bucket
    managed_postgres          = var.managed_postgres
    pg_host                   = local.pg_host_fqdn
    pg_port                   = local.pg_port
    pg_database               = var.pg_db_name
    pg_user                   = var.pg_user_name
    lockbox_db_secret_id      = yandex_lockbox_secret.db.id
    lockbox_app_secret_id     = yandex_lockbox_secret.app.id
    lockbox_storage_secret_id = yandex_lockbox_secret.storage.id
    lockbox_external_secrets  = { for name, secret in yandex_lockbox_secret.external : name => secret.id }
    monitoring_agent_enabled  = var.monitoring_agent_enabled
    monitoring_agent_image    = var.monitoring_agent_image
  })
}

# Еженедельный снимок загрузочного диска. Учения по восстановлению — пункт cloud-ops.
resource "yandex_compute_snapshot_schedule" "boot" {
  count = var.vm_snapshot_schedule ? 1 : 0

  name      = "${local.prefix}-boot-weekly"
  folder_id = var.folder_id
  labels    = local.labels

  schedule_policy {
    expression = var.vm_snapshot_expression
  }

  snapshot_count = var.vm_snapshot_retain_count

  snapshot_spec {
    description = "Загрузочный диск ВМ ${local.prefix}-app"
    labels      = local.labels
  }

  disk_ids = [yandex_compute_instance.app.boot_disk[0].disk_id]
}
