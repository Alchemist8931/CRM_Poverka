#!/usr/bin/env bash
# Выкладка на ВМ. Запускается по SSH из GitHub Actions (.github/workflows/deploy.yml),
# но написан так, чтобы его можно было запустить руками с машины — когда Actions
# недоступен, а выложить надо:
#
#   ssh <пользователь>@<адрес> 'bash /opt/uchetkin/deploy.sh <идентификатор реестра> <тег>'
#
# Порядок шагов и почему он такой — docs/release.md. Коротко: сначала образы
# скачиваются, потом отдельным шагом идут миграции, и только после этого
# перезапускается приложение. Наоборот нельзя: новый код на старой схеме падает.
#
# Секретов скрипт не получает и не хранит: пароль к базе он берёт из Lockbox по
# сервисному аккаунту самой машины и кладёт только туда, где без него не обойтись
# (файл окружения контейнера базы, права 0600).
set -euo pipefail

REGISTRY_ID=${1:?первым доводом — идентификатор Container Registry (crp...)}
IMAGE_TAG=${2:?вторым доводом — тег образа (короткий SHA)}

APP_DIR=/opt/uchetkin
REGISTRY="cr.yandex/${REGISTRY_ID}"
HEALTH_URL=http://127.0.0.1:3000/health
HEALTH_TIMEOUT=120
METADATA_TOKEN_URL=http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token
LOCKBOX_URL=https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets

say() { printf '\n== %s\n' "$*"; }

cd "$APP_DIR"

# ── Конфигурация машины ──────────────────────────────────────────────────────
# app.env пишет cloud-init, лежит он у root с правами 0640. Контейнеру нужна
# читаемая копия; заодно так видно, с какой конфигурацией уехал релиз.
say "Конфигурация из /etc/uchetkin/app.env"
sudo install -m 0600 -o "$(id -un)" -g "$(id -gn)" /etc/uchetkin/app.env "${APP_DIR}/app.env"
# shellcheck source=/dev/null
. "${APP_DIR}/app.env"

: "${APP_ENV:?в app.env нет APP_ENV}"
: "${LOCKBOX_DB_SECRET_ID:?в app.env нет LOCKBOX_DB_SECRET_ID}"
echo "контур: ${APP_ENV}, образы: ${REGISTRY}/uchetkin-{api,web}:${IMAGE_TAG}"

# ── Доступ к реестру ─────────────────────────────────────────────────────────
# По сервисному аккаунту машины (роль container-registry.images.puller выдана в
# infra/iam.tf). Ключа на диске нет и не нужно.
say "Вход в Container Registry"
IAM_TOKEN=$(curl -sfH 'Metadata-Flavor: Google' "$METADATA_TOKEN_URL" | jq -re .access_token)
printf '%s' "$IAM_TOKEN" | docker login --username iam --password-stdin cr.yandex

# ── Что запускать ────────────────────────────────────────────────────────────
# Профиль localdb включается там, где базы как сервиса нет (dev): тогда
# PostgreSQL поднимается контейнером рядом (infra/dev.tfvars, managed_postgres).
COMPOSE_PROFILES=""
if [ "${MANAGED_POSTGRES:-true}" != "true" ]; then
  COMPOSE_PROFILES=localdb
fi

PREVIOUS_TAG=""
if [ -f "${APP_DIR}/.env" ]; then
  PREVIOUS_TAG=$(sed -n 's/^IMAGE_TAG=//p' "${APP_DIR}/.env")
fi

umask 077
cat > "${APP_DIR}/.env" <<ENV
# Файл пишет deploy.sh. Правки здесь переживут только до следующей выкладки.
REGISTRY=${REGISTRY}
IMAGE_TAG=${IMAGE_TAG}
COMPOSE_PROFILES=${COMPOSE_PROFILES}
ENV

# ── База ─────────────────────────────────────────────────────────────────────
if [ "$COMPOSE_PROFILES" = localdb ]; then
  say "Пароль базы из Lockbox и запуск PostgreSQL"
  DB_PAYLOAD=$(curl -sfH "Authorization: Bearer ${IAM_TOKEN}" "${LOCKBOX_URL}/${LOCKBOX_DB_SECRET_ID}/payload")
  entry() { printf '%s' "$DB_PAYLOAD" | jq -re --arg k "$1" '.entries[] | select(.key == $k) | .textValue'; }
  cat > "${APP_DIR}/db.env" <<ENV
POSTGRES_DB=$(entry database)
POSTGRES_USER=$(entry username)
POSTGRES_PASSWORD=$(entry password)
ENV
  chmod 600 "${APP_DIR}/db.env"
  docker compose up -d postgres
  # Миграции идут первым же шагом после этого, и им нужна отвечающая база.
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' uchetkin-postgres)" = healthy ] && break
    sleep 2
  done
fi
umask 022

# ── Образы ───────────────────────────────────────────────────────────────────
say "Скачивание образов"
docker compose pull api web caddy

# ── Миграции ─────────────────────────────────────────────────────────────────
# Отдельным шагом и до перезапуска: приложение поднимается уже на готовой схеме.
# Строку подключения контейнер собирает сам из Lockbox (server/src/migrate.ts).
say "Миграции базы"
docker compose run --rm --no-deps api npm run migrate:cloud

# ── Запуск ───────────────────────────────────────────────────────────────────
say "Запуск приложения"
docker compose up -d --remove-orphans

# ── Проверка ─────────────────────────────────────────────────────────────────
say "Проба живости ${HEALTH_URL}"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)
  if [ "$code" = 200 ]; then
    echo "/health ответил 200"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ПЛОХО: /health не ответил 200 за ${HEALTH_TIMEOUT} с (последний код: ${code:-нет ответа})" >&2
    docker compose ps >&2
    docker compose logs --tail=100 api >&2
    if [ -n "$PREVIOUS_TAG" ]; then
      echo "Откат: тот же workflow с тегом ${PREVIOUS_TAG} (docs/release.md)" >&2
    fi
    exit 1
  fi
  sleep 3
done

# ── Уборка ───────────────────────────────────────────────────────────────────
# Старые образы копятся на диске ВМ быстрее, чем кажется. Предыдущий тег при
# этом остаётся в записи о релизах — по нему делается откат.
printf '%s\t%s\t%s\n' "$(date --iso-8601=seconds)" "$IMAGE_TAG" "${PREVIOUS_TAG:-—}" >> "${APP_DIR}/releases.log"
docker image prune -f >/dev/null

say "Готово: ${APP_ENV} на теге ${IMAGE_TAG} (предыдущий — ${PREVIOUS_TAG:-нет})"
