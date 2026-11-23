# Deployment Guide — Meetofast

Meetofast is engineered for effortless self-hosted deployment across personal VPS instances, company on-premise servers, private clouds, and local machines.

---

## 1. Quick Start (2 Commands)

```bash
git clone https://github.com/meocode/Meetofast.git
cd Meetofast
docker compose up -d
```

Open your browser at:

```text
http://YOUR_SERVER_IP:4780
```

Meetofast automatically detects that first-time setup has not been completed and launches the **Web Installation Wizard** (`/setup`). No manual `.env` editing or SQL table creation is required.

---

## 2. Deployment Topologies

### Option A: Standalone Self-Hosted (SQLite or External DB)
`docker-compose.yml` starts Meetofast (`web` + `api`) with a persistent Docker volume (`meofast_data:/app/data`).
- Choose **SQLite** in the browser wizard for a zero-dependency single-server installation (stored persistently in `/app/data/Meetofast.sqlite`).
- Or point the browser wizard at an existing external **PostgreSQL**, **MySQL**, or **MariaDB** database on your private network.

### Option B: Production Stack with Bundled PostgreSQL & Reverse Proxy
`docker-compose.production.yml` adds:
- Dedicated `postgres:17-alpine` container on an isolated internal Docker network (database port `5432` is **not** exposed publicly).
- Optional `redis:7-alpine` cache/queue container.
- Health checks, `unless-stopped` restart policies, memory limits, and log rotation.
- Ready-to-use **Nginx** (`deploy/nginx/Meetofast.conf`) and **Traefik** (`deploy/traefik/docker-compose.traefik.yml`) TLS configurations.

```bash
cp .env.example .env
docker compose -f docker-compose.production.yml up -d
```

In Step 2 of the Web Setup Wizard, select **PostgreSQL** and enter host `postgres`, port `5432`, and the credentials from your `.env`.

---

## 3. Lifecycle Scripts

All operational scripts are included at the repository root:

| Script | Purpose |
|---|---|
| `./install.sh` | Verifies Docker & Compose, prepares persistent directories, generates optional `.env`, starts containers, and waits for healthcheck |
| `./update.sh` | Creates a pre-upgrade backup, pulls latest images/code, rebuilds containers, runs automatic database migrations on startup, and verifies health |
| `./backup.sh` | Exports an atomic timestamped archive (`backups/Meetofast-backup-YYYYMMDD-HHMMSS.tar.gz`) containing `/app/data` (`config.enc.json`, `master.key`, `install.lock`, SQLite DB) and optional `pg_dump` / `mysqldump` |
| `./restore.sh` | Safely stops services, restores a backup archive into persistent volumes/database, restarts containers, and verifies `/api/v1/health` |

---

## 4. Persistent Volumes & Security Checklist

- **`meofast_data` (`/app/data`):** Holds `master.key` (AES-256-GCM key), `config.enc.json` (encrypted DB config), `install.lock`, and SQLite database files if SQLite is selected. **Never delete this volume during routine container updates.**
- **`meofast_pgdata` (`/var/lib/postgresql/data`):** Persistent PostgreSQL storage in `docker-compose.production.yml`.
- **Database Ports:** Keep PostgreSQL (`5432`) and MySQL/MariaDB (`3306`) unbound from `0.0.0.0` in production; containers communicate over the private `meofast_internal` bridge network.
- **HTTPS Termination:** Terminate TLS 1.2/1.3 at Nginx or Traefik in front of port `3000` and set the Public URL to `https://api-studio.yourcompany.com` during Step 5 of setup (so session cookies automatically enable `Secure`).
