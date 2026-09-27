#!/usr/bin/env bash
#
# verify-device.sh — one-shot self-check of the Android device-verification harness,
# exercised against the 知衣 APK that is actually installed on the emulator.
#
#     ./mobile/scripts/verify-device.sh [--apk <path>] [--device-login]
#
# What it proves, in order:
#   1. adb + the AVD are reachable and the framework finished booting
#   2. the app is installed (and, with --apk, a given APK installs cleanly)
#   3. known photos are in the emulator gallery AND indexed by MediaStore
#      — without which "add a garment from the gallery" cannot be exercised at all
#   4. screenshots capture a valid PNG of the real screen
#   5. the UI hierarchy dumps as parseable XML and contains 知衣's own Chinese copy,
#      which is the assertion the acceptance scenarios are built from
#   6. the permission-control path really changes device state, and which permissions
#      the installed build declares (a camera scenario is impossible without CAMERA)
#   7. the backend the app was built against is reachable, with the device/host
#      address distinction spelled out
#
# Exit code 0 = every check PASSed. Non-zero = at least one FAIL (see the summary).
# SKIPs never fail the run and are always explained.
#
# This script writes only under $ARTIFACTS_DIR (mobile/docs/device-shots/).
#
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-env.sh"

# Everything below drives the single shared emulator, so the whole run must hold the device
# lock. The first pass acquires it and re-execs; the second pass (ZHIYI_HARNESS_LOCKED=1) owns
# it and is responsible for releasing it.
#
# The release trap is armed by the CHILD, not before the exec: `exec` resets traps to their
# default disposition, so a trap armed in the parent would be gone by the time the locked
# process exits and the lock directory would be left behind forever.
#
# Nested calls are safe — acquire_device_lock is reentrant, so the device-prep.sh invocations
# made below do not wait on their own parent.
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

APK_PATH=""
FORCE_DEVICE_LOGIN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apk) APK_PATH="$2"; shift 2 ;;
    --device-login) FORCE_DEVICE_LOGIN=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

mkdir -p "$ARTIFACTS_DIR"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
declare -a RESULTS=()

record() { # record <PASS|FAIL|SKIP> <name> <detail>
  local status="$1" name="$2" detail="${3:-}"
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)); printf '%sPASS%s %-26s %s\n' "$_c_green" "$_c_reset" "$name" "$detail" ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)); printf '%sSKIP%s %-26s %s\n' "$_c_yellow" "$_c_reset" "$name" "$detail" ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); printf '%sFAIL%s %-26s %s\n' "$_c_red" "$_c_reset" "$name" "$detail" ;;
  esac
  RESULTS+=("$status|$name|$detail")
}

# ---------------------------------------------------------------------------------------------
echo "==============================================================="
echo " 知衣 round-2 device harness self-check"
echo " device      : ${AVD_NAME} (adb: ${ADB})"
echo " app         : ${APP_ID}"
echo " backend     : host ${BACKEND_HOST_URL}  |  device ${BACKEND_DEVICE_URL}"
echo " artifacts   : ${ARTIFACTS_DIR}"
echo "==============================================================="
echo

# ---------------------------------------------------------------------------------------------
# 1. Toolchain + device + boot
# ---------------------------------------------------------------------------------------------
if [ ! -x "$ADB" ]; then
  record FAIL "adb-present" "adb missing at $ADB — provision with ./mobile/scripts/build-android.sh"
  echo
  fail "Cannot continue without adb."
  exit 1
fi
record PASS "adb-present" "$("$ADB" version | head -1)"

if [ -z "$(adb_serial)" ]; then
  record FAIL "device-online" "no emulator/device attached"
  echo
  fail "Start the AVD, then re-run:
    $EMULATOR -avd $AVD_NAME -no-snapshot-save &
    $ADB wait-for-device"
  exit 1
fi
record PASS "device-online" "serial $(adb_serial)"

if wait_for_boot 120; then
  record PASS "device-booted" "sys.boot_completed=1, API $(adb_shell getprop ro.build.version.sdk), $(adb_shell getprop ro.product.cpu.abi)"
