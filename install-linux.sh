#!/usr/bin/env bash
# SyncBoard nativo no Linux (Electron empacotado)
set -euo pipefail

MAC_IP="${SYNCBOARD_MAC_IP:-192.168.3.93}"
# Preferir 8787 (mesmo servidor SyncBoard). Override: SYNCBOARD_PORT=8788
PORT="${SYNCBOARD_PORT:-8787}"
BASE="http://${MAC_IP}:${PORT}/downloads"
TAR="SyncBoard-linux-x64.tar.gz"

INSTALL_ROOT="$HOME/.local/share/syncboard"
APP_DIR="$INSTALL_ROOT/app"
BIN="$HOME/.local/bin/syncboard"
LOG="/tmp/syncboard-native.log"
CONFIG_DIR="$HOME/.config/syncboard-desktop"
DESKTOP_DIR="$HOME/.local/share/applications"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   SyncBoard Linux — app nativo Electron  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
  echo "ERRO: pacote é x86_64, máquina é $ARCH"
  exit 1
fi

echo -n "→ Mac ($MAC_IP:8787)... "
if curl -sf --connect-timeout 4 "http://${MAC_IP}:8787/api/health" >/dev/null; then
  echo "OK"
else
  echo "OFFLINE — suba o SyncBoard no Mac primeiro"
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  echo "→ Dependências..."
  sudo apt-get update -qq 2>/dev/null || true
  for p in \
    curl ca-certificates libgtk-3-0 libnss3 libxss1 libxtst6 libgbm1 \
    libatk1.0-0t64 libatk1.0-0 libatk-bridge2.0-0t64 libatk-bridge2.0-0 \
    libcups2t64 libcups2 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
    libxkbcommon0 libpango-1.0-0 libcairo2 libx11-xcb1 libxcb-dri3-0 \
    libayatana-appindicator3-1 libappindicator3-1 \
    libasound2t64 libasound2 libasound2-dev \
    xdg-utils fonts-liberation xdotool wtype xclip wl-clipboard python3-gi gir1.2-gtk-3.0
  do
    apt-cache show "$p" >/dev/null 2>&1 && \
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$p" >/dev/null 2>&1 || true
  done
fi

