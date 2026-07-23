#!/usr/bin/env bash
# Inicia o SyncBoard — server daemon estável + Electron (menu bar)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/desktop"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/syncboard"
LOG_FILE="$LOG_DIR/launch.log"
OS="$(uname -s)"
SERVER_SH="$ROOT/scripts/syncboard-server.sh"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

is_running() {
  if [ "$OS" = "Darwin" ]; then
    pgrep -f "$DESKTOP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \\." >/dev/null 2>&1
  else
    pgrep -f "$DESKTOP/node_modules/electron/dist/electron" >/dev/null 2>&1
  fi
}

cd "$DESKTOP"

if [ ! -d "node_modules/electron" ]; then
  log "Instalando Electron..."
  npm install >>"$LOG_FILE" 2>&1
fi

if [ ! -d "$ROOT/client/dist" ] || [ ! -d "$ROOT/server/dist" ]; then
  log "Compilando..."
  cd "$ROOT" && npm run build >>"$LOG_FILE" 2>&1
  cd "$DESKTOP"
fi

# Server separado com KeepAlive (não cai junto com o Electron)
chmod +x "$SERVER_SH"
if [ "$OS" = "Darwin" ]; then
  if ! curl -sf --connect-timeout 1 http://127.0.0.1:8787/api/health >/dev/null; then
    log "Instalando/subindo daemon do server (LaunchAgent)..."
    "$SERVER_SH" install >>"$LOG_FILE" 2>&1 || "$SERVER_SH" start >>"$LOG_FILE" 2>&1
  else
    log "Server já online :8787"
  fi
else
  "$SERVER_SH" start >>"$LOG_FILE" 2>&1 || true
fi

if is_running; then
  log "Electron já rodando — abrindo janela..."
  export SYNCBOARD_START_VISIBLE=1
else
  log "Iniciando Electron..."
  if [ "$OS" = "Linux" ]; then
    export SYNCBOARD_START_VISIBLE=1
    export ELECTRON_OZONE_PLATFORM_HINT=auto
  fi
fi

ELECTRON_BIN="$DESKTOP/node_modules/electron/dist/electron"
if [ "$OS" = "Darwin" ]; then
  ELECTRON_BIN="$DESKTOP/node_modules/.bin/electron"
fi

cd "$DESKTOP"
if [ "$OS" = "Linux" ]; then
  exec "$ELECTRON_BIN" . --no-sandbox "$@" >>"$LOG_FILE" 2>&1
else
  exec "$ELECTRON_BIN" . "$@" >>"$LOG_FILE" 2>&1
fi
