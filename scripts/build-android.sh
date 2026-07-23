#!/usr/bin/env bash
# Gera APK release arm64-v8a localmente (fora do GitHub Actions).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID="$ROOT/android"
VER="$(node -p "require('$ROOT/package.json').version")"

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
if [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || true)}"
if [ -z "${JAVA_HOME:-}" ] && [ -d /opt/homebrew/opt/openjdk@17 ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
fi

cd "$ANDROID"
echo "sdk.dir=$ANDROID_HOME" > local.properties

if [ ! -f gradlew ]; then
  echo "→ Gerando Gradle Wrapper..."
  if command -v gradle >/dev/null 2>&1; then
    gradle wrapper --gradle-version 8.11.1
  else
    echo "Instale Gradle ou rode uma vez: /tmp/gradle-8.11.1/bin/gradle wrapper"
    exit 1
  fi
fi

chmod +x gradlew
./gradlew :app:assembleRelease --stacktrace

OUT_DIR="$ANDROID/app/build/outputs/apk/release"
SRC="$(find "$OUT_DIR" -name '*.apk' | head -1)"
if [ -z "$SRC" ]; then
  echo "APK não encontrado em $OUT_DIR"
  exit 1
fi

DEST_DIR="$ROOT/desktop/release"
mkdir -p "$DEST_DIR"
DEST="$DEST_DIR/SyncBoard-${VER}-arm64.apk"
cp -f "$SRC" "$DEST"
echo ""
echo "✓ APK: $DEST"
ls -lh "$DEST"