# Clipboard: no Wayland o Electron sozinho não lê cópias de outros apps
if [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  if ! command -v wl-paste >/dev/null 2>&1; then
    echo "AVISO: instale wl-clipboard para sync Linux→Mac (sudo apt install wl-clipboard)"
  fi
fi

echo "→ Baixando app..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR" "$HOME/.local/bin" "$CONFIG_DIR" "$DESKTOP_DIR"
TMP=$(mktemp -d)
curl -fL "$BASE/$TAR" -o "$TMP/$TAR"
tar --warning=no-unknown-keyword -xzf "$TMP/$TAR" -C "$TMP" 2>/dev/null || tar xzf "$TMP/$TAR" -C "$TMP"

FOUND=$(find "$TMP" -type f -name syncboard | head -1 || true)
if [ -z "$FOUND" ]; then
  echo "ERRO: binário não encontrado"
  exit 1
fi
cp -a "$(dirname "$FOUND")"/. "$APP_DIR/"
rm -rf "$TMP"

chmod +x "$APP_DIR/syncboard"
[ -f "$APP_DIR/chrome-sandbox" ] && chmod 755 "$APP_DIR/chrome-sandbox" || true

echo "→ Binário OK ($(file -b "$APP_DIR/syncboard" | cut -d, -f1))"

MISSING=$(ldd "$APP_DIR/syncboard" 2>/dev/null | grep "not found" || true)
if [ -n "$MISSING" ]; then
  echo "Bibliotecas faltando:"
  echo "$MISSING"
fi

# Mata instâncias e locks antigos (causa exit 0 silencioso)
echo "→ Limpando instâncias/locks antigos..."
pkill -9 -f "$APP_DIR/syncboard" 2>/dev/null || true
pkill -9 -f "syncboard-desktop|SyncBoard" 2>/dev/null || true
sleep 1
rm -f "$CONFIG_DIR"/Singleton* "$CONFIG_DIR"/lockfile 2>/dev/null || true
rm -f /tmp/.org.chromium.Chromium.* 2>/dev/null || true
find "$HOME/.config" -maxdepth 2 -name 'Singleton*' -path '*syncboard*' -delete 2>/dev/null || true

cat > "$CONFIG_DIR/config.json" << EOF
{
  "serverUrl": "http://${MAC_IP}:8787",
  "runLocalServer": false,
  "autoSync": true,
  "launchAtLogin": true,
  "hotkey": "Alt+V",
  "port": 8787,
  "deviceName": "$(hostname)"
}
EOF

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  export DISPLAY=:0
fi

# Flags de plataforma
# Preferir X11 (XWayland) no Wayland: clipboard do Electron fica legível entre apps.
# O app também usa wl-paste/xclip como fallback nativo.
EXTRA=(--no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage --ozone-platform=x11)

cat > "$BIN" << 'WRAP'
#!/usr/bin/env bash
APP_DIR="$HOME/.local/share/syncboard/app"
LOG="/tmp/syncboard-native.log"
export SYNCBOARD_START_VISIBLE=1
export ELECTRON_DISABLE_SECURITY_WARNINGS=1
export ELECTRON_ENABLE_LOGGING=1
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  export DISPLAY=:0
fi
echo "[$(date -Iseconds)] starting syncboard DISPLAY=$DISPLAY WAYLAND=$WAYLAND_DISPLAY" >>"$LOG"
cd "$APP_DIR" || exit 1
exec "$APP_DIR/syncboard" --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage "$@" >>"$LOG" 2>&1
WRAP
chmod +x "$BIN"

# Injeta ozone X11 no wrapper (clipboard confiável entre apps)
sed -i 's|--disable-dev-shm-usage|--disable-dev-shm-usage --ozone-platform=x11|' "$BIN"

cat > "$DESKTOP_DIR/syncboard.desktop" << EOF
[Desktop Entry]
Type=Application
Name=SyncBoard
Comment=Clipboard sync nativo
Exec=$BIN
Path=$APP_DIR
Terminal=false
Categories=Utility;Network;
StartupWMClass=syncboard
EOF
mkdir -p "$HOME/.config/autostart"
cp "$DESKTOP_DIR/syncboard.desktop" "$HOME/.config/autostart/"
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

echo "→ Teste direto do binário..."
: > "$LOG"
set +e
# Roda em background e observa 4s
(
  cd "$APP_DIR"
  echo "[test] DISPLAY=${DISPLAY:-} WAYLAND=${WAYLAND_DISPLAY:-}" >>"$LOG"
  echo "[test] exec syncboard" >>"$LOG"
  ./syncboard "${EXTRA[@]}" >>"$LOG" 2>&1
  echo "[test] exited with $?" >>"$LOG"
) &
TEST_PID=$!
sleep 4
set -e

if pgrep -f "$APP_DIR/syncboard" >/dev/null; then
  echo ""
  echo "✓ SyncBoard nativo RODANDO"
  echo "  Abrir: syncboard"
  echo "  Atalho: Alt+V"
  echo "  Log: $LOG"
  echo ""
  tail -20 "$LOG" || true
  exit 0
fi

echo ""
echo "✗ Não ficou rodando. Log:"
echo "─────────"
cat "$LOG"
echo "─────────"
echo ""
echo "Diagnóstico extra — rode e cole:"
echo "  cd $APP_DIR"
echo "  echo DISPLAY=\$DISPLAY WAYLAND=\$WAYLAND_DISPLAY"
echo "  ./syncboard --no-sandbox --ozone-platform=x11 2>&1 | head -80"
exit 1
