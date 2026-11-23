# Security Policy — Meetofast

## Supported Versions

| Version | Supported |
|---|---|
| `1.x` | Yes |

## Built-In Security Controls

- **Password Hashing:** Native RFC 9106 `Argon2id` (`memory: 64 MiB`, `passes: 3`, `parallelism: 4`, 16-byte random CSPRNG salt).
- **Encryption at Rest:** `AES-256-GCM` authenticated encryption (`master.key` with 96-bit random IV and 128-bit auth tag) protecting `data/config.enc.json` database credentials and workspace secret variables.
- **Session & CSRF Hardening:** `HttpOnly; SameSite=Lax` session cookies (`Secure` when served over HTTPS), SHA-256 hashed session tokens in the database, and session-bound `X-CSRF-Token` verification on all mutating routes.
- **Setup Wizard Locking:** Bootstrap setup endpoints are guarded by CSRF + rate limiting before installation and permanently return `403 INSTALLATION_LOCKED` once `data/install.lock` and `system_settings.installation_completed` are written.
- **SSRF Protection:** Pre-flight DNS resolution (`dns.lookup`) and manual per-hop redirect validation block cloud metadata endpoints (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`) unconditionally, and block localhost/RFC1918 networks unless explicitly whitelisted by an Organization Administrator.

## Reporting a Vulnerability

Please **do not** open public GitHub issues for suspected security vulnerabilities (such as SSRF bypasses, authentication bypasses, or cryptographic flaws).

Instead, report vulnerabilities privately via GitHub Security Advisories or email `security@meocode.org` with:
1. Affected version and deployment topology.
2. Minimal reproduction steps or proof-of-concept request.
3. Expected vs. observed security boundary behavior.

We acknowledge reports within 48 hours and coordinate responsible disclosure once a patch is released.
