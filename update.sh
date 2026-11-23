#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  Meofast — Safe Zero-Data-Loss Upgrade                     "
echo "============================================================"

echo "[1/4] Creating pre-upgrade backup..."
./backup.sh

echo "[2/4] Pulling latest git updates..."
git pull --ff-only

echo "[3/4] Rebuilding and restarting containers (volumes preserved)..."
docker compose up -d --build --remove-orphans

PORT_VAL="$(grep -E '^MEOFAST_PORT=' .env 2>/dev/null | cut -d= -f2 || echo '4780')"
PORT_VAL="${PORT_VAL:-4780}"

echo "[4/4] Verifying post-migration health check..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT_VAL}/api/v1/health" >/dev/null 2>&1; then
    echo "[SUCCESS] Meofast upgraded and verified healthy!"
    exit 0
  fi
  sleep 2
done

echo "[ERROR] Health check timed out after upgrade. Inspect 'docker compose logs api'."
exit 1
