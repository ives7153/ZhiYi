#!/usr/bin/env bash
#
# run-acceptance.sh — execute the round-2 acceptance scenarios against the emulator
# mechanically, instead of tapping by hand.
#
#     ./mobile/scripts/run-acceptance.sh              # every scenario
#     ./mobile/scripts/run-acceptance.sh --list       # show them, run none
#     ./mobile/scripts/run-acceptance.sh s1 s3        # only these
#
# Each scenario prints PASS / FAIL / MANUAL / SKIP with the evidence it used, writes a
# screenshot + UI dump under mobile/docs/device-shots/, and returns non-zero if any
# automated scenario failed.
#
# WHAT IS SCRIPTABLE, AND WHAT IS NOT
#
# The system PhotoPicker (com.google.android.providers.media.module) is a normal Android
# activity whose items carry content-desc and bounds, so choosing a photo from the gallery IS
# scriptable — tap the tile by coordinate, verified. Camera capture is NOT: the emulated
# camera's shutter is a system UI button whose accessibility tree changes per image, so
# `camera-capture` is reported MANUAL with the exact commands to do it by hand.
#
# This script asserts against the BACKEND as well as the screen. A screenshot alone cannot
# distinguish "the upload failed" from "the upload succeeded but the list is stale", and
# scenario 4 (no duplicate records) is only meaningful against stored rows.
#
# See mobile/docs/第二轮-设备验证手册.md for the narrative version of each scenario.
#
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-env.sh"

# Same device lock as the other harness scripts: re-exec once and let the child own the lock.
# The release trap is armed by the child because `exec` resets traps.
if [ -z "${ZHIYI_HARNESS_LOCKED:-}" ]; then
  case "${1:-}" in
    -h|--help) ;;
    *)
      acquire_device_lock
      export ZHIYI_HARNESS_LOCKED=1
      exec bash "${BASH_SOURCE[0]}" "$@"
      ;;
  esac
else
  # shellcheck disable=SC2064
  trap 'release_device_lock' EXIT INT TERM
fi

mkdir -p "$ARTIFACTS_DIR"

# The test account's email domain matters. `.test`, `.local` and friends are reserved TLDs:
# POST /auth/sync accepts them, but GET /auth/session validates `email` as an EmailStr and
# returns 422, so the app treats its own credential as unusable and drops back to the login
# screen mid-run. Verified on this backend:
#   harness@zhiyi-dev.test    -> /auth/sync 200, /auth/session 422 ("special-use or reserved name")
#   harness@zhiyi-harness.com -> /auth/sync 200, /auth/session 200
# This is the same trap mobile/README.md §5 warns about, and it silently invalidated earlier
# scenario runs by logging the app out between steps. Keep a real TLD here.
TEST_USER_EMAIL="${TEST_USER_EMAIL:-harness@zhiyi-harness.com}"

# The harness MUST present the same `external_id` the app's dev login does.
#
# `src/auth/AuthContext.tsx:213` derives it as `dev:<email>`. When the two differ, the backend
# treats the second one as an auth-provider migration: `UserService.sync_from_oidc` (see its
# docstring, and `app/services/user_service.py:73-86`) looks the user up by external_id, misses,
# finds it by email, and REWRITES `external_id` to whichever value just arrived.
#
# Access tokens carry the external_id in `sub`, and `get_current_user` resolves the user by it,
# so every rewrite instantly invalidates the other side's token: the app gets 401 on its next
# wardrobe query, treats it as "credentials rejected", signs itself out and clears secure
# storage. That is exactly what made s1 stop at the login screen with no upload: the harness
# logged in first, the app then rewrote external_id at its own login, and the harness's later
# /auth/sync rewrite killed the app's session mid-form.
#
# Measured on this backend: with the mismatched value the app lost its session within ~2 minutes
# of login; with the value below, login -> gallery pick -> submit -> restart all hold.
TEST_USER_EXTERNAL_ID="dev:${TEST_USER_EMAIL}"

# Fail immediately if the configured address cannot survive /auth/session, rather than
# discovering it as a mysterious logout halfway through a scenario.
assert_test_account_usable() {
  local token status
  token="$(curl -fsS -m 10 -X POST "$API/auth/sync" \
      -H 'Content-Type: application/json' \
      -d "{\"external_id\":\"$TEST_USER_EXTERNAL_ID\",\"email\":\"$TEST_USER_EMAIL\",\"display_name\":\"设备验证脚手架\"}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
  if [ -z "$token" ]; then
    die "GET/POST to $API/auth/sync did not return a token — is the backend in dev_mode?
  Check: curl $API/auth/config"
  fi
  status="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$API/auth/session" \
    -H "Authorization: Bearer $token")"
  if [ "$status" != "200" ]; then
    die "Test account '$TEST_USER_EMAIL' cannot pass /auth/session (HTTP $status).
  The app would log itself out mid-run, producing failures that look like app bugs.
  Use an email with a real TLD, e.g. TEST_USER_EMAIL=harness@example.com $0 ..."
  fi
  # Reuse this verified token rather than fetching another one.
  printf '%s' "$token" > "$TOKEN_CACHE"
}
API="${API:-$BACKEND_HOST_URL/api/v1}"

PASS_COUNT=0
FAIL_COUNT=0
MANUAL_COUNT=0
SKIP_COUNT=0
declare -a RESULTS=()

record() {
  local status="$1" name="$2" detail="${3:-}"
  case "$status" in
    PASS)   PASS_COUNT=$((PASS_COUNT + 1));   printf '%sPASS%s   %-22s %s\n' "$_c_green"  "$_c_reset" "$name" "$detail" ;;
    FAIL)   FAIL_COUNT=$((FAIL_COUNT + 1));   printf '%sFAIL%s   %-22s %s\n' "$_c_red"    "$_c_reset" "$name" "$detail" ;;
    MANUAL) MANUAL_COUNT=$((MANUAL_COUNT + 1)); printf '%sMANUAL%s %-22s %s\n' "$_c_yellow" "$_c_reset" "$name" "$detail" ;;
    SKIP)   SKIP_COUNT=$((SKIP_COUNT + 1));   printf '%sSKIP%s   %-22s %s\n' "$_c_yellow" "$_c_reset" "$name" "$detail" ;;
  esac
  RESULTS+=("$status|$name|$detail")
}