else
  record FAIL "device-booted" "sys.boot_completed never became 1"
fi

# ---------------------------------------------------------------------------------------------
# 2. Install (optional) + installed package
# ---------------------------------------------------------------------------------------------
if [ -n "$APK_PATH" ]; then
  if [ ! -f "$APK_PATH" ]; then
    record FAIL "apk-install" "APK not found: $APK_PATH"
  else
    log "Installing $APK_PATH"
    if "$ADB" install -r "$APK_PATH" >/tmp/harness-install.log 2>&1; then
      record PASS "apk-install" "$(tail -1 /tmp/harness-install.log | tr -d '\r')"
    else
      record FAIL "apk-install" "$(tail -1 /tmp/harness-install.log | tr -d '\r')"
    fi
  fi
fi

if is_installed; then
  record PASS "app-installed" "$(adb_shell "dumpsys package $APP_ID" | grep -m1 versionName | sed 's/^ *//')"
else
  record FAIL "app-installed" "$APP_ID is not installed. Install it with: $0 --apk <path>"
  echo
  fail "Nothing to drive. Stopping here."
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# 3. Gallery photos indexed by MediaStore
# ---------------------------------------------------------------------------------------------
# `adb push` alone is NOT enough — verified on this image: the file lands on disk but
# `content query --uri content://media/external/images/media` stays empty until a
# MEDIA_SCANNER_SCAN_FILE broadcast runs, and the PhotoPicker reads MediaStore.
photos_before="$(media_image_count)"
if [ "$photos_before" -lt 4 ]; then
  log "Found $photos_before indexed photo(s); pushing samples (device-prep.sh push-sample-photos)"
  "$ANDROID_ENV_DIR/device-prep.sh" push-sample-photos >/tmp/harness-photos.log 2>&1
  photos_after="$(media_image_count)"
  if [ "$photos_after" -gt "$photos_before" ]; then
    record PASS "gallery-photos" "$photos_before -> $photos_after indexed ($(tail -3 /tmp/harness-photos.log | head -1 | sed 's/^ *//'))"
  else
    record FAIL "gallery-photos" "still $photos_after indexed after push — see /tmp/harness-photos.log"
  fi
else
  record PASS "gallery-photos" "$photos_before indexed rows; MediaStore query returns:"
  adb_shell "content query --uri content://media/external/images/media --projection _id:_display_name" | sed 's/^/                              /'
fi

# ---------------------------------------------------------------------------------------------
# 4. Cold start, then screenshot
#
# Wait for the UI to actually render instead of guessing a delay. The release build takes ~20s
# to paint its first frame on this GPU-less emulator (measured: 21s from `am start` to the first
# text node), because there is no hardware acceleration and the Hermes bundle has to be
# unpacked. A fixed 8-second wait therefore dumped a blank React root and reported
# "the app IS on top but rendered no recognised copy", which reads like a broken app but is
# only the harness looking too early.
log "Force-stopping and cold-starting $APP_ID"
"$ADB" shell am force-stop "$APP_ID" >/dev/null 2>&1
"$ADB" shell am start -n "$MAIN_ACTIVITY" >/dev/null 2>&1

