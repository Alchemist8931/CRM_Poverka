# terraform init -backend-config=backend-prod.hcl -reconfigure
#
# Тот же бакет состояния, другой ключ: состояния контуров не пересекаются.
bucket = "uchetkin-tfstate"
key    = "prod/terraform.tfstate"
