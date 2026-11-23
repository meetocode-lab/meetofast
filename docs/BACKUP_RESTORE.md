# Backup and Restore Guide — Meofast

## Creating a Backup

```bash
./backup.sh
```

This creates a timestamped archive under `./backups/meofast-backup-YYYYMMDD-HHMMSS.tar.gz` containing:
1. Persistent application vault (`/app/data`: `master.key`, `config.enc.json`, `install.lock`, and any SQLite database files using safe snapshot copy).
2. If running `docker-compose.production.yml` with bundled PostgreSQL, a consistent `pg_dump` SQL archive (`postgres-dump.sql`).

> **Security Note:** Backup archives contain `master.key` and encrypted secrets. Store backups in encrypted object storage or restricted backup volumes (`chmod 600`).

## Restoring from a Backup

```bash
./restore.sh ./backups/meofast-backup-20261116-220000.tar.gz
```

What `restore.sh` performs:
1. Verifies archive integrity before touching running containers.
2. Stops the `web` and `api` containers cleanly.
3. Restores `/app/data` into the `meofast_data` volume (and restores `postgres-dump.sql` if bundled PostgreSQL is active).
4. Starts all services (`docker compose up -d`) and polls `/api/v1/health` until healthy.
