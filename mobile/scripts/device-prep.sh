#!/usr/bin/env bash
#
# device-prep.sh — idempotent, scriptable preparation and inspection of the Android
# emulator that the round-2 acceptance scenarios run on.
#
#     ./mobile/scripts/device-prep.sh <subcommand> [args]
#
#   push-sample-photos              create + push + index 4 gallery photos
#   grant-permissions               grant the app's camera + photo permissions
#   deny-permissions [soft|hard]    deny them (default: soft)
#   permission-state                print declared/granted state of each permission
#   install [apk]                   adb install -r (default: the built release APK)
#   shot <name>                     screenshot into docs/device-shots/
#   dump <name>                     UI hierarchy dump into docs/device-shots/
#   reset [--keep-data]             force-stop (+ pm clear) — cold, logged-out start
#   clear-test-user                 delete the harness test user and its items
#   help
#
# Every subcommand is safe to re-run. Nothing here assumes a rooted adbd; the
# `deny-permissions` subcommand explains the one operation that does.
#
# See mobile/docs/第二轮-设备验证手册.md for the manual steps that cannot be scripted.
#
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-env.sh"

# ---------------------------------------------------------------------------------------------
# Sample photos
# ---------------------------------------------------------------------------------------------
# Four distinguishable images, two of them deliberately awkward:
#   A/B/C        plain colour + a huge letter, big enough that client-side downscaling is
#                observable (the app must shrink these before uploading)
#   D-rotated    a JPEG with EXIF Orientation=6 (1200x1600 stored, upright at 1600x1200).
#                Device-proof for "does the pipeline rotate the photo the right way".
#                A phone-camera portrait shot carries exactly this tag.
PHOTO_SPECS=(
  "A:1600:1200:220,60,60:A"
  "B:1600:1200:60,120,220:B"
  "C:1600:1200:60,170,90:C"
  "D-rotated:1200:1600:200,140,40:D"
)

generate_photos() {
  local out_dir="$1"
  mkdir -p "$out_dir"

  local py
  py="$(harness_python)"
  [ -n "$py" ] || die "No Python with Pillow found.
  Tried: backend/.venv/bin/python, python3
  Install Pillow (pip install pillow) or create backend/.venv."

  "$py" - "$out_dir" "${PHOTO_SPECS[@]}" <<'PY'
import sys
from PIL import Image, ImageDraw, ImageFont

out_dir = sys.argv[1]
specs = sys.argv[2:]

for font_path in (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
):
    try:
        font = ImageFont.truetype(font_path, 300)
        break
    except Exception:
        font = None
else:
    font = None
if font is None:
    font = ImageFont.load_default()

for spec in specs:
    name, w, h, rgb, label = spec.split(":")
    w, h = int(w), int(h)
    colour = tuple(int(c) for c in rgb.split(","))
    img = Image.new("RGB", (w, h), colour)
    draw = ImageDraw.Draw(img)
    box = draw.textbbox((0, 0), label, font=font)
    draw.text(
        ((w - (box[2] - box[0])) / 2 - box[0], (h - (box[3] - box[1])) / 2 - box[1]),
        label,
        font=font,
        fill=(255, 255, 255),
    )
    path = f"{out_dir}/sample-{name}.jpg"
    if name.endswith("rotated"):
        # EXIF tag 0x0112 (Orientation) = 6 → "rotate 90° CW for display".
        exif = Image.Exif()
        exif[0x0112] = 6
        img.save(path, quality=92, exif=exif)
    else:
        img.save(path, quality=90)
    print(f"  generated {path} ({w}x{h})")
PY
}

# harness_python() lives in android-env.sh (shared with verify-device.sh).

# media_image_count() lives in android-env.sh (shared with verify-device.sh).