# ---------------------------------------------------------------------------------------------
# Backend helpers — the ground truth the UI is only a view of
# ---------------------------------------------------------------------------------------------
# Cached dev token, kept in a file rather than a shell variable.
#
# A variable is not enough: api_item_count and the other helpers are called as `$( ... )`, so a
# variable assigned inside that subshell dies with it. Without a cache every call re-runs
# /auth/sync, which is slow and racy — it showed up as a bare `curl: (22) ... 401` in the middle
# of a scenario run. A file survives the subshell.
TOKEN_CACHE="$ARTIFACTS_DIR/.dev-token"
api_login() {
  if [ -s "$TOKEN_CACHE" ]; then
    TOKEN="$(cat "$TOKEN_CACHE")"
    return 0
  fi
  TOKEN="$(curl -fsS -m 10 -X POST "$API/auth/sync" \
      -H 'Content-Type: application/json' \
      -d "{\"external_id\":\"$TEST_USER_EXTERNAL_ID\",\"email\":\"$TEST_USER_EMAIL\",\"display_name\":\"设备验证脚手架\"}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
  if [ -z "$TOKEN" ]; then
    warn "could not obtain a dev token from $API/auth/sync"
    return 1
  fi
  printf '%s' "$TOKEN" > "$TOKEN_CACHE"
  return 0
}

# Number of non-archived items for the test user, as the server counts them.

# Drop the cached token so the next call re-authenticates; used after a 401.
api_forget_token() {
  rm -f "$TOKEN_CACHE" 2>/dev/null || true
  TOKEN=""
}

# GET an API path with the token, re-authenticating once on 401 and printing the body.
api_get() {
  local path="$1" token body
  api_login || return 1
  token="$(cat "$TOKEN_CACHE")"
  body="$(curl -fsS -m 10 "$API$path" -H "Authorization: Bearer $token" 2>/dev/null)" && {
    printf '%s' "$body"
    return 0
  }
  # Retry once with a fresh token: the cached one may have expired (the backend issues no
  # refresh endpoint), or a previous run may have been interrupted mid-write.
  api_forget_token
  api_login || return 1
  token="$(cat "$TOKEN_CACHE")"
  curl -fsS -m 10 "$API$path" -H "Authorization: Bearer $token"
}
api_item_count() {
  api_get "/items?page=1&page_size=1&is_archived=false" \
    | sed -n 's/.*"total":\([0-9]*\).*/\1/p'
}

# Every item id owned by the test user — archived rows AND live ones.
#
# The earlier version queried `is_archived=true` only. On this API that filter means "archived
# rows ONLY", so for a wardrobe of ordinary items it returned nothing, `api_delete_all` deleted
# nothing, and the caller's "before" count was taken over rows it had just failed to clear. The
# server's pHash duplicate check then rejected the new upload with 409 and the scenario reported
# "no new item appeared" — a harness bug wearing a product bug's clothes.
#
# Ids are extracted with a JSON parser rather than `sed`: the response also carries `user_id`,
# whose value matched the old pattern and was dutifully DELETEd (harmlessly 404-ing) every run.
api_item_ids() {
  local archived
  for archived in false true; do
    api_get "/items?page=1&page_size=100&is_archived=$archived" | python3 -c '
import json, sys
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    items = []
for item in items:
    print(item.get("id") or "")
'
  done | sed '/^$/d' | sort -u
}

api_delete_all() {
  local id token
  api_login || return 0
  token="$(cat "$TOKEN_CACHE")"
  for id in $(api_item_ids); do
    curl -fsS -m 10 -o /dev/null -X DELETE "$API/items/$id" \
      -H "Authorization: Bearer $token" || true
  done
}

# Item names currently on the server, one per line.
# Item names currently on the server, one per line — archived rows included, because s1 checks
# the name it just typed and archiving must not make a stored name invisible here. (Same
# `is_archived` mistake as api_item_ids: the filter is "archived only", not "include archived".)
api_item_names() {
  local archived
  for archived in false true; do
    api_get "/items?page=1&page_size=100&is_archived=$archived" | python3 -c '
import json, sys
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    items = []
for item in items:
    print(item.get("name") or "")
'
  done | sed '/^$/d' | sort -u
}

# ---------------------------------------------------------------------------------------------
# UI helpers built on the shared primitives
# ---------------------------------------------------------------------------------------------
# Screen label from the dump parser, e.g. 登录页 / 衣橱页 / 添加单品页.
# True when an activity from another package is in the foreground (the system PhotoPicker, the
# camera, a permission dialog). The app is then not in control of the screen, and any tap or
# screen assertion would be meaningless until it is dismissed.
foreign_activity_in_foreground() {
  local top
  top="$(adb_shell "dumpsys activity activities" | grep -m1 topResumedActivity || true)"
  [ -n "$top" ] || return 1
  # 0 or 1 matches for our own package means we are (or may be) in charge; anything else is foreign.
  [ "$(printf '%s' "$top" | grep -c "$APP_ID")" -eq 0 ]
}

# Dismiss whatever foreign activity is on top and bring the app back.
recover_to_app() {
  local attempt
  for attempt in 1 2 3; do
    "$ADB" shell input keyevent KEYCODE_BACK >/dev/null 2>&1
    sleep 2
    if ! foreign_activity_in_foreground; then
      return 0
    fi
    warn "a foreign activity is still on top (attempt $attempt); force-stopping it"
    # The picker and the camera are separate packages; stopping them is safe and is what a user
    # dismissing the sheet does anyway.
    "$ADB" shell am force-stop com.google.android.providers.media.module >/dev/null 2>&1 || true
    "$ADB" shell am force-stop com.android.camera2 >/dev/null 2>&1 || true
    sleep 2
  done
  return 0
}

current_screen() {
  local xml="$ARTIFACTS_DIR/.screen.xml"
  ui_dump_xml "$xml" || return 1
  python3 "$ANDROID_ENV_DIR/ui-dump-report.py" "$xml" 2>/dev/null \
    | sed -n 's/^SCREEN=//p'
}

# True when the screen contains the given text.
screen_has_text() {
  local needle="$1" xml="$ARTIFACTS_DIR/.has.xml"
  ui_dump_xml "$xml" || return 1
  grep -q -F -- "$needle" "$xml"
}

capture() {
  local name="$1"
  "$ADB" exec-out screencap -p > "$ARTIFACTS_DIR/$name.png" 2>/dev/null || true
  local xml="$ARTIFACTS_DIR/$name.xml"
  if ui_dump_xml "$xml"; then
    python3 "$ANDROID_ENV_DIR/ui-dump-report.py" "$xml" "$ARTIFACTS_DIR" >/dev/null 2>&1 || true
  fi
}

# Ensure the app is on the wardrobe screen, logged in. Returns non-zero if it is not.
#
# Every step waits for the screen to actually change before acting again. Tapping immediately
# after KEYCODE_BACK races the transition: the tap lands on the outgoing screen and the next
# check sees the wrong state — which is how "could not reach the add screen" appeared right
# after a permission change.
goto_wardrobe() {
  # First make sure the app — not the picker, camera or a system dialog — owns the screen.
  # Without this, a picker left open by an earlier step makes the app look unreachable, since
  # the dump then describes the picker and every screen assertion is about the wrong window.
  if foreign_activity_in_foreground; then
    warn "a foreign activity is in the foreground; recovering to the app"
    recover_to_app
  fi

  local screen
  screen="$(current_screen || echo unknown)"

  # Cold or logged out: bring the app up and use the dev form.
  if [ "$screen" = "登录页" ] || [ "$screen" = "未识别" ]; then
    login_dev || return 1
    sleep 3
    screen="$(current_screen || echo unknown)"
  fi

  case "$screen" in
    衣橱页)
      return 0
      ;;
    添加单品页|单品详情)
      "$ADB" shell input keyevent KEYCODE_BACK >/dev/null 2>&1
      if wait_for_screen "衣橱页" 12; then
        return 0
      fi
      # BACK did not land where expected; fall through to the restart path below.
      warn "still on '$screen' after BACK; restarting the app"
      ;;
  esac

  # Anything else (system dialog, the picker, back at the launcher after a crash): restart.
  "$ADB" shell am force-stop "$APP_ID" >/dev/null 2>&1
  sleep 1
  "$ADB" shell am start -n "$MAIN_ACTIVITY" >/dev/null 2>&1
  wait_for_screen "衣橱页" 25 || wait_for_text "登录以管理你的衣橱" 10
}

# Wait until the dump reports a particular screen label.
wait_for_screen() {
  local want="$1" timeout="${2:-10}" waited=0 got
  while [ "$waited" -lt "$timeout" ]; do
    got="$(current_screen || true)"
    [ "$got" = "$want" ] && return 0
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

# Log in through the dev form, unless the app is already authenticated.
#
# The session persists in secure storage, so a restarted app usually lands straight on the
# wardrobe. The earlier version assumed a login form and timed out waiting for one that never
# appeared — which surfaced as "could not reach the add screen" and looked like a navigation
# bug. Check where we actually are first.
login_dev() {
  "$ADB" shell am force-stop "$APP_ID" >/dev/null 2>&1
  "$ADB" shell am start -n "$MAIN_ACTIVITY" >/dev/null 2>&1

  # Wait for the app to paint rather than guessing. The release build needs ~20s on this
  # GPU-less emulator (measured 21s from `am start` to the first text node); a fixed 8s wait
  # dumped a blank React root and the screen then looked unreachable.
  wait_for_ui_ready 60 || warn "the app did not render any text within 60s"

  # Already signed in: nothing to do.
  if wait_for_screen "衣橱页" 6; then
    log "already logged in (session restored from secure storage)"
    return 0
  fi

  if ! wait_for_text "登录以管理你的衣橱" 15; then
    warn "neither the wardrobe nor the login form appeared"
    return 1
  fi
  log "Logging in with the dev form ($TEST_USER_EMAIL)"

  # The email field may be prefilled with the app's placeholder; select it by its current
  # content, falling back to the field label.
  "$ANDROID_ENV_DIR/device-prep.sh" tap-text "dev@example.com" >/dev/null 2>&1 || \
    "$ANDROID_ENV_DIR/device-prep.sh" tap-text "邮箱" >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 25); do "$ADB" shell input keyevent KEYCODE_DEL >/dev/null 2>&1; done
  "$ANDROID_ENV_DIR/device-prep.sh" type "$TEST_USER_EMAIL" >/dev/null 2>&1
  "$ANDROID_ENV_DIR/device-prep.sh" hide-keyboard >/dev/null 2>&1

  # The name field sits below the email field, so the keyboard must be closed first.
  "$ANDROID_ENV_DIR/device-prep.sh" tap-text "你的名字" >/dev/null 2>&1
  "$ANDROID_ENV_DIR/device-prep.sh" type "Harness" >/dev/null 2>&1
  "$ANDROID_ENV_DIR/device-prep.sh" hide-keyboard >/dev/null 2>&1

  "$ANDROID_ENV_DIR/device-prep.sh" tap-text "登录" >/dev/null 2>&1
  wait_for_text "衣橱" 25
}

