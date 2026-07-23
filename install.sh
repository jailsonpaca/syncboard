#!/usr/bin/env bash
# Instalação completa do SyncBoard — Mac e Linux
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DESKTOP="$ROOT/desktop"
LAUNCHER="$DESKTOP/launch.sh"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Instalação SyncBoard — Desktop       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "ERRO: Node.js não encontrado. Instale em https://nodejs.org"
  exit 1
fi

echo "→ Instalando dependências..."
cd "$ROOT"
npm run install:all

echo "→ Compilando servidor e interface..."
npm run build

echo "→ Instalando app desktop (Electron)..."
cd "$DESKTOP"
npm install

chmod +x "$LAUNCHER"

OS="$(uname -s)"

# Autostart via módulo compartilhado (Mac LaunchAgent / Linux .desktop)
enable_autostart() {
  cd "$ROOT"
  node -e "require('./desktop/autostart').setEnabled(true)"
}

if [ "$OS" = "Darwin" ]; then
  enable_autostart
  # Atalho no Applications (opcional — symlink)
  APP_LINK="$HOME/Applications/SyncBoard.app"
  mkdir -p "$HOME/Applications"
  if [ ! -e "$APP_LINK" ]; then
    mkdir -p "$APP_LINK/Contents/MacOS"
    cat > "$APP_LINK/Contents/MacOS/SyncBoard" << SCRIPT
#!/bin/bash
exec "$LAUNCHER"
SCRIPT
    chmod +x "$APP_LINK/Contents/MacOS/SyncBoard"
    cat > "$APP_LINK/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>SyncBoard</string>
  <key>CFBundleExecutable</key>
  <string>SyncBoard</string>
  <key>CFBundleIdentifier</key>
  <string>com.syncboard.desktop</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST
  fi

  echo ""
  echo "✓ SyncBoard instalado no Mac!"
  echo "  Ícone na barra de menu (topo direito)"
  echo "  Atalho: Alt+V (⌥V) para abrir"
  echo "  Log: ~/Library/Logs/syncboard.log"
  echo "  App: ~/Applications/SyncBoard.app"
  echo "  Autostart: ativado (desative no menu → Preferências)"
  echo ""
  echo "  Iniciando agora..."
  "$LAUNCHER" &

elif [ "$OS" = "Linux" ]; then
  node "$DESKTOP/generate-icons.js"
  enable_autostart

  # Cliente Linux → usa Mac como servidor por padrão
  MAC_IP="${SYNCBOARD_MAC_IP:-192.168.3.93}"
  CONFIG_DIR="$HOME/.config/syncboard-desktop"
  mkdir -p "$CONFIG_DIR"
  node -e "
    const fs=require('fs');
    const p='$CONFIG_DIR/config.json';
    let c={};
    try{c=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
    Object.assign(c,{
      serverUrl:'http://${MAC_IP}:8787',
      runLocalServer:false,
      launchAtLogin:true,
      autoSync:true,
      hotkey:'Alt+V',
      port:8787
    });
    fs.writeFileSync(p,JSON.stringify(c,null,2));
    console.log('Config Linux → Mac:',c.serverUrl);
  "

  chmod +x "$ROOT/linux-open.sh" "$ROOT/linux-doctor.sh"

  echo ""
  echo "✓ SyncBoard instalado no Linux!"
  echo "  Abrir: ~/mesa/projects/syncboard/linux-open.sh"
  echo "  Atalho: Alt+V"
  echo "  Servidor: http://${MAC_IP}:8787 (Mac)"
  echo "  Diagnóstico: ~/mesa/projects/syncboard/linux-doctor.sh"
  echo ""
  echo "  Iniciando agora..."
  SYNCBOARD_START_VISIBLE=1 "$LAUNCHER" &

else
  echo "Sistema não suportado para instalação automática."
  echo "Execute manualmente: $LAUNCHER"
  exit 1
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || echo 'SEU-IP')"
echo ""
echo "  Android: http://${IP}:8787"
echo "  (adicione à tela inicial no Chrome)"
echo ""
