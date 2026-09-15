#!/usr/bin/env python3
"""Проверка cloud-init: шаблон отрисовывается, YAML разбирается, меры на месте.

Скрипт сам отрисовывает cloud-init.yaml.tftpl через `terraform console` — по разу
для enable_oslogin = false и true — и проверяет в полученном файле то, ради чего
меры и заводились: пароли в SSH выключены, вход root закрыт, правила входа для
приложения уехали в app.env, конфигурация SSH применяется.

    cd infra && terraform init -backend=false && python3 check_cloud_init.py

Нулевой код возврата — все проверки прошли. Значения переменных здесь
произвольные: проверяется шаблон, а не контур.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

import yaml

HERE = pathlib.Path(__file__).resolve().parent
TEMPLATE = HERE / "cloud-init.yaml.tftpl"

AUTH = {
    "password_min_length": 10,
    "password_classes": 3,
    "password_max_age_days": 180,
    "max_failed_attempts": 5,
    "lockout_minutes": 15,
    "session_idle_minutes": 30,
    "session_absolute_hours": 12,
    "audit_retain_days": 1095,
}

ARGS = {
    "vm_user": "uchetkin",
    "timezone": "Asia/Yekaterinburg",
    "env": "prod",
    "auth": AUTH,
    "folder_id": "b1gxxxxxxxxxxxxxxxxx",
    "app_domain": "uchetkin.elpa.systems",
    "public_base_url": "https://uchetkin.elpa.systems",
    "api_base_url": "https://uchetkin.elpa.systems/api",
    "webhook_base_url": "https://uchetkin.elpa.systems/api/webhooks",
    "cookie_domain": "uchetkin.elpa.systems",
    "api_path_prefix": "/api",
    "health_check_path": "/health",
    "tls_by_caddy": True,
    "acts_bucket": "uchetkin-prod-acts",
    "calls_bucket": "uchetkin-prod-calls",
    "managed_postgres": True,
    "pg_host": "rc1a.mdb.yandexcloud.net",
    "pg_port": 6432,
    "pg_database": "uchetkin",
    "pg_user": "uchetkin_app",
    "lockbox_db_secret_id": "e6q000000000000000d1",
    "lockbox_app_secret_id": "e6q000000000000000d2",
    "lockbox_storage_secret_id": "e6q000000000000000d3",
    "lockbox_external_secrets": {"novofon": "e6q000000000000000d4"},
    "monitoring_agent_enabled": True,
    "monitoring_agent_image": "cr.yandex/yc/unified-agent",
}

SSHD_FILE = "10-uchetkin.conf"
APP_ENV = "/etc/uchetkin/app.env"

MUST_BE_IN_SSHD = [
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitEmptyPasswords no",
    "PermitRootLogin no",
    "MaxAuthTries 3",
    "ClientAliveInterval 300",
]

MUST_BE_IN_ENV = [
    "AUTH_PASSWORD_MIN_LENGTH=10",
    "AUTH_PASSWORD_CLASSES=3",
    "AUTH_PASSWORD_MAX_AGE_DAYS=180",
    "AUTH_MAX_FAILED_ATTEMPTS=5",
    "AUTH_LOCKOUT_MINUTES=15",
    "SESSION_IDLE_MINUTES=30",
    "SESSION_ABSOLUTE_HOURS=12",
    "AUDIT_RETAIN_DAYS=1095",
]

failures = []


def render(oslogin):
    """Отрисовать шаблон терраформом и вернуть текст."""
    args = dict(ARGS, enable_oslogin=oslogin)
    expr = 'templatefile("%s", %s)' % (TEMPLATE, json.dumps(args, ensure_ascii=False))
    # Консоль запускается в пустом каталоге: самому шаблону ни провайдеры,
    # ни состояние не нужны, а корневой модуль потребовал бы настроенный бэкенд.
    with tempfile.TemporaryDirectory() as empty:
        done = subprocess.run(
            ["terraform", "console"],
            input=expr, capture_output=True, text=True, cwd=empty,
        )
    if done.returncode != 0:
        print(done.stderr.strip())
        raise SystemExit(f"terraform console вернул {done.returncode}")

    out = done.stdout.strip()
    if out.startswith('"'):
        return json.loads(out)
    if out.startswith("<<EOT"):
        # Многострочный вывод terraform console обёрнут в heredoc.
        return out[len("<<EOT"):].rsplit("EOT", 1)[0].lstrip("\n")
    return out


def check(oslogin):
    where = f"enable_oslogin={str(oslogin).lower()}"
    doc = yaml.safe_load(render(oslogin))

    files = {f["path"]: f["content"] for f in doc["write_files"]}
    sshd = next((c for p, c in files.items() if p.endswith(SSHD_FILE)), None)
    if sshd is None:
        failures.append(f"{where}: нет файла конфигурации SSH")
        return

    # Сравниваются только действующие строки: слово из комментария настройкой
    # не является, и проверка не должна принимать его за настройку.
    directives = [ln.strip() for ln in sshd.splitlines()
                  if ln.strip() and not ln.strip().startswith("#")]

    for line in MUST_BE_IN_SSHD:
        if line not in directives:
            failures.append(f"{where}: в конфигурации SSH нет строки {line!r}")

    # Без OS Login вход разрешён одному пользователю и только по ключу.
    # С OS Login список пользователей ведёт облако, и AllowUsers перекрыл бы IAM.
    if oslogin:
        if any(d.startswith("AllowUsers") for d in directives):
            failures.append(f"{where}: AllowUsers перекрывает права OS Login")
    else:
        for line in ("AuthenticationMethods publickey", "AllowUsers uchetkin"):
            if line not in directives:
                failures.append(f"{where}: в конфигурации SSH нет строки {line!r}")

    env = files.get(APP_ENV)
    if env is None:
        failures.append(f"{where}: нет {APP_ENV}")
    else:
        for line in MUST_BE_IN_ENV:
            if line not in env:
                failures.append(f"{where}: в app.env нет строки {line!r}")

    applied = any(
        "sshd -t" in (" ".join(cmd) if isinstance(cmd, list) else str(cmd))
        for cmd in doc["runcmd"]
    )
    if not applied:
        failures.append(f"{where}: конфигурация SSH нигде не применяется")

    print(f"{where}: YAML разобран, файлов {len(files)}, проверки пройдены")


for oslogin in (False, True):
    check(oslogin)

if failures:
    for line in failures:
        print("ОШИБКА:", line)
    sys.exit(1)

print("Все проверки пройдены")