cmd_push_sample_photos() {
  require_device

  local staging="$ARTIFACTS_DIR/sample-photos"
  log "Generating sample photos in $staging"
  generate_photos "$staging"

  local before
  before="$(media_image_count)"
  log "MediaStore image rows before: $before"

  adb_shell "mkdir -p $PUBLIC_STORAGE"
  local f
  for f in "$staging"/sample-*.jpg; do
    log "Pushing $(basename "$f")"
    "$ADB" push "$f" "$PUBLIC_STORAGE/" >/dev/null
  done

  # MEDIA_SCANNER_SCAN_FILE is deprecated-but-working on this API 36 image and is the
  # operation that was actually verified: it creates the MediaStore row. Simply copying the
  # file with `adb push` does NOT make the gallery (or the PhotoPicker) see it — verified:
  # after push, `content query` still reported "No result found.".
  local name
  for f in "$staging"/sample-*.jpg; do
    name="$(basename "$f")"
    adb_shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://$PUBLIC_STORAGE/$name" \
      >/dev/null
  done
  sleep 2

  local after
  after="$(media_image_count)"
  log "MediaStore image rows after: $after (was $before)"

  # Assert PRESENCE, not an increase.
  #
  # This script must be idempotent: a re-run pushes the same four filenames, which
  # overwrite the existing rows instead of adding new ones, so the row count
  # legitimately stays unchanged. Requiring `after > before` turned a correctly
  # prepared gallery into a hard failure on every second run. What matters for the
  # scenarios is that every sample is visible in MediaStore, which is checked here.
  local indexed missing=0
  indexed="$(adb_shell "content query --uri content://media/external/images/media --projection _display_name")"

  local name
  for f in "$staging"/sample-*.jpg; do
    name="$(basename "$f")"
    if printf '%s\n' "$indexed" | has_match "$name"; then
      ok "indexed: $name"
    else
      fail "NOT indexed: $name (the gallery and PhotoPicker will not show it)"
      missing=1
    fi
  done

  if [ "$missing" -ne 0 ]; then
    fail "MediaStore is missing sample photos."
    fail "Debug with: $ADB shell content query --uri content://media/external/images/media"
    exit 1
  fi

  ok "All sample photos are in MediaStore ($after image rows total)."

  adb_shell "content query --uri content://media/external/images/media --projection _id:_display_name:_size" \
    | sed 's/^/     /'
}

# ---------------------------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------------------------
# Permission names are documented in android-env.sh next to APP_PERMISSIONS.

cmd_permission_state() {
  require_device
  printf 'permission                                       state\n'
  printf '%s\n' '-----------------------------------------------  ----------'
  local perm state
  for perm in "${APP_PERMISSIONS[@]}"; do
    state="$(app_permission_state "$perm")"
    printf '%-47s  %s\n' "$perm" "$state"
  done

  if [ "$(app_permission_state android.permission.CAMERA)" = "undeclared" ]; then
    warn "$APP_ID does not declare CAMERA — camera capture cannot work on this build."
    warn "It was built before the picker plugin was applied. Rebuild (./mobile/scripts/build-android.sh)
  and reinstall before running the camera scenarios."
  fi
}

# Grant state for a permission; skips undeclared ones with a warning instead of failing,
# because `pm grant` on an undeclared permission silently exits 0 (verified).
_grant_one() {
  local perm="$1" intent="$2"
  if ! app_declares_permission "$perm"; then
    warn "skip $perm — not declared by $APP_ID (pm grant would exit 0 and change nothing)"
    return 0
  fi
  if "$ADB" shell pm grant "$APP_ID" "$perm" >/dev/null 2>&1; then
    ok "$intent $perm -> $(app_permission_state "$perm")"
  else
    warn "$intent $perm failed; state is $(app_permission_state "$perm")"
  fi
}

# Remove the USER_FIXED flag so the next request shows a system dialog again, and so
# canAskAgain becomes true.
_clear_user_fixed() {
  local perm="$1"
  app_declares_permission "$perm" || return 0
  "$ADB" shell pm clear-permission-flags "$APP_ID" "$perm" user-fixed >/dev/null 2>&1 || true
}

cmd_grant_permissions() {
  require_device
  log "Granting camera + photo permissions to $APP_ID"
  local perm
  for perm in "${APP_PERMISSIONS[@]}"; do
    _clear_user_fixed "$perm"
    _grant_one "$perm" "granted"
  done
  cmd_permission_state
}