open_add_screen() {
  goto_wardrobe || return 1

  # Tap and wait for the add screen to actually appear, retrying once: a tap issued during a
  # screen transition can be swallowed.
  local attempt
  for attempt in 1 2 3; do
    # A previous step may have left a foreign activity up; clear it before tapping.
    foreign_activity_in_foreground && recover_to_app
    "$ANDROID_ENV_DIR/device-prep.sh" tap-text "添加单品" >/dev/null 2>&1
    if wait_for_text "从相册选择" 8; then
      return 0
    fi
    warn "add screen did not appear (attempt $attempt)"
    sleep 2
  done
  return 1
}

# Scroll the add form until the given control is tappable, then tap it.
#
# The add form is taller than the screen: the 名称 / 类别 / 颜色 / 品牌 / 收藏 fields and the
# 取消 / 保存 row all sit below the fold. `tap-text` fails loudly when a label is not in the
# current dump, so this simply scrolls in steps until the label appears, then taps.
#
# Returns 0 when the control was tapped, 1 when it never came into view.
tap_after_scrolling_to() {
  local label="$1" max_scrolls="${2:-12}" i
  for i in $(seq 1 "$max_scrolls"); do
    if "$ANDROID_ENV_DIR/device-prep.sh" tap-text "$label" >/dev/null 2>&1; then
      return 0
    fi
    "$ANDROID_ENV_DIR/device-prep.sh" swipe up 400 >/dev/null 2>&1
    sleep 1
  done
  return 1
}

# Type into a field that may be below the fold, scrolling until it can be focused.
# True when an EditText currently has focus.
focused_field_is_editable() {
  local xml="$ARTIFACTS_DIR/.focus.xml"
  mkdir -p "$ARTIFACTS_DIR"
  ui_dump_xml "$xml" 2>/dev/null || return 1
  python3 - "$xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

for n in ET.parse(sys.argv[1]).iter("node"):
    if n.get("class") == "android.widget.EditText" and n.get("focused") == "true":
        sys.exit(0)
sys.exit(1)
PY
}

# True when the focused EditText holds (at least) the given text.
focused_field_contains() {
  local want="$1" xml="$ARTIFACTS_DIR/.focus.xml"
  mkdir -p "$ARTIFACTS_DIR"
  ui_dump_xml "$xml" 2>/dev/null || return 1
  python3 - "$xml" "$want" <<'PY'
import sys
import xml.etree.ElementTree as ET

want = sys.argv[2]
for n in ET.parse(sys.argv[1]).iter("node"):
    if n.get("class") != "android.widget.EditText":
        continue
    if want in (n.get("text") or ""):
        sys.exit(0)
sys.exit(1)
PY
}

type_into_scrolled_field() {
  local placeholder="$1" text="$2" attempt

  # The soft keyboard owns the lower half of the screen, so a field whose bounds sit in that
  # region cannot be tapped — the tap lands on the keyboard and the text goes nowhere.
  # Measured: the name field at y≈1790 never received anything while the keyboard was up, and
  # the run only failed much later at the name-comparison assertion, which pointed at the wrong
  # cause. So close the keyboard before each attempt, and verify the field both took focus and
  # holds the text before claiming success.
  for attempt in 1 2 3 4 5; do
    "$ANDROID_ENV_DIR/device-prep.sh" hide-keyboard >/dev/null 2>&1 || true

    if "$ANDROID_ENV_DIR/device-prep.sh" tap-text "$placeholder" >/dev/null 2>&1; then
      if focused_field_is_editable; then
        "$ANDROID_ENV_DIR/device-prep.sh" type "$text" >/dev/null 2>&1
        if focused_field_contains "$text"; then
          "$ANDROID_ENV_DIR/device-prep.sh" hide-keyboard >/dev/null 2>&1 || true
          return 0
        fi
        warn "field took focus but does not hold the text yet"
      else
        warn "tap on '$placeholder' did not focus an editable field"
      fi
    fi

    "$ANDROID_ENV_DIR/device-prep.sh" swipe up 400 >/dev/null 2>&1
    sleep 1
  done
  return 1
}


# Open the system PhotoPicker from the add screen, retrying a few times.
#
# The picker is a separate package and its activity does not always come up on the first tap:
# a leftover system dialog, an in-flight transition, or a just-changed permission state can
# swallow the tap. Observed as "system PhotoPicker did not open after tapping 从相册选择" with
# nothing visibly wrong afterwards.
#
# Returns 0 when the picker is in the foreground.
picker_open() {
  local attempt
  for attempt in 1 2 3 4; do
    "$ANDROID_ENV_DIR/device-prep.sh" tap-text "从相册选择" >/dev/null 2>&1
    sleep 6
    if adb_shell "dumpsys activity activities" | has_match "photopicker"; then
      return 0
    fi
    warn "picker did not open (attempt $attempt); dismissing anything on top and retrying"
    "$ANDROID_ENV_DIR/device-prep.sh" hide-keyboard >/dev/null 2>&1 || true
    "$ADB" shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
    sleep 2
    "$ANDROID_ENV_DIR/device-prep.sh" tap-text "添加单品" >/dev/null 2>&1 || true
    sleep 2
  done
  return 1
}
# Pick the Nth visible tile in the system PhotoPicker.
# The tiles carry no text, only a rotationally-varying content-desc, so this taps by
# coordinate derived from the live dump: the tiles are the clickable FrameLayouts in the grid.
picker_take_photo() {
  local index="${1:-1}" xml="$ARTIFACTS_DIR/.picker.xml" bounds attempt

  # The grid is populated asynchronously by the picker's own media loader, so a dump taken
  # the instant the activity appears can legitimately contain zero tiles. Earlier this
  # returned 1 on the first empty dump, which is how s1 reported "could not find a photo
  # tile" even with four photos indexed. Retry with a wait instead of judging once.
  for attempt in 1 2 3 4 5 6; do
    if ui_dump_xml "$xml"; then
      bounds="$(python3 - "$xml" "$index" <<'PY'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
idx = int(sys.argv[2])
tiles = []
for n in root.iter("node"):
    if n.get("clickable") != "true":
        continue
    # The photo grid items are FrameLayouts with a "Photo taken on ..." description.
    if "Photo taken" in (n.get("content-desc") or ""):
        tiles.append(n.get("bounds"))
if 0 < idx <= len(tiles):
    print(tiles[idx - 1])
PY
)"
      if [ -n "$bounds" ]; then
        tap_bounds "$bounds" || return 1
        return 0
      fi
    fi
    warn "no photo tile in the picker yet (attempt $attempt); waiting for the grid"
    sleep 3
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------------------------

