#!/usr/bin/env bash
# Gera app instalável 100% pronto — Mac (.dmg) e Linux (.AppImage)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$ROOT/desktop"
RES="$DESKTOP/resources"
ELECTRON_VERSION=$(node -p "require('$DESKTOP/node_modules/electron/package.json').version")

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Build SyncBoard (app empacotado)     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

echo "→ Compilando cliente e servidor..."
cd "$ROOT"
npm run build

echo "→ Dependências do servidor (raiz)..."
cd "$ROOT/server"
npm install --omit=dev --no-audit --no-fund

echo "→ Preparando recursos embarcados..."
rm -rf "$RES"
mkdir -p "$RES/server" "$RES/client"

cp -r "$ROOT/server/dist" "$RES/server/"
cp "$ROOT/server/package.json" "$RES/server/"
cp "$ROOT/release.config.json" "$RES/server/"
cp -r "$ROOT/server/node_modules" "$RES/server/"
cp -r "$ROOT/client/dist/"* "$RES/client/"

echo "→ Recompilando better-sqlite3 para Electron ${ELECTRON_VERSION}..."
cd "$DESKTOP"
npm install --no-audit --no-fund 2>&1 | tail -2
node generate-icons.js

npx @electron/rebuild \
  -v "$ELECTRON_VERSION" \
  -m "$DESKTOP" \
  -w better-sqlite3 \
  -p "$RES/server" 2>&1 | tail -8

OS="$(uname -s)"
echo "→ Empacotando (sem assinatura Apple — uso local)..."
cd "$DESKTOP"

# Não usa certificado da Jornada Encantum nem pede senha de assinatura
export CSC_IDENTITY_AUTO_DISCOVERY=false
export CSC_LINK=""
export CSC_KEY_PASSWORD=""

if [ "$OS" = "Darwin" ]; then
  npx electron-builder --mac dmg zip --x64
  # AppImage + tar.gz (install-linux.sh usa o tar)
  npx electron-builder --linux AppImage tar.gz --x64
elif [[ "$OS" == MINGW* || "$OS" == MSYS* || "$OS" == CYGWIN* || "$OS" == "Windows_NT" ]]; then
  npx electron-builder --win nsis zip --x64
else
  npx electron-builder --linux AppImage tar.gz --x64
fi

# Nome estável esperado pelo install-linux.sh
VERSION=$(node -p "require('$DESKTOP/package.json').version")
if [ -f "$DESKTOP/release/SyncBoard-${VERSION}-x64.tar.gz" ]; then
  cp -f "$DESKTOP/release/SyncBoard-${VERSION}-x64.tar.gz" "$DESKTOP/release/SyncBoard-linux-x64.tar.gz"
elif [ -f "$DESKTOP/release/SyncBoard-${VERSION}.tar.gz" ]; then
  cp -f "$DESKTOP/release/SyncBoard-${VERSION}.tar.gz" "$DESKTOP/release/SyncBoard-linux-x64.tar.gz"
fi
# Fallback: empacota linux-unpacked se o tar.gz versionado não existir
if [ ! -f "$DESKTOP/release/SyncBoard-linux-x64.tar.gz" ] && [ -d "$DESKTOP/release/linux-unpacked" ]; then
  (cd "$DESKTOP/release" && tar -czf SyncBoard-linux-x64.tar.gz -C linux-unpacked .)
fi

echo "→ Gerando latest.json..."
node "$ROOT/scripts/write-latest-json.js"

echo ""
echo "✓ Build concluído!"
echo ""
find "$DESKTOP/release" -maxdepth 1 -type f \( -name "*.dmg" -o -name "*.AppImage" -o -name "*.zip" -o -name "*.tar.gz" -o -name "latest.json" -o -name "latest*.yml" \) -exec ls -lh {} \;

# Scripts de instalação Linux na pasta release (servidos em :8787/downloads e :8788)
MAC_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '192.168.3.93')"
for script in install-appimage-linux.sh install-linux.sh; do
  if [ -f "$ROOT/$script" ]; then
    cp "$ROOT/$script" "$DESKTOP/release/"
  elif [ -f "$DESKTOP/release/$script" ]; then
    : # já existe
  fi
  if [ -f "$DESKTOP/release/$script" ]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      sed -i '' "s|192.168.3.93|$MAC_IP|g" "$DESKTOP/release/$script"
    else
      sed -i "s|192.168.3.93|$MAC_IP|g" "$DESKTOP/release/$script"
    fi
  fi
done
# install-linux.sh vive só em release — garante IP atualizado
if [ -f "$ROOT/desktop/release/install-linux.sh" ]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    sed -i '' "s|MAC_IP=\"\${SYNCBOARD_MAC_IP:-[^\"]*}\"|MAC_IP=\"\${SYNCBOARD_MAC_IP:-$MAC_IP}\"|g" "$DESKTOP/release/install-linux.sh" || true
  fi
fi

echo ""
echo "  Mac:   open desktop/release/mac/SyncBoard.app"
echo "         ou desktop/release/SyncBoard-*.dmg"
echo ""
echo "  Linux (recomendado — tar nativo via SyncBoard :8787):"
echo "    curl -fsSL http://${MAC_IP}:8787/downloads/install-linux.sh | bash"
echo ""
echo "  Linux (AppImage via :8788):"
echo "    curl -fsSL http://${MAC_IP}:8788/install-appimage-linux.sh | bash"
echo ""
echo "  Servir AppImage: npm run serve:releases"
echo ""