cmd_deny_permissions() {
  require_device
  local mode="${1:-soft}"
  case "$mode" in
    soft|hard) ;;
    *) die "deny-permissions takes 'soft' or 'hard' (got: $mode)" ;;
  esac

  log "Denying camera + photo permissions to $APP_ID (mode=$mode)"

  # pm revoke clears the grant but leaves the app able to ask again: Expo computes
  # canAskAgain from shouldShowRequestPermissionRationale, and a freshly revoked permission
  # still reports a rationale. Verified on this emulator (API 36).
  # 'hard' additionally sets the USER_FIXED flag, which is what the platform does after the
  # user picks "Don't allow" twice — the app then reports canAskAgain=false and the system
  # stops showing the dialog.
  local perm
  for perm in "${APP_PERMISSIONS[@]}"; do
    if ! app_declares_permission "$perm"; then
      warn "skip $perm — not declared by $APP_ID"
      continue
    fi
    "$ADB" shell pm revoke "$APP_ID" "$perm" >/dev/null 2>&1 || true
    if [ "$mode" = "hard" ]; then
      "$ADB" shell pm set-permission-flags "$APP_ID" "$perm" user-fixed >/dev/null 2>&1 || true
    fi
    ok "denied $perm -> $(app_permission_state "$perm")"
  done

  if [ "$mode" = "soft" ]; then
    log "soft mode: the app can still request again, so the system dialog WILL appear."
    log "To exercise the permanent-denial branch instead, run: deny-permissions hard"
  fi
  cmd_permission_state
}

# ---------------------------------------------------------------------------------------------
# Install / capture / reset
# ---------------------------------------------------------------------------------------------
default_apk() {
  printf '%s' "$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
}

cmd_install() {
  require_device
  local apk="${1:-$(default_apk)}"
  [ -f "$apk" ] || die "APK not found: $apk
  Build it first: ./mobile/scripts/build-android.sh
  Or pass a path: $0 install /path/to/app-release.apk"

  # Reinstall, not a fresh install: -r keeps the app's data (the logged-in session), which is
  # what lets us upgrade an installed build without redoing login.
  log "Installing $(basename "$apk") ($(du -h "$apk" | cut -f1))"
  "$ADB" install -r "$apk" | tail -1
  ok "Installed $(adb_shell "dumpsys package $APP_ID" | grep -m1 versionName | sed 's/^ *//')"
  if ! app_declares_permission android.permission.CAMERA; then
    warn "This build does not declare CAMERA. Camera capture will not work; rebuild before"
    warn "running the camera scenarios (see the note in build-android.sh about prebuild)."
  fi
}

cmd_shot() {
  require_device
  local name="${1:-shot}"
  mkdir -p "$ARTIFACTS_DIR"
  local out="$ARTIFACTS_DIR/${name}.png"
  # exec-out avoids the CRLF translation that `adb shell screencap -p > file` would introduce
  # and would corrupt the PNG.
  "$ADB" exec-out screencap -p > "$out"
  [ -s "$out" ] || die "screencap produced an empty file: $out"
  ok "shot -> $out"
}

# ui_dump_xml() lives in android-env.sh (shared with verify-device.sh).

cmd_dump() {
  require_device
  local name="${1:-dump}"
  mkdir -p "$ARTIFACTS_DIR"
  local xml="$ARTIFACTS_DIR/${name}.xml"
  local txt="$ARTIFACTS_DIR/${name}.txt"
  ui_dump_xml "$xml" \
    || die "uiautomator dump produced no usable XML.
  If the screen is off: $ADB shell input keyevent KEYCODE_WAKEUP"

  # One parser for both scripts, so a dump reads the same however it was produced.
  python3 "$ANDROID_ENV_DIR/ui-dump-report.py" "$xml" "$ARTIFACTS_DIR" >/dev/null
  ok "dump -> $xml"
  ok "       $txt"
  echo
  echo "  --- text nodes ---"
  sed -n '1,200p' "$txt" | sed 's/^/  /'
}