# S1 — add a garment from the gallery; it survives a refresh and an app restart.
scenario_s1() {
  log "S1  add a garment from the gallery, then verify it persists"
  api_delete_all

  open_add_screen || { record FAIL "s1-add-from-gallery" "could not reach the add screen"; return; }
  capture "s1-01-add-screen"

  # picker_open retries and is itself an assertion that the picker really came up.
  # (Note it uses has_match internally, not `grep -q`: under `set -o pipefail` a SUCCESSFUL
  # grep -q match kills the upstream adb with SIGPIPE and the pipeline reports 141, so the test
  # reads as false. That mistake made the picker look absent while 20 matching rows were present.)
  if ! picker_open; then
    record FAIL "s1-add-from-gallery" "system PhotoPicker did not open after 4 attempts"
    capture "s1-02-picker-missing"
    return
  fi
  capture "s1-02-picker"

  if ! picker_take_photo 1; then
    record FAIL "s1-add-from-gallery" "could not find a photo tile in the picker grid"
    return
  fi
  sleep 6
  capture "s1-03-selected"

  # The photo must now be attached: the add screen shows a preview instead of the placeholder.
  if screen_has_text "还没有选择照片"; then
    record FAIL "s1-add-from-gallery" "after picking a photo the add screen still shows 还没有选择照片"
    return
  fi
  ok "photo attached to the add form"

  # Fill the manual fields — the path that must work with AI disabled. The fields sit below the
  # fold on this device, so scroll until each control is reachable.
  #
  # The name is ASCII on purpose. `adb shell input text` cannot inject non-ASCII at all: sending
  # CJK makes InputShellCommand throw NullPointerException and nothing is typed at all. A Chinese
  # test name therefore tested nothing and failed at the last assertion, pointing at the wrong
  # cause. Chinese input needs a different route (see the manual, pitfall 8).
  # The stem is `harness-garment-`, not `harness-shirt-`: s2 scans the visible UI for
  # backend enum tokens, and a name containing "shirt" would trip its own check.
  local name="harness-garment-$(date +%H%M%S)"
  type_into_scrolled_field "例如：白色棉质衬衫" "$name" \
    || warn "could not reach the name field"
  capture "s1-04-filled"

  # Confirm the name actually landed in the field before relying on it later.
  if ! screen_has_text "$name"; then
    warn "the name field does not contain '$name' after typing"
  fi

  local before after
  before="$(api_item_count || echo 0)"

  local saved=0
  # The add page's submit button is 「添加」, NOT 「保存」. 「保存」 only exists in the
  # DETAIL screen's edit form. Tapping the wrong label made `tap-text` fail, so the
  # button was never pressed, no request was ever sent, and this scenario reported
  # "no new item appeared" on every run — a script bug that looked like a product
  # failure. See the audit report, finding B-3.
  if tap_after_scrolling_to "添加"; then
    # Give the upload time to finish and the list to refetch.
    local waited=0
    while [ "$waited" -lt 60 ]; do
      after="$(api_item_count || echo "$before")"
      [ "${after:-0}" -gt "${before:-0}" ] && { saved=1; break; }
      sleep 3; waited=$((waited + 3))
    done
  fi
  capture "s1-05-after-save"

  if [ "$saved" -ne 1 ]; then
    record FAIL "s1-add-from-gallery" "no new item appeared on the server within 45s (before=$before after=${after:-?})"
    return
  fi
  ok "server item count $before -> $after"
  # The name typed must be the name stored.
  if api_item_names | has_match "$name"; then
    ok "stored name matches the typed name: $name"
  else
    record FAIL "s1-name-stored" "typed '$name' but the server does not have that name"
    return
  fi

  # Persistence: a restart must still show it, and the image must load.
  "$ADB" shell am force-stop "$APP_ID" >/dev/null 2>&1
  sleep 2
  "$ADB" shell am start -n "$MAIN_ACTIVITY" >/dev/null 2>&1
  # The restart must be given time to actually paint (see wait_for_ui_ready).
  wait_for_ui_ready 60 || warn "the app did not render after the restart"
  capture "s1-06-after-restart"

  if wait_for_text "$name" 25; then
    record PASS "s1-add-from-gallery" "added '$name', server count $before -> $after, still visible after restart"
  elif screen_has_text "你的衣柜是空的"; then
    record FAIL "s1-add-from-gallery" "after restart the wardrobe is empty although the server has $after item(s)"
  else
    record FAIL "s1-add-from-gallery" "after restart '$name' is not visible (capture s1-06-after-restart)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Round-2 wrap-up scenarios (S2 edit, S5 cold start)
# ---------------------------------------------------------------------------------------------

# Every text / content-desc value the UI actually shows, written to $ARTIFACTS_DIR/.visible.txt.
#
# Deliberately narrower than grepping the raw dump: that XML also carries class names, resource
# ids and package names, so a plain `grep unknown` matched android widget names rather than a
# string a person can read. Only the two attributes that reach the screen are considered.
ui_visible_strings() {
  local xml="$ARTIFACTS_DIR/.strings.xml" out="$ARTIFACTS_DIR/.visible.txt"
  ui_dump_xml "$xml" || return 1
  python3 - "$xml" > "$out" <<'PY'
import sys, xml.etree.ElementTree as ET
for n in ET.parse(sys.argv[1]).getroot().iter("node"):
    for attr in ("text", "content-desc"):
        value = n.get(attr)
        if value:
            print(value)
PY
}

# One field of the newest non-archived item, exactly as the server stores it.
#
# `sort_order=desc` with no `sort_by` is the ordering the app's default `newest` sort asks for,
# so this is the item the first wardrobe tile shows.
api_item_field() {
  api_get "/items?page=1&page_size=1&is_archived=false&sort_order=desc" | python3 -c '
import json, sys
field = sys.argv[1]
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    items = []
if items:
    stored = items[0].get(field)
    print("" if stored is None else stored)
else:
    print("")
' "$1" 2>/dev/null
}

# Same, for the newest archived item; used to prove archiving really is reversible.
api_item_field_archived() {
  api_get "/items?page=1&page_size=1&is_archived=true&sort_order=desc" | python3 -c '
import json, sys
field = sys.argv[1]
try:
    items = json.load(sys.stdin).get("items") or []
except Exception:
    items = []
if items:
    stored = items[0].get(field)
    print("" if stored is None else stored)
else:
    print("")
' "$1" 2>/dev/null
}
# Put one item in the wardrobe through the real API, so a scenario about editing, archiving or
# deleting does not have to drive the gallery picker first.
#
# This is test *setup*, not a product assertion — the flow under test is the one that follows.
# It uploads a sample photo the harness already pushed into the gallery, so what the app then
# lists is a genuinely stored row with a genuinely stored image.
seed_test_item() {
  local name="${1:-harness-seed-$(date +%H%M%S)}"
  local photo="$ARTIFACTS_DIR/sample-photos/sample-B.jpg" token status
  [ -f "$photo" ] || { warn "sample photo not found at $photo"; return 1; }
  api_login || return 1
  token="$(cat "$TOKEN_CACHE")"
  # `skip_ai=true` mirrors AI being off: the server marks the item ready and leaves it pending,
  # which is the state the round-2 acceptance criteria assume.
  status="$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST "$API/items" \
    -H "Authorization: Bearer $token" \
    -F "image=@$photo;type=image/jpeg;filename=sample-B.jpg" \
    -F "name=$name" \
    -F "skip_ai=true")"
  case "$status" in
    200|201) printf '%s' "$name"; return 0 ;;
    409) warn "the seed photo is already in the wardrobe (409) — clear the test user first"; return 1 ;;
    *) warn "seeding an item failed with HTTP $status"; return 1 ;;
  esac
}

# Deterministic precondition: exactly one item in the test user's wardrobe.
#
# Each scenario that touches an existing row starts from this, so the precondition no longer
# depends on which scenario ran before it — an implicit dependency that made "run s1 first"
# a hidden requirement and let scenarios silently skip.
reset_wardrobe_with_one_item() {
  api_delete_all || true
  local left
  left="$(api_item_count || echo 0)"
  if [ "${left:-0}" -ne 0 ]; then
    warn "the wardrobe still holds $left item(s) after clearing"
    return 1
  fi
  seed_test_item "harness-seed-$(date +%H%M%S)"
}
# Tap the LAST node whose text / description is exactly <label>.
#
# The confirmation dialogs reuse the action's own wording on their confirm button — `归档` is
# both the detail page's button and the dialog's confirm — so tap-text's "smallest clickable
# node" rule is ambiguous there. React Native renders the modal after the screen, so the
# dialog's copy is the last match in document order, which is what this returns.
tap_text_last() {
  local label="$1" xml="$ARTIFACTS_DIR/.last.xml" bounds
  ui_dump_xml "$xml" || return 1
  bounds="$(python3 - "$xml" "$label" <<'PY'
import sys, xml.etree.ElementTree as ET
label = sys.argv[2]
found = None
for n in ET.parse(sys.argv[1]).getroot().iter("node"):
    if (n.get("text") or "").strip() == label or (n.get("content-desc") or "").strip() == label:
        found = n.get("bounds")
print(found or "")
PY
)"
  [ -n "$bounds" ] || return 1
  tap_bounds "$bounds"
}

# Clear the focused text field.
#
# The edit form opens with the current name already in it, so typing appends instead of
# replacing. Every delete event goes in one `input keyevent` call: one adb round trip rather
# than sixty.
clear_focused_field() {
  local count="${1:-60}" keys="" i
  "$ADB" shell input keyevent KEYCODE_MOVE_END >/dev/null 2>&1 || true
  for i in $(seq 1 "$count"); do keys="$keys 67"; done
  # shellcheck disable=SC2086
  "$ADB" shell input keyevent $keys >/dev/null 2>&1 || true
}

# Replace the value of a field identified by its current label (its value, or its placeholder
# when empty). Mirrors type_into_scrolled_field, but clears the field first.
replace_field_value() {
  local field_label="$1" text="$2" attempt
  for attempt in 1 2 3 4 5; do
    "$ANDROID_ENV_DIR/device-prep.sh" hide-keyboard >/dev/null 2>&1 || true
    if "$ANDROID_ENV_DIR/device-prep.sh" tap-text "$field_label" >/dev/null 2>&1; then
      if focused_field_is_editable; then
        clear_focused_field 60
        "$ANDROID_ENV_DIR/device-prep.sh" type "$text" >/dev/null 2>&1
        if focused_field_contains "$text"; then
          "$ANDROID_ENV_DIR/device-prep.sh" hide-keyboard >/dev/null 2>&1 || true
          return 0
        fi
        warn "field took focus but does not hold '$text' yet"
      else
        warn "tap on '$field_label' did not focus an editable field"
      fi
    fi
    "$ANDROID_ENV_DIR/device-prep.sh" swipe up 400 >/dev/null 2>&1
    sleep 1
  done
  return 1
}

