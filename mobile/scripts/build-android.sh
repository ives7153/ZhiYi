#!/usr/bin/env bash
#
# build-android.sh — produce an installable Android APK for the 知衣 client.
#
# ---------------------------------------------------------------------------------------------
# WHY THIS SCRIPT EXISTS
#
# This machine has no Android toolchain (verified: no JDK, no Android SDK, no ANDROID_HOME, no
# Docker, no Homebrew). `npx expo export` alone produces Hermes bytecode — useful as a
# compile check, but NOT installable. This script assembles a *self-contained* toolchain under
# $DEV_ROOT so nothing is installed system-wide and no sudo is needed, then builds a real APK.
#
# It is NOT a supported production or CI path. On a machine with Android Studio, just run
# `npx expo run:android --variant release`. This script is the fallback for a bare machine.
#
# WHAT IT DOES
#
#   1. JDK 21         — Microsoft OpenJDK, tar.gz, no installer
#   2. Android SDK    — Google commandline-tools + platform-tools + platform + build-tools + NDK
#   3. prebuild       — generates android/ from app.json (expo-build-properties injects
#                       usesCleartextTraffic; see NOTE below)
#   4. gradle         — :app:assembleRelease
#
# NOTE ON CLEARTEXT HTTP — this is the bug that made the first APK unusable.
#
#   app.json used to declare `expo.android.usesCleartextTraffic: true`. Expo does NOT recognise
#   that key: it is silently ignored, so the flag never reached AndroidManifest.xml and Android 9+
#   blocked every plain-HTTP call to the backend. The app installed and launched fine but could
#   never reach an http:// server. The fix is the official plugin:
#
#       ["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
#
#   Drop that plugin and a `http://` backend becomes unreachable again with no build-time warning.
#
# NOTE ON API URL — baked in at build time.
#
#   EXPO_PUBLIC_API_URL is inlined into the JS bundle, so it must point at an address the DEVICE
#   can reach (not the dev machine's loopback):
#       Android emulator (AVD) .... http://10.0.2.2:8000
#       physical device on LAN .... http://<host-lan-ip>:8000
#   And the backend must listen on 0.0.0.0, not 127.0.0.1:
#       BIND_HOST=0.0.0.0 ./scripts/dev-local.sh start
#
# USAGE
#
#   ./mobile/scripts/build-android.sh
#
# Overridable knobs:
#   DEV_ROOT=/tmp/zhiyi-android   scratch root for JDK + SDK + downloads
#   API_URL=http://10.0.2.2:8000  baked into the bundle (see NOTE above)
#   SKIP_SDK=1                    reuse an already-provisioned $ANDROID_HOME
#
# ---------------------------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE_DIR="$REPO_ROOT/mobile"

DEV_ROOT="${DEV_ROOT:-/tmp/zhiyi-android}"
API_URL="${API_URL:-http://10.0.2.2:8000}"

JDK_DIR="$DEV_ROOT/jdk-21.0.12.1+1/Contents/Home"
ANDROID_HOME="${ANDROID_HOME:-$DEV_ROOT/sdk}"
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# 1. JDK 21
#
# Android Gradle Plugin 8.x supports JDK 17–21. A JDK 25 will fail; do not substitute one.
# ---------------------------------------------------------------------------------------------
ensure_jdk() {
  if [ -x "$JDK_DIR/bin/java" ]; then
    log "Reusing JDK: $("$JDK_DIR/bin/java" -version 2>&1 | head -1)"
    return
  fi
  mkdir -p "$DEV_ROOT"
  log "Fetching Microsoft OpenJDK 21 (aarch64)"
  curl -fL --retry 3 -o "$DEV_ROOT/jdk21.tar.gz" \
    "https://aka.ms/download-jdk/microsoft-jdk-21-macos-aarch64.tar.gz"
  tar xzf "$DEV_ROOT/jdk21.tar.gz" -C "$DEV_ROOT"
  [ -x "$JDK_DIR/bin/java" ] || die "JDK not found at $JDK_DIR after extraction"
  log "JDK ready: $("$JDK_DIR/bin/java" -version 2>&1 | head -1)"
}

