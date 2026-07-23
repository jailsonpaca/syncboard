#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [ ! -d "node_modules" ]; then
  echo "Instalando dependências..."
  npm run install:all
fi

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"

echo ""
echo "Iniciando SyncBoard em http://${HOST}:${PORT}"
echo ""

# Build client se necessário
if [ ! -d "client/dist" ]; then
  echo "Compilando interface web..."
  (cd client && npm run build)
fi

export HOST PORT
cd server && npm start
