#!/usr/bin/env bash
# Build APK rilis Legend EDC Bridge. Password kunci dibaca dari Keychain macOS, tidak pernah dicetak.
set -euo pipefail

cd "$(dirname "$0")/.."

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}"
export LEGEND_EDC_KEYSTORE="${LEGEND_EDC_KEYSTORE:-$HOME/.legend-release/edc-bridge-release.jks}"

if [ ! -f "$LEGEND_EDC_KEYSTORE" ]; then
  echo "Keystore tidak ditemukan: $LEGEND_EDC_KEYSTORE" >&2
  exit 1
fi

LEGEND_EDC_KEYSTORE_PASSWORD="$(security find-generic-password -s legend-edc-bridge-release -a release -w)" || {
  echo "Password tidak ada di Keychain (service legend-edc-bridge-release, account release)." >&2
  exit 1
}
export LEGEND_EDC_KEYSTORE_PASSWORD

[ -f local.properties ] || echo "sdk.dir=$ANDROID_SDK_ROOT" > local.properties

heavy ./gradlew assembleRelease
echo "APK: app/build/outputs/apk/release/app-release.apk"
