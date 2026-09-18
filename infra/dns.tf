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

# ── Почтовый домен (пункт cloud-domain): Яндекс 360 для бизнеса.
#
# Уведомления клиентам уходят с ящика на этом же домене (docs/notify.md), и
# принимающая почта верит письму только когда домен отправителя подписан:
# MX — куда приходит почта, SPF — кому разрешено слать от имени домена,
# DKIM — подпись письма ключом домена, DMARC — что делать с неподписанным.
# Значения подтверждения и DKIM выдаёт админка Яндекс 360 после того, как
# домен туда добавлен; до этого две записи ниже не заводятся.

locals {
  mail_records = var.manage_dns_zone && var.mail_records_enabled
  dmarc_rua    = var.dmarc_rua != "" ? var.dmarc_rua : "postmaster@${trimsuffix(local.dns_zone_fqdn, ".")}"

  # Значение TXT со пробелом или «;» Cloud DNS принимает только в кавычках
  # (docs/dns/concepts/resource-record). Кавычки добавляются здесь, чтобы в
  # tfvars лежало то, что показала админка Яндекса, как есть.
  quoted = { for k, v in {
    spf          = "v=spf1 redirect=_spf.yandex.net"
    verification = var.mail_verification_txt
    dkim         = var.mail_dkim_public_key
  } : k => v == "" ? "" : (startswith(v, "\"") ? v : "\"${v}\"") }

  # На вершине зоны может быть только один набор TXT: SPF и подтверждение
  # домена лежат в нём вместе.
  apex_txt = compact([local.quoted.spf, local.quoted.verification])
}

resource "yandex_dns_recordset" "mx" {
  count = local.mail_records ? 1 : 0

  zone_id = yandex_dns_zone.main[0].id
  name    = "@"
  type    = "MX"
  ttl     = var.dns_ttl
  data    = ["10 mx.yandex.net."]
}

resource "yandex_dns_recordset" "apex_txt" {
  count = local.mail_records ? 1 : 0

  zone_id = yandex_dns_zone.main[0].id
  name    = "@"
  type    = "TXT"
  ttl     = var.dns_ttl
  data    = local.apex_txt
}

resource "yandex_dns_recordset" "dkim" {
  count = local.mail_records && var.mail_dkim_public_key != "" ? 1 : 0

  zone_id = yandex_dns_zone.main[0].id
  name    = "mail._domainkey"
  type    = "TXT"
  ttl     = var.dns_ttl
  data    = [local.quoted.dkim]
}

resource "yandex_dns_recordset" "dmarc" {
  count = local.mail_records ? 1 : 0

  zone_id = yandex_dns_zone.main[0].id
  name    = "_dmarc"
  type    = "TXT"
  ttl     = var.dns_ttl
  data    = ["\"v=DMARC1; p=${var.dmarc_policy}; rua=mailto:${local.dmarc_rua}; adkim=s; aspf=s\""]
}
