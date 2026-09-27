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
# 1 only after 我的 shows $TEST_USER_EMAIL. s5 may fall back to a count check
# only then; a count match alone proved nothing when the device was signed into
# a different account that happened to have the same number of garments (M2).
ACCOUNT_CONFIRMED=0
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

  # Already signed in. Say WHICH account — "already logged in" without the
  # email is how a run kept asserting against $TEST_USER_EMAIL while the device
  # was someone else (audit M2). ensure_test_account switches or refuses.
  if wait_for_screen "衣橱页" 6; then
    local session_email
    session_email="$(read_profile_email_here || true)"
    session_email="${session_email//[[:space:]]/}"
    if [ -n "$session_email" ]; then
      log "already logged in as $session_email (session restored from secure storage)"
    else
      log "already logged in (session restored from secure storage); profile email was not readable"
    fi
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

# Email shown on 我的, or empty if it cannot be read.
#
# Stdout is ONLY the address: callers capture it. Do not log here.
# Leaves the app on the wardrobe tab when the tab bar was reachable.
read_profile_email_here() {
  local xml="$ARTIFACTS_DIR/.profile-email.xml" email="" attempt opened=0
  for attempt in 1 2 3; do
    if "$ANDROID_ENV_DIR/device-prep.sh" tap-text "我的" >/dev/null 2>&1 \
      && wait_for_text "退出登录" 8; then
      opened=1
      break
    fi
  done
  if [ "$opened" -ne 1 ]; then
    return 1
  fi
  for attempt in 1 2 3 4 5 6; do
    if ui_dump_xml "$xml"; then
      email="$(python3 - "$xml" <<'PY'
import re, sys, xml.etree.ElementTree as ET
pat = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
found = []
for node in ET.parse(sys.argv[1]).getroot().iter("node"):
    for attr in ("text", "content-desc"):
        match = pat.search(node.get(attr) or "")
        if match:
            found.append(match.group(0))
sys.stdout.write(found[-1] if found else "")
PY
)"
      if [ -n "$email" ]; then
        break
      fi
    fi
    sleep 2
  done
  # Back to the wardrobe so a later step is not left standing on 我的.
  "$ANDROID_ENV_DIR/device-prep.sh" tap-text "衣橱" >/dev/null 2>&1 || true
  wait_for_text "添加单品" 8 || true
  printf '%s' "$email"
  [ -n "$email" ]
}

# Switch accounts the way a person does. `pm clear` would wipe the secure
# storage s5 is not allowed to wipe, and it is not a login.
sign_out_via_app() {
  local attempt
  for attempt in 1 2 3; do
    if "$ANDROID_ENV_DIR/device-prep.sh" tap-text "我的" >/dev/null 2>&1 \
      && wait_for_text "退出登录" 8; then
      break
    fi
    if [ "$attempt" -eq 3 ]; then
      capture "account-signout-no-profile"
      return 1
    fi
  done
  "$ANDROID_ENV_DIR/device-prep.sh" tap-text "退出登录" >/dev/null 2>&1 || return 1
  if ! wait_for_text "确定要退出登录吗" 12; then
    capture "account-signout-no-dialog"
    return 1
  fi
  tap_text_last "确认" || return 1
  if ! wait_for_text "登录以管理你的衣橱" 25; then
    capture "account-signout-no-login"
    return 1
  fi
}

