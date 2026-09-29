#!/usr/bin/env bash
#
# android-env.sh — shared environment for the Android device-verification harness.
#
# SOURCE this file, do not execute it:
#
#     source "$(dirname "$0")/android-env.sh"
#
# It resolves and exports:
#   ANDROID_HOME / ANDROID_SDK_ROOT   the provisioned SDK
#   JAVA_HOME                          the JDK AGP accepts (17–21, JDK 25 will fail)
#   PATH                               JAVA_HOME/bin + platform-tools + emulator
#   ADB / EMULATOR / AVD_NAME / APP_ID where everything lives
#   BACKEND_HOST_PORT / BACKEND_DEVICE_URL / API_URL
#
# and defines log/warn/die/adb_shell/require_device so every script fails loudly
# and identically instead of silently doing nothing.
#
# NOTE: this machine has no global `java` and no ANDROID_HOME in the ambient
# environment. Everything lives under DEV_ROOT (default /tmp/zhiyi-android),
# exactly as mobile/scripts/build-android.sh provisions it. Override DEV_ROOT to
# point at a different toolchain.
#
set -o pipefail

# ---------------------------------------------------------------------------------------------
# 1. Locate the repository
# ---------------------------------------------------------------------------------------------
# Resolve our own directory without relying on $0 being a real path (works when sourced).
_android_env_self="${BASH_SOURCE[0]:-$0}"
ANDROID_ENV_DIR="$(cd "$(dirname "$_android_env_self")" && pwd)"
MOBILE_DIR="$(cd "$ANDROID_ENV_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/.." && pwd)"
export ANDROID_ENV_DIR MOBILE_DIR REPO_ROOT

# ---------------------------------------------------------------------------------------------
# 2. Toolchain
# ---------------------------------------------------------------------------------------------
DEV_ROOT="${DEV_ROOT:-/tmp/zhiyi-android}"
export DEV_ROOT

