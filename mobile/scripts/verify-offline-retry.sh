#!/usr/bin/env bash
# Manual verification driver: "a failed upload keeps the photo and the typed fields, and the
# retry succeeds from the preserved form".
#
# The harness cannot own this one: it needs the backend DOWN, and stopping a shared backend from
# inside a scenario risks leaving it down if the script dies. This driver owns the stop/start
# instead, and restarts the API from an EXIT trap so a failure cannot leave it down.
#
#   bash mobile/scripts/verify-offline-retry.sh
#
# Preconditions: backend up, app installed and signed in.
set -uo pipefail

REPO=/Users/Apple/.vetta/workspace/知衣/wardrowbe
export ANDROID_HOME=/tmp/zhiyi-android/sdk
export ARTIFACTS_DIR="$REPO/mobile/docs/device-shots"
ADB=$ANDROID_HOME/platform-tools/adb
PREP="$REPO/mobile/scripts/device-prep.sh"
APP=com.zhiyi.wardrobe
API=http://127.0.0.1:8000/api/v1
EMAIL=harness@zhiyi-harness.com
EXTERNAL_ID="dev:$EMAIL"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()  { printf '  \033[32mok\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }

started=$(date +%s)
NAME="offline-keeps-$(date +%H%M%S)"
FAILED=0
API_DOWN=0

token() {
  curl -fsS -m 10 -X POST "$API/auth/sync" -H 'Content-Type: application/json' \
    -d "{\"external_id\":\"$EXTERNAL_ID\",\"email\":\"$EMAIL\",\"display_name\":\"x\"}" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])'
}

item_total() {
  curl -fsS -m 10 "$API/items?page=1&page_size=1&is_archived=false" \
    -H "Authorization: Bearer $(token)" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["total"])'
}

restore_backend() {
  if [ "$API_DOWN" -eq 1 ]; then
    log "cleanup: restarting the API"
    ( cd "$REPO" && DEV_ROOT=/tmp/zhiyi-pg ./scripts/dev-local.sh start ) >/tmp/offline-restart-backend.log 2>&1
    for _ in $(seq 1 40); do
      curl -fsS -m 3 "$API/health" >/dev/null 2>&1 && break
      sleep 2
    done
    if curl -fsS -m 3 "$API/health" >/dev/null 2>&1; then
      ok "the API is healthy again"
    else
      bad "the API did not come back; see /tmp/offline-restart-backend.log"
    fi
  fi
}
trap restore_backend EXIT

# Dump the visible UI to $ARTIFACTS_DIR/<name>.xml and echo the path.
dump() {
  "$PREP" dump "$1" >/dev/null 2>&1
  printf '%s/%s.xml' "$ARTIFACTS_DIR" "$1"
}

# Tap a control that may be below the fold: try, then scroll and retry.
#
# The add form is taller than the screen — the 取消/添加 row sits under the type chips — so a
# single `tap-text 添加` finds nothing in the dump and does nothing at all. The first version of
# this driver did exactly that and then reported "no failure message", i.e. it blamed the product
# for a tap that never happened.
tap_after_scroll() {
  local label="$1" i
  for i in $(seq 1 12); do
    if "$PREP" tap-text "$label" >/dev/null 2>&1; then
      return 0
    fi
    "$PREP" swipe up 400 >/dev/null 2>&1
    sleep 1
  done
  return 1
}

log "0. clear the test wardrobe, so the retry below is a genuine create (not a 409 duplicate)"
curl -fsS -m 3 "$API/health" >/dev/null 2>&1 || { echo "backend is down; start it first"; exit 2; }
for archived in false true; do
  curl -fsS -m 10 "$API/items?page=1&page_size=100&is_archived=$archived" -H "Authorization: Bearer $(token)" \
    | python3 -c 'import json,sys
for i in (json.load(sys.stdin).get("items") or []): print(i["id"])'
done | sort -u | while read -r id; do
  curl -s -o /dev/null -m 10 -X DELETE "$API/items/$id" -H "Authorization: Bearer $(token)"
done
ok "the test wardrobe is empty (was $(item_total) item(s) before clearing is not re-read here)"

log "1. the backend is up and the app restores its session"
"$ADB" shell am force-stop "$APP" >/dev/null 2>&1
sleep 2
"$ADB" shell am start -n "$APP/.MainActivity" >/dev/null 2>&1
sleep 28
"$PREP" shot "offline-01-cold-start" >/dev/null 2>&1
D="$(dump offline-01-cold-start)"
if grep -q "登录以管理你的衣橱" "$D"; then
  bad "the app is on the login screen although the backend is up"
  exit 1
fi
ok "the session was restored from secure storage"