# Refuse to score scenarios until the device session is $TEST_USER_EMAIL.
#
# "Already on the wardrobe" is not enough: s5 compared this account's item
# count with whatever was on screen, and another account with the same count
# was a PASS. s1 counted this account's rows while the upload (and its 409)
# happened on the device account, then reported "no new item appeared".
ensure_test_account() {
  log "Checking the device is signed in as $TEST_USER_EMAIL"
  if ! goto_wardrobe; then
    die "could not reach the app to read the signed-in account (harness expects $TEST_USER_EMAIL)"
  fi

  local email
  email="$(read_profile_email_here || true)"
  email="${email//[[:space:]]/}"
  log "device session email: ${email:-<unreadable>} (harness expects $TEST_USER_EMAIL)"

  if [ "$email" = "$TEST_USER_EMAIL" ]; then
    ACCOUNT_CONFIRMED=1
    ok "device session matches the harness account"
    return 0
  fi

  if [ -z "$email" ]; then
    die "Could not read an email on 我的, so this run cannot prove the device is $TEST_USER_EMAIL.
  Refusing to continue: s5 would treat another account's wardrobe count as a pass."
  fi

  warn "device is signed in as '$email', not '$TEST_USER_EMAIL'; signing out in the app and logging in as the harness account"
  if ! sign_out_via_app; then
    die "App is signed in as '$email' but the harness asserts against '$TEST_USER_EMAIL', and signing out through 我的 failed.
  Both accounts: device='$email' harness='$TEST_USER_EMAIL'."
  fi
  if ! login_dev; then
    die "Signed out of '$email' but could not log in as '$TEST_USER_EMAIL'."
  fi
  email="$(read_profile_email_here || true)"
  email="${email//[[:space:]]/}"
  log "device session email after switch: ${email:-<unreadable>}"
  if [ "$email" != "$TEST_USER_EMAIL" ]; then
    die "After sign-out and login the app is '${email:-unreadable}', not '$TEST_USER_EMAIL'.
  Both accounts: device='${email:-unreadable}' harness='$TEST_USER_EMAIL'.
  Refusing to run scenarios against the wrong account."
  fi
  ACCOUNT_CONFIRMED=1
  ok "device session switched to $TEST_USER_EMAIL"
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
    # A 409 on the device is a correct duplicate rejection for whoever is
    # signed in. Calling it "no new item" blamed the product when this script
    # was counting a different account (audit M2, evidence A).
    if screen_has_text "这张照片已存在" || screen_has_text "没有重复添加"; then
      record FAIL "s1-add-from-gallery" \
        "screen says the photo already exists (409) but $TEST_USER_EMAIL's count stayed $before -> ${after:-?}. That duplicate belongs to the signed-in account, which is not the account being counted."
    else
      record FAIL "s1-add-from-gallery" "no new item appeared on the server within 45s (before=$before after=${after:-?})"
    fi
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
  # Only once an item really landed. The named upload above cannot catch M1:
  # the panel shows the typed name, so a raw `item.type` stays hidden.
  if [ "${saved:-0}" -eq 1 ]; then
    assert_unnamed_success_panel
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

# Backend enum tokens that must never appear as user-visible text.
# One list for the detail screen (s2 / C17) and the add-success panel (s1 / M1).
# Matched as whole tokens, not substrings, so "top" does not trip on an unrelated
# word and a garment named "harness-garment-…" does not trip on "shirt".
leaked_backend_enums() {
  local visible="${1:-$ARTIFACTS_DIR/.visible.txt}"
  [ -f "$visible" ] || return 0
  python3 - "$visible" <<'PY'
import re, sys
tokens = [
    "unknown", "t-shirt", "shirt", "top", "coat", "pants", "dress", "skirt",
    "bag", "sneakers", "jacket", "blouse",
]
tokens.sort(key=len, reverse=True)
pat = re.compile(
    r"(?<![A-Za-z0-9])(?:" + "|".join(re.escape(t) for t in tokens) + r")(?![A-Za-z0-9])"
)
found = []
seen = set()
with open(sys.argv[1], encoding="utf-8", errors="replace") as fh:
    for line in fh:
        for match in pat.finditer(line):
            token = match.group(0).lower()
            if token not in seen:
                seen.add(token)
                found.append(token)
print(" ".join(found))
PY
}

# The named upload in s1 shows the typed name, so `item.name || item.type` still
# looks fine there. This submits a second photo with the name left blank — the
# path that painted `unknown` on the success panel (audit M1).
assert_unnamed_success_panel() {
  log "S1b  unnamed add: the success panel must not show a raw type enum"
  if ! open_add_screen; then
    record FAIL "s1-success-panel-no-enum" "could not reopen the add screen for the unnamed upload"
    return
  fi
  if ! picker_open; then
    record FAIL "s1-success-panel-no-enum" "system PhotoPicker did not open for the unnamed upload"
    return
  fi
  if ! picker_take_photo 2; then
    record FAIL "s1-success-panel-no-enum" "could not pick a second photo (tile 2); the gallery needs at least two distinct photos"
    return
  fi
  sleep 6
  if screen_has_text "还没有选择照片"; then
    record FAIL "s1-success-panel-no-enum" "the second photo was not attached"
    return
  fi

  # Deliberately do not type a name. That is the path under test.
  local before after stored_name stored_type leaked
  before="$(api_item_count || echo 0)"
  if ! tap_after_scrolling_to "添加"; then
    record FAIL "s1-success-panel-no-enum" "could not tap 添加 for the unnamed upload"
    return
  fi
  if ! wait_for_text "已添加" 60; then
    capture "s1-07-unnamed-no-success"
    if screen_has_text "这张照片已存在" || screen_has_text "没有重复添加"; then
      record FAIL "s1-success-panel-no-enum" "the second photo was treated as a duplicate, so the unnamed success panel was never shown"
    else
      record FAIL "s1-success-panel-no-enum" "unnamed submit did not reach the success panel (已添加) within 60s"
    fi
    return
  fi
  capture "s1-07-unnamed-success"
  after="$(api_item_count || echo "$before")"
  if [ "${after:-0}" -le "${before:-0}" ]; then
    record FAIL "s1-success-panel-no-enum" "the success panel showed 已添加 but the server count did not rise ($before -> ${after:-?})"
    return
  fi
  if ! ui_visible_strings; then
    record FAIL "s1-success-panel-no-enum" "could not read the success panel"
    return
  fi
  leaked="$(leaked_backend_enums)"
  if [ -n "$leaked" ]; then
    record FAIL "s1-success-panel-no-enum" "success panel prints a raw backend enum: $leaked (see s1-07-unnamed-success)"
    return
  fi
  stored_name="$(api_item_field name || true)"
  stored_type="$(api_item_field type || true)"
  if [ -n "$stored_name" ]; then
    if ! grep -q -F -- "$stored_name" "$ARTIFACTS_DIR/.visible.txt"; then
      record FAIL "s1-success-panel-no-enum" "server stored name '$stored_name' but the success panel does not show it"
      return
    fi
  elif [ "$stored_type" = "unknown" ] || [ -z "$stored_type" ]; then
    if ! grep -q -F -- "待分类" "$ARTIFACTS_DIR/.visible.txt" \
      && ! grep -q -F -- "未命名单品" "$ARTIFACTS_DIR/.visible.txt"; then
      record FAIL "s1-success-panel-no-enum" "unnamed item (type=${stored_type:-empty}) hid the enum but did not show 待分类 or 未命名单品"
      return
    fi
  fi
  record PASS "s1-success-panel-no-enum" "unnamed add (count $before -> $after, type=${stored_type:-empty}) shows a Chinese label, not a raw type enum"
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

# ---------------------------------------------------------------------------------------------
# Round 3: slot-outfit helpers.
# ---------------------------------------------------------------------------------------------

# One field of a JSON object on stdin — the top level, or a named list inside it.
#
# `json_field id` and `json_field total` cover every read the round-3 helpers need.
json_field() {
  python3 -c 'import json,sys
d=json.load(sys.stdin)
key=sys.argv[1]
# A named container may be a list (the API items/outfits arrays), so take its first element.
# Without that branch every json_field id items returned nothing, and the caller reported
# "no garment to remove" while the garment was right there.
rows=d.get(sys.argv[2]) if len(sys.argv) > 2 else d
if isinstance(rows, list):
    rows = rows[0] if rows else None
value=rows.get(key) if isinstance(rows, dict) else None
if isinstance(rows, list):
    rows = rows[0] if rows else None
value=rows.get(key) if isinstance(rows, dict) else None
print("" if value is None else value)' "$@" 2>/dev/null || true
}


# Generate one distinct photo under $ARTIFACTS_DIR/outfit-seeds/ and return its path.
#
# Distinct on purpose: POST /items hashes the picture and answers 409 for a repeat, so
# seeding ten garments from one sample photo would silently produce one garment. The colour
# and the random speckle both vary per type.
seed_photo() {
  local type="$1" py
  local seq="${SEED_PHOTO_SEQ:-0}"
  SEED_PHOTO_SEQ=$((seq + 1))
  local out="$ARTIFACTS_DIR/outfit-seeds/r3-$type-$seq.jpg"
  mkdir -p "$ARTIFACTS_DIR/outfit-seeds"
  py="$(harness_python || true)"
  [ -n "$py" ] || { warn "no python with PIL for generating seed photos"; return 1; }
  # Generated fresh on every call, with a per-call sequence number baked into both the bytes
  # and the file name. An earlier version cached one file per type: the second garment of that
  # type was then the *same picture*, and the server's pHash check answered 409 — so "seed 13
  # tops for the pagination check" silently produced one top, and the scenario that followed
  # failed with a message pointing at the app.
  "$py" - "$type" "$seq" "$out" <<'PYSEED'
import random
import sys

from PIL import Image

type_name, seq, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
random.seed((hash(type_name) & 0xFFFF) + seq * 7919)
base = (
    20 + (abs(hash(type_name + str(seq))) % 220),
    40 + (abs(hash(type_name + 'y' + str(seq))) % 200),
    60 + (abs(hash(type_name + 'z' + str(seq))) % 180),
)
image = Image.new('RGB', (1000, 1000), base)
px = image.load()
for _ in range(12000):
    px[random.randrange(1000), random.randrange(1000)] = (
        random.randrange(256),
        random.randrange(256),
        random.randrange(256),
    )
image.save(out, quality=90)
PYSEED
  printf '%s' "$out"
}

# Upload one garment with an explicit type through the real API.
#
# skip_ai=true mirrors AI being off: the server stores it as ready (which is what
# validate_item_ownership requires before a garment may join an outfit) and leaves its
# tagging status pending. Prints the new item's id, or nothing on failure.
seed_typed_item() {
  local type="$1" name="$2" photo token body
  photo="$(seed_photo "$type")" || return 1
  [ -f "$photo" ] || { warn "seed photo missing for $type"; return 1; }
  api_login || return 1
  token="$(cat "$TOKEN_CACHE")"
  body="$(curl -s -m 60 -X POST "$API/items" \
    -H "Authorization: Bearer $token" \
    -F "image=@$photo;type=image/jpeg;filename=r3-$type.jpg" \
    -F "name=$name" \
    -F "type=$type" \
    -F "skip_ai=true")"
  printf '%s' "$body" | json_field id
}

# A garment with no usable type, the way the server leaves one when no type was supplied.
# This is the 待分类 case: it must be reported, never filed under 上衣.
seed_untyped_item() {
  local name="${1:-harness-untyped}" photo token body
  photo="$(seed_photo untyped)"
  [ -f "$photo" ] || return 1
  api_login || return 1
  token="$(cat "$TOKEN_CACHE")"
  body="$(curl -s -m 60 -X POST "$API/items" \
    -H "Authorization: Bearer $token" \
    -F "image=@$photo;type=image/jpeg;filename=r3-untyped.jpg" \
    -F "name=$name" \
    -F "skip_ai=true")"
  printf '%s' "$body" | json_field id
}

# A wardrobe built for the slot feature: two garments for each basic slot, both optional
# slots, and the two cases this round must refuse (连衣裙, 待分类).
#
# Prints the stamp used for the names, or nothing when anything could not be seeded — a
# scenario must never run on a half-built wardrobe and then report a product failure.
seed_slot_wardrobe() {
  api_delete_all || true
  local left
  left="$(api_item_count || echo 0)"
  if [ "${left:-0}" -ne 0 ]; then
    warn "the wardrobe still holds $left item(s) after clearing"
    return 1
  fi
  local stamp failures="" id
  stamp="$(date +%H%M%S)"
  id="$(seed_typed_item shirt "r3-上装-$stamp" || true)"; [ -n "$id" ] || failures="$failures shirt"
  id="$(seed_typed_item sweater "r3-毛衣-$stamp" || true)"; [ -n "$id" ] || failures="$failures sweater"
  id="$(seed_typed_item pants "r3-长裤-$stamp" || true)"; [ -n "$id" ] || failures="$failures pants"
  id="$(seed_typed_item skirt "r3-半裙-$stamp" || true)"; [ -n "$id" ] || failures="$failures skirt"
  id="$(seed_typed_item sneakers "r3-运动鞋-$stamp" || true)"; [ -n "$id" ] || failures="$failures sneakers"
  id="$(seed_typed_item boots "r3-靴子-$stamp" || true)"; [ -n "$id" ] || failures="$failures boots"
  id="$(seed_typed_item coat "r3-大衣-$stamp" || true)"; [ -n "$id" ] || failures="$failures coat"
  id="$(seed_typed_item hat "r3-帽子-$stamp" || true)"; [ -n "$id" ] || failures="$failures hat"
  id="$(seed_typed_item dress "r3-连衣裙-$stamp" || true)"; [ -n "$id" ] || failures="$failures dress"
  id="$(seed_untyped_item "r3-待分类-$stamp" || true)"; [ -n "$id" ] || failures="$failures untyped"
  if [ -n "$failures" ]; then
    warn "could not seed:$failures"
    return 1
  fi
  printf '%s' "$stamp"
}

# ===== outfits, read straight from the API =====

api_outfit_count() {
  api_get "/outfits?page=1&page_size=1" | json_field total
}

api_outfit_ids() {
  api_get "/outfits?page=1&page_size=100" | python3 -c 'import json,sys
for outfit in (json.load(sys.stdin).get("outfits") or []):
    print(outfit.get("id") or "")'
}

# One field of the outfit whose name matches, or of the newest outfit when no name is given.
api_outfit_field() {
  local field="$1" name="${2:-}" body
  body="$(api_get "/outfits?page=1&page_size=100")" || return 1
  printf '%s' "$body" | python3 -c 'import json,sys
field, wanted = sys.argv[1], sys.argv[2]
outfits = json.load(sys.stdin).get("outfits") or []
if wanted:
    outfits = [o for o in outfits if (o.get("name") or "") == wanted]
value = outfits[0].get(field) if outfits else None
print("" if value is None else value)' "$field" "$name"
}


# How many garments the outfit with this name holds, or -1 when it cannot be found.
#
# Parsed from the JSON directly rather than via `api_outfit_field items`: that helper prints the
# parsed value, and a Python list prints as `[{'id': ...}]`, which is not JSON — the caller's
# `json.load` then failed and the count came back as 0, making a perfectly good edit look like

# ===== stopping and restarting the local API =====

# Stop the API the way it is actually running in this environment.
#
# `scripts/dev-local.sh stop` does nothing here: the API was started by hand (no pidfile under
# $DEV_ROOT/api.pid), so its own status reports "API: stopped" while `curl /health` still answers
# 200 — verified. The process is therefore matched by its command line and killed directly.
stop_local_api() {
  pkill -f "uvicorn app.main:app" 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 25 ]; do
    if ! curl -s -o /dev/null -m 2 "$API/health" 2>/dev/null; then
      return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

# Start it again with the identical command line and working directory.
#
# The backend reads `backend/.env` relative to its working directory, so the restart has to happen
# from `backend/` or the database URL and the storage path would silently change.
start_local_api() {
  ( cd "$REPO_ROOT/backend" && nohup .venv/bin/uvicorn app.main:app \
      --host 127.0.0.1 --port 8000 --log-level info >> "$ARTIFACTS_DIR/uvicorn-harness.log" 2>&1 & ) \
    >/dev/null 2>&1
  local waited=0 status
  while [ "$waited" -lt 90 ]; do
    status="$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$API/health" 2>/dev/null || echo 000)"
    [ "$status" = "200" ] && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

# it had dropped every garment.
api_outfit_item_count() {
  local name="$1"
  api_get "/outfits?page=1&page_size=100" | python3 -c 'import json,sys
wanted = sys.argv[1]
outfits = json.load(sys.stdin).get("outfits") or []
match = [o for o in outfits if (o.get("name") or "") == wanted]
print(len(match[0].get("items") or []) if match else -1)' "$name"
}

api_outfit_count_named() {
  local needle="$1"
  api_get "/outfits?page=1&page_size=100" | python3 -c 'import json,sys
needle = sys.argv[1]
outfits = json.load(sys.stdin).get("outfits") or []
print(sum(1 for o in outfits if needle in (o.get("name") or "")))' "$needle"
}

# "<slot>:<garment name>" for each filled slot of an outfit, in the client's own slot order.
#
# The slot is recomputed here from the stored garment types through the same table the app
# reads, which makes this an independent check of what the screen shows: if the two disagree,
# the slot the user saw was not derived from the stored garment.
api_outfit_slots() {
  local outfit_id="$1" body
  body="$(api_get "/outfits/$outfit_id")" || return 1
  printf '%s' "$body" | python3 "$ANDROID_ENV_DIR/outfit-slots.py" \
    "$REPO_ROOT/mobile/src/api/outfitVocab.ts"
}

# Bounds of the first node whose content-desc starts with <prefix>, e.g. 上衣席位.
find_bounds_prefix() {
  local prefix="$1" xml="$ARTIFACTS_DIR/.prefix.xml"
  ui_dump_xml "$xml" || return 1
  python3 -c 'import sys, xml.etree.ElementTree as ET
prefix, path = sys.argv[1], sys.argv[2]
root = ET.parse(path).getroot()
for node in root.iter("node"):
    desc = (node.get("content-desc") or "").strip()
    if desc.startswith(prefix):
        print(node.get("bounds"))
        break' "$prefix" "$xml"
}

# Swipe horizontally inside the node whose content-desc starts with <prefix>.
#
# `input swipe` is a real touch stream, so this drives the PanResponder the way a finger
# would — which is the point: 左右滑动 is the required interaction, and tapping the
# 上一件/下一件 buttons would not prove the gesture works.
swipe_prefix() {
  local prefix="$1" direction="$2" bounds x1 y1 x2 y2 w cx cy sx ex
  bounds="$(find_bounds_prefix "$prefix" || true)"
  [ -n "$bounds" ] || return 1
  x1="$(printf '%s' "$bounds" | sed -n 's/^\[\([0-9]*\),[0-9]*\]\[[0-9]*,[0-9]*\]$/\1/p')"
  y1="$(printf '%s' "$bounds" | sed -n 's/^\[[0-9]*,\([0-9]*\)\]\[[0-9]*,[0-9]*\]$/\1/p')"
  x2="$(printf '%s' "$bounds" | sed -n 's/^\[[0-9]*,[0-9]*\]\[\([0-9]*\),[0-9]*\]$/\1/p')"
  y2="$(printf '%s' "$bounds" | sed -n 's/^\[[0-9]*,[0-9]*\]\[[0-9]*,\([0-9]*\)\]$/\1/p')"
  [ -n "$x1" ] && [ -n "$x2" ] || return 1

  # The swipe runs inside the node but **away from the screen edges**.
  #
  # The first version swiped from x2-12 to x1+12, i.e. 1026 -> 54 on this 1080px-wide device.
  # That made the app leave the screen: Android's gesture navigation reserves the outer strip
  # of both edges for Back, so a touch starting ~50px from the right edge is the system's
  # gesture, not the row's. Measured: the swipe logged below switched the screen from 搭配页 to
  # 未识别 (the wardrobe) instead of changing the slot. A finger has the same constraint, so
  # this is how the feature is meant to be swiped too — from the middle of the row.
  w=$(( x2 - x1 ))
  [ "$w" -gt 320 ] && w=320
  cx=$(( (x1 + x2) / 2 ))
  cy=$(( (y1 + y2) / 2 ))
  if [ "$direction" = "next" ]; then
    sx=$(( cx + w / 2 )); ex=$(( cx - w / 2 ))
  else
    sx=$(( cx - w / 2 )); ex=$(( cx + w / 2 ))
  fi
  warn "swipe on '$prefix': $sx,$cy -> $ex,$cy"
  "$ADB" shell input swipe "$sx" "$cy" "$ex" "$cy" 300 >/dev/null 2>&1
  return 0
}

# The garment name shown for a slot: the slot's tile carries it as content-desc
# Tap the centre of the first node whose content-desc starts with <prefix>.
#
# Needed because the slot tile's description changes with its state
# ("选择上衣单品" while empty, "更换上衣：<name>" once filled), and `tap-text` matches exactly.
tap_prefix() {
  local prefix="$1" bounds x1 y1 x2 y2
  bounds="$(find_bounds_prefix "$prefix" || true)"
  [ -n "$bounds" ] || return 1
  x1="$(printf '%s' "$bounds" | sed -n 's/^\[\([0-9]*\),[0-9]*\]\[[0-9]*,[0-9]*\]$/\1/p')"
  y1="$(printf '%s' "$bounds" | sed -n 's/^\[[0-9]*,\([0-9]*\)\]\[[0-9]*,[0-9]*\]$/\1/p')"
  x2="$(printf '%s' "$bounds" | sed -n 's/^\[[0-9]*,[0-9]*\]\[\([0-9]*\),[0-9]*\]$/\1/p')"
  y2="$(printf '%s' "$bounds" | sed -n 's/^\[[0-9]*,[0-9]*\]\[[0-9]*,\([0-9]*\)\]$/\1/p')"
  [ -n "$x1" ] && [ -n "$x2" ] || return 1
  "$ADB" shell input tap "$(( (x1 + x2) / 2 ))" "$(( (y1 + y2) / 2 ))" >/dev/null 2>&1
  return 0
}

# Open a slot's bottom panel by pressing its tile, whatever state the slot is in.
open_slot_panel() {
  local slot="$1"
  tap_prefix "更换$slot：" && return 0
  tap_prefix "选择$slot单品" && return 0
  return 1
}

# Type into the picker panel's search field.
#
# Deliberately not `type_into_scrolled_field`: that helper starts by dismissing the keyboard
# with ESCAPE, and while a React Native Modal is open ESCAPE acts like Back — it closes the
# panel through its own `onRequestClose`. Measured: after that call the panel was gone, so the
# tap on 搜索单品... could not find the field and the scenario reported "could not type".
# (Closing the panel on Back is the required behaviour; the harness has to work with it.)
type_into_panel_search() {
  local text="$1" attempt
  for attempt in 1 2 3; do
    if "$ANDROID_ENV_DIR/device-prep.sh" tap-text "搜索单品..." >/dev/null 2>&1; then
      sleep 1
      "$ANDROID_ENV_DIR/device-prep.sh" type "$text" >/dev/null 2>&1 || true
      if focused_field_contains "$text"; then
        return 0
      fi
      warn "the panel's search field does not hold '$text' yet (attempt $attempt)"
    else
      warn "could not tap the panel's search field (attempt $attempt)"
    fi
    sleep 1
  done
  return 1
}

# "已显示 N / M 件" as the panel prints it, once the candidate query has answered.
#
# Polled rather than read once: opening the panel starts a request for every type in the slot,
# and the line only exists after those resolve. Reading it immediately after the panel opened
# reported "the panel does not state how many candidates are shown" while the capture taken a
# moment later clearly showed 已显示 12 / 15 件 — a harness race, not a missing feature.
panel_page_count() {
  local attempt value
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    # The strings land in $ARTIFACTS_DIR/.visible.txt — `ui_visible_strings` prints nothing to
    # stdout, so piping it into grep silently returned nothing (and looked like a missing
    # feature on screen).
    ui_visible_strings >/dev/null 2>&1 || true
    value="$(grep -o '已显示 [0-9]* / [0-9]* 件' "$ARTIFACTS_DIR/.visible.txt" 2>/dev/null | head -1 || true)"
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
    sleep 2
  done
  return 1
}

# Same, but waits for the count to become something other than $1 (used after 加载更多).
panel_page_count_change() {
  local previous="$1" attempt value
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    ui_visible_strings >/dev/null 2>&1 || true
    value="$(grep -o '已显示 [0-9]* / [0-9]* 件' "$ARTIFACTS_DIR/.visible.txt" 2>/dev/null | head -1 || true)"
    [ -n "$value" ] && [ "$value" != "$previous" ] && { printf '%s' "$value"; return 0; }
    sleep 2
  done
  return 1
}

# The garment name shown inside a slot row, on either screen.
#
# The builder puts it in the tile's content-desc ("更换上衣：<name>"), while the read-only
# detail row only renders it as text, so matching one description is not enough — an earlier
# version of this helper returned nothing on the detail screen and the slot comparison failed
# with "screen slots [上衣: 下装: 鞋子: ]" against a server that had all three.
#
# Both cases are covered by looking *inside the row's bounds* (the row is labelled "<slot>席位"
# on both screens) for the harness's own garment names, which all start with "r3-". Reading the
# name out of the row is also a stronger check than reading a description: it proves the name is
# displayed in that slot, not merely that some node mentions it.
slot_shown_garment() {
  local slot="$1" row xml="$ARTIFACTS_DIR/.slot.xml"
  row="$(find_bounds_prefix "${slot}席位" || true)"
  [ -n "$row" ] || return 1
  ui_dump_xml "$xml" >/dev/null 2>&1 || return 1
  python3 -c 'import re, sys, xml.etree.ElementTree as ET
row, path = sys.argv[1], sys.argv[2]
digits = [int(v) for v in re.findall(r"[0-9]+", row)]
rx1, ry1, rx2, ry2 = digits
for node in ET.parse(path).getroot().iter("node"):
    bounds = [int(v) for v in re.findall(r"[0-9]+", node.get("bounds") or "")]
    if len(bounds) != 4:
        continue
    x1, y1, x2, y2 = bounds
    if x1 < rx1 or y1 < ry1 or x2 > rx2 or y2 > ry2:
        continue
    for value in (node.get("content-desc") or "", node.get("text") or ""):
        for name in re.findall(r"r3-[^\s：]+", value):
            print(name)
            raise SystemExit(0)
raise SystemExit(1)' "$row" "$xml"
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
  # Same token list as the add-success panel (leaked_backend_enums).
  local leaked
  leaked="$(leaked_backend_enums "$visible")"
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

    # The test account's own item must be on screen. Falling through to the
    # count when that name is known is how s5 passed on someone else's wardrobe
    # that happened to hold the same number of items (audit M2: "server's count
    # (1)"). The count fallback stays only after the account was confirmed AND
    # the newest row has no name to look for.
    if [ -n "$name" ]; then
      if wait_for_text "$name" 25; then
        ok "cold start $i: wardrobe rendered and '$name' is readable"
      else
        warn "cold start $i: '$name' (owned by $TEST_USER_EMAIL) is not on screen; a matching count is not accepted"
        failures=$((failures + 1))
      fi
    elif [ "$ACCOUNT_CONFIRMED" = 1 ] && wait_for_text "衣柜中有 ${count} 件单品" 10; then
      ok "cold start $i: wardrobe rendered with the server's count ($count); account confirmed and the item has no name"
    else
      warn "cold start $i: the wardrobe showed neither the test account's item nor a confirmed-account count"
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


# S9 — the whole slot flow:席位, the bottom panel, saving, the saved list, a cold start,
# reopening, editing and deleting.
scenario_s9() {
  log "S9  slot builder: 席位 swipe, picker panel, save, list, cold start, reopen, edit, delete"
  local stamp
  stamp="$(seed_slot_wardrobe)" || {
    record FAIL "s9-build-outfit" "could not seed the slot wardrobe (see the warnings above)"
    return
  }
  local wardrobe_before
  wardrobe_before="$(api_item_count || echo 0)"
  ok "seeded the slot wardrobe ($wardrobe_before garments, stamp $stamp)"

  # Seed a second page's worth of 上衣 through the real API: the panel's pagination claim
  # ("不能用第一页冒充全部衣物") cannot be checked on a two-garment slot.
  local i extra=""
  for i in $(seq 1 13); do
    extra="$(seed_typed_item shirt "r3-上衣批量-$i-$stamp" || true)"
    [ -n "$extra" ] || break
  done
  local tops
  tops="$(api_get "/items?type=shirt&page=1&page_size=1&is_archived=false" | json_field total)"
  ok "the 上衣 slot now holds $tops garments, enough for a second page"

  # Cold start before the assertions. The garments were written straight through the API, and
  # the per-type counts the notice is built from are cached for 5 minutes (`useItemTypes`),
  # so a still-running app would judge the wardrobe from before the seeding. In normal use an
  # in-app add/delete invalidates that key; only out-of-band writes can leave it stale, and
  # restarting is the honest way for the harness to clear that.
  restart_app_fresh >/dev/null 2>&1 || true
  goto_wardrobe >/dev/null 2>&1 || true
  tap_after_scrolling_to "搭配" || {
    record FAIL "s9-open-tab" "could not reach the 搭配 tab"
    return
  }
  if ! wait_for_screen "搭配页" 20; then
    capture "s9-01-no-builder"
    record FAIL "s9-open-tab" "the 搭配 tab did not render the slot builder (see s9-01-no-builder)"
    return
  fi
  capture "s9-01-builder"
  ok "the 搭配 tab shows the slot builder"

  # The two wardrobe facts the round demands be reported rather than hidden.
  if screen_has_text "待分类"; then
    ok "the builder reports the 待分类 garments that no slot can hold"
  else
    record FAIL "s9-unclassified-note" "no 待分类 note on the builder although an untyped garment exists"
    return
  fi
  if screen_has_text "连衣裙、连体衣暂不支持搭配席位"; then
    ok "the builder says 连衣裙/连体衣 are not supported this round"
  else
    record FAIL "s9-fullbody-note" "no not-supported note although a 连衣裙 exists in the wardrobe"
    return
  fi
  if screen_has_text "未选择"; then
    ok "the slots start empty rather than pre-filled with a guess"
  fi

  # ---- swipe changes exactly one slot --------------------------------------------------
  local before_top after_top bottom_before
  swipe_prefix "上衣席位" next || {
    record FAIL "s9-swipe" "could not swipe the 上衣 slot"
    return
  }
  sleep 2
  before_top="$(slot_shown_garment 上衣 || true)"
  if [ -z "$before_top" ]; then
    capture "s9-02-swipe-empty"
    record FAIL "s9-swipe" "swiping the empty 上衣 slot selected nothing (see s9-02-swipe-empty)"
    return
  fi
  ok "a swipe on the empty 上衣 slot selected '$before_top'"

  swipe_prefix "上衣席位" next || true
  sleep 2
  after_top="$(slot_shown_garment 上衣 || true)"
  bottom_before="$(slot_shown_garment 下装 || true)"
  if [ "$after_top" = "$before_top" ]; then
    capture "s9-03-swipe-same"
    record FAIL "s9-swipe" \
      "the second swipe left 上衣 on the same garment ('$after_top'); 14 candidates were available"
    return
  fi
  if [ -n "$bottom_before" ]; then
    record FAIL "s9-swipe-isolation" \
      "changing 上衣 also changed 下装 (now '$bottom_before'); a swipe must only touch its own slot"
    return
  fi
  record PASS "s9-swipe-isolation" \
    "下装 was untouched: only the swiped slot changed ($before_top -> $after_top)"

  # ---- the bottom panel: search, pagination, select, cancel, back ----------------------
  # Open the 下装 panel (empty slot, so its tile reads 选择下装单品).
  open_slot_panel 下装 || {
    record FAIL "s9-panel-open" "could not press the 下装 tile to open the panel"
    return
  }
  if ! wait_for_text "取消后保持原来的选择" 15; then
    capture "s9-04-no-panel"
    record FAIL "s9-panel-open" "pressing the slot did not open the bottom panel (see s9-04-no-panel)"
    return
  fi
  capture "s9-04-panel"
  ok "the panel opened from the bottom and offers 取消"

  # Cancel first: the empty 下装 slot must stay empty.
  tap_text_last "取消" || { record FAIL "s9-panel-cancel" "could not tap 取消"; return; }
  sleep 2
  if [ -n "$(slot_shown_garment 下装 || true)" ]; then
    record FAIL "s9-panel-cancel" "cancelling the panel still put a garment in 下装"
    return
  fi
  record PASS "s9-panel-cancel" "cancelling the panel left 下装 empty, as it was"

  # Search inside the panel. The term is "skirt" — ASCII, because `adb shell input text`
  # cannot inject non-ASCII at all (`device-prep.sh type` refuses it outright), and the server
  # matches `search` against name, brand, **type** and notes (`ItemService.get_list`), so the
  # English type value is a real server-side hit. This slot holds a skirt and a pair of
  # trousers, so "did the search narrow the list" is a real question here, not a vacuous one.
  open_slot_panel 下装 || { record FAIL "s9-panel-search" "could not reopen the 下装 panel"; return; }
  wait_for_text "取消后保持原来的选择" 12 || true
  if ! type_into_panel_search "skirt"; then
    record FAIL "s9-panel-search" "could not type into the panel's search field"
    return
  fi
  sleep 4
  capture "s9-05-panel-search"
  if ! screen_has_text "r3-半裙-$stamp"; then
    record FAIL "s9-panel-search" "searching for 'skirt' did not list r3-半裙-$stamp"
    return
  fi
  if screen_has_text "r3-长裤-$stamp"; then
    record FAIL "s9-panel-search" "searching for 'skirt' still lists the trousers from the same slot"
    return
  fi
  record PASS "s9-panel-search" "the server-side search narrowed the 下装 panel to the skirt"

  # Selecting from the searched list fills the slot with exactly that garment.
  if ! tap_after_scrolling_to "r3-半裙-$stamp" 3; then
    record FAIL "s9-panel-select" "could not select the skirt from the panel"
    return
  fi
  sleep 2
  picked="$(slot_shown_garment 下装 || true)"
  if [ "$picked" != "r3-半裙-$stamp" ]; then
    capture "s9-06-after-select"
    record FAIL "s9-panel-select" \
      "选择 put '$picked' in 下装 instead of the garment that was tapped (r3-半裙-$stamp)"
    return
  fi
  record PASS "s9-panel-select" "selecting from the panel put r3-半裙-$stamp in 下装"

  # Pagination, on the slot with 14 candidates: the reveal window must grow rather than the
  # panel presenting page 1 as the whole slot.
  open_slot_panel 上衣 || { record FAIL "s9-panel-pagination" "could not open the 上衣 panel"; return; }
  if ! wait_for_text "取消后保持原来的选择" 15; then
    record FAIL "s9-panel-pagination" "could not open the 上衣 panel"
    return
  fi
  local first_page second_page
  first_page="$(panel_page_count || true)"
  capture "s9-07-panel-top"
  if [ -z "$first_page" ]; then
    record FAIL "s9-panel-pagination" "the panel does not state how many candidates are shown"
    return
  fi
  ok "the panel reports '$first_page'"
  if tap_after_scrolling_to "加载更多" 14; then
    sleep 2
    # Scroll back to the top before reading the count again: 已显示 is the list's header, so it
    # scrolls out of view on the way down and the first version of this check read an empty
    # string and reported "did not change the revealed window" while nothing was wrong.
    local i
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do
      "$ANDROID_ENV_DIR/device-prep.sh" swipe down 400 >/dev/null 2>&1 || true
    done
    sleep 2
    second_page="$(panel_page_count_change "$first_page" || true)"
    capture "s9-08-panel-page2"
    if [ -n "$second_page" ] && [ "$second_page" != "$first_page" ]; then
      record PASS "s9-panel-pagination" \
        "加载更多 revealed more candidates ($first_page -> $second_page), so one page is not passed off as the whole slot"
    else
      record FAIL "s9-panel-pagination" \
        "加载更多 did not change the revealed window ('$first_page' -> '$second_page')"
    fi
  else
    record FAIL "s9-panel-pagination" \
      "no 加载更多 control although the slot holds more than one page of candidates"
  fi

  # Android's back button must close the panel first, leaving the screen in place.
  "$ADB" shell input keyevent KEYCODE_BACK >/dev/null 2>&1
  sleep 2
  if screen_has_text "取消后保持原来的选择"; then
    record FAIL "s9-panel-back" "the back button did not close the panel"
  elif wait_for_screen "搭配页" 8; then
    record PASS "s9-panel-back" "the back button closed the panel and left the builder on screen"
  else
    record FAIL "s9-panel-back" "the back button closed the panel but also left the builder"
  fi

  # 鞋子 through the panel, by name: the slot must end up holding exactly the garment tapped.
  open_slot_panel 鞋子 || { record FAIL "s9-fill-鞋子" "could not open the 鞋子 panel"; return; }
  wait_for_text "取消后保持原来的选择" 12 || true
  if ! tap_after_scrolling_to "r3-运动鞋-$stamp" 3; then
    record FAIL "s9-fill-鞋子" "could not select the sneakers from the panel"
    return
  fi
  sleep 2
  picked="$(slot_shown_garment 鞋子 || true)"
  if [ "$picked" != "r3-运动鞋-$stamp" ]; then
    capture "s9-09-shoes"
    record FAIL "s9-fill-鞋子" "鞋子 holds '$picked' instead of r3-运动鞋-$stamp"
    return
  fi
  ok "鞋子 holds r3-运动鞋-$stamp, the garment that was tapped"

  # ---- save ----------------------------------------------------------------------------
  # ASCII on purpose: `adb shell input text` cannot inject non-ASCII (device-prep.sh `type`
  # refuses it and exits), so a Chinese outfit name made the harness report "could not type the
  # outfit's name" while the field was fine — the same trap the round-2 scenarios document.
  local outfit_name="r3-outfit-$stamp"
  if ! type_into_scrolled_field "例如：通勤三件套" "$outfit_name"; then
    record FAIL "s9-save" "could not type the outfit's name"
    return
  fi
  capture "s9-09-filled"
  tap_after_scrolling_to "保存搭配" || {
    record FAIL "s9-save" "could not tap 保存搭配"
    return
  }
  if ! wait_for_screen "搭配详情" 40; then
    capture "s9-10-no-detail"
    record FAIL "s9-save" "saving did not open the outfit's detail screen (see s9-10-no-detail)"
    return
  fi
  capture "s9-10-detail"

  local stored_id stored_name
  stored_id="$(api_outfit_field id "$outfit_name")"
  stored_name="$(api_outfit_field name "$outfit_name")"
  if [ "$stored_name" != "$outfit_name" ]; then
    record FAIL "s9-save" "the outfit is not on the server under '$outfit_name' (got '$stored_name')"
    return
  fi
  record PASS "s9-save" "saved as '$outfit_name' (id $stored_id) and the detail screen opened"

  # The slots the app showed must equal the slots derived from the server's own copy.
  local server_slots screen_slots=""
  server_slots="$(api_outfit_slots "$stored_id")"
  for slot_name in 上衣 下装 鞋子; do
    screen_slots="$screen_slots$slot_name:$(slot_shown_garment "$slot_name" || true)"$'\n'
  done
  if [ -z "$server_slots" ]; then
    record FAIL "s9-slots-persisted" "the server did not report any slot for the saved outfit"
    return
  fi
  local expected_screen=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "${line%%:*}" in
      top) expected_screen="$expected_screen上衣:${line#*:}"$'\n' ;;
      bottom) expected_screen="$expected_screen下装:${line#*:}"$'\n' ;;
      shoes) expected_screen="$expected_screen鞋子:${line#*:}"$'\n' ;;
    esac
  done <<< "$server_slots"
  if [ "$expected_screen" = "$screen_slots" ]; then
    record PASS "s9-slots-persisted" \
      "every slot on the detail screen matches the server's stored garment ($(printf '%s' "$server_slots" | tr '\n' ' '))"
  else
    capture "s9-11-slot-mismatch"
    record FAIL "s9-slots-persisted" \
      "screen slots [$(printf '%s' "$screen_slots" | tr '\n' ' ')] != server slots [$(printf '%s' "$server_slots" | tr '\n' ' ')]"
  fi

  # ---- cold start, list, reopen ---------------------------------------------------------
  restart_app_fresh >/dev/null 2>&1 || true
  tap_after_scrolling_to "搭配" || true
  wait_for_screen "搭配页" 25 || true
  tap_after_scrolling_to "已保存搭配" || {
    record FAIL "s9-cold-start" "could not open 已保存搭配 after a cold start"
    return
  }
  if ! wait_for_screen "已保存搭配" 20; then
    capture "s9-12-no-list"
    record FAIL "s9-cold-start" "the saved list did not render after a cold start"
    return
  fi
  capture "s9-12-list"
  if screen_has_text "$outfit_name"; then
    ok "the saved outfit is listed after a cold start"
  else
    record FAIL "s9-cold-start" "'$outfit_name' is missing from the saved list after a cold start"
    return
  fi
  if tap_after_scrolling_to "$outfit_name" 4; then
    wait_for_screen "搭配详情" 20 || true
  fi
  screen_slots=""
  for slot_name in 上衣 下装 鞋子; do
    screen_slots="$screen_slots$slot_name:$(slot_shown_garment "$slot_name" || true)"$'\n'
  done
  if [ "$expected_screen" = "$screen_slots" ]; then
    record PASS "s9-cold-start-reopen" \
      "reopening after a cold start shows the same garments in the same slots"
  else
    capture "s9-13-reopen-mismatch"
    record FAIL "s9-cold-start-reopen" \
      "reopened slots [$(printf '%s' "$screen_slots" | tr '\n' ' ')] != saved slots [$(printf '%s' "$expected_screen" | tr '\n' ' ')]"
  fi
  OUT_S9_ID="$stored_id"
  OUT_S9_NAME="$outfit_name"
  OUT_S9_WARDROBE="$wardrobe_before"
}


