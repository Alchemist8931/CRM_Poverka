# terraform init -backend-config=backend-dev.hcl
#
# Бакет состояния создаётся один раз до первого init (см. README, шаг 1)
# и в Terraform не описан: описывать хранилище собственного состояния нельзя.
# Ключи доступа — только из окружения:
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY статического ключа
#   сервисного аккаунта terraform.
bucket = "uchetkin-tfstate"
key    = "dev/terraform.tfstate"