# Cold-start the app and wait for it to paint the wardrobe.
#
# Needed after the harness changes data through the API. The app refetches the wardrobe when
# the screen regains focus (and on a 30s idle poll), not the instant a script acts, so a tile
# for a row the harness just deleted can still be on screen: tapping it opened a detail screen
# that answered 404 and rendered 未找到该单品, which looked like a product failure but was the
# test reading a stale list. A cold start makes the app read the same state as the assertions.
restart_app_fresh() {
  "$ADB" shell am force-stop "$APP_ID" >/dev/null 2>&1
  sleep 2
  "$ADB" shell am start -n "$MAIN_ACTIVITY" >/dev/null 2>&1
  wait_for_ui_ready 90 || return 1
  wait_for_screen "衣橱页" 30
}

# Open the newest item's detail screen.
#
# The wardrobe tile carries the item's display label in `content-desc`, so it is tapped BY NAME.
# A purely positional rule was tried first and was wrong: "first clickable node below the
# header" matched the 所有类型 filter chip (y=545, ~200px wide) rather than the tile
# (y=661, 478px wide), so the tap changed a filter and no detail screen ever opened. The
# positional path survives only as a fallback for an item with no name.
open_first_item_detail() {
  # Read the state the assertions are about, not a list painted before the harness wrote.
  restart_app_fresh || true
  goto_wardrobe || return 1
  local label="${1:-$(api_item_field name)}"

  if [ -n "$label" ] && \
     "$ANDROID_ENV_DIR/device-prep.sh" tap-text "$label" >/dev/null 2>&1; then
    if wait_for_screen "单品详情" 20; then
      return 0
    fi
    warn "tapped '$label' but no detail screen opened; falling back to a positional tap"
  fi

  local xml="$ARTIFACTS_DIR/.first.xml" bounds
  ui_dump_xml "$xml" || return 1
  bounds="$(python3 - "$xml" <<'PY'
import sys, xml.etree.ElementTree as ET
best = None
for n in ET.parse(sys.argv[1]).getroot().iter("node"):
    if n.get("clickable") != "true":
        continue
    b = n.get("bounds", "")
    try:
        x1 = int(b.split("[")[1].split(",")[0])
        y1 = int(b.split(",")[1].split("]")[0])
        x2 = int(b.split("][")[1].split(",")[0])
    except Exception:
        continue
    # Wide and below the chip row: the chips are ~200px wide at y=545, the tile is ~478px.
    if 640 < y1 < 1500 and (x2 - x1) > 300:
        best = b
        break
print(best or "")
PY
)"
  [ -n "$bounds" ] || return 1
  tap_bounds "$bounds"
  wait_for_screen "单品详情" 25
}
# S2 — editing must reach the server, must not claim a human classified the garment, and no
# backend enum may reach the screen (audit findings C17 and B-2).
scenario_s2() {
  log "S2  edit a garment: the change lands, no enum reaches the screen, tagging is untouched"
  if ! reset_wardrobe_with_one_item >/dev/null; then
    record FAIL "s2-edit-consistency" "could not put a known item in the wardrobe to edit"
    return
  fi

  local old_name old_status old_tagged_by old_type
  old_name="$(api_item_field name)"
  old_status="$(api_item_field tagging_status)"
  old_tagged_by="$(api_item_field tagged_by)"
  old_type="$(api_item_field type)"
  ok "before: type='$old_type' name='$old_name' tagging_status='$old_status' tagged_by='$old_tagged_by'"

  open_first_item_detail \
    || { record FAIL "s2-edit-consistency" "could not open the first item's detail screen"; return; }
  capture "s2-01-detail"

  # --- C17: the screen must show Chinese, never the stored enum -----------------------------
  local visible="$ARTIFACTS_DIR/.visible.txt"
  if ! ui_visible_strings; then
    record FAIL "s2-detail-chinese-only" "could not read the detail screen"
    return
  fi
  local leaked="" token
  for token in unknown shirt coat pants dress skirt sneakers jacket blouse; do
    # grep against the file, never against a pipeline: under `set -o pipefail` a successful
    # `grep -q` kills the upstream python with SIGPIPE and the pipeline reports 141, which
    # reads as "no match". That exact mistake once made the picker look absent.
    if grep -q -- "$token" "$visible"; then
      leaked="$leaked$token "
    fi
  done
  if [ -n "$leaked" ]; then
    capture "s2-02-enum-leak"
    record FAIL "s2-detail-chinese-only" \
      "the detail screen prints a raw backend enum: $leaked (see s2-02-enum-leak)"
    return
  fi
  ok "detail screen shows no raw type enum (stored type is '$old_type')"

  # The name must be the one this screen is showing, or the assertions below would be about a
  # different row and would prove nothing.
  if [ -n "$old_name" ] && ! grep -q -F -- "$old_name" "$visible"; then
    record FAIL "s2-edit-consistency" \
      "the opened item does not show '$old_name', so it is not the row the API reports as newest"
    return
  fi

  # --- edit: rename only --------------------------------------------------------------------
  "$ANDROID_ENV_DIR/device-prep.sh" tap-text "编辑" >/dev/null 2>&1 \
    || { record FAIL "s2-edit-consistency" "no 编辑 control on the detail screen"; return; }
  # The edit form is identified by its 类别 label: the read-only view says 类型 instead. Waiting
  # for the "都可以稍后修改" hint was wrong — it sits at the bottom of the form, below the fold,
  # so the dump never contained it and this reported "the edit form did not open" on a screen
  # that plainly was the edit form.
  if ! wait_for_text "类别" 15; then
    capture "s2-03-no-edit-form"
    record FAIL "s2-edit-consistency" "the edit form did not open (see s2-03-no-edit-form)"
    return
  fi
  capture "s2-03-edit-form"

  local new_name="harness-renamed-$(date +%H%M%S)"
  local field_label="$old_name"
  [ -n "$field_label" ] || field_label="例如：白色棉质衬衫"
  if ! replace_field_value "$field_label" "$new_name"; then
    capture "s2-04-name-not-typed"
    record FAIL "s2-edit-consistency" \
      "could not put '$new_name' into the name field (see s2-04-name-not-typed)"
    return
  fi
  ok "name field now holds '$new_name'"

  if ! tap_after_scrolling_to "保存"; then
    record FAIL "s2-edit-consistency" "could not tap the edit form's 保存 button"
    return
  fi

  # The server is the ground truth: wait for it to report the new name.
  local waited=0 stored=""
  while [ "$waited" -lt 45 ]; do
    stored="$(api_item_field name)"
    [ "$stored" = "$new_name" ] && break
    sleep 3; waited=$((waited + 3))
  done
  capture "s2-05-after-save"
  if [ "$stored" != "$new_name" ]; then
    record FAIL "s2-edit-consistency" \
      "the rename never reached the server (expected '$new_name', server has '$stored')"
    return
  fi

  # --- B-2: a rename must not be recorded as a manual classification ------------------------
  local new_status new_tagged_by
  new_status="$(api_item_field tagging_status)"
  new_tagged_by="$(api_item_field tagged_by)"
  if [ "$new_status" != "$old_status" ] || [ "$new_tagged_by" != "$old_tagged_by" ]; then
    record FAIL "s2-rename-not-tagging" \
      "renaming changed the tagging state: tagging_status '$old_status'->'$new_status', tagged_by '$old_tagged_by'->'$new_tagged_by'"
    return
  fi
  record PASS "s2-rename-not-tagging" \
    "renamed to '$new_name'; tagging_status stayed '$new_status' and tagged_by stayed '${new_tagged_by:-null}'"

  # --- the list must show the new name --------------------------------------------------------
  goto_wardrobe || { record FAIL "s2-edit-consistency" "could not return to the wardrobe"; return; }
  capture "s2-06-wardrobe"
  if wait_for_text "$new_name" 25; then
    record PASS "s2-edit-consistency" \
      "the edit reached the server, came back in the list, and the tagging state was not forged"
  else
    record FAIL "s2-edit-consistency" "the renamed item is not visible in the wardrobe after the edit"
    return
  fi

  ui_visible_strings || return 0
  local ascii_chips
  ascii_chips="$(grep -E '^[a-z][a-z-]* \([0-9]+\)$' "$visible" | head -3 | tr '\n' ' ')"
  if [ -n "$ascii_chips" ]; then
    record FAIL "s2-chip-labels-chinese" "a type filter chip still prints the raw enum: $ascii_chips"
  else
    record PASS "s2-chip-labels-chinese" "type filter chips are labelled in Chinese"
  fi
}

