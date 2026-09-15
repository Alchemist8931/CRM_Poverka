# Публичная зона Cloud DNS.
#
# Пока система живёт на временном имени — поддомене уже существующего домена,
# NS которого стоят у стороннего регистратора, — зона здесь не нужна:
# manage_dns_zone = false, и одна A-запись на статический адрес из выхода
# app_external_ip заводится у регистратора один раз.
#
# Когда регистрируется боевой домен (пункт cloud-domain), переменная
# переключается в true, NS домена делегируются в Яндекс Облако, и дальше
# записями управляет Terraform.

resource "yandex_dns_zone" "main" {
  count = var.manage_dns_zone ? 1 : 0

  name        = replace(trimsuffix(local.dns_zone_fqdn, "."), ".", "-")
  description = "Публичная зона контура ${var.env}"
  folder_id   = var.folder_id
  zone        = local.dns_zone_fqdn
  public      = true
  labels      = local.labels
}

resource "yandex_dns_recordset" "app" {
  count = var.manage_dns_zone ? 1 : 0

  zone_id = yandex_dns_zone.main[0].id
  name    = local.app_record_name
  type    = "A"
  ttl     = var.dns_ttl
  data    = [local.external_ip]
}
