#!/usr/bin/env bash
# Envia o SyncBoard do Mac para o Linux e instala — um comando só.
#
# Uso:
#   ./send-to-linux.sh                          # usa jailson@192.168.3.7
#   ./send-to-linux.sh usuario@192.168.1.20
#   ./send-to-linux.sh usuario@192.168.1.20 --no-install

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REMOTE="${1:-jailson@192.168.3.7}"
NO_INSTALL=false

if [ "${1:-}" = "--no-install" ]; then
  REMOTE="jailson@192.168.3.7"
  NO_INSTALL=true
elif [ "${2:-}" = "--no-install" ]; then
  NO_INSTALL=true
fi

REMOTE_DIR="${SYNCBOARD_REMOTE_DIR:-~/mesa/projects/syncboard}"

ensure_sshpass() {
  if command -v sshpass >/dev/null 2>&1; then return; fi
  if command -v brew >/dev/null 2>&1; then
    echo "→ Instalando sshpass (Homebrew)..."
    brew install hudochenkov/sshpass/sshpass 2>/dev/null || brew install sshpass 2>/dev/null || true
  fi
}

get_ssh_password() {
  osascript <<'APPLESCRIPT'
display dialog "Digite a senha SSH do Linux:" default answer "" with hidden answer with title "SyncBoard → Linux"
return text returned of result
APPLESCRIPT
}

setup_ssh_auth() {
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE" "echo ok" >/dev/null 2>&1; then
    RSYNC_SSH="ssh"
    SSH_CMD=(ssh)
    return
  fi

  echo "→ Chave SSH não configurada. Pedindo senha..."
  ensure_sshpass
  if ! command -v sshpass >/dev/null 2>&1; then
    echo ""
    echo "ERRO: Configure SSH sem senha primeiro:"
    echo "  ssh-copy-id $REMOTE"
    echo ""
    exit 1
  fi

  export SSHPASS
  SSHPASS="$(get_ssh_password)"
  RSYNC_SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
  SSH_CMD=(sshpass -e ssh -o StrictHostKeyChecking=accept-new -t)
}

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     SyncBoard → Linux                    ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "→ Destino: $REMOTE:$REMOTE_DIR"
echo ""

echo "→ Compilando no Mac..."
cd "$ROOT"
npm run build

setup_ssh_auth

echo "→ Enviando arquivos..."
rsync -avz --progress -e "$RSYNC_SSH" \
  --exclude node_modules \
  --exclude 'server/data' \
  --exclude .daemon-state.json \
  --exclude 'desktop/node_modules' \
  --exclude 'client/node_modules' \
  --exclude 'server/node_modules' \
  --exclude 'daemon/node_modules' \
  "$ROOT/" "$REMOTE:$REMOTE_DIR/"

echo ""
echo "✓ Arquivos copiados"
echo ""

if [ "$NO_INSTALL" = true ]; then
  echo "Pulando instalação (--no-install)."
  echo "No Linux: cd $REMOTE_DIR && ./install.sh"
  exit 0
fi

echo "→ Instalando no Linux..."
"${SSH_CMD[@]}" "$REMOTE" "cd $REMOTE_DIR && chmod +x install.sh desktop/launch.sh daemon.sh start.sh send-to-linux.sh && ./install.sh"

MAC_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '192.168.3.93')"

echo ""
echo "✓ SyncBoard instalado no Linux!"
echo ""
echo "  Linux: ícone na bandeja ou Alt+V"
echo "  Preferências → desmarque 'Servidor local'"
echo "  URL do servidor: http://${MAC_IP}:8787"
echo ""