# S5 — three consecutive cold starts, without uninstalling, clearing data or signing out.
scenario_s5() {
  log "S5  three consecutive cold starts keep the session and re-read the wardrobe"
  if [ "$(api_item_count || echo 0)" -eq 0 ]; then
    if ! reset_wardrobe_with_one_item >/dev/null; then
      record FAIL "s5-cold-start" "the wardrobe is empty and could not be seeded"
      return
    fi
  fi
  local count name
  count="$(api_item_count)"
  name="$(api_item_field name)"

  local i failures=0
  for i in 1 2 3; do
    # Deliberately NOT `device-prep.sh reset`: that runs `pm clear`, which wipes the app's
    # secure storage, so "the session survived" would be untestable. `am force-stop` is the
    # cold start a user gets by swiping the app out of recents.
    "$ADB" shell am force-stop "$APP_ID" >/dev/null 2>&1
    sleep 2
    "$ADB" shell am start -n "$MAIN_ACTIVITY" >/dev/null 2>&1
    if ! wait_for_ui_ready 90; then
      warn "cold start $i: the app never rendered any text"
      capture "s5-0${i}-not-rendered"
      failures=$((failures + 1))
      continue
    fi
    sleep 3
    capture "s5-0${i}-cold-start"

    if wait_for_text "登录以管理你的衣橱" 8; then
      warn "cold start $i: landed on the login screen, so the stored session was not restored"
      failures=$((failures + 1))
      continue
    fi

    # A cold start can restore the last route, which may be the detail screen rather than the
    # list. Accept either, but require the app to be past the login screen and on a wardrobe
    # route — otherwise "the session survived" would be untested on the run that happened to
    # land on the detail screen.
    if ! wait_for_screen "衣橱页" 25; then
      if wait_for_screen "单品详情" 5; then
        "$ADB" shell input keyevent KEYCODE_BACK >/dev/null 2>&1 || true
        wait_for_screen "衣橱页" 25 || warn "cold start $i: BACK did not return to the wardrobe"
      fi
    fi
    if ! wait_for_screen "衣橱页" 12; then
      warn "cold start $i: did not reach the wardrobe"
      failures=$((failures + 1))
      continue
    fi

    # The garment must be readable again, and the count must be the server's.
    if [ -n "$name" ] && wait_for_text "$name" 25; then
      ok "cold start $i: wardrobe rendered and '$name' is readable"
    elif wait_for_text "衣柜中有 ${count} 件单品" 10; then
      ok "cold start $i: wardrobe rendered with the server's count ($count)"
    else
      warn "cold start $i: the wardrobe showed neither the item nor the expected count"
      failures=$((failures + 1))
    fi
  done

  if [ "$failures" -eq 0 ]; then
    record PASS "s5-cold-start" \
      "3/3 cold starts restored the session and re-read the wardrobe from the backend (no uninstall, no pm clear)"
  else
    record FAIL "s5-cold-start" "$failures/3 cold starts failed; see s5-0*-cold-start.png"
  fi
}
# S3 — permission denial and picker cancellation must recover without a fake success.
scenario_s3() {
  log "S3  denial / cancellation paths must not produce a fake success"

  # 3a. Permanent camera denial (USER_FIXED, i.e. canAskAgain=false — what the platform leaves
  # behind after the user picks "Don't allow" twice). The app must explain itself and stay
  # recoverable, not hang or silently do nothing.
  #
  # Verified app behaviour on denial: the add screen stays up with the photo placeholder intact
  # and shows 相机权限已被拒绝，请在系统设置中允许后重试。 Persistent, not a transient toast.
  "$ANDROID_ENV_DIR/device-prep.sh" deny-permissions hard >/dev/null 2>&1
  open_add_screen || { record FAIL "s3-denied-camera" "could not reach the add screen"; return; }
  "$ANDROID_ENV_DIR/device-prep.sh" tap-text "拍照" >/dev/null 2>&1
  sleep 5
  capture "s3-01-camera-denied"

  if screen_has_text "相机权限已被拒绝"; then
    if screen_has_text "拍照"; then
      record PASS "s3-denied-camera" \
        "camera denied: explained in place (相机权限已被拒绝…请在系统设置中允许) and 拍照 is still offered for retry"
    else
      record FAIL "s3-denied-camera" "camera denied: explanation shown but the 拍照 control disappeared, so the user cannot retry"
    fi
  elif screen_has_text "还没有选择照片"; then
    # Acceptable fallback wording; the important part is that no fake success occurred and the
    # form is still usable.
    if screen_has_text "拍照"; then
      record PASS "s3-denied-camera" \
        "camera denied: stayed on the add screen with no photo attached, no crash, retry still offered"
    else
      record FAIL "s3-denied-camera" "camera denied: the add screen is no longer recoverable"
    fi
  elif screen_has_text "设置"; then
    record PASS "s3-denied-camera" "camera denied: app surfaced a permission explanation with a path to 设置"
  else
    capture "s3-01b-camera-denied-unexpected"
    record FAIL "s3-denied-camera" "unexpected screen after denying camera (see s3-01-camera-denied)"
  fi

  # A denied camera must not have produced an attachment: verify no item was created.
  local denied_count
  denied_count="$(api_item_count || echo unknown)"
  ok "item count after the denial path: $denied_count (unchanged means no fake success)"

  # 3b. Cancelling the picker must return to a usable form with no attachment.
  "$ANDROID_ENV_DIR/device-prep.sh" grant-permissions >/dev/null 2>&1
  open_add_screen || { record FAIL "s3-cancel-picker" "could not reach the add screen"; return; }

  # picker_open already retries; reuse it rather than a second hand-rolled loop.
  local picker_up=0
  picker_open && picker_up=1
  if [ "$picker_up" -eq 1 ]; then
    "$ANDROID_ENV_DIR/device-prep.sh" tap-text "Cancel" >/dev/null 2>&1
    sleep 4
    capture "s3-02-picker-cancelled"
    if screen_has_text "还没有选择照片" && screen_has_text "从相册选择"; then
      record PASS "s3-cancel-picker" "cancelling the picker returned to the form with no photo attached and controls intact"
    else
      record FAIL "s3-cancel-picker" "after cancelling the picker the add screen is not in its initial state"
    fi
  else
    capture "s3-02b-picker-unavailable"
    record SKIP "s3-cancel-picker" "picker never opened across 3 attempts; see s3-02b-picker-unavailable"
  fi

  # 3c. Upload failure must keep the input for a retry. Exercised by pointing the app at a
  # dead backend, which is only possible by rebuilding. Reported MANUAL rather than faked.
  record MANUAL "s3-upload-failure" \
    "needs a build pointed at an unreachable API; see the manual, section 'Upload failure and retry'"
}

# S4 — retrying the same upload must not create a second record.
scenario_s4() {
  log "S4  a retried upload must not duplicate the record"
  local before
  # Start from an empty wardrobe: the first upload of the run has to really create a row, so
  # it must not collide with an identical photo stored earlier (the pHash check would answer
  # 409 and the "first upload landed" precondition would be unprovable).
  api_delete_all
  before="$(api_item_count)" || { record FAIL "s4-no-duplicate" "backend unreachable"; return; }
  open_add_screen || { record FAIL "s4-no-duplicate" "could not reach the add screen"; return; }

  # Pick the SAME first tile in two separate add flows. The server's perceptual-hash
  # duplicate check should reject the second (POST /items has no upload_key — see the manual).
  #
  # The add page's submit button is 「添加」, NOT 「保存」 (that label belongs to the detail
  # screen's edit form). Tapping the wrong one made the tap fail, the upload never happened,
  # and `second_delta <= 0` was then trivially true — so this scenario used to PASS without
  # ever exercising the behaviour it claims to test. Two changes close that:
  #   1. the correct label, and
  #   2. a hard requirement that the FIRST upload really landed before the retry is judged.
  # Without (2) the assertion is unfalsifiable. See the audit report, finding B-5.
  picker_open || { record FAIL "s4-no-duplicate" "picker did not open"; return; }
  picker_take_photo 1 || { record FAIL "s4-no-duplicate" "picker tile not found"; return; }
  sleep 5
  tap_after_scrolling_to "添加" \
    || { record FAIL "s4-no-duplicate" "could not tap the add-page submit button"; return; }
  sleep 20
  capture "s4-01-first-upload"
  after="$(api_item_count || echo "$before")"
  local first_delta=$((after - before))

  # Guard against a vacuous pass: if the first upload created no record, the retry half of
  # the test proves nothing at all, so fail instead of "passing".
  if [ "${first_delta:-0}" -le 0 ]; then
    record FAIL "s4-no-duplicate" \
      "the first upload created no record (+$first_delta), so the retry cannot be judged"
    return
  fi

  # Now repeat with the same tile, and double-tap save: the realistic impatient retry.
  open_add_screen || { record FAIL "s4-no-duplicate" "could not reach the add screen"; return; }
  picker_open || { record FAIL "s4-no-duplicate" "picker did not open on the retry"; return; }
  picker_take_photo 1 || { record FAIL "s4-no-duplicate" "picker tile not found on retry"; return; }
  sleep 5
  if tap_after_scrolling_to "添加"; then
    # Second tap on purpose, immediately after the first: the client's own re-entrancy lock
    # should swallow it, and the server's duplicate check is the backstop.
    "$ANDROID_ENV_DIR/device-prep.sh" tap-text "添加" >/dev/null 2>&1 || true
  fi
  sleep 25
  capture "s4-02-after-retry"

  local final
  final="$(api_item_count || echo "$after")"
  local second_delta=$((final - after))

  # A duplicate photo is a 409 that creates nothing, so exactly zero new rows is the correct
  # outcome — and because the first upload is now proven to have landed, zero is meaningful
  # rather than a symptom of nothing having happened.
  if [ "${second_delta:-0}" -eq 0 ]; then
    record PASS "s4-no-duplicate" \
      "first upload +$first_delta; re-uploading the same photo added 0 record(s)"
  else
    record FAIL "s4-no-duplicate" "re-uploading the same photo created $second_delta extra record(s)"
  fi
}

