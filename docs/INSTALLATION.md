# Detailed Installation, Upgrade, Backup & API Guides

See the dedicated operational guides in this directory:
- `INSTALLATION.md` (this file)
- [UPGRADE.md](./UPGRADE.md)
- [BACKUP_RESTORE.md](./BACKUP_RESTORE.md)
- [API.md](./API.md)

---

## Step-by-Step Self-Hosted Installation

### 1. System Requirements
- **CPU / RAM:** Minimum 1 vCPU, 1 GB RAM (2 vCPU, 2+ GB RAM recommended for team deployments).
- **Disk:** 5 GB free disk space with persistent volume mount.
- **Runtime:** Docker Engine `>= 24.0` + Docker Compose v2 (or Node.js `>= 24.7` for bare-metal runs).

### 2. Automated One-Script Deployment
```bash
git clone https://github.com/meocode/meofast.git
cd meofast
chmod +x install.sh update.sh backup.sh restore.sh
./install.sh
```

### 3. Completing the Browser Setup Wizard
1. Navigate to `http://YOUR_SERVER_IP:4780` (or your HTTPS reverse-proxied domain).
2. Meofast automatically opens `/setup`:
   - **Step 1 (Welcome):** Click **Get Started**.
   - **Step 2 (Database):** Choose **PostgreSQL** (recommended for teams), **MySQL**, **MariaDB**, or **SQLite** (stored in `/app/data/meofast.sqlite`).
   - **Step 3 (Validation):** Click **Validate Connection**. If using PostgreSQL/MySQL/MariaDB and the database does not exist yet, click **Create Database** if prompted.
   - **Step 4 (Administrator):** Enter Full Name, Email, Username, and a strong password (`>= 10` characters with upper, lower, digit, symbol).
   - **Step 5 (Application):** Confirm Application Name (`Meofast`), Public URL, Timezone, Language, and Organization Name.
   - **Step 6 (Execution):** Watch migrations, seeding, Argon2id hashing, and setup locking complete automatically.
   - **Step 7 (Complete):** Click **Go to Dashboard**.

### 4. Emergency Setup Reset (Server Shell Only)
Setup cannot be unlocked over HTTP. If you must reset an instance on a server you administer:
```bash
docker compose exec api npm run setup:reset -- --confirm
docker compose restart api
```
