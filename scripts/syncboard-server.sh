#!/usr/bin/env bash
# Daemon do SyncBoard Server — sobrevive sem o Electron
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/syncboard"
PID_FILE="$STATE/server.pid"
LOG_FILE="$STATE/server.log"
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
PLIST="$HOME/Library/LaunchAgents/com.syncboard.server.plist"

# launchd não carrega nvm — resolve node absoluto
resolve_node() {
  if [ -n "${SYNCBOARD_NODE:-}" ] && [ -x "$SYNCBOARD_NODE" ]; then
    echo "$SYNCBOARD_NODE"
    return
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  for c in \
    "$HOME/.nvm/versions/node"/*/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node
  do
    # shellcheck disable=SC2086
    for f in $c; do
      if [ -x "$f" ]; then
        echo "$f"
        return
      fi
    done
  done
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [ -z "${NODE_BIN:-}" ]; then
  echo "ERRO: node não encontrado (nvm/homebrew)" >&2
  exit 1
fi

mkdir -p "$STATE"

is_healthy() {
  curl -sf --connect-timeout 1 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1
}

pid_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start_foreground() {
  cd "$ROOT/server"
  if [ ! -f dist/index.js ]; then
    echo "Compilando servidor..."
    npm run build
  fi
  export PORT HOST
  export SYNCBOARD_RELEASE_DIR="$ROOT/desktop/release"
  export SYNCBOARD_CLIENT_DIST="$ROOT/client/dist"
  exec "$NODE_BIN" dist/index.js
}

start_bg() {
  if is_healthy; then
    echo "SyncBoard server já está no ar (:${PORT})"
    return 0
  fi

  if [ -f "$PID_FILE" ]; then
    old="$(cat "$PID_FILE" 2>/dev/null || true)"
    if pid_running "$old"; then
      # processo vivo mas health falhou — mata e sobe de novo
      kill "$old" 2>/dev/null || true
      sleep 0.5
    fi
    rm -f "$PID_FILE"
  fi

  # libera porta se ficou zumbi
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:"$PORT" | xargs kill 2>/dev/null || true
    sleep 0.3
  fi

  cd "$ROOT/server"
  if [ ! -f dist/index.js ]; then
    npm run build >>"$LOG_FILE" 2>&1
  fi

  export PORT HOST
  export SYNCBOARD_RELEASE_DIR="$ROOT/desktop/release"
  export SYNCBOARD_CLIENT_DIST="$ROOT/client/dist"

  nohup "$NODE_BIN" dist/index.js >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  disown $! 2>/dev/null || true

  for _ in $(seq 1 30); do
    if is_healthy; then
      echo "✓ SyncBoard server :${PORT} (pid $(cat "$PID_FILE"))"
      return 0
    fi
    sleep 0.2
  done

  echo "✗ Server não respondeu. Log: $LOG_FILE"
  tail -20 "$LOG_FILE" || true
  return 1
}

stop_bg() {
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  lsof -ti:"$PORT" | xargs kill 2>/dev/null || true
  echo "Server parado"
}

install_launchagent() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "LaunchAgent só no macOS"
    return 1
  fi

  NODE_DIR="$(dirname "$NODE_BIN")"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.syncboard.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>HOST</key>
    <string>0.0.0.0</string>
    <key>SYNCBOARD_RELEASE_DIR</key>
    <string>$ROOT/desktop/release</string>
    <key>SYNCBOARD_CLIENT_DIST</key>
    <string>$ROOT/client/dist</string>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
  <key>WorkingDirectory</key>
  <string>$ROOT/server</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/com.syncboard.server" 2>/dev/null || true
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
  launchctl enable "gui/$(id -u)/com.syncboard.server" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/com.syncboard.server" 2>/dev/null || true

  for _ in $(seq 1 40); do
    if is_healthy; then
      echo "✓ LaunchAgent instalado — server permanece no ar (KeepAlive)"
      return 0
    fi
    sleep 0.25
  done
  echo "LaunchAgent instalado; aguardando health… veja $LOG_FILE"
}

uninstall_launchagent() {
  launchctl bootout "gui/$(id -u)/com.syncboard.server" 2>/dev/null || true
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  stop_bg
  echo "LaunchAgent removido"
}

status() {
  if is_healthy; then
    echo "online :${PORT}"
    curl -s "http://127.0.0.1:${PORT}/api/health" || true
    echo
  else
    echo "offline"
    exit 1
  fi
}

cmd="${1:-start}"
case "$cmd" in
  start) start_bg ;;
  stop) stop_bg ;;
  restart) stop_bg; start_bg ;;
  foreground) start_foreground ;;
  status) status ;;
  install) install_launchagent ;;
  uninstall) uninstall_launchagent ;;
  *)
    echo "Uso: $0 {start|stop|restart|status|install|uninstall|foreground}"
    exit 1
    ;;
esac