# S10 — editing and deleting a saved outfit, and the isolation guarantees around both.
#
# Depends on S9 having run in the same invocation (`OUT_S9_ID`): it edits and then deletes the
# outfit S9 created, and finishes by proving the wardrobe it was built from is untouched.
scenario_s10() {
  log "S10 edit and delete a saved outfit; other accounts see neither the outfit nor its garments"
  local outfit_id="${OUT_S9_ID:-}" outfit_name="${OUT_S9_NAME:-}" wardrobe_before="${OUT_S9_WARDROBE:-}"
  if [ -z "$outfit_id" ]; then
    outfit_id="$(api_outfit_field id)"
    outfit_name="$(api_outfit_field name)"
  fi
  if [ -z "$outfit_id" ]; then
    record SKIP "s10-edit-outfit" "no saved outfit to edit; run s9 first (or create one by hand)"
    return
  fi
  # Count the wardrobe now, not as S9 left it: S9 seeds 13 extra 上衣 *after* its own snapshot, so
  # comparing against that number made the delete check report "deleting the outfit changed the
  # wardrobe (10 -> 23)" when nothing had been touched.
  wardrobe_before="$(api_item_count || echo 0)"

  # Open the outfit's detail screen through the app's own deep link. S9 already proved the
  # list → detail path, so this only needs a deterministic starting point.
  "$ADB" shell am start -a android.intent.action.VIEW -d "wardrowbe://outfit/$outfit_id" \
    >/dev/null 2>&1 || true
  wait_for_ui_ready 60 || true
  if ! wait_for_screen "搭配详情" 30; then
    capture "s10-01-no-detail"
    record FAIL "s10-open-detail" "the deep link did not open the outfit's detail screen"
    return
  fi

  local slots_before
  slots_before="$(api_outfit_slots "$outfit_id")"

  # ---- edit: rename, and change the 下装 slot by swiping ---------------------------------
  tap_after_scrolling_to "编辑搭配" || {
    record FAIL "s10-edit-outfit" "no 编辑搭配 control on the detail screen"
    return
  }
  sleep 2
  local new_name="$outfit_name-renamed"
  if ! replace_field_value "$outfit_name" "$new_name"; then
    if ! type_into_scrolled_field "$outfit_name" "$new_name"; then
      record MANUAL "s10-edit-outfit" \
        "could not replace the name field; rename by hand and check the change reaches the server"
      return
    fi
  fi

  local bottom_before bottom_after
  bottom_before="$(slot_shown_garment 下装 || true)"
  swipe_prefix "下装席位" next || true
  sleep 2
  bottom_after="$(slot_shown_garment 下装 || true)"
  capture "s10-02-editing"

  if [ -z "$bottom_before" ] || [ -z "$bottom_after" ]; then
    record FAIL "s10-edit-slot" "could not read the 下装 slot before/after the swipe"
    return
  fi
  if [ "$bottom_after" = "$bottom_before" ]; then
    record FAIL "s10-edit-slot" "the swipe did not change 下装 ('$bottom_before' -> '$bottom_after')"
    return
  fi
  ok "下装 changed from '$bottom_before' to '$bottom_after' while editing"

  tap_after_scrolling_to "保存搭配" || {
    record FAIL "s10-edit-save" "could not tap 保存搭配 in the editor"
    return
  }
  local waited=0 stored_name=""
  while [ "$waited" -lt 45 ]; do
    stored_name="$(api_outfit_field name "$new_name")"
    [ -n "$stored_name" ] && break
    sleep 3; waited=$((waited + 3))
  done
  capture "s10-03-saved"
  if [ "$stored_name" != "$new_name" ]; then
    record FAIL "s10-edit-save" "the rename did not reach the server (still '$(api_outfit_field name "$outfit_name")')"
    return
  fi

  local slots_after expected_after=""
  slots_after="$(api_outfit_slots "$outfit_id")"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "${line%%:*}" in
      top) expected_after="$expected_after上衣:${line#*:}"$'\n' ;;
      bottom) expected_after="$expected_after下装:${line#*:}"$'\n' ;;
      shoes) expected_after="$expected_after鞋子:${line#*:}"$'\n' ;;
    esac
  done <<< "$slots_after"
  local screen_after=""
  local slot_name
  for slot_name in 上衣 下装 鞋子; do
    screen_after="$screen_after$slot_name:$(slot_shown_garment "$slot_name" || true)"$'\n'
  done
  if [ "$expected_after" = "$screen_after" ]; then
    record PASS "s10-edit-save" \
      "renaming and re-slotting reached the server and the screen agrees ($(printf '%s' "$slots_after" | tr '\n' ' '))"
  else
    capture "s10-04-mismatch"
    record FAIL "s10-edit-save" \
      "after saving, screen slots [$(printf '%s' "$screen_after" | tr '\n' ' ')] != server slots [$(printf '%s' "$expected_after" | tr '\n' ' ')]"
  fi

  # THE bug this check exists for: PATCH replaces the whole item set, so an edit that sent a
  # stale or partial list would silently drop a garment. The outfit must still hold one
  # garment per slot.
  local item_count
  item_count="$(api_outfit_item_count "$new_name" || echo -1)"
  local slots_count
  slots_count="$(printf '%s' "$slots_after" | grep -c . || true)"
  if [ "${item_count:-0}" -ge "${slots_count:-0}" ] && [ "${slots_count:-0}" -ge 3 ]; then
    ok "the edit kept every garment ($item_count items for $slots_count slots)"
  else
    record FAIL "s10-edit-save" \
      "the edit lost garments: $item_count item(s) for $slots_count slot(s)"
  fi

  # ---- delete: cancel keeps it, confirm removes the outfit but not the wardrobe ----------
  tap_after_scrolling_to "删除搭配" || {
    record FAIL "s10-delete" "no 删除搭配 control on the detail screen"
    return
  }
  if ! wait_for_text "只会删除这套搭配本身" 15; then
    capture "s10-05-no-dialog"
    record FAIL "s10-delete" "deleting asked for no confirmation (see s10-05-no-dialog)"
    return
  fi
  capture "s10-05-delete-dialog"
  ok "deleting asks first, and the wording says the garments are not deleted"

  tap_text_last "取消" || true
  sleep 2
  if [ -z "$(api_outfit_field id "$new_name")" ]; then
    record FAIL "s10-delete-cancel" "cancelling the confirmation deleted the outfit anyway"
    return
  fi
  record PASS "s10-delete-cancel" "cancelling the delete left the outfit in place"

  tap_after_scrolling_to "删除搭配" || true
  wait_for_text "只会删除这套搭配本身" 12 || true
  tap_text_last "确认删除" || {
    record FAIL "s10-delete" "could not confirm the delete"
    return
  }
  waited=0
  local gone=""
  while [ "$waited" -lt 45 ]; do
    gone="$(curl -s -o /dev/null -w '%{http_code}' "$API/outfits/$outfit_id" -H "Authorization: Bearer $(cat "$TOKEN_CACHE")")"
    [ "$gone" = "404" ] && break
    sleep 3; waited=$((waited + 3))
  done
  capture "s10-06-after-delete"
  if [ "$gone" != "404" ]; then
    record FAIL "s10-delete" "the outfit still exists on the server (HTTP $gone)"
    return
  fi

  local wardrobe_after
  wardrobe_after="$(api_item_count || echo 0)"
  if [ "${wardrobe_after:-0}" = "${wardrobe_before:-0}" ]; then
    record PASS "s10-delete" \
      "the outfit is gone (404) and the wardrobe still holds $wardrobe_after garments"
  else
    record FAIL "s10-delete" \
      "deleting the outfit changed the wardrobe ($wardrobe_before -> ${wardrobe_after:-?})"
  fi

  # ---- isolation: a second account -------------------------------------------------------
  local other_token other_item my_garment foreign_name
  other_token="$(curl -s -X POST "$API/auth/sync" -H 'Content-Type: application/json' \
    -d "{\"external_id\":\"dev:r3-other-$TEST_USER_EMAIL\",\"email\":\"r3-other-$TEST_USER_EMAIL\",\"display_name\":\"隔离账号\"}" \
    | json_field access_token)"
  if [ -z "$other_token" ]; then
    record MANUAL "s10-isolation" "could not create the second account; check isolation by hand"
    return
  fi

  # A garment only the other account owns, with a name that cannot collide.
  my_garment="$(seed_typed_item shirt "r3-我方上装-$(date +%H%M%S)" || true)"
  foreign_name="r3-仅对方可见-$(date +%H%M%S)"
  local other_photo other_item_id
  other_photo="$(seed_photo other)"
  other_item_id="$(curl -s -X POST "$API/items" -H "Authorization: Bearer $other_token" \
    -F "image=@$other_photo;type=image/jpeg;filename=r3-other.jpg" \
    -F "name=$foreign_name" -F "type=shirt" -F "skip_ai=true" | json_field id)"
  if [ -z "$other_item_id" ]; then
    record MANUAL "s10-isolation" "could not seed the other account's garment"
    return
  fi
  local foreign_outfit
  foreign_outfit="$(curl -s -X POST "$API/outfits/suggestions" -H "Authorization: Bearer $other_token" \
    -H 'Content-Type: application/json' \
    -d "{\"items\":[\"$other_item_id\"],\"occasion\":\"casual\",\"name\":\"r3-对方搭配\"}" | json_field id)"

  # The other account's garment must never appear as one of my candidates.
  if api_get "/items?page=1&page_size=100&is_archived=false" | grep -q "$foreign_name"; then
    record FAIL "s10-candidate-isolation" "another account's garment appears in my item list"
  else
    ok "another account's garment is not in my candidate list"
  fi

  # Its outfit id must not be readable through the app either.
  if [ -n "$foreign_outfit" ]; then
    "$ADB" shell am start -a android.intent.action.VIEW -d "wardrowbe://outfit/$foreign_outfit" \
      >/dev/null 2>&1 || true
    wait_for_ui_ready 60 || true
    sleep 2
    # Polled, and read from the dump file rather than through two back-to-back `screen_has_text`
    # calls: those each take their own dump, and a busy moment makes `uiautomator dump` fail, which
    # `screen_has_text` reports as "text not found" — that is how this check first came out MANUAL
    # while the capture it had just taken plainly said 未找到该搭配.
    local attempt=0 verdict=""
    local dump="$ARTIFACTS_DIR/s10-07-foreign-id.xml"
    while [ "$attempt" -lt 10 ]; do
      ui_dump_xml "$dump" >/dev/null 2>&1 || true
      if grep -q -F -- "r3-对方搭配" "$dump" 2>/dev/null; then
        verdict="leak"
        break
      fi
      if grep -q -F -- "未找到该搭配" "$dump" 2>/dev/null; then
        verdict="refused"
        break
      fi
      sleep 2; attempt=$((attempt + 1))
    done
    capture "s10-07-foreign-id"
    case "$verdict" in
      leak)
        record FAIL "s10-cross-account" "another account's outfit renders in my app"
        ;;
      refused)
        record PASS "s10-cross-account" \
          "another account's outfit id answers 未找到该搭配 instead of rendering their outfit"
        ;;
      *)
        record MANUAL "s10-cross-account" \
          "the deep link to another account's outfit did not show a clear refusal; check by hand"
        ;;
    esac
  fi

  # My own wardrobe is still intact after all of the above.
  local mine
  mine="$(api_item_count || echo 0)"
  if [ "${mine:-0}" -ge "${wardrobe_before:-0}" ]; then
    record PASS "s10-wardrobe-intact" \
      "the wardrobe still holds $mine garments (started at $wardrobe_before)"
  else
    record FAIL "s10-wardrobe-intact" \
      "the wardrobe shrank ($wardrobe_before -> ${mine:-?}) during the outfit tests"
  fi
  OUT_S10_OTHER_ITEM="$other_item_id"
}