# ---------------------------------------------------------------------------------------------
# 2. Android SDK
#
# Platform/build-tools versions must match react-native/gradle/libs.versions.toml — read them
# from there rather than hardcoding, so an RN upgrade does not silently desync the SDK.
# ---------------------------------------------------------------------------------------------
ensure_sdk() {
  local toml="$MOBILE_DIR/node_modules/react-native/gradle/libs.versions.toml"
  local compile_sdk build_tools ndk_version
  if [ -f "$toml" ]; then
    compile_sdk="$(grep -E '^\s*compileSdk\s*=' "$toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
    ndk_version="$(grep -E '^\s*ndkVersion\s*=' "$toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
  fi
  compile_sdk="${compile_sdk:-36}"
  ndk_version="${ndk_version:-27.1.12297006}"
  build_tools="${compile_sdk}.0.0"

  if [ -x "$ANDROID_HOME/platform-tools/adb" ] \
     && [ -d "$ANDROID_HOME/platforms/android-${compile_sdk}" ] \
     && [ -d "$ANDROID_HOME/ndk/${ndk_version}" ]; then
    log "Reusing Android SDK at $ANDROID_HOME (platform ${compile_sdk}, NDK ${ndk_version})"
    return
  fi

  export JAVA_HOME="$JDK_DIR"
  export PATH="$JAVA_HOME/bin:$PATH"

  if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
    log "Fetching Android commandline-tools"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    curl -fL --retry 3 -o "$DEV_ROOT/cmdtools.zip" \
      "https://dl.google.com/android/repository/commandlinetools-mac-13114758_latest.zip"
    unzip -q -o "$DEV_ROOT/cmdtools.zip" -d "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" 2>/dev/null || true
  fi

  local sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
  log "Accepting SDK licences"
  yes | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true

  log "Installing platform-tools + platform-${compile_sdk} + build-tools ${build_tools} + NDK ${ndk_version}"
  "$sdkmanager" --sdk_root="$ANDROID_HOME" \
    "platform-tools" \
    "platforms;android-${compile_sdk}" \
    "build-tools;${build_tools}" \
    "ndk;${ndk_version}" >/dev/null

  [ -x "$ANDROID_HOME/platform-tools/adb" ] || die "Android SDK provisioning failed"
  log "Android SDK ready at $ANDROID_HOME"
}

# ---------------------------------------------------------------------------------------------
# 3. Native project + APK
# ---------------------------------------------------------------------------------------------
build_apk() {
  export JAVA_HOME="$JDK_DIR"
  export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

  cd "$MOBILE_DIR"

  # EXPO_PUBLIC_* is inlined into the bundle at build time — it cannot be changed after install.
  export EXPO_PUBLIC_API_URL="$API_URL"

  log "Generating android/ from app.json (API_URL=$API_URL)"
  CI=1 npx expo prebuild --platform android --no-install >/dev/null


  # The cleartext flag must have reached the manifest, or every http:// call fails at runtime
  # with no build error at all. Fail loudly here instead.
  grep -q 'usesCleartextTraffic="true"' android/app/src/main/AndroidManifest.xml \
    || die "usesCleartextTraffic missing from AndroidManifest.xml — is expo-build-properties configured in app.json?"

  echo "sdk.dir=$ANDROID_HOME" > android/local.properties

  log "Building release APK (first run takes ~10 min)"
  ( cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a --no-daemon )

  local apk="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
  [ -f "$apk" ] || die "Gradle reported success but no APK at $apk"
  log "APK: $apk ($(du -h "$apk" | cut -f1))"
}

# ---------------------------------------------------------------------------------------------
# 4. Optional: install onto a running emulator/device and smoke-test it
# ---------------------------------------------------------------------------------------------
verify_apk() {
  local apk="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
  local adb="$ANDROID_HOME/platform-tools/adb"
  [ -x "$adb" ] || return 0

  if ! "$adb" get-state >/dev/null 2>&1; then
    warn "No device/emulator attached — skipping install. Start one with:"
    warn "  \$ANDROID_HOME/emulator/emulator -avd <name> -no-window -gpu swiftshader_indirect &"
    return 0
  fi

  log "Installing onto the attached device"
  "$adb" install -r "$apk" | tail -1
  "$adb" shell am force-stop com.zhiyi.wardrobe || true
  "$adb" shell am start -n com.zhiyi.wardrobe/.MainActivity >/dev/null
  log "Launched com.zhiyi.wardrobe"

  if curl -fsS "http://127.0.0.1:8000/api/v1/health" >/dev/null 2>&1; then
    log "Backend is up — the app should reach it."
  else
    warn "Backend is NOT reachable on 127.0.0.1:8000. The app will show its error screen."
    warn "Start it with: BIND_HOST=0.0.0.0 ./scripts/dev-local.sh start"
  fi
}

main() {
  ensure_jdk
  [ "${SKIP_SDK:-0}" = "1" ] || ensure_sdk
  export JAVA_HOME="$JDK_DIR"
  build_apk
  verify_apk
  log "Done."
}

main "$@"