# prepare — make the emulator fit to run scenarios, idempotently.
#
# The one non-obvious step is `hide_error_dialogs`. This AVD runs without a GPU
# (hw.gpu.enabled=no), so SystemUI periodically stops responding and a "System UI isn't
# responding" dialog takes window focus. Every tap then goes to the dialog and the app looks
# frozen, which reads as a scenario failure. Verified: with the dialog up, `input tap` on the
# app produced no change at all, and only the `settings put global` flag plus clearing the
# wedged dialog restored control.
cmd_prepare() {
  require_device
  log "Preparing the emulator for the round-2 acceptance run"

  # 1. Booted
  wait_for_boot 180
  ok "device booted (API $(adb_shell getprop ro.build.version.sdk))"

  # 2. Stop system ANR/FC dialogs from stealing focus for the rest of this boot.
  adb_shell "settings put global hide_error_dialogs 1" >/dev/null
  [ "$(adb_shell settings get global hide_error_dialogs)" = "1" ] \
    && ok "hide_error_dialogs=1 (system ANR dialogs suppressed)" \
    || warn "could not set hide_error_dialogs; ANR dialogs may steal focus"

  # 3. Dismiss anything already on screen, then keep the screen awake.
  dismiss_anr_if_present
  "$ADB" shell svc power stayon true >/dev/null 2>&1 || true
  "$ADB" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  ok "screen kept awake (svc power stayon true)"

  # 4. Gallery photos indexed (a scenario without them cannot start).
  local count
  count="$(media_image_count)"
  if [ "$count" -lt 4 ]; then
    log "only $count photos indexed; pushing samples"
    cmd_push_sample_photos
  else
    ok "$count photos indexed in MediaStore"
  fi

  # 5. The app under test.
  if is_installed; then
    ok "$APP_ID installed ($(adb_shell "dumpsys package $APP_ID" | grep -m1 versionName | sed 's/^ *//'))"
  else
    warn "$APP_ID is not installed. Install it now:
      $0 install $MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
  fi

  # 6. Backend, and the address split that causes most "app can't connect" reports.
  if curl -fsS -m 5 "$BACKEND_HOST_URL/api/v1/health" >/dev/null 2>&1; then
    ok "backend healthy on the host at $BACKEND_HOST_URL"
    log "the emulator reaches it at $BACKEND_DEVICE_URL (baked into the APK at build time)"
  else
    warn "backend not reachable at $BACKEND_HOST_URL/api/v1/health
      start it with: BIND_HOST=0.0.0.0 ./scripts/dev-local.sh start"
  fi

  echo
  ok "prepare done. Next: $ANDROID_ENV_DIR/verify-device.sh"
}
cmd_reset() {
  require_device
  local keep_data=0
  [ "${1:-}" = "--keep-data" ] && keep_data=1

  log "force-stop $APP_ID"
  "$ADB" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true

  if [ "$keep_data" -eq 1 ]; then
    log "--keep-data: session and cached data preserved (simulates 'reopen the app')."
  else
    log "pm clear $APP_ID — cold start with no credentials (simulates 'fresh install')."
    adb_shell "pm clear $APP_ID" || true
  fi
  ok "reset done (app not running)"
}

# ---------------------------------------------------------------------------------------------
# Backend test user
# ---------------------------------------------------------------------------------------------
# Round-2 scenarios need a logged-in user whose wardrobe state is known. The dev login
# (POST /auth/sync) provisions one on demand; deleting it is only possible through the API.
# Must use a real TLD: `.test`/`.local` are reserved, and while /auth/sync accepts them,
# /auth/session rejects the address with 422, which logs the app out mid-run.
#
# `external_id` must be `dev:<email>` — the same value the app's dev login uses
# (`src/auth/AuthContext.tsx:213`). A mismatch makes the backend migrate the user row's
# external_id on every sync, which invalidates the app's access token (its `sub` stops
# resolving) and logs the app out mid-scenario. See the long note in run-acceptance.sh.
TEST_USER_EMAIL="${TEST_USER_EMAIL:-harness@zhiyi-harness.com}"
TEST_USER_EXTERNAL_ID="dev:${TEST_USER_EMAIL}"

