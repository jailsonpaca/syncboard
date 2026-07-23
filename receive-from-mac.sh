#!/usr/bin/env bash
# Rode ESTE script no Linux para baixar e instalar o SyncBoard do Mac
set -euo pipefail

MAC_IP="${1:-192.168.3.93}"
PORT="${2:-8788}"
DIR="$HOME/mesa/projects"

echo ""
echo "→ Baixando SyncBoard de http://${MAC_IP}:${PORT}/syncboard.tar.gz"
mkdir -p "$DIR"
cd "$DIR"
curl -fL "http://${MAC_IP}:${PORT}/syncboard.tar.gz" -o syncboard.tar.gz
tar xzf syncboard.tar.gz
rm syncboard.tar.gz
cd syncboard
chmod +x install.sh desktop/launch.sh send-to-linux.sh
./install.sh

echo ""
echo "→ Configure nas Preferências:"
echo "  Desmarque 'Servidor local'"
echo "  URL: http://${MAC_IP}:8787"
echo ""
