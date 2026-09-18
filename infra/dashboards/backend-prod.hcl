# terraform -chdir=dashboards init -backend-config=backend-prod.hcl -reconfigure
bucket = "uchetkin-tfstate"
key    = "prod/dashboards.tfstate"