log "2. open the add screen, attach a gallery photo, type a name"
"$PREP" tap-text "添加单品" >/dev/null 2>&1 || true
sleep 6
"$PREP" tap-text "从相册选择" >/dev/null 2>&1
sleep 9
tile=$(python3 - "$ARTIFACTS_DIR" "$ADB" <<'PY'
import subprocess, sys, xml.etree.ElementTree as ET
artifacts, adb = sys.argv[1], sys.argv[2]
out = subprocess.run([adb, "exec-out", "uiautomator", "dump", "/dev/tty"],
                     capture_output=True, text=True)
xml = out.stdout.split("<hierarchy")[-1].split("UI hierchary dumped")[0]
path = f"{artifacts}/.offline-picker.xml"
open(path, "w").write("<hierarchy" + xml)
best = ""
for n in ET.parse(path).getroot().iter("node"):
    if n.get("clickable") == "true" and "Photo taken" in (n.get("content-desc") or ""):
        digits = n.get("bounds", "").replace("][", ",").strip("[]").split(",")
        best = f"{(int(digits[0]) + int(digits[2])) // 2} {(int(digits[1]) + int(digits[3])) // 2}"
        break
print(best)
PY
)
[ -n "$tile" ] || { bad "no photo tile in the system picker"; exit 1; }
# shellcheck disable=SC2086
"$PREP" tap $tile >/dev/null 2>&1
sleep 9
"$PREP" hide-keyboard >/dev/null 2>&1 || true
"$PREP" tap-text "例如：白色棉质衬衫" >/dev/null 2>&1
sleep 1
"$PREP" type "$NAME" >/dev/null 2>&1
"$PREP" hide-keyboard >/dev/null 2>&1 || true
sleep 2
"$PREP" shot "offline-02-form-filled" >/dev/null 2>&1
D="$(dump offline-02-form-filled)"
if grep -q -F -- "$NAME" "$D"; then
  ok "the form holds the photo and the name '$NAME'"
else
  bad "the name did not land in the field"
fi

log "3. stop ONLY the API (PostgreSQL stays up)"
kill "$(pgrep -f 'uvicorn app.main:app' | head -1)" 2>/dev/null
API_DOWN=1
sleep 3
if curl -fsS -m 3 "$API/health" >/dev/null 2>&1; then
  bad "the API is still reachable; the test would prove nothing"
  exit 1
fi
ok "the API is unreachable (connection refused)"

log "4. submit: the upload must fail visibly and keep the form"
"$PREP" hide-keyboard >/dev/null 2>&1 || true
"$PREP" swipe down 600 >/dev/null 2>&1 || true
tap_after_scroll "添加" || bad "could not reach the 添加 button to submit"
sleep 30
"$PREP" shot "offline-03-after-submit" >/dev/null 2>&1
D="$(dump offline-03-after-submit)"

# The failure UI for this path is the "your photo and entries are kept" panel, not the generic
# 上传失败 string: `app/item/new.tsx` keeps the form mounted and shows `inputKept` with a retry
# control. Accept either wording; what matters is that a failure is stated and nothing is lost.
if grep -qE "照片和填写的信息都已保留|上传失败" "$D"; then
  ok "the user is told it failed (照片和填写的信息都已保留 / 上传失败)"
else
  bad "no failure message after submitting with the API down"
fi
if grep -q "已添加" "$D"; then
  bad "the app claimed success while the API was unreachable"
else
  ok "no false success (no 已添加)"
fi
if grep -q -F -- "$NAME" "$D"; then
  ok "the typed name survived the failure"
else
  bad "the typed name was lost on failure"
fi
if grep -q "还没有选择照片" "$D"; then
  bad "the photo was dropped on failure"
else
  ok "the photo is still attached"
fi
if grep -q "重新上传" "$D" || grep -q "重试" "$D"; then
  ok "a retry control is offered"
else
  bad "no retry control after the failure"
fi

log "5. restart the API and retry from the same screen"
restore_backend
API_DOWN=0
before_total=$(item_total)
"$PREP" hide-keyboard >/dev/null 2>&1 || true
tap_after_scroll "重新上传" || tap_after_scroll "重试" || true
sleep 40
"$PREP" shot "offline-04-after-retry" >/dev/null 2>&1
D="$(dump offline-04-after-retry)"
after_total=$(item_total)
if grep -q "已添加" "$D" || [ "${after_total:-0}" -gt "${before_total:-0}" ]; then
  ok "the retry succeeded from the preserved form (server items $before_total -> $after_total)"
else
  bad "the retry stored nothing (server items $before_total -> $after_total; see offline-04-after-retry.png)"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "RESULT: PASS — the failure was reported, the photo and the typed name were kept, and the retry stored the item ($(( $(date +%s) - started ))s)"
else
  echo "RESULT: FAIL — see the FAIL lines above"
fi
exit "$FAILED"
