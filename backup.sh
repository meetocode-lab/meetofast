#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
WORK_DIR="$(mktemp -d)"
ARCHIVE_PATH="${BACKUP_DIR}/meofast-backup-${TIMESTAMP}.tar.gz"

trap 'rm -rf "${WORK_DIR}"' EXIT

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

echo "[INFO] Exporting persistent /app/data volume from meofast-api..."
if docker ps -a --format '{{.Names}}' | grep -q '^meofast-api$'; then
  docker cp meofast-api:/app/data "${WORK_DIR}/data"
else
  echo "[WARN] Container meofast-api not found; checking local ./data directory..."
  if [ -d "./data" ]; then
    cp -R ./data "${WORK_DIR}/data"
  else
    mkdir -p "${WORK_DIR}/data"
  fi
fi

if docker ps --format '{{.Names}}' | grep -q '^meofast-postgres$'; then
  echo "[INFO] Dumping bundled PostgreSQL database..."
  PG_USER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | cut -d= -f2 || echo 'meofast')"
  PG_DB="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | cut -d= -f2 || echo 'meofast')"
  docker exec meofast-postgres pg_dump -U "${PG_USER:-meofast}" -d "${PG_DB:-meofast}" > "${WORK_DIR}/postgres-dump.sql"
fi

tar -czf "${ARCHIVE_PATH}" -C "${WORK_DIR}" .
chmod 600 "${ARCHIVE_PATH}"

echo "[SUCCESS] Backup created at ${ARCHIVE_PATH}"
