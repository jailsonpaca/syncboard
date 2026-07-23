#!/usr/bin/env bash
# Diagnóstico SyncBoard no Linux
echo "=== SyncBoard Doctor (Linux) ==="
echo "Host: $(hostname)"
echo "IP: $(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""

echo "→ Node.js"
command -v node && node -v || echo "FALTA node (sudo apt install nodejs npm)"
echo ""

echo "→ Rede → Mac"
curl -sf --connect-timeout 3 http://192.168.3.93:8787/api/health && echo "" || echo "FALHOU — Mac inacessível"
echo ""

echo "→ Projeto"
DIR="$HOME/mesa/projects/syncboard"
if [ -d "$DIR" ]; then
  echo "OK: $DIR"
  ls -la "$DIR/desktop/launch.sh" 2>/dev/null || echo "FALTA launch.sh"
  [ -d "$DIR/desktop/node_modules/electron" ] && echo "OK: Electron instalado" || echo "FALTA: cd $DIR/desktop && npm install"
else
  echo "FALTA: $DIR — reinstale com curl do Mac"
fi
echo ""

echo "→ Processo"
pgrep -af "syncboard.*electron" || echo "Não está rodando"
echo ""

echo "→ Log"
LOG="${XDG_STATE_HOME:-$HOME/.local/state}/syncboard/launch.log"
if [ -f "$LOG" ]; then tail -20 "$LOG"; else echo "(sem log ainda)"; fi
echo ""

echo "→ Config"
CONFIG="$HOME/.config/syncboard-desktop/config.json"
[ -f "$CONFIG" ] && cat "$CONFIG" || echo "(padrão — servidor local)"
echo ""

echo "=== Abrir agora ==="
echo "  ~/mesa/projects/syncboard/linux-open.sh"
echo "  ou: ~/mesa/projects/syncboard/desktop/launch.sh"
