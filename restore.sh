#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: ./restore.sh <path-to-backup.tar.gz>"
  exit 1
fi

ARCHIVE_PATH="$1"
if [ ! -f "${ARCHIVE_PATH}" ]; then
  echo "[ERROR] Backup archive not found: ${ARCHIVE_PATH}"
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "[1/4] Verifying backup archive..."
tar -xzf "${ARCHIVE_PATH}" -C "${WORK_DIR}"

echo "[2/4] Stopping web and api containers cleanly..."
docker compose stop web api || true

echo "[3/4] Restoring /app/data persistent state..."
docker compose up -d --no-start api
if [ -d "${WORK_DIR}/data" ]; then
  docker cp "${WORK_DIR}/data/." meofast-api:/app/data/
fi

if [ -f "${WORK_DIR}/postgres-dump.sql" ] && docker ps --format '{{.Names}}' | grep -q '^meofast-postgres$'; then
  echo "[INFO] Restoring bundled PostgreSQL dump..."
  PG_USER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2 || echo 'meofast')"
  PG_DB="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2 || echo 'meofast')"
  cat "${WORK_DIR}/postgres-dump.sql" | docker exec -i meofast-postgres psql -U "${PG_USER:-meofast}" -d "${PG_DB:-meofast}"
fi

echo "[4/4] Starting Meofast services..."
docker compose up -d

echo "[SUCCESS] Restore completed."
