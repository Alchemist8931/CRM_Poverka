# Модулю нужно знать только, где лежит состояние основного модуля контура:
# всё остальное (каталог, машина, кластер, пороги) он читает оттуда.

variable "cloud_id" {
  description = "Идентификатор облака — тот же, что в ../dev.tfvars или ../prod.tfvars."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{20}$", var.cloud_id))
    error_message = "cloud_id — 20 символов из консоли облака."
  }
}

variable "zone" {
  description = "Зона по умолчанию для провайдера; на дашборды не влияет."
  type        = string
  default     = "ru-central1-a"
}

variable "state_bucket" {
  description = "Бакет состояния основного модуля (../backend-*.hcl)."
  type        = string
  default     = "uchetkin-tfstate"
}

variable "state_key" {
  description = "Ключ состояния основного модуля контура: dev/terraform.tfstate или prod/terraform.tfstate."
  type        = string
}