# Pick the JDK: prefer the JDK 17 that build-android.sh may also have unpacked, then 21.
_pick_jdk() {
  local candidate
  for candidate in \
    "$DEV_ROOT/jdk-21.0.12.1+1/Contents/Home" \
    "$DEV_ROOT/jdk-17.0.13+11/Contents/Home" \
    "$DEV_ROOT"/jdk-1*/Contents/Home \
    "$DEV_ROOT"/jdk*/Contents/Home; do
    if [ -x "$candidate/bin/java" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

JAVA_HOME="$(_pick_jdk || true)"
[ -n "$JAVA_HOME" ] || JAVA_HOME="${JAVA_HOME:-}"
export JAVA_HOME

ANDROID_HOME="${ANDROID_HOME:-$DEV_ROOT/sdk}"
ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_HOME ANDROID_SDK_ROOT

# Only prepend the JDK when it actually exists — otherwise we would shadow a working
# system java with a dangling path.
if [ -n "$JAVA_HOME" ] && [ -d "$JAVA_HOME/bin" ]; then
  PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
else
  PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
fi
export PATH

ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
export ADB EMULATOR SDKMANAGER

AVD_NAME="${AVD_NAME:-zhiyi-test}"
APP_ID="${APP_ID:-com.zhiyi.wardrobe}"
MAIN_ACTIVITY="${MAIN_ACTIVITY:-$APP_ID/.MainActivity}"
PUBLIC_STORAGE="${PUBLIC_STORAGE:-/sdcard/Pictures/zhiyi}"
export AVD_NAME APP_ID MAIN_ACTIVITY PUBLIC_STORAGE

# ---------------------------------------------------------------------------------------------
# 3. Backend address
# ---------------------------------------------------------------------------------------------
# The emulator reaches the host through the fixed alias 10.0.2.2; 127.0.0.1 inside the
# emulator is the emulator itself. EXPO_PUBLIC_API_URL is baked in at build time, so this
# value must match what the installed APK was built with (see build-android.sh).
BACKEND_HOST_PORT="${BACKEND_HOST_PORT:-8000}"
BACKEND_DEVICE_HOST="${BACKEND_DEVICE_HOST:-10.0.2.2}"
BACKEND_DEVICE_URL="http://${BACKEND_DEVICE_HOST}:${BACKEND_HOST_PORT}"
BACKEND_HOST_URL="http://127.0.0.1:${BACKEND_HOST_PORT}"
API_URL="${API_URL:-$BACKEND_DEVICE_URL}"
BACKEND_BIND_HOST="${BACKEND_BIND_HOST:-0.0.0.0}"
export BACKEND_HOST_PORT BACKEND_DEVICE_HOST BACKEND_DEVICE_URL BACKEND_HOST_URL API_URL BACKEND_BIND_HOST

# Artifact directory for screenshots/UI dumps produced by the harness.
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$MOBILE_DIR/docs/device-shots}"
export ARTIFACTS_DIR


# Where the backend keeps garment images.
#
# Read from `backend/.env` — the same file the API loads — rather than hard-coded, so a scenario
# that has to make an image unreadable (the round-3 image-failure check) points at the real
# directory. Falls back to the scratch root if that file is missing.
STORAGE_ROOT="${STORAGE_ROOT:-$(sed -n 's/^STORAGE_PATH=//p' "$REPO_ROOT/backend/.env" 2>/dev/null | head -1)}"
[ -n "$STORAGE_ROOT" ] || STORAGE_ROOT="$DEV_ROOT/storage"
export STORAGE_ROOT
# ---------------------------------------------------------------------------------------------
# 4. Logging
# ---------------------------------------------------------------------------------------------
if [ -t 1 ]; then
  _c_blue=$'\033[1;34m'; _c_green=$'\033[1;32m'; _c_yellow=$'\033[1;33m'
  _c_red=$'\033[1;31m'; _c_reset=$'\033[0m'
else
  _c_blue=''; _c_green=''; _c_yellow=''; _c_red=''; _c_reset=''
fi

log()  { printf '%s==>%s %s\n' "$_c_blue" "$_c_reset" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$_c_green" "$_c_reset" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$_c_yellow" "$_c_reset" "$*" >&2; }
fail() { printf '%s[fail]%s %s\n' "$_c_red" "$_c_reset" "$*" >&2; }
die()  { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------------------------
# 5. Guards, locking and helpers
# ---------------------------------------------------------------------------------------------

# Exclusive access to the emulator.
#
# The AVD is a single shared resource: there is one device, one foreground app and one input
# queue. Two sessions driving it at once interleave their taps (observed: a form the harness
# had just opened came back scrolled with another run's text already typed into it), which
# produces failures that look like app bugs. Any scenario batch should therefore hold this
# lock. It is advisory — it only protects runs that use these scripts — but that covers the
# realistic case of two harness invocations overlapping.
HARNESS_LOCK_FILE="${HARNESS_LOCK_FILE:-/tmp/zhiyi-device-harness.lock}"
export HARNESS_LOCK_FILE

# Acquire the device lock, blocking until it is free. mkdir is the atomic primitive (there is
# no flock on macOS bash 3.2).
#
# REENTRANT within a process tree. The harness scripts legitimately nest: run-acceptance.sh
# holds the lock and then calls device-prep.sh for every tap and dump. Without this a child
# would wait forever on its own parent — which is exactly what happened before it was fixed
# (run-acceptance.sh wedged for 6 minutes inside `device-prep.sh deny-permissions`). The
# exported ZHIYI_LOCK_DEPTH marks the process tree as already holding the lock, and children
# inherit it.
#
# Stale locks are reclaimed automatically. A run killed mid-flight cannot run its EXIT trap, so
# without this the lock directory would survive and block every later run forever. The holder
# writes its pid, so liveness is checkable.
acquire_device_lock() {
  # Someone up the process tree already holds it.
  if [ -n "${ZHIYI_LOCK_DEPTH:-}" ]; then
    export ZHIYI_LOCK_DEPTH=$((ZHIYI_LOCK_DEPTH + 1))
    return 0
  fi

  local timeout="${DEVICE_LOCK_TIMEOUT:-900}" waited=0 holder
  while ! mkdir "$HARNESS_LOCK_FILE" 2>/dev/null; do
    holder="$(cat "$HARNESS_LOCK_FILE/pid" 2>/dev/null || echo '')"

    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      warn "reclaiming stale device lock left by pid $holder (no longer running)"
      rm -rf "$HARNESS_LOCK_FILE"
      continue
    fi

    if [ "$waited" -ge "$timeout" ]; then
      die "another harness run (pid ${holder:-unknown}) has held the device lock for ${timeout}s.
  Remove it if that run is gone: rm -rf $HARNESS_LOCK_FILE"
    fi
    [ "$waited" -eq 0 ] && warn "waiting for the device lock (held by pid ${holder:-unknown})..."
    sleep 2; waited=$((waited + 2))
  done
  printf '%s' "$$" > "$HARNESS_LOCK_FILE/pid"
  export ZHIYI_LOCK_DEPTH=1
}

# Run a command while holding the device lock.
with_device_lock() {
  acquire_device_lock
  # shellcheck disable=SC2064
  trap "release_device_lock" EXIT INT TERM
  "$@"
  local status=$?
  release_device_lock
  trap - EXIT INT TERM
  return $status
}

# Release the lock. Only the process that created it removes the directory; a nested holder
# just drops its depth counter, so an inner command returning cannot unlock the outer run.
release_device_lock() {
  if [ -n "${ZHIYI_LOCK_DEPTH:-}" ] && [ "$ZHIYI_LOCK_DEPTH" -gt 1 ]; then
    export ZHIYI_LOCK_DEPTH=$((ZHIYI_LOCK_DEPTH - 1))
    return 0
  fi
  unset ZHIYI_LOCK_DEPTH
  rm -rf "$HARNESS_LOCK_FILE" 2>/dev/null || true
}

# Fails with an actionable message rather than letting adb print "no devices".
require_tools() {
  [ -x "$ADB" ] || die "adb not found at $ADB
  Provision the toolchain with: ./mobile/scripts/build-android.sh
  Or point DEV_ROOT at an existing one: DEV_ROOT=/path/to/toolchain source mobile/scripts/android-env.sh"
  [ -x "$EMULATOR" ] || warn "emulator binary not found at $EMULATOR (only needed to start an AVD)"
  [ -x "$JAVA_HOME/bin/java" ] || warn "no JDK at JAVA_HOME='$JAVA_HOME' (only needed to build, not to drive a device)"
}

# Serial of the one attached device, or empty.
adb_serial() {
  "$ADB" devices | awk '/^emulator-|^[0-9.]+:[0-9]+/{print $1; exit}'
}

# Fails with the exact command needed to start the AVD.
require_device() {
  require_tools
  local serial
  serial="$(adb_serial)"
  if [ -z "$serial" ]; then
    die "No emulator/device attached.
  Start the AVD with:
      $EMULATOR -avd $AVD_NAME -no-snapshot-save &
  then wait for boot:
      $ADB wait-for-device
      until [ \"\$($ADB shell getprop sys.boot_completed | tr -d '\\r')\" = 1 ]; do sleep 2; done"
  fi
  ADB_SERIAL="$serial"
  export ADB_SERIAL
}

# Boot completion of the attached device: "1" when the framework is up.
device_boot_completed() {
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]
}

# Wait until the framework reports boot_completed. $1 = timeout seconds (default 180).
wait_for_boot() {
  local timeout="${1:-180}" waited=0
  while ! device_boot_completed; do
    if [ "$waited" -ge "$timeout" ]; then
      die "Device did not finish booting within ${timeout}s."
    fi
    sleep 2; waited=$((waited + 2))
  done
}

# adb shell with CRLF stripped — every value we compare in this harness goes through it.
adb_shell() {
  "$ADB" shell "$@" 2>/dev/null | tr -d '\r'
}

# Test whether a command's output contains a pattern, with pipefail in mind.
#
# Using `cmd | grep -q pat` is WRONG under `set -o pipefail`: grep exits at the first match,
# the upstream process dies of SIGPIPE, and the pipeline reports 141 — so a successful match
# looks like a failure. That silently disabled app_declares_permission and every check built
# on it. `grep -c` reads all input, so it returns a truthful 0/1 and no SIGPIPE occurs.
has_match() {
  local pattern="$1"
  grep -c -- "$pattern" >/dev/null
}

# True when the installed app declares a runtime permission. ADB cannot grant a permission
# the app never declared, so this check precedes every grant attempt — otherwise the failure
# is silent (see mobile/docs/第二轮-设备验证手册.md, pitfall "pm grant exits 0 on undeclared perms").
app_declares_permission() {
  local perm="$1"
  adb_shell "dumpsys package $APP_ID" \
    | sed -n '/requested permissions:/,/install permissions:/p' \
    | has_match "$perm"
}

# Current grant state of a runtime permission as reported by the package manager.
# Prints "true" / "false" / "undeclared".
app_permission_state() {
  local perm="$1"
  if ! app_declares_permission "$perm"; then
    printf 'undeclared'
    return 0
  fi
  local granted
  granted="$(adb_shell "dumpsys package $APP_ID" \
    | grep -m1 "  $perm:" \
    | sed -n 's/.*granted=\([a-z]*\).*/\1/p')"
  printf '%s' "${granted:-unknown}"
}

# has_match rather than `grep -qx`: the exact-match test currently survives pipefail only because
# the wanted line happens to be last, and `pm list packages` output order is not guaranteed.
is_installed() {
  adb_shell pm list packages | has_match "^package:$APP_ID$"
}

# PIDs of the running app, space separated; empty when not running.
app_pids() {
  adb_shell "pidof $APP_ID"
}

# Tap the centre of a node's bounds. Bounds look like "[x1,y1][x2,y2]".
#
# The separator between the two pairs is "][". Deleting non-digits without converting it
# first merges x2 into y1: "[76,1238][1004,1358]" yields 12381004 for one field and leaves y2
# empty, so the tap silently targets nothing. Replace the separator, then filter.
# (bash substitution, not `sed 's/][/,/'` — BSD sed rejects the unescaped bracket.)
tap_bounds() {
  local bounds="$1"
  local nums x1 y1 x2 y2
  nums="$(printf '%s' "${bounds//][/,}" | tr -dc '0-9,' | tr ',' '\n')"
  x1="$(printf '%s\n' "$nums" | sed -n 1p)"
  y1="$(printf '%s\n' "$nums" | sed -n 2p)"
  x2="$(printf '%s\n' "$nums" | sed -n 3p)"
  y2="$(printf '%s\n' "$nums" | sed -n 4p)"
  if [ -z "$x1" ] || [ -z "$y1" ] || [ -z "$x2" ] || [ -z "$y2" ]; then
    warn "could not parse bounds: $bounds"
    return 1
  fi
  "$ADB" shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
}

# True when an ANR dialog is blocking input.
#
# This emulator has no GPU (hw.gpu.enabled=no), so SystemUI periodically stops responding and
# its "System UI isn't responding" dialog takes window focus. While it is up, every tap goes to
# the dialog and the app looks frozen — a scenario would report a bogus failure. The dump's
# package list is the reliable signal: the dialog's nodes belong to `android`, not the app.
anr_dialog_present() {
  local xml="${ARTIFACTS_DIR:?}/.anr-probe.xml"
  mkdir -p "$ARTIFACTS_DIR"
  ui_dump_xml "$xml" 2>/dev/null || return 1
  grep -q -F "isn't responding" "$xml"
}

# Dismiss an ANR dialog by pressing its "Wait" button, and tell the framework to stop showing
# these dialogs for the rest of the session.
#
# `settings put global hide_error_dialogs 1` is the durable fix and is applied by
# device-prep.sh prepare in the first place; this function is the cleanup path for a dialog
# that is already on screen. Tapping "Wait" (not "Close app") keeps the app process alive.
dismiss_anr_if_present() {
  anr_dialog_present || return 0
  warn "system ANR dialog is blocking input; dismissing it (tap Wait)"
  local xml="$ARTIFACTS_DIR/.anr-probe.xml" bounds
  bounds="$(python3 "$ANDROID_ENV_DIR/ui-dump-report.py" --find "Wait" "$xml" 2>/dev/null || true)"
  if [ -n "$bounds" ]; then
    tap_bounds "$bounds" || true
  else
    # Fall back to the dialog's lower button, which is where "Wait" sits on this image.
    "$ADB" shell input tap 540 1399 || true
  fi
  sleep 2
}

# ---------------------------------------------------------------------------------------------
# 6. Shared device primitives
#
# Everything below is used by BOTH device-prep.sh and verify-device.sh, so it lives here
# rather than in either script. Keeping one copy is what stops the two from drifting.
# ---------------------------------------------------------------------------------------------

# Runtime permissions checked by the harness.
#
# Verified against the shipped APKs (aapt2 dump permissions) and the expo-image-picker
# module manifest:
#   CAMERA                        — declared by the picker module, so every build that
#                                   includes it declares this; the only permission the
#                                   round-2 camera flow actually requests.
#   READ_MEDIA_IMAGES / READ_MEDIA_VISUAL_USER_SELECTED — API 33+ only, and only if the app
#                                   declares them; the photo picker does NOT need them.
#   READ/WRITE_EXTERNAL_STORAGE    — declared with maxSdkVersion=32, so they do not exist at
#                                   all on this API 36 device. They are listed so the
#                                   "expected on a modern device?" question has an answer.
#
# Why the picker needs no photo permission: since Android 13 the system PhotoPicker hands the
# app a read grant for the one URI the user chose. That is also why an "unable to open photo
# library" failure caused by a missing READ_MEDIA_IMAGES is impossible on this path — a point
# worth knowing before blaming permissions for a picker bug.
#
# REQUIRED_FOR_CAMERA is the set the harness insists on; the rest are informational. Without
# CAMERA the camera scenarios cannot run at all, and the check must fail rather than skip.
REQUIRED_FOR_CAMERA=(android.permission.CAMERA)
APP_PERMISSIONS=(
  android.permission.CAMERA
  android.permission.READ_MEDIA_IMAGES
  android.permission.READ_MEDIA_VISUAL_USER_SELECTED
  android.permission.READ_EXTERNAL_STORAGE
  android.permission.WRITE_EXTERNAL_STORAGE
)

# Count rows returned by a MediaStore query. An empty result set prints "No result found."
# and zero rows, so this is 0 exactly when nothing is indexed.
media_image_count() {
  adb_shell "content query --uri content://media/external/images/media --projection _id" \
    | grep -c '^Row:' || true
}

# Stream the UI hierarchy as XML into $1. `exec-out ... /dev/tty` avoids a second adb
# round-trip to /sdcard; the trailing "UI hierchary dumped to: /dev/tty" line (sic) is dropped.
#
# `uiautomator dump` fails intermittently on this emulator — measured 6 failures in 20
# consecutive attempts (~30%), with no output at all rather than bad XML. Treating a single
# attempt as authoritative made every tap-text and every scenario flaky, so retry a few times
# before reporting failure. The retries are cheap (a dump takes well under a second) and a
# genuinely dead window still fails after the last attempt.
UI_DUMP_ATTEMPTS=5
ui_dump_xml() {
  local out="$1" attempt
  for attempt in $(seq 1 "$UI_DUMP_ATTEMPTS"); do
    "$ADB" exec-out uiautomator dump /dev/tty 2>/dev/null \
      | sed 's/UI hierchary dumped to.*//' > "$out"
    # A dump that is not XML means the window was mid-animation or the dump aborted.
    if [ -s "$out" ] && grep -q '<hierarchy' "$out"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Wait until the given text appears anywhere in the UI. $1 = text, $2 = timeout seconds.
#
# Shared rather than private to one script: run-acceptance.sh waits on screen transitions after
# every action, and it calls device-prep.sh rather than being called by it, so the helper has to
# live one level down or the acceptance run cannot see it.
wait_for_text() {
  local needle="$1" timeout="${2:-10}" waited=0 xml="$ARTIFACTS_DIR/.wait.xml"
  mkdir -p "$ARTIFACTS_DIR"
  while [ "$waited" -lt "$timeout" ]; do
    if ui_dump_xml "$xml" 2>/dev/null && grep -q -F -- "$needle" "$xml"; then
      return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

# Wait until the app has painted something. $1 = timeout seconds (default 60).
#
# The release build needs ~20s to render its first frame on this GPU-less emulator: measured 21s
# from `am start` to the first text node, because there is no hardware acceleration and the
# Hermes bundle has to be unpacked. Any fixed delay shorter than that produces a dump of a blank
# React root, which reads as "the app is broken" when it is only early. Wait for the condition.
wait_for_ui_ready() {
  local timeout="${1:-60}" waited=0 xml="$ARTIFACTS_DIR/.startup.xml"
  mkdir -p "$ARTIFACTS_DIR"
  while [ "$waited" -lt "$timeout" ]; do
    if ui_dump_xml "$xml" 2>/dev/null \
       && [ "$(grep -o 'text="[^"]*"' "$xml" | grep -cv 'text=""')" -gt 0 ]; then
      return 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  return 1
}

# Python interpreter that actually has Pillow (needed for sample photos and readable dumps).
harness_python() {
  local candidate
  for candidate in "$REPO_ROOT/backend/.venv/bin/python" "$(command -v python3 || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    if "$candidate" -c 'import PIL' >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}
