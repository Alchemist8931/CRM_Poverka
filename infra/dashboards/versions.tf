terraform {
  required_version = ">= 1.6.0"

  required_providers {
    yandex = {
      source = "yandex-cloud/yandex"
      # Ровно 0.222.0, не «~>»: с 0.223.0 провайдер не читает ответ API
      # дашбордов (см. шапку dashboards.tf). Снять пин, когда починят.
      version = "= 0.222.0"
    }
  }

  # Своё состояние в том же бакете, что и у основного модуля:
  #   terraform init -backend-config=backend-dev.hcl
  backend "s3" {
    endpoints = {
      s3 = "https://storage.yandexcloud.net"
    }
    region = "ru-central1"

    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

provider "yandex" {
  cloud_id  = var.cloud_id
  folder_id = local.folder_id
  zone      = var.zone
}