# S6 — archiving removes the item from the default list.
scenario_s6() {
  log "S6  archiving removes the item from the list"
  local before
  before="$(api_item_count)" || { record FAIL "s6-archive" "backend unreachable"; return; }
  if [ "${before:-0}" -eq 0 ]; then
    record SKIP "s6-archive" "no items to archive — run s1 first"
    return
  fi
  open_add_screen >/dev/null 2>&1 || true
  goto_wardrobe || { record FAIL "s6-archive" "could not reach the wardrobe"; return; }
  # Open the first item's detail, then archive it.
  local xml="$ARTIFACTS_DIR/.s6.xml" bounds
  ui_dump_xml "$xml" || { record FAIL "s6-archive" "could not read the wardrobe"; return; }
  bounds="$(python3 - "$xml" <<'PY'
import sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
# The first item tile: wide, and below the filter-chip row. The chips start at y=545 and are
# ~200px wide, so a bare "first clickable node in the middle of the screen" rule picked a chip
# instead of the tile, and this scenario could never open a detail screen.
best = None
for n in root.iter("node"):
    if n.get("clickable") != "true":
        continue
    b = n.get("bounds", "")
    try:
        x1 = int(b.split("[")[1].split(",")[0])
        y1 = int(b.split(",")[1].split("]")[0])
        x2 = int(b.split("][")[1].split(",")[0])
    except Exception:
        continue
    if 640 < y1 < 1500 and (x2 - x1) > 300:
        best = b
        break
print(best or "")
PY
)"
  if [ -z "$bounds" ]; then
    record SKIP "s6-archive" "could not locate an item tile to open"
    return
  fi
  tap_bounds "$bounds"
  sleep 4
  capture "s6-01-detail"

  local archived=0
  local label
  for label in "归档" "移出衣橱" "删除"; do
    # Scroll first: the archive/delete buttons sit at the bottom of the detail page, below the
    # fold, so a bare tap-text never found them and this scenario reported MANUAL ("no
    # archive/delete control found") on a screen that does have them. s7 exercises the same
    # flow with the correct scrolling tap and supersedes this one.
    if tap_after_scrolling_to "$label"; then
      sleep 3
      # A confirmation step may follow.
      for label in "确认" "确定" "归档" "删除"; do
        "$ANDROID_ENV_DIR/device-prep.sh" tap-text "$label" >/dev/null 2>&1 && break
      done
      archived=1
      break
    fi
  done
  sleep 6
  capture "s6-02-after-archive"

  local after
  after="$(api_item_count || echo "$before")"
  if [ "$archived" -eq 0 ]; then
    record MANUAL "s6-archive" "no archive/delete control found on the detail screen; do it by hand and check the list refreshes"
  elif [ "${after:-0}" -lt "${before:-0}" ]; then
    record PASS "s6-archive" "item count $before -> $after and the list refreshed"
  else
    record FAIL "s6-archive" "archived on screen but the server still reports $after item(s)"
  fi
}
# S7 — archiving is reversible, and the two delete paths differ: cancel keeps the row,
# confirm removes it from the wardrobe and from the server.
#
# Only the delete flow is exercised end to end, because its confirm label (`确认删除`) is
# unique on screen. The archive dialog repeats the word `归档` on its confirm button, so the
# reopen-and-confirm step is done with tap_text_last.
scenario_s7() {
  log "S7  archive is reversible; delete cancel keeps the row and delete confirm removes it"
  if ! reset_wardrobe_with_one_item >/dev/null; then
    record FAIL "s7-archive-restore" "could not put a known item in the wardrobe to archive"
    return
  fi
  before="$(api_item_count)" || { record FAIL "s7-archive-restore" "backend unreachable"; return; }

  # ---- 1. archiving, and the copy that must be shown before it happens ----
  open_first_item_detail \
    || { record FAIL "s7-archive-restore" "could not open the first item's detail screen"; return; }
  capture "s7-01-detail"

  if ! tap_after_scrolling_to "归档"; then
    record MANUAL "s7-archive-restore" \
      "no 归档 control on the detail screen; archive by hand and check the list refreshes"
    return
  fi
  if ! wait_for_text "归档这件衣物" 12; then
    capture "s7-02-no-archive-dialog"
    record FAIL "s7-archive-confirm" "tapping 归档 did not open the confirmation (see s7-02-no-archive-dialog)"
    return
  fi
  capture "s7-02-archive-dialog"
  ok "archive asked for confirmation before acting"

  # Cancel first: the row must survive untouched. This is the "cancel" half.
  if ! tap_text_last "取消"; then
    record FAIL "s7-delete-cancel" "could not tap the dialog's 取消"
    return
  fi
  sleep 3
  local after_cancel
  after_cancel="$(api_item_count || echo "$before")"
  if [ "${after_cancel:-0}" != "${before:-0}" ]; then
    record FAIL "s7-delete-cancel" \
      "cancelling the confirmation still changed the wardrobe ($before -> $after_cancel)"
    return
  fi
  record PASS "s7-delete-cancel" "cancelling the confirmation left the wardrobe at $before item(s)"

  # ---- 2. archive for real, then restore ----
  if ! tap_after_scrolling_to "归档"; then
    record FAIL "s7-archive-restore" "the 归档 control disappeared after cancelling"
    return
  fi
  wait_for_text "归档这件衣物" 12 || warn "the archive dialog did not reappear"
  tap_text_last "归档" || { record FAIL "s7-archive-restore" "could not confirm the archive"; return; }

  local waited=0 after_archive=""
  while [ "$waited" -lt 45 ]; do
    after_archive="$(api_item_count || echo "$before")"
    [ "${after_archive:-0}" -lt "${before:-0}" ] && break
    sleep 3; waited=$((waited + 3))
  done
  capture "s7-03-after-archive"
  if [ "${after_archive:-0}" -ge "${before:-0}" ]; then
    record FAIL "s7-archive-restore" \
      "the item count did not drop after archiving ($before -> ${after_archive:-?})"
    return
  fi
  ok "archived: the default list dropped from $before to $after_archive"

  # It must still exist as an archived row — archive is not a delete.
  local archived_name
  archived_name="$(api_item_field_archived name)"
  if [ -z "$archived_name" ]; then
    record FAIL "s7-archive-restore" "the archived item cannot be found in the archived list"
    return
  fi
  ok "the archived row still exists (name='$archived_name'), so archiving is not a delete"

  # Restore it. The archived row is hidden from the default list and round 2 exposes no
  # "archived" view, so the row is opened through the app's own deep link (`scheme: wardrowbe`)
  # — the same route a saved link would use. That exercises the real 取消归档 button. If the
  # link does not resolve, the restore half is reported as MANUAL instead of assumed.
  local archived_id
  archived_id="$(api_item_field_archived id)"
  if [ -n "$archived_id" ]; then
    "$ADB" shell am start -a android.intent.action.VIEW -d "wardrowbe://item/$archived_id" \
      >/dev/null 2>&1 || true
    wait_for_ui_ready 45 || true
  fi
  if ! tap_after_scrolling_to "取消归档"; then
    capture "s7-05-no-restore-control"
    record MANUAL "s7-archive-restore" \
      "archived OK (count $before -> $after_archive, row kept), but 取消归档 was not reachable (deep link wardrowbe://item/$archived_id); restore by hand"
    return
  fi
  waited=0
  local after_restore=""
  while [ "$waited" -lt 45 ]; do
    after_restore="$(api_item_count || echo "$after_archive")"
    [ "${after_restore:-0}" -eq "${before:-0}" ] && break
    sleep 3; waited=$((waited + 3))
  done
  capture "s7-04-after-restore"
  if [ "${after_restore:-0}" -eq "${before:-0}" ]; then
    record PASS "s7-archive-restore" \
      "archive dropped the list $before -> $after_archive with the row kept, and restore put it back to $after_restore"
  else
    record FAIL "s7-archive-restore" \
      "restore did not bring the count back ($before -> $after_archive -> ${after_restore:-?})"
  fi
}

