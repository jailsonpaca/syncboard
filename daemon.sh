#!/usr/bin/env bash
# SyncBoard — sync automático do clipboard (Mac/Linux)
# Uso: ./daemon.sh [URL_DO_SERVIDOR]

export SYNCBOARD_URL="${1:-http://localhost:8787}"
export SYNCBOARD_DEVICE="${SYNCBOARD_DEVICE:-$(hostname)}"

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/daemon"

if [ ! -d "node_modules" ]; then
  npm install
fi

node src/index.js
