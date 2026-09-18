#!/usr/bin/env bash
# Сверка ролей в облаке и в репозитории с реестром доступов (docs/support/roles.json).
#
#   docs/support/check-roles.sh            # код 0 — роли совпадают с реестром
#
# Нужны: yc с профилем, у которого есть чтение прав на каталог (переменная YC_PROFILE,
# по умолчанию crm-deploy), учётные данные GitHub в git credential, python3.
# Прокси для api.github.com — HTTPS_PROXY (в песочнице http://127.0.0.1:10809).
# Значений секретов скрипт не читает и не печатает: только субъект=роль.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cfg="$here/roles.json"
YC=${YC:-$(command -v yc || echo "$HOME/bin/yc")}
PROFILE=${YC_PROFILE:-crm-deploy}
folder=$(python3 -c "import json;print(json.load(open('$cfg'))['folder_id'])")
registry=$(python3 -c "import json;print(json.load(open('$cfg'))['registry_id'])")
repo=$(python3 -c "import json;print(json.load(open('$cfg'))['github_repo'])")

names=$("$YC" iam service-account list --folder-id "$folder" --profile "$PROFILE" --format json)
folder_b=$("$YC" resource-manager folder list-access-bindings "$folder" --profile "$PROFILE" --format json)
registry_b=$("$YC" container registry list-access-bindings "$registry" --profile "$PROFILE" --format json)

tok=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | sed -n 's/^password=//p')
collab=$(curl -sS ${HTTPS_PROXY:+-x "$HTTPS_PROXY"} -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$repo/collaborators")

NAMES="$names" FOLDER="$folder_b" REGISTRY="$registry_b" COLLAB="$collab" CFG="$cfg" python3 - <<'PY'
import json, os, sys
cfg = json.load(open(os.environ['CFG']))
names = {s['id']: s['name'] for s in json.loads(os.environ['NAMES'])}
def norm(bindings):
    out = []
    for b in bindings:
        s = b['subject']
        who = names.get(s['id'], s['id']) if s['type'] == 'serviceAccount' else s['id']
        out.append(f"{s['type']}:{who}={b['role_id']}")
    return sorted(out)
collab = json.loads(os.environ['COLLAB'])
if not isinstance(collab, list):
    print('GitHub:', collab.get('message', collab)); sys.exit(2)
actual = {
    'folder_bindings': norm(json.loads(os.environ['FOLDER'])),
    'registry_bindings': norm(json.loads(os.environ['REGISTRY'])),
    'github_collaborators': sorted(f"{c['login']}={c['role_name']}" for c in collab),
}
ok = True
for key, got in actual.items():
    want = sorted(cfg[key])
    if got != want:
        ok = False
        print(f"{key}: расходится с реестром")
        for x in sorted(set(want) - set(got)): print(f"  в реестре, но не в факте: {x}")
        for x in sorted(set(got) - set(want)): print(f"  в факте, но не в реестре: {x}")
    else:
        print(f"{key}: {len(got)} — совпадает с реестром")
sys.exit(0 if ok else 1)
PY
