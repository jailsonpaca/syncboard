#!/usr/bin/env bash
# Instala SyncBoard AppImage no Linux — app pronto, sem Node/npm
set -euo pipefail

MAC_IP="${SYNCBOARD_MAC_IP:-192.168.3.93}"
PORT="${SYNCBOARD_PORT:-8788}"
BASE="http://${MAC_IP}:${PORT}"

APPIMAGE_NAME=$(curl -fsSL "$BASE/" 2>/dev/null | grep -oE 'SyncBoard-[0-9.]+-x86_64\.AppImage' | head -1 || true)
APPIMAGE_NAME="${APPIMAGE_NAME:-SyncBoard-1.0.0-x86_64.AppImage}"

INSTALL_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
CONFIG_DIR="$HOME/.config/syncboard-desktop"
APPIMAGE="$INSTALL_DIR/syncboard.AppImage"

echo ""
echo "→ Baixando SyncBoard..."
mkdir -p "$INSTALL_DIR"
curl -fL "$BASE/$APPIMAGE_NAME" -o "$APPIMAGE"
chmod +x "$APPIMAGE"

# AppImage precisa de FUSE — instala ou usa modo sem FUSE
USE_EXTRACT=0
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
  echo "→ libfuse2 não encontrado..."
  if command -v apt-get >/dev/null 2>&1; then
    echo "  Tentando instalar libfuse2 (pede sudo)..."
    if sudo apt-get install -y libfuse2 fuse 2>/dev/null; then
      echo "  ✓ libfuse2 instalado"
    else
      echo "  Usando modo sem FUSE (APPIMAGE_EXTRACT_AND_RUN)"
      USE_EXTRACT=1
    fi
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y fuse fuse-libs 2>/dev/null || USE_EXTRACT=1
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm fuse2 2>/dev/null || USE_EXTRACT=1
  else
    USE_EXTRACT=1
  fi
fi

if [ "$USE_EXTRACT" = 1 ] || ! ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
  USE_EXTRACT=1
fi

# Wrapper que sempre funciona
WRAPPER="$INSTALL_DIR/syncboard"
cat > "$WRAPPER" << 'WRAP'
#!/usr/bin/env bash
APPIMAGE="$HOME/.local/bin/syncboard.AppImage"
export SYNCBOARD_START_VISIBLE=1
if ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; then
  exec "$APPIMAGE" --no-sandbox "$@"
else
  exec env APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" --no-sandbox "$@"
fi
WRAP
chmod +x "$WRAPPER"

mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/config.json" << EOF
{
  "serverUrl": "http://${MAC_IP}:8787",
  "runLocalServer": false,
  "autoSync": true,
  "launchAtLogin": true,
  "hotkey": "Alt+V",
  "port": 8787
}
EOF

mkdir -p "$DESKTOP_DIR" "$HOME/.config/autostart"
cat > "$DESKTOP_DIR/syncboard.desktop" << EOF
[Desktop Entry]
Type=Application
Name=SyncBoard
Comment=Clipboard sync na rede local
Exec=$WRAPPER
Terminal=false
Categories=Utility;Network;
StartupWMClass=syncboard
EOF
cp "$DESKTOP_DIR/syncboard.desktop" "$HOME/.config/autostart/"

command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

echo ""
echo "✓ SyncBoard instalado!"
echo "  Abrir: syncboard   (ou menu SyncBoard)"
echo "  Atalho: Alt+V"
echo "  Servidor Mac: http://${MAC_IP}:8787"
echo ""
echo "→ Abrindo..."
"$WRAPPER" &
