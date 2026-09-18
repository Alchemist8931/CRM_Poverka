#!/bin/sh
# Выгрузка заявок за период в .xlsx на машине контура — страховка отката пилота
# (docs/launch.md, «Откат»). Только чтение базы.
#
#   sudo /opt/uchetkin/src/deploy/export-period.sh 2026-09-21 2026-09-27 [каталог]
#   → /var/lib/uchetkin/export/заявки-2026-09-21-2026-09-27.xlsx
#
# Образ API собран без dev-зависимостей и без scripts/, поэтому выгрузка идёт
# отдельным контейнером node:22-alpine из свежих исходников main (клон во
# временный каталог — рабочий клон /opt/uchetkin/src не трогается: он источник
# образов). База — контейнер compose, по его сети; пароль — из db.env.
set -eu

FROM=${1:?дата с, ГГГГ-ММ-ДД}
TO=${2:?дата по, ГГГГ-ММ-ДД}
OUT=${3:-/var/lib/uchetkin/export}
REPO=${REPO:-https://github.com/Alchemist8931/CRM_Poverka}
NETWORK=${NETWORK:-uchetkin_default}
DB_ENV=${DB_ENV:-/opt/uchetkin/db.env}

mkdir -p "$OUT"
SRC=$(mktemp -d /tmp/uchetkin-export.XXXXXX)
trap 'rm -rf "$SRC"' EXIT
git clone -q --depth 1 "$REPO" "$SRC"

# shellcheck disable=SC1090
. "$DB_ENV"
URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@uchetkin-postgres:5432/$POSTGRES_DB"

docker run --rm --network "$NETWORK" \
  -v "$SRC/server:/app" -v "$OUT:/out" -w /app \
  -e DATABASE_URL="$URL" -e FROM="$FROM" -e TO="$TO" \
  node:22-alpine sh -c 'npm ci --no-audit --no-fund --loglevel=error >/dev/null \
    && npm run --silent export:period -- --from "$FROM" --to "$TO" --out "/out/заявки-$FROM-$TO.xlsx"'
chmod 644 "$OUT/заявки-$FROM-$TO.xlsx"
echo "Готово: $OUT/заявки-$FROM-$TO.xlsx"
