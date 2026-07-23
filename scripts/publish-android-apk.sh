#!/usr/bin/env bash
# Faz upload do APK para um GitHub Release e atualiza latest.json com androidApk.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(node -p "require('$ROOT/package.json').version")"
TAG="${1:-v$VER}"
APK="$ROOT/desktop/release/SyncBoard-${VER}-arm64.apk"
CFG="$ROOT/release.config.json"
OWNER="$(node -p "require('$CFG').owner")"
REPO="$(node -p "require('$CFG').repo")"

if [ ! -f "$APK" ]; then
  echo "APK não encontrado. Rode: ./scripts/build-android.sh"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Instale o GitHub CLI (gh)."
  exit 1
fi

echo "→ Upload $APK → $TAG"
gh release upload "$TAG" "$APK" --repo "$OWNER/$REPO" --clobber

ASSET_URL="https://github.com/$OWNER/$REPO/releases/download/$TAG/$(basename "$APK")"

# Baixa latest.json do release (se existir) e injeta androidApk
TMP="$(mktemp)"
if gh release download "$TAG" --repo "$OWNER/$REPO" --pattern latest.json --dir "$(dirname "$TMP")" 2>/dev/null; then
  FOUND="$(dirname "$TMP")/latest.json"
  node -e "
    const fs=require('fs');
    const p='$FOUND';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.assets=j.assets||{};
    j.assets.androidApk='$ASSET_URL';
    j.files=j.files||{};
    j.files.androidApk='$(basename "$APK")';
    j.roadmap=j.roadmap||{};
    j.roadmap.android={status:'available',available:true,note:'APK nativo arm64'};
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  "
  gh release upload "$TAG" "$FOUND" --repo "$OWNER/$REPO" --clobber
  cp -f "$FOUND" "$ROOT/desktop/release/latest.json"
  echo "✓ latest.json atualizado com androidApk"
else
  echo "Aviso: latest.json ainda não existe neste release. APK enviado; publique o desktop release antes ou rode write-latest-json."
fi

echo "✓ Android: $ASSET_URL"
