#!/usr/bin/env bash
# SyncBoard no Linux — só navegador. Sem Electron, sem FUSE, sem Node.
set -euo pipefail

MAC_IP="${SYNCBOARD_MAC_IP:-192.168.3.93}"
URL="http://${MAC_IP}:8787"
BIN="$HOME/.local/bin/syncboard"
DESKTOP="$HOME/.local/share/applications"

echo ""
echo "=== SyncBoard Linux (navegador) ==="
echo ""

echo -n "→ Testando Mac... "
if ! curl -sf --connect-timeout 4 "$URL/api/health" >/dev/null; then
  echo "FALHOU"
  echo "  Abra o SyncBoard no Mac primeiro (ícone na barra de menu)."
  exit 1
fi
echo "OK"

mkdir -p "$HOME/.local/bin" "$DESKTOP" "$HOME/.config/autostart"

# Prefer Chrome/Chromium em modo app (janela sem barra de URL)
BROWSER=""
for c in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$c" >/dev/null 2>&1; then
    BROWSER="$c"
    break
  fi
done

if [ -n "$BROWSER" ]; then
  cat > "$BIN" << EOF
#!/usr/bin/env bash
exec $BROWSER --app="$URL" --new-window "\$@"
EOF
else
  cat > "$BIN" << EOF
#!/usr/bin/env bash
exec xdg-open "$URL"
EOF
fi
chmod +x "$BIN"

cat > "$DESKTOP/syncboard.desktop" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=SyncBoard
Comment=Clipboard sync na rede local
Exec=$BIN
Terminal=false
Categories=Utility;Network;
StartupNotify=true
EOF

# Autostart opcional — só atalho no menu; sem forçar abrir
cp "$DESKTOP/syncboard.desktop" "$HOME/.config/autostart/" 2>/dev/null || true
command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP" 2>/dev/null || true

echo ""
echo "✓ Pronto!"
echo "  Abrir:   syncboard"
echo "  Ou menu: SyncBoard"
echo "  URL:     $URL"
echo ""
echo "  Dica Chrome: ⋮ → Instalar SyncBoard / Criar atalho → Abrir como janela"
echo ""
echo "→ Abrindo agora..."
"$BIN" &
