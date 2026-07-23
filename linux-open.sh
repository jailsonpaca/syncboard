#!/usr/bin/env bash
# Abre SyncBoard no Linux — tenta Electron, senão navegador
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC_IP="${SYNCBOARD_MAC_IP:-192.168.3.93}"
CONFIG="$HOME/.config/syncboard-desktop/config.json"

get_url() {
  if [ -f "$CONFIG" ]; then
    node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG','utf8'));console.log(c.serverUrl||'http://${MAC_IP}:8787')}catch{console.log('http://${MAC_IP}:8787')}" 2>/dev/null
  else
    echo "http://${MAC_IP}:8787"
  fi
}

URL="$(get_url)"

if [ -x "$ROOT/desktop/launch.sh" ]; then
  SYNCBOARD_START_VISIBLE=1 "$ROOT/desktop/launch.sh" &
  sleep 2
  if pgrep -f "$ROOT/desktop/node_modules/electron/dist/electron" >/dev/null 2>&1; then
    echo "SyncBoard aberto (Electron). Atalho: Alt+V"
    exit 0
  fi
fi

echo "Electron indisponível — abrindo no navegador: $URL"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
elif command -v gnome-open >/dev/null 2>&1; then
  gnome-open "$URL"
else
  echo "Abra manualmente: $URL"
fi
