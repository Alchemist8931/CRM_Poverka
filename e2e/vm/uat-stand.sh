#!/usr/bin/env bash
# Перезаливка тестового контура на машине dev (пункт test-uat).
#
#   sudo UAT_BOT_PASSWORD=… bash /opt/uchetkin/src/e2e/vm/uat-stand.sh
#
# Что делает: поднимает контейнер node с исходниками сервера из /opt/uchetkin/src,
# ставит зависимости (кэш — в томе uchetkin-uat-npm, чтобы не качать каждый раз)
# и запускает `npm run uat:stand -- --yes` со строкой подключения к базе
# контура. Строка собирается внутри контейнера из /opt/uchetkin/db.env — пароль
# на экран не попадает.
#
# Данные испытаний стираются: скрипт для этого и нужен. В prod его нет.
set -euo pipefail

SRC=${SRC:-/opt/uchetkin/src/server}
DB_ENV=${DB_ENV:-/opt/uchetkin/db.env}
NETWORK=${NETWORK:-uchetkin_default}
PGHOST=${PGHOST:-postgres}

[ -f "$DB_ENV" ] || { echo "нет $DB_ENV — база контура не настроена" >&2; exit 1; }
[ -n "${UAT_BOT_PASSWORD:-}" ] || echo "UAT_BOT_PASSWORD не задан: пароль технической учётки будет напечатан ниже один раз" >&2

docker run --rm --network "$NETWORK" \
  -v "$SRC:/app" -w /app \
  -v uchetkin-uat-npm:/root/.npm \
  --env-file "$DB_ENV" \
  -e PGHOST="$PGHOST" \
  -e UAT_BOT_PASSWORD="${UAT_BOT_PASSWORD:-}" \
  -e UCHETKIN_OWNER_NAME="${UCHETKIN_OWNER_NAME:-}" -e UCHETKIN_OWNER_LOGIN="${UCHETKIN_OWNER_LOGIN:-}" -e UCHETKIN_OWNER_EMAIL="${UCHETKIN_OWNER_EMAIL:-}" \
  -e UCHETKIN_CHIEF_NAME="${UCHETKIN_CHIEF_NAME:-}" -e UCHETKIN_CHIEF_LOGIN="${UCHETKIN_CHIEF_LOGIN:-}" -e UCHETKIN_CHIEF_EMAIL="${UCHETKIN_CHIEF_EMAIL:-}" \
  node:22-alpine sh -c '
    set -e
    export DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@$PGHOST:5432/$POSTGRES_DB"
    # node_modules из песочницы разработчика сюда не монтируются: ставим в
    # отдельный каталог образа, чтобы не трогать чужие файлы на диске.
    if [ ! -d /opt/nm/node_modules ] || [ package-lock.json -nt /opt/nm/.stamp ]; then
      mkdir -p /opt/nm && cp package.json package-lock.json /opt/nm/ && (cd /opt/nm && npm ci --no-audit --no-fund --loglevel=error) && touch /opt/nm/.stamp
    fi
    export NODE_PATH=/opt/nm/node_modules
    ln -sfn /opt/nm/node_modules /app/node_modules 2>/dev/null || true
    npx --prefix /opt/nm tsx scripts/uat-stand.mts --yes
  '
