#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  Meofast — Open-Source Self-Hosted API Platform Installer  "
echo "============================================================"

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] Docker is not installed. Please install Docker Engine >= 24.0 first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[ERROR] Docker Compose v2 plugin is required ('docker compose')."
  exit 1
fi

mkdir -p backups

if [ ! -f .env ]; then
  cp .env.example .env
  GENERATED_KEY="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if grep -q "^MEOFAST_MASTER_KEY=$" .env; then
    sed -i.bak "s/^MEOFAST_MASTER_KEY=$/MEOFAST_MASTER_KEY=${GENERATED_KEY}/" .env && rm -f .env.bak
  fi
  chmod 600 .env
  echo "[INFO] Created .env with secure generated MEOFAST_MASTER_KEY."
fi

PORT_VAL="$(grep -E '^MEOFAST_PORT=' .env | cut -d= -f2 || echo '4780')"
PORT_VAL="${PORT_VAL:-4780}"

echo "[INFO] Building and starting Meofast containers..."
docker compose up -d --build

echo "[INFO] Waiting for Meofast health check on port ${PORT_VAL}..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT_VAL}/api/v1/health" >/dev/null 2>&1; then
    echo ""
    echo "[SUCCESS] Meofast is up and running!"
    echo "Open http://YOUR_SERVER_IP:${PORT_VAL} in your browser to complete the Setup Wizard."
    exit 0
  fi
  sleep 2
done

echo "[WARN] Containers started, still initializing. Check 'docker compose logs -f'."
