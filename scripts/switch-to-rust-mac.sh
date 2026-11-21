#!/usr/bin/env bash
set -euo pipefail

# Transição segura do SyncBoard Electron + Node para SyncBoard Rust (Tauri v2) no macOS.
# - Faz backup do banco legado
# - Descarrega os LaunchAgents antigos (com.syncboard.server e com.syncboard.desktop)
# - Instala o SyncBoard.app (Rust) em /Applications/SyncBoard.app
# - Abre o novo app (que executa a migração automática dos itens da aba "Fixo")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$ROOT/target/release/bundle/macos/SyncBoard.app"

if [ ! -d "$APP_BUNDLE" ]; then
  echo "Erro: bundle release não encontrado em $APP_BUNDLE"
  echo "Rode primeiro: npm run tauri:build"
  exit 1
fi

echo "==> 1. Parando serviços legados (Electron + Node server)..."
for plist in "$HOME/Library/LaunchAgents/com.syncboard.desktop.plist" "$HOME/Library/LaunchAgents/com.syncboard.server.plist"; do
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    mv "$plist" "${plist}.legacy.bak"
    echo "    Desativado: $(basename "$plist") (backup em ${plist}.legacy.bak)"
  fi
done

pkill -f "syncboard/server/dist/index.js" 2>/dev/null || true
pkill -f "SyncBoard.app/Contents/MacOS/SyncBoard" 2>/dev/null || true
sleep 1

echo "==> 2. Instalando SyncBoard.app (Rust) em /Applications/SyncBoard.app..."
rm -rf /Applications/SyncBoard.app
cp -R "$APP_BUNDLE" /Applications/SyncBoard.app

echo "==> 3. Abrindo novo SyncBoard..."
open /Applications/SyncBoard.app
sleep 2

echo "==> 4. Validando itens fixados migrados..."
NEW_DB="$HOME/Library/Application Support/com.syncboard.app/data/syncboard.db"
if [ -f "$NEW_DB" ]; then
  echo "    Fixados no novo banco ($NEW_DB):"
  sqlite3 "$NEW_DB" "SELECT id, type, label FROM items WHERE pinned = 1;"
fi

echo "==> 5. Memória do novo processo:"
ps -eo pid,rss,comm | grep -i syncboard | grep -v grep || true