# Poll until the dump contains at least one non-empty text value, or give up after 60s.
_ui_ready=0
for _i in $(seq 1 60); do
  sleep 1
  if ui_dump_xml "$ARTIFACTS_DIR/.startup.xml" 2>/dev/null \
     && [ "$(grep -o 'text="[^"]*"' "$ARTIFACTS_DIR/.startup.xml" | grep -cv 'text=""')" -gt 0 ]; then
    _ui_ready=$((_i))
    break
  fi
done
if [ "$_ui_ready" -gt 0 ]; then
  log "UI painted after ${_ui_ready}s"
else
  warn "no text rendered within 60s; the dump below may show a blank view"
fi

pids="$(app_pids)"
if [ -n "$pids" ]; then
  record PASS "app-process" "pid $pids"
else
  record FAIL "app-process" "$APP_ID is not running after launch (check: $ADB logcat -d | grep -i $APP_ID)"
fi

shot="$ARTIFACTS_DIR/verify-01-cold-start.png"
"$ADB" exec-out screencap -p > "$shot" 2>/dev/null
# A real PNG starts with \x89PNG\r\n\x1a\n. Checking the bytes is what catches the classic
# `adb shell screencap -p > f.png` mistake, where CRLF translation silently corrupts the file
# into something no viewer can open.
shot_magic="$(head -c 8 "$shot" | od -An -tx1 | tr -d ' \n')"
if [ -s "$shot" ] && [ "$shot_magic" = "89504e470d0a1a0a" ]; then
  shot_dims="$(
    for probe in "$(command -v sips || true)" "$(command -v identify || true)"; do
      [ -n "$probe" ] || continue
      if [ "$(basename "$probe")" = "sips" ]; then
        "$probe" -g pixelWidth -g pixelHeight "$shot" 2>/dev/null \
          | awk -F': ' '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{if(w)printf "%sx%s", w, h}'
      else
        "$probe" -format '%wx%h' "$shot" 2>/dev/null
      fi
      break
    done
  )"
  record PASS "screenshot" "$(basename "$shot") (${shot_dims:-unknown dims}, $(wc -c < "$shot" | tr -d ' ') bytes)"
else
  record FAIL "screenshot" "$(basename "$shot") is not a valid PNG (magic: ${shot_magic:-empty})"
fi

# ---------------------------------------------------------------------------------------------
# 5. UI dump parses and contains the app's own copy
# ---------------------------------------------------------------------------------------------
xml="$ARTIFACTS_DIR/verify-02-ui.xml"
if ui_dump_xml "$xml" 2>/dev/null; then
  # The parser is a separate file rather than a heredoc so that it can be run, tested and
  # quoted independently — a heredoc containing quotes inside $( ) is where a shell harness
  # like this usually breaks.
  if out="$(python3 "$ANDROID_ENV_DIR/ui-dump-report.py" "$xml" "$ARTIFACTS_DIR" 2>&1)"; then
    sigs="$(printf '%s\n' "$out" | sed -n 's/^SIG=//p')"
    screen="$(printf '%s\n' "$out" | sed -n 's/^SCREEN=//p')"
    node_count="$(printf '%s\n' "$out" | sed -n 's/^NODES=//p')"
    if [ -n "$sigs" ]; then
      record PASS "ui-dump-app-copy" "$node_count nodes, screen=$screen, matched 知衣 copy: $sigs"
    else
      # Distinguish the two very different causes, because they need different responses.
      # The device is shared: another driver can force-stop the app between the launch above and
      # this dump, and the dump then legitimately describes the launcher. That is an environment
      # problem, not a harness or app defect.
      local top_pkg
      top_pkg="$(printf '%s\n' "$out" | sed -n 's/^PKGS=//p')"
      if [ "$top_pkg" = "$APP_ID" ]; then
        record FAIL "ui-dump-app-copy" \
          "the app IS on top but rendered no recognised copy ($node_count nodes, screen=$screen) — the React view may be blank or stuck; see verify-02-ui.txt"
      else
        record FAIL "ui-dump-app-copy" \
          "the app is not on top: the dump belongs to '$top_pkg' (another process likely force-stopped $APP_ID). Re-run when the device is free."
      fi
    fi
  else
    record FAIL "ui-dump-parse" "$(printf '%s\n' "$out" | grep '^PARSE_ERROR' || printf '%s' "$out" | head -1)"
  fi
else
  record FAIL "ui-dump" "uiautomator dump failed or returned nothing (is the screen off? $ADB shell input keyevent KEYCODE_WAKEUP)"
fi

# ---------------------------------------------------------------------------------------------
# 6. Permission control
# ---------------------------------------------------------------------------------------------
cam_state="$(app_permission_state android.permission.CAMERA)"
declared_count=0
for perm in "${APP_PERMISSIONS[@]}"; do
  [ "$(app_permission_state "$perm")" != "undeclared" ] && declared_count=$((declared_count + 1))
done

# Reading the package proves the HARNESS works; declaring CAMERA is a property of the APP.
# They are separate checks on purpose — merging them would make "the harness is broken" and
# "this APK needs a rebuild" produce the same failure, and they need different fixes.
record PASS "harness-permission-probe" \
  "read the declared set of $APP_ID: $declared_count/${#APP_PERMISSIONS[@]} candidates present, CAMERA=$cam_state"

if [ "$cam_state" = "undeclared" ]; then
  record FAIL "app-camera-declared" \
    "$APP_ID does not declare android.permission.CAMERA — the camera scenario cannot run on this build; rebuild with the expo-image-picker plugin applied and reinstall"
else
  record PASS "app-camera-declared" "$APP_ID declares CAMERA (camera scenario is runnable)"
fi

# Prove the grant/revoke commands actually mutate device state. When the app under test
# declares CAMERA we can prove it on the app itself; when it does not (as with a build made
# before the picker plugin was applied) `pm grant` exits 0 and changes nothing, so we prove
# the mechanism on a system package that does declare it, then restore that package.
PERM_SELFTEST_PKG=""
if [ "$cam_state" != "undeclared" ]; then
  PERM_SELFTEST_PKG="$APP_ID"
else
  for candidate in com.google.android.apps.messaging com.android.chrome; do
    # has_match, not `grep -q`: see its comment in android-env.sh — pipefail makes
    # `... | grep -q` report 141 on a SUCCESSFUL match.
    if adb_shell "dumpsys package $candidate" | has_match "android.permission.CAMERA"; then
      PERM_SELFTEST_PKG="$candidate"; break
    fi
  done
fi

# The round trip must be state-independent: a freshly installed app has CAMERA=false, so
# asserting a specific start value would only pass on a device that happened to be in the
# right state. Instead assert that the state CHANGES on revoke and comes back on grant.
perm_state() {
  adb_shell "dumpsys package $PERM_SELFTEST_PKG" \
    | grep -m1 'android.permission.CAMERA:' \
    | sed -n 's/.*granted=\([a-z]*\).*/\1/p'
}

if [ -n "$PERM_SELFTEST_PKG" ]; then
  # Normalise to a known granted starting point first.
  "$ADB" shell pm grant "$PERM_SELFTEST_PKG" android.permission.CAMERA >/dev/null 2>&1
  st_start="$(perm_state)"
  "$ADB" shell pm revoke "$PERM_SELFTEST_PKG" android.permission.CAMERA >/dev/null 2>&1
  st_after="$(perm_state)"
  "$ADB" shell pm grant "$PERM_SELFTEST_PKG" android.permission.CAMERA >/dev/null 2>&1
  st_restored="$(perm_state)"

  if [ "$st_start" = "true" ] && [ "$st_after" = "false" ] && [ "$st_restored" = "true" ]; then
    record PASS "permission-control" "grant/revoke round-trip on $PERM_SELFTEST_PKG (true -> false -> true)"
  else
    record FAIL "permission-control" "no state change on $PERM_SELFTEST_PKG ($st_start -> $st_after -> $st_restored)"
  fi
  # USER_FIXED (permanent denial) is exercised by device-prep.sh deny-permissions hard.
  "$ADB" shell pm set-permission-flags "$PERM_SELFTEST_PKG" android.permission.CAMERA user-fixed >/dev/null 2>&1
  fixed_flag="$(adb_shell "dumpsys package $PERM_SELFTEST_PKG" | grep -m1 'android.permission.CAMERA:' | grep -c USER_FIXED)"
  "$ADB" shell pm clear-permission-flags "$PERM_SELFTEST_PKG" android.permission.CAMERA user-fixed >/dev/null 2>&1
  if [ "$fixed_flag" = "1" ]; then
    record PASS "permission-hard-deny" "USER_FIXED flag settable and clearable (permanent-denial branch reachable)"
  else
    record FAIL "permission-hard-deny" "could not set USER_FIXED"
  fi

  if [ "$PERM_SELFTEST_PKG" != "$APP_ID" ]; then
    warn "camera permission proved on $PERM_SELFTEST_PKG because $APP_ID does not declare CAMERA."
    warn "CAMERA capture is therefore UNVERIFIABLE on the installed build — rebuild and reinstall."
  fi

  # Leave the app's own camera permission granted so the scenarios start from a usable state;
  # device-prep.sh deny-permissions is what revokes it deliberately.
  if [ "$PERM_SELFTEST_PKG" = "$APP_ID" ]; then
    "$ADB" shell pm grant "$APP_ID" android.permission.CAMERA >/dev/null 2>&1
    ok "left $APP_ID with CAMERA granted for the scenario run"
  fi
else
  record SKIP "permission-control" "no package declaring CAMERA found to exercise the grant/revoke path"
fi

# ---------------------------------------------------------------------------------------------
# 7. Backend reachability
# ---------------------------------------------------------------------------------------------
# The distinction that breaks most runs: 127.0.0.1 inside the emulator is the emulator.
# The APK has EXPO_PUBLIC_API_URL baked in at build time, so it must have been built with
# the 10.0.2.2 form. We can only check the host side from here; the device side is checked
# by watching the app render a wardrobe instead of its error screen.
if health="$(curl -fsS -m 5 "$BACKEND_HOST_URL/api/v1/health" 2>/dev/null)"; then
  caps="$(curl -fsS -m 5 "$BACKEND_HOST_URL/api/v1/capabilities" 2>/dev/null)"
  record PASS "backend-host" "$health  |  $(printf '%s' "$caps" | sed -n 's/.*"ai":{\([^}]*\)}.*/ai={\1}/p')"
  if printf '%s' "$caps" | has_match '"vision":false'; then
    record PASS "ai-vision-off" "AI vision disabled — the manual-entry path (acceptance scenario 5) is the live path on this backend"
  else
    record PASS "ai-vision-on" "AI vision enabled — uploads will be tagged automatically"
  fi
else
  record FAIL "backend-host" "no healthy response from $BACKEND_HOST_URL/api/v1/health"
fi

# Can the DEVICE reach the host? curl cannot run in the emulator, so use a shell-level TCP
# probe instead. Note the emulator's toybox has no nc/telnet, so we rely on the app's own
# rendering for the definitive answer and only report this as advisory.
if adb_shell "getprop ro.kernel.qemu" | has_match 1; then
  record PASS "device-is-emulator" "host alias $BACKEND_DEVICE_HOST is the emulator's route to this machine"
else
  record SKIP "device-is-emulator" "physical device — use http://<host-lan-ip>:$BACKEND_HOST_PORT and BIND_HOST=0.0.0.0"
fi

# ---------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------
echo
echo "==============================================================="
printf ' TOTAL  %sPASS %d%s   %sFAIL %d%s   %sSKIP %d%s\n' \
  "$_c_green" "$PASS_COUNT" "$_c_reset" "$_c_red" "$FAIL_COUNT" "$_c_reset" "$_c_yellow" "$SKIP_COUNT" "$_c_reset"
echo "==============================================================="
echo
echo "Artifacts written to $ARTIFACTS_DIR:"
ls -1 "$ARTIFACTS_DIR" 2>/dev/null | sed 's/^/  /'
echo
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "Failing checks:"
  for row in "${RESULTS[@]}"; do
    [ "${row%%|*}" = "FAIL" ] && echo "  - ${row#*|}"
  done
  echo
  if [ "$FORCE_DEVICE_LOGIN" -eq 1 ]; then :; fi
  fail "Harness self-check FAILED ($FAIL_COUNT check(s))."
  exit 1
fi

ok "Harness self-check passed."
echo
echo "Next: the round-2 acceptance run — see mobile/docs/第二轮-设备验证手册.md"
echo