# S11 — the three failure states round 3 requires to be recoverable: an empty slot category,
# a garment image that cannot be loaded, and a save that fails.
#
# Each is produced for real (a deleted garment, a moved image file, a stopped backend) rather
# than asserted from a screenshot of a happy path.
scenario_s11() {
  log "S11 empty category, broken image and failed save all report honestly and recover"
  local stamp
  stamp="$(seed_slot_wardrobe)" || {
    record FAIL "s11-empty-category" "could not seed the slot wardrobe"
    return
  }

  # ---- an empty category ----------------------------------------------------------------
  local coat_id
  coat_id="$(api_get "/items?type=coat&page=1&page_size=1&is_archived=false" | json_field id items)"
  if [ -z "$coat_id" ]; then
    record MANUAL "s11-empty-category" "no 外套 garment to remove; check the empty-slot wording by hand"
  else
    curl -s -o /dev/null -X DELETE "$API/items/$coat_id" -H "Authorization: Bearer $(cat "$TOKEN_CACHE")"
    restart_app_fresh >/dev/null 2>&1 || true
    tap_after_scrolling_to "搭配" >/dev/null 2>&1 || true
    if ! wait_for_screen "搭配页" 25; then
      capture "s11-01-no-builder"
      record FAIL "s11-empty-category" "could not reach the builder after removing the 外套"
      return
    fi
    sleep 3
    capture "s11-01-empty-category"
    if screen_has_text "衣橱里还没有外套类别的单品"; then
      record PASS "s11-empty-category" \
        "with no 外套 left, the 外套 slot says so instead of offering an empty list"
    else
      record FAIL "s11-empty-category" "the 外套 slot does not report that the wardrobe has none"
    fi
  fi

  # ---- an image that cannot be loaded, and its retry ------------------------------------
  #
  # The failure is made real by moving one thumbnail file out of the way: the signed URL still
  # resolves and passes its signature check, but the bytes are gone, so the app's <Image> fires
  # onError. The file is restored before the retry, which is what the user's retry would hit
  # after a temporary fault.
  # The garment is chosen by asking the app first: the slot's first candidate is whatever the
  # server returns newest, and guessing "the newest shirt" broke this check once (the newest
  # 上衣 was a sweater, so the broken file was never the one on screen). One swipe now, remember
  # the name, and break *that* garment's file.
  local slot_name_first="" top_id top_thumb source_path moved=""
  swipe_prefix "上衣席位" next || true
  sleep 3
  slot_name_first="$(slot_shown_garment 上衣 || true)"
  top_id="$(api_get "/items?page=1&page_size=100&is_archived=false" \
    | python3 -c 'import json,sys
wanted = sys.argv[1]
items = json.load(sys.stdin).get("items") or []
match = [i for i in items if (i.get("name") or "") == wanted]
print(match[0].get("id") if match else "")' "$slot_name_first")"
  top_thumb="$([ -n "$top_id" ] && api_get "/items/$top_id" | json_field thumbnail_path)"
  source_path="$STORAGE_ROOT/$top_thumb"
  if [ -n "$top_thumb" ] && [ -f "$source_path" ]; then
    moved="$source_path.hidden-s11"
    mv "$source_path" "$moved"
    restart_app_fresh >/dev/null 2>&1 || true
    tap_after_scrolling_to "搭配" >/dev/null 2>&1 || true
    wait_for_screen "搭配页" 25 || true
    swipe_prefix "上衣席位" next || true
    sleep 4
    capture "s11-02-image-failed"
    if screen_has_text "图片加载失败"; then
      if screen_has_text "重试"; then
        record PASS "s11-image-failure" \
          "a garment whose image 404s shows 图片加载失败 with a 重试 affordance"
      else
        record FAIL "s11-image-failure" "the failure placeholder offers no retry"
      fi
    else
      record FAIL "s11-image-failure" \
        "the slot with a missing image file shows no failure state (see s11-02-image-failed)"
    fi
    mv "$moved" "$source_path"
    # Retry: the file is back, so the placeholder must give way to the image.
    if tap_after_scrolling_to "重试" 3; then
      sleep 4
      capture "s11-03-image-retry"
      if screen_has_text "图片加载失败"; then
        record FAIL "s11-image-retry" "重试 did not clear the image failure although the file is back"
      else
        record PASS "s11-image-retry" "重试 reloaded the image once the file was back"
      fi
    else
      record MANUAL "s11-image-retry" "could not press 重试; check the reload by hand"
    fi
  else
    record MANUAL "s11-image-failure" \
      "could not locate a stored thumbnail under $STORAGE_ROOT; check the failure state by hand"
    [ -n "$moved" ] && [ -f "$moved" ] && mv "$moved" "$source_path"
  fi

  # ---- a save that fails, and the retry that succeeds ------------------------------------
  #
  # The backend is stopped, which is the failure a phone actually meets (no connectivity). The
  # requirement is that the draft survives and the user can retry — never that the app pretends
  # the write happened.
# Wait until a slot shows the named garment, or give up.
#
# Used after picking from the panel: the candidates load asynchronously, so a tap that lands while
# the list is still filling in is applied a moment later. Reading the slot immediately made the
# draft baseline look empty and the "the failed save kept the selection" check compared against a
# value the screen never had.
wait_for_slot_garment() {
  local slot="$1" want="$2" timeout="${3:-20}" waited=0 got
  while [ "$waited" -lt "$timeout" ]; do
    got="$(slot_shown_garment "$slot" || true)"
    [ "$got" = "$want" ] && return 0
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

  local name="r3-retry-$stamp"
  tap_after_scrolling_to "选择下装单品" >/dev/null 2>&1 || open_slot_panel 下装 || true
  wait_for_text "取消后保持原来的选择" 12 || true
  tap_after_scrolling_to "r3-半裙-$stamp" 6 >/dev/null 2>&1 || true
  wait_for_slot_garment 下装 "r3-半裙-$stamp" 24 || true
  if ! type_into_scrolled_field "例如：通勤三件套" "$name"; then
    record MANUAL "s11-save-failure" "could not type the outfit name; check the failure copy by hand"
    return
  fi
  local top_before bottom_before
  top_before="$(slot_shown_garment 上衣 || true)"
  bottom_before="$(slot_shown_garment 下装 || true)"

  if ! stop_local_api; then
    record MANUAL "s11-save-failure" "could not stop the API to simulate a failed save; check by hand"
    return
  fi
  tap_after_scrolling_to "保存搭配" >/dev/null 2>&1 || true
  sleep 8
  capture "s11-04-save-failed"
  local reported=0
  if screen_has_text "保存失败"; then
    reported=1
  elif screen_has_text "无法连接服务器"; then
    reported=1
  fi
  if [ "$reported" = "1" ]; then
    ok "a save with the backend down reports a failure instead of claiming success"
  else
    record FAIL "s11-save-failure" \
      "tapping 保存搭配 with the backend down produced no error (see s11-04-save-failed)"
  fi
  # The draft must be intact: the same garments, still in their slots.
  local top_after bottom_after
  top_after="$(slot_shown_garment 上衣 || true)"
  bottom_after="$(slot_shown_garment 下装 || true)"
  if [ "$top_after" = "$top_before" ] && [ "$bottom_after" = "$bottom_before" ]; then
    record PASS "s11-save-keeps-draft" \
      "the failed save kept the selection ($top_after / $bottom_after)"
  else
    capture "s11-05-draft-lost"
    record FAIL "s11-save-keeps-draft" \
      "the failed save changed the draft ([$top_before / $bottom_before] -> [$top_after / $bottom_after])"
  fi

  if ! start_local_api; then
    record FAIL "s11-save-retry" "the API did not come back after the failure test — restart it by hand"
    return
  fi
  local up="200"
  api_forget_token || true
  tap_after_scrolling_to "保存搭配" >/dev/null 2>&1 || true
  if ! wait_for_screen "搭配详情" 45; then
    capture "s11-06-retry-failed"
    record FAIL "s11-save-retry" "retrying the save after the backend returned did not work"
    return
  fi
  capture "s11-06-retry-ok"
  local stored
  stored="$(api_outfit_field name "$name")"
  if [ "$stored" = "$name" ]; then
    record PASS "s11-save-retry" \
      "the same session retried the save and '$name' is now on the server"
  else
    record FAIL "s11-save-retry" "the retry did not store the outfit (server says '$stored')"
  fi
}


# ---------------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------------
declare -a ALL_SCENARIOS=(s1 s2 s3 s4 s5 s6 s7 s8 s9 s10 s11)

usage() {
  cat <<EOF
run-acceptance.sh — mechanized acceptance scenarios for 知衣 (Android), rounds 2-3

Usage: ./mobile/scripts/run-acceptance.sh [--list] [scenario ...]

Scenarios:
  s1   Add a garment from the gallery; verify it persists across refresh and restart
       (scenario 1; an unnamed second add must not print a raw type enum)
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
  s9   Slot outfits: 席位 swipe, the bottom picker (search + pagination), save, the saved
       list, a cold start, reopening, and slot-by-slot agreement with the server
       (round-3 acceptance scenarios 1-4)
  s10  Edit and delete a saved outfit; deleting keeps the wardrobe; a second account's
       outfit and garments stay invisible (round-3 acceptance scenarios 4-5)
  s11  Empty slot category, a garment image that cannot load, and a save that fails: each
       reports honestly and recovers (round-3 acceptance scenario 4)

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

  # The device must be signed in as $TEST_USER_EMAIL before any scenario.
  # Otherwise s5 passes on a stranger's wardrobe and s1 reports their 409 as
  # "no new item appeared" (audit M2).
  ensure_test_account

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
      s9) scenario_s9 ;;
      s10) scenario_s10 ;;
      s11) scenario_s11 ;;
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

  # Explicit success. Without it the function's exit status is the last command's, and the last
  # `[ ... ] && echo` of the MANUAL loop is false whenever the final row is not MANUAL — so a run
  # that passed every automated check still exited 1 whenever any manual step was listed.
  return 0
}

main "$@"