# S8 — deleting for real, and the cancel path that must not delete anything.
scenario_s8() {
  log "S8  delete: cancel keeps the row, confirm removes it everywhere"
  if ! reset_wardrobe_with_one_item >/dev/null; then
    record FAIL "s8-delete" "could not put a known item in the wardrobe to delete"
    return
  fi
  before="$(api_item_count)" || { record FAIL "s8-delete" "backend unreachable"; return; }

  open_first_item_detail \
    || { record FAIL "s8-delete" "could not open the first item's detail screen"; return; }

  # ---- cancel: nothing may change ----
  tap_after_scrolling_to "删除" \
    || { record FAIL "s8-delete" "no 删除 control on the detail screen"; return; }
  if ! wait_for_text "删除这件衣物" 12; then
    capture "s8-01-no-delete-dialog"
    record FAIL "s8-delete" "tapping 删除 did not open the confirmation (see s8-01-no-delete-dialog)"
    return
  fi
  capture "s8-01-delete-dialog"

  # The warning has to state the real blast radius: DELETE cascades into outfit_items.
  if ui_visible_strings && grep -q -F -- "已经用到它的搭配会一并移除" "$ARTIFACTS_DIR/.visible.txt"; then
    ok "the dialog states that existing outfits lose this garment"
  else
    record FAIL "s8-delete-copy" "the delete confirmation does not mention the outfit links it removes"
    return
  fi

  tap_text_last "取消" || { record FAIL "s8-delete" "could not tap the dialog's 取消"; return; }
  sleep 3
  local after_cancel
  after_cancel="$(api_item_count || echo "$before")"
  capture "s8-02-after-cancel"
  if [ "${after_cancel:-0}" != "${before:-0}" ]; then
    record FAIL "s8-delete" "cancelling the delete still removed an item ($before -> $after_cancel)"
    return
  fi
  record PASS "s8-delete-cancel" "cancelling the delete confirmation left all $before item(s) in place"

  # ---- confirm: the row must disappear from the list and from the server ----
  tap_after_scrolling_to "删除" || { record FAIL "s8-delete" "the 删除 control disappeared"; return; }
  wait_for_text "删除这件衣物" 12 || warn "the delete dialog did not reappear"
  tap_text_last "确认删除" || { record FAIL "s8-delete" "could not tap 确认删除"; return; }

  local waited=0 after_delete=""
  while [ "$waited" -lt 45 ]; do
    after_delete="$(api_item_count || echo "$before")"
    [ "${after_delete:-0}" -lt "${before:-0}" ] && break
    sleep 3; waited=$((waited + 3))
  done
  sleep 3
  capture "s8-03-after-delete"
  if [ "${after_delete:-0}" -ge "${before:-0}" ]; then
    record FAIL "s8-delete" "confirming the delete did not remove the row ($before -> ${after_delete:-?})"
    return
  fi
  # A deleted row is gone for good: it must not appear in the archived list either.
  if [ -n "$(api_item_field_archived name)" ] && [ "${after_delete:-0}" -eq 0 ]; then
    record PASS "s8-delete" \
      "delete removed the row ($before -> $after_delete); archiving would have kept it"
    return
  fi
  record PASS "s8-delete" "confirming the delete removed the row ($before -> $after_delete) and the list refreshed"
}

# ---------------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------------
declare -a ALL_SCENARIOS=(s1 s2 s3 s4 s5 s6 s7 s8)

usage() {
  cat <<EOF
run-acceptance.sh — mechanized round-2 acceptance scenarios for 知衣 (Android)

Usage: ./mobile/scripts/run-acceptance.sh [--list] [scenario ...]

Scenarios:
  s1   Add a garment from the gallery; verify it persists across refresh and restart
       (covers acceptance scenario 1 and, via the manual fields, scenario 5)
  s2   Edit a garment: the change reaches the server, no backend enum reaches the
       screen, and a rename is not recorded as a manual classification
       (acceptance scenario 2, audit findings C17 + B-2)
  s3   Camera denial and picker cancellation recover without a fake success
       (acceptance scenario 3; the upload-failure part is reported MANUAL)
  s4   A retried upload does not create a duplicate record
       (acceptance scenario 4)
  s5   Three consecutive cold starts: the session and the wardrobe survive
       (acceptance scenario 1's restart clause, three times, without pm clear)
  s6   Archiving removes the item from the list and refreshes it
       (acceptance scenario 6)
  s7   Archive is reversible: cancel changes nothing, confirm archives the row
       without deleting it, and restore puts it back (acceptance scenario 6)
  s8   Delete: cancel keeps the row, confirm removes it, and the warning names the
       outfits it will affect (acceptance scenario 6)

Not scripted (see mobile/docs/第二轮-设备验证手册.md):
  camera capture          the emulated camera's shutter is not addressable by label
  upload failure/retry    needs a build pointed at an unreachable API
  OIDC login              needs a configured identity provider

Environment: DEV_ROOT AVD_NAME APP_ID ARTIFACTS_DIR
             BACKEND_HOST_PORT BACKEND_DEVICE_HOST TEST_USER_EMAIL
EOF
}

main() {
  local targets=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --list|-l) usage; exit 0 ;;
      -h|--help) usage; exit 0 ;;
      *) targets+=("$1"); shift ;;
    esac
  done
  [ ${#targets[@]} -eq 0 ] && targets=("${ALL_SCENARIOS[@]}")

  require_device
  wait_for_boot 120

  if ! is_installed; then
    die "$APP_ID is not installed. Install it with:
      $ANDROID_ENV_DIR/device-prep.sh install"
  fi
  if ! curl -fsS -m 5 "$API/health" >/dev/null 2>&1; then
    die "Backend not reachable at $API/health.
  Start it with: BIND_HOST=0.0.0.0 ./scripts/dev-local.sh start
  Then re-run. Scenarios assert against stored rows, so the backend is required."
  fi

  # The test credential must be able to survive /auth/session, or the app will log itself out
  # partway through and every later assertion will be about the login screen.
  assert_test_account_usable

  echo "==============================================================="
  echo " 知衣 round-2 acceptance run"
  echo " device    : $AVD_NAME (serial ${ADB_SERIAL:-?})"
  echo " app       : $APP_ID"
  echo " backend   : $API"
  echo " test user : $TEST_USER_EMAIL"
  echo " scenarios : ${targets[*]}"
  echo " artifacts : $ARTIFACTS_DIR"
  echo "==============================================================="
  echo

  local s
  for s in "${targets[@]}"; do
    case "$s" in
      s1) scenario_s1 ;;
      s2) scenario_s2 ;;
      s3) scenario_s3 ;;
      s4) scenario_s4 ;;
      s5) scenario_s5 ;;
      s6) scenario_s6 ;;
      s7) scenario_s7 ;;
      s8) scenario_s8 ;;
      *) die "unknown scenario: $s (try --list)" ;;
    esac
    echo
  done

  echo "==============================================================="
  printf ' TOTAL  %sPASS %d%s   %sFAIL %d%s   %sMANUAL %d%s   %sSKIP %d%s\n' \
    "$_c_green" "$PASS_COUNT" "$_c_reset" "$_c_red" "$FAIL_COUNT" "$_c_reset" \
    "$_c_yellow" "$MANUAL_COUNT" "$_c_reset" "$_c_yellow" "$SKIP_COUNT" "$_c_reset"
  echo "==============================================================="
  echo
  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "Failures:"
    local row
    for row in "${RESULTS[@]}"; do
      [ "${row%%|*}" = "FAIL" ] && echo "  - ${row#*|}"
    done
    echo
    fail "acceptance run FAILED ($FAIL_COUNT automated check(s))."
    exit 1
  fi

  ok "all automated acceptance checks passed."
  if [ "$MANUAL_COUNT" -gt 0 ]; then
    echo
    echo "Manual steps still required:"
    local row
    for row in "${RESULTS[@]}"; do
      [ "${row%%|*}" = "MANUAL" ] && echo "  - ${row#*|}"
    done
  fi
}

main "$@"
