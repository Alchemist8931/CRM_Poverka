terraform {
  required_version = ">= 1.6.0"

  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "~> 0.228"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Упаковка кода сторожа (watchdog.tf) в zip для Cloud Functions.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Состояние хранится в Object Storage. Параметры бакета и ключа не зашиты сюда,
  # чтобы один и тот же корневой модуль обслуживал оба контура:
  #   terraform init -backend-config=backend-dev.hcl
  #   terraform init -backend-config=backend-prod.hcl -reconfigure
  backend "s3" {
    endpoints = {
      s3 = "https://storage.yandexcloud.net"
    }
    region = "ru-central1"

    # Проверки AWS в Яндекс Облаке неприменимы.
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
