# Upgrade Guide — Meofast

Meofast handles schema migrations automatically during startup when already installed (`data/install.lock` present).

## Standard Docker Upgrade

Run the included `update.sh` script from your Meofast installation directory:

```bash
./update.sh
```

What `update.sh` performs:
1. Executes `./backup.sh` first so you always have a pre-upgrade snapshot in `./backups/`.
2. Pulls the latest repository changes (`git pull --ff-only`).
3. Rebuilds and restarts containers (`docker compose up -d --build`) while preserving `meofast_data` and database volumes.
4. Waits for `GET /api/v1/health` to report `"status": "ok"` after Kysely finishes any pending schema migrations.

## Zero-Data-Loss Checklist
- **Never run `docker compose down -v`** during an upgrade (`-v` deletes Docker volumes!).
- Keep a copy of `/app/data/master.key` backed up securely off-host; it is required to decrypt `config.enc.json` and secret environment variables.