cmd_clear_test_user() {
  local base="${1:-$BACKEND_HOST_URL/api/v1}"
  require_tools

  if ! curl -fsS -m 5 "$base/health" >/dev/null 2>&1; then
    die "Backend not reachable at $base/health.
  Start it with: BIND_HOST=0.0.0.0 ./scripts/dev-local.sh start"
  fi

  local token
  token="$(curl -fsS -m 10 -X POST "$base/auth/sync" \
      -H 'Content-Type: application/json' \
      -d "{\"external_id\":\"$TEST_USER_EXTERNAL_ID\",\"email\":\"$TEST_USER_EMAIL\",\"display_name\":\"设备验证脚手架\"}" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || die "Could not obtain a dev token from $base/auth/sync (is dev_mode on? see GET $base/auth/config)"

  local ids
  ids="$(curl -fsS -m 10 "$base/items?page=1&page_size=100&is_archived=true" \
      -H "Authorization: Bearer $token" \
    | tr ',' '\n' | sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | sort -u)"

  if [ -z "$ids" ]; then
    ok "Test user $TEST_USER_EMAIL has no items — nothing to clean."
    return 0
  fi

  local id count=0
  for id in $ids; do
    if curl -fsS -m 10 -o /dev/null -X DELETE "$base/items/$id" -H "Authorization: Bearer $token"; then
      count=$((count + 1))
    else
      warn "could not delete item $id"
    fi
  done
  ok "Deleted $count test item(s) for $TEST_USER_EMAIL."
  log "Note: this deletes the items, not the account — /auth/sync returns the same user next time."
}

# ---------------------------------------------------------------------------------------------
# Interaction
#
# Round-2 scenarios need to tap, type and scroll, not just observe. These wrap the adb commands
# verified on this emulator image; the fiddly parts (IME state, tapping by label rather than by a
# hardcoded coordinate, ANR dialogs stealing focus) are handled here so a scenario stays readable.
#
# tap_bounds() lives in android-env.sh, because the shared ANR helper also needs it.
# ---------------------------------------------------------------------------------------------

# tap-text <label> — tap the node whose text or content-desc is exactly <label>.
# Reads the current screen itself, so scenarios do not need a prior `dump`.
cmd_tap_text() {
  require_device
  dismiss_anr_if_present
  [ $# -ge 1 ] || die "tap-text takes a label: tap-text <label>"
  local label="$1" xml="$ARTIFACTS_DIR/.tap.xml" bounds
  mkdir -p "$ARTIFACTS_DIR"
  ui_dump_xml "$xml" || die "could not read the UI; is the screen on?"
  bounds="$(python3 "$ANDROID_ENV_DIR/ui-dump-report.py" --find "$label" "$xml" || true)"
  if [ -z "$bounds" ]; then
    die "no node with text or description '$label' on screen.
  Run '$ANDROID_ENV_DIR/device-prep.sh dump current' to see what is there."
  fi
  tap_bounds "$bounds"
  ok "tapped '$label' at $bounds"
}

# type <text> — types into the focused field, and verifies that it arrived.
#
# `adb shell input text` is NOT reliable on this emulator: it injects key events faster than the
# React Native TextInput processes them and silently drops characters. Measured: typing
# "IMMEDIATE" into the name field produced "IMMED"; typing a 21-character email address left
# the field empty. A scenario that assumed the text landed then failed much later with a
# misleading "name does not match" error, so the verification has to happen here, where the
# cause is knowable.
#
# Strategy: send the whole string (fast path), read the field back, and fall back to one
# character at a time with a small gap until the field holds the text. The readback cost is one
# UI dump per attempt, which is cheap compared to a silently wrong test run.
#
# Other traps, both verified:
#   * `input text` does not encode spaces; %s is the escape the tool accepts.
#   * The text passes through a second shell expansion inside `adb shell`, so a literal % must
#     itself be escaped first.
cmd_type() {
  require_device
  dismiss_anr_if_present
  [ $# -ge 1 ] || die "type takes at least one argument"

  local want="$*"

  # `adb shell input text` cannot inject non-ASCII AT ALL. Sending CJK makes
  # InputShellCommand.sendText throw NullPointerException and nothing is typed — no partial
  # result, no useful exit status. Fail here with the reason, instead of letting the caller
  # discover it later as a mysterious "the text I typed is not on the server".
  # (Chinese text entry needs the on-screen IME or a clipboard paste; not scriptable this way.)
  if printf '%s' "$want" | LC_ALL=C grep -q '[^ -~]'; then
    die "type: refusing non-ASCII input (adb 'input text' cannot inject it).\n  Use ASCII for scripted text, or paste Chinese by hand. Got: $want"
  fi

  # Always start from an empty field so the result is deterministic. Appending would make the
  # outcome depend on whether a previous attempt got partway through, which is exactly the kind
  # of state that turns one flaky run into a confusing failure.
  clear_focused_field

  # Fast path: send the whole string at once.
  adb_input_text "$want"
  sleep 1
  if focused_field_contains "$want"; then
    ok "typed: $want"
    return 0
  fi

  # Slow path: the bulk send dropped characters. Type one character at a time with a gap.
  warn "'input text' dropped characters; retrying one character at a time"
  clear_focused_field
  local i
  for ((i = 0; i < ${#want}; i++)); do
    adb_input_text "${want:i:1}"
  done

  if focused_field_contains "$want"; then
    ok "typed (character by character): $want"
    return 0
  fi
  warn "field does not contain the requested text after both attempts"
  return 1
}

# Send literal text through `adb shell input text`, with the escaping that tool requires:
#   * a space must become %s (input text does not encode spaces)
#   * a literal % must itself be escaped, because the value goes through a second shell expansion
adb_input_text() {
  local text="$1"
  text="${text//%/%25}"
  text="${text// /%s}"
  "$ADB" shell input text "$text" >/dev/null 2>&1
  sleep 0.15
}

# Clear the focused field.
#
# Uses a single device-side loop: 60 separate `adb shell` round-trips took ~6s and were the
# slowest part of every scenario. The device `input keyevent` accepts repeated keycodes, and
# 100 is comfortably above the 100-char field limit, so one call always empties the field.
clear_focused_field() {
  local n="${1:-100}" keys=""
  local i
  for ((i = 0; i < n; i++)); do keys+="KEYCODE_DEL "; done
  "$ADB" shell input keyevent $keys >/dev/null 2>&1 || true
  sleep 0.2
}

# True when the focused EditText's value contains $1. Reads one dump.
focused_field_contains() {
  local want="$1" xml="$ARTIFACTS_DIR/.field.xml"
  mkdir -p "$ARTIFACTS_DIR"
  ui_dump_xml "$xml" 2>/dev/null || return 1
  python3 - "$xml" "$want" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
want = sys.argv[2]
for n in root.iter("node"):
    if n.get("class") != "android.widget.EditText":
        continue
    if n.get("focused") == "true" and want in (n.get("text") or ""):
        sys.exit(0)
    # Some builds do not mark focus on the field itself but do expose it on the value.
    if want in (n.get("text") or ""):
        sys.exit(0)
sys.exit(1)
PY
}

# Dismiss the soft keyboard. ESCAPE closes the IME without also triggering back-navigation,
# which KEYCODE_BACK can do on screens that handle it themselves.
cmd_hide_keyboard() {
  require_device
  "$ADB" shell input keyevent KEYCODE_ESCAPE
  ok "soft keyboard dismissed (ESCAPE)"
}

# swipe <up|down|left|right> [ms] — scrolls from the middle of the screen.
# A longer duration reads as a drag rather than a fling, which gives a predictable distance.
cmd_swipe() {
  require_device
  dismiss_anr_if_present
  local dir="${1:-up}" ms="${2:-300}"
  local x1 y1 x2 y2
  case "$dir" in
    up)    x1=540; y1=1700; x2=540; y2=700  ;;
    down)  x1=540; y1=700;  x2=540; y2=1700 ;;
    left)  x1=900; y1=1200; x2=200; y2=1200 ;;
    right) x1=200; y1=1200; x2=900; y2=1200 ;;
    *) die "swipe direction must be up|down|left|right (got: $dir)" ;;
  esac
  "$ADB" shell input swipe "$x1" "$y1" "$x2" "$y2" "$ms"
  ok "swiped $dir"
}

# tap <x> <y> — raw coordinate tap, for when no label is unique.
cmd_tap() {
  require_device
  dismiss_anr_if_present
  [ $# -eq 2 ] || die "tap takes exactly two arguments: tap <x> <y>"
  "$ADB" shell input tap "$1" "$2"
  ok "tapped $1,$2"
}

# ---------------------------------------------------------------------------------------------
usage() {
  cat <<EOF
device-prep.sh — Android emulator preparation and interaction for the 知衣 round-2 run

Usage: ./mobile/scripts/device-prep.sh <subcommand> [args]

Preparation:
  prepare                     Make the emulator fit to run scenarios (idempotent): boot,
                              suppress ANR dialogs, push+index sample photos, check the
                              app and the backend. Start here.
  push-sample-photos          Create + push + MediaStore-index 4 gallery photos
                              (A/B/C plus D-rotated, an EXIF Orientation=6 JPEG)
  install [apk]               adb install -r (default: $MOBILE_DIR/android/.../app-release.apk)
  reset [--keep-data]         force-stop (+ pm clear) for a cold start

Permissions:
  grant-permissions           Grant CAMERA + photo permissions to $APP_ID
  deny-permissions [soft|hard]  Revoke them. hard also sets USER_FIXED so the app
                              reports canAskAgain=false (permanent denial).
  permission-state            Print declared/granted state of each permission
  clear-test-user             Delete the harness test user's items via the API

Observation:
  shot <name>                 Screenshot -> $ARTIFACTS_DIR/<name>.png
  dump <name>                 UI hierarchy -> <name>.xml + readable <name>.txt

Interaction:
  tap <x> <y>                 Raw coordinate tap
  tap-text <label>            Tap the node whose text/description is <label>
  type <text>                 Type into the focused field
  hide-keyboard               Dismiss the soft keyboard (ESCAPE)
  swipe <up|down|left|right> [ms]   Scroll the screen

  help

Environment (all optional): DEV_ROOT AVD_NAME APP_ID PUBLIC_STORAGE
                            BACKEND_HOST_PORT BACKEND_DEVICE_HOST ARTIFACTS_DIR
EOF
}

main() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    push-sample-photos) cmd_push_sample_photos "$@" ;;
    grant-permissions)  cmd_grant_permissions "$@" ;;
    deny-permissions)   cmd_deny_permissions "$@" ;;
    permission-state)   cmd_permission_state "$@" ;;
    install)            cmd_install "$@" ;;
    shot)               cmd_shot "$@" ;;
    dump)               cmd_dump "$@" ;;
    reset)              cmd_reset "$@" ;;
    clear-test-user)    cmd_clear_test_user "$@" ;;
    prepare)            cmd_prepare "$@" ;;
    tap)                cmd_tap "$@" ;;
    tap-text)           cmd_tap_text "$@" ;;
    type)               cmd_type "$@" ;;
    hide-keyboard)      cmd_hide_keyboard "$@" ;;
    swipe)              cmd_swipe "$@" ;;
    help|-h|--help)     usage ;;
    *) usage; die "Unknown subcommand: $cmd" ;;
  esac
}

# Dispatch under the device lock so two overlapping harness runs cannot interleave their taps
# on the one shared emulator (see with_device_lock in android-env.sh).
# Help needs no device, so it stays outside the lock and works with no emulator attached.
main_locked() {
  local cmd="${1:-help}"
  case "$cmd" in
    help|-h|--help) usage ;;
    *) with_device_lock main "$@" ;;
  esac
}

main_locked "$@"
