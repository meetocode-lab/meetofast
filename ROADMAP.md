# Meofast — Feature Development Roadmap

Breakdown lengkap pengembangan fitur Meofast dari Phase 1 sampai Phase 5 (100% Selesai).

---

## Phase 1 — Foundation, Setup Wizard & Deployment (Selesai)
- [x] Monorepo TypeScript (`apps/web`, `apps/api`, `packages/shared`, `packages/cli`)
- [x] Blue Aurora UI Design System (`meorora` tokens, Light default + Dark mode switch)
- [x] Komponen UI standar (`Button`, `Input`, Popover `Select` ala `shadcn/ui`, `Dialog`, `Tabs`, `Switch`, `Badge`, `Card`, `Avatar`, `CodeEditor`, `ResizableSplit`, `Icon`)
- [x] Hono Modular Monolith backend + Kysely multi-database runtime (`PostgreSQL`, `MySQL`, `MariaDB`, `SQLite` tanpa rebuild)
- [x] First-Time Web Installation Wizard 7 langkah (`/setup`) + progress bar instalasi berikon roket
- [x] Validasi koneksi DB, pembuatan DB opsional terkonfirmasi, pembuatan akun Super Admin (`Argon2id`), dan penguncian permanen (`install.lock`)
- [x] Paket deployment lengkap (`Dockerfile`, `docker-compose.yml`, `docker-compose.production.yml`, Nginx, Traefik, script `install.sh`, `update.sh`, `backup.sh`, `restore.sh`)

---

## Phase 2 — Auth, Team Workspace & Core REST API Client (Selesai)
- [x] Autentikasi session (`HttpOnly` cookie + CSRF), login, logout, registrasi/invite token, manajemen sesi
- [x] Multi-user & 5-level RBAC (`super_admin`, `org_admin`, `workspace_admin`, `developer`, `viewer`) + aktivasi/nonaktif akun
- [x] Multi-workspace (buat, pindah workspace, kelola member)
- [x] Audit log & riwayat login di panel Admin
- [x] Backend HTTP Request Execution Engine (bebas CORS, pembatalan request, timeout, SSRF guard + pengaturan akses jaringan privat/localhost)
- [x] Multi-tab Request Editor (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, query params, path `:vars`, headers, JSON/XML/Text/Form/Multipart body)
- [x] Skema Auth dasar (`Bearer/JWT`, `Basic`, `API Key` header/query, `OAuth 2.0`, `Custom Header`)
- [x] Response Viewer (status, durasi ms, ukuran byte, pretty JSON/raw body, filter cepat, headers, cookies, console log, copy & export)
- [x] Declarative Assertions dasar (status code, latency, header, JSON path, body contains)
- [x] Collections & Folder + simpan/update/hapus request + riwayat eksekusi (History)
- [x] Import cURL & Postman Collection v2.1 + Export Postman v2.1
- [x] Environment Manager (Global & Workspace variables, secret terenkripsi, dynamic variables `{{$uuid}}`/`{{$timestamp}}`, import/export `.env` & Postman Environment)

---

## Phase 3 — Advanced API Client, Scripting, Multi-Protocol & CLI (Selesai)
- [x] **Code Editor (`<CodeEditor />`):** Line numbers, syntax highlighting JSON/XML/JS, auto-indent/closing brackets, dan highlight `{{variable}}`
- [x] **Resizable Split Panels (`<ResizableSplit />`):** Geser lebar sidebar kiri + geser batas Request/Response + toggle mode Top/Bottom & Side-by-Side
- [x] **Pre-request & Post-response Scripting:** Eksekusi script JavaScript terisolasi (`pm.environment.set`, chaining token antar-request, custom `pm.test` & `pm.expect`)
- [x] **JSON Schema Validation:** Validasi otomatis struktur JSON response terhadap skema + tombol *Generate from Response*
- [x] **Collection Runner & Data-Driven Testing:** Jalankan seluruh folder/koleksi secara berurutan dengan iterasi file CSV/JSON dan export laporan JSON
- [x] **Drag-and-Drop & Nested Tree Lengkap:** Buat/hapus nested sub-folder, duplikasi request, drag-and-drop pindah/urutkan request, serta variabel level Collection & Folder
- [x] **OpenAPI 3.0 / 3.1 Import & Export:** Import spesifikasi OpenAPI/Swagger menjadi koleksi berfolder + Export koleksi ke OpenAPI 3.0.3
- [x] **Auth Lanjutan & Binary Upload:** OAuth 2.0 *Fetch Token* otomatis (`client_credentials`, `password`, `authorization_code`), AWS Signature v4, HTTP Digest Auth, OAuth 1.0a, dan Binary file upload
- [x] **Multi-Protocol Client:**
  - [x] GraphQL client (Query, Variables, Schema Introspection explorer)
  - [x] WebSocket interactive client (connect, send frame, live message stream)
  - [x] Server-Sent Events (SSE) stream viewer
  - [x] SOAP & gRPC-JSON request support
- [x] **Import / Export Format Tambahan:** HAR 1.2, Insomnia v4, Bruno (`.bru`), Postman Environment, dan Git-friendly native export (`.meofast.json`)
- [x] **CLI Runner (`@meofast/cli`) & Personal API Tokens (`mf_pat_...`):** Eksekusi koleksi di terminal & CI/CD (GitHub Actions, GitLab CI, Jenkins) dengan report HTML, JSON, dan JUnit XML
- [x] **Multi-Language Code Snippet Generator *(Bonus Power Feature)*:** Generate kode siap pakai (`cURL`, `JavaScript fetch`, `Node/TS`, `Python requests`, `Go`, `PHP`, `Rust`) langsung dari setiap tab request

---

## Phase 4 — API Documentation, Mock Server, Webhook Inspector & Debugging (Selesai)
- [x] **API Documentation & Playground:** Generate dokumentasi interaktif dari Collection lengkap dengan parameter, header, cURL, tombol *Try in Client*, dan export **Static HTML**
- [x] **Local & Workspace Mock Server:** Endpoint mock dinamis (`/api/v1/mock/<workspace>/...`) dengan dynamic tokens, stateful CRUD store (`GET`/`POST`/`DELETE`), simulasi latency (`ms`), simulasi error rate (`%`), hit counter, dan generate otomatis dari Collection
- [x] **Webhook Inspector:** URL penangkap webhook unik per workspace (`/api/v1/webhooks/in/<token>`), live payload & header viewer, verifikasi signature HMAC-SHA256, tombol *Send Sample Event*, dan *Replay Event*
- [x] **API Debugging, `.capsule` Format & Response Diff:** Simpan & download paket reproduksi bug `.capsule.json` dengan masking secret otomatis, replay dari tab *Capsules*, serta *Compare / Pin Baseline* untuk melihat line-by-line Response Diff

---

## Phase 5 — Performance Testing, Scheduled Monitoring, Collaboration & Optional AI (Selesai)
- [x] **Performance & Load Testing:** Simulasi concurrent virtual users di backend, pengukuran throughput (`req/s`), error rate, distribusi persentil latency (`min`, `avg`, `p50`, `p95`, `p99`, `max`), grafik distribusi latency, dan export JSON report
- [x] **Scheduled API Monitoring:** Pengecekan endpoint terjadwal, kalkulasi Uptime `%`, bar riwayat status probe, tombol *Check Now*, dan pengiriman alert webhook otomatis saat gagal
- [x] **Team Collaboration & Request Comments:** Sinkronisasi otomatis tree koleksi serta diskusi komentar anggota tim langsung pada setiap saved request
- [x] **Optional BYOK AI Assistant + Smart Test Generator:** Integrasi opsional (`OpenAI-compatible`, `Gemini`, `Ollama` lokal — nonaktif secara default tanpa paksaan cloud) dilengkapi penganalisa lokal deterministik untuk tombol *Auto-Generate Tests*
