# Latihan rilis 2026-11-25: deploy dan Caddy (bagian A, brief 1265)

Cabang `ws/1265-release-rehearsal`. Semua nilai env buatan sendiri (dummy) di folder scratch;
tidak ada rahasia, server, VM, domain, atau layanan luar yang disentuh (hanya `docker pull caddy:2.10-alpine`).

## Deploy

| Perintah                                                                                                                                                                  | Hasil                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `deploy/single-vm/deploy.sh --env-file <dummy> --dry-run` (docker nyata, env dari `compose.env.example` + `runtime.env.example` dipecah jadi api/web/worker/migrator.env) | exit 0, "Validated compose configuration"                                                             |
| `deploy/single-vm/test-deploy.sh`                                                                                                                                         | exit 0                                                                                                |
| `deploy/backup/test-scripts.sh`, `deploy/backup/restore-drill.test.sh`                                                                                                    | exit 0                                                                                                |
| `deploy/edge/test-check-edge-host.sh`, `deploy/edge/test-image-version.sh`                                                                                                | exit 0                                                                                                |
| `node --test tests/deployment-env.test.mjs tests/monitoring-*.test.mjs` (deploy/monitoring)                                                                               | 27 dari 29 lulus; 2 gagal hanya karena butuh DB sekali pakai (`pnpm test` yang menyiapkan), bukan bug |

### Nama kunci env

- Contoh env dimuat lewat `apps/api/src/config/env.ts` (api dan worker, worker lewat penanda `role-worker`) dan `apps/web/src/lib/env.server.ts` dengan nilai dummy: lulus setelah placeholder diganti.
- Semua kunci di `runtime.env.example`/`compose.env.example` dibaca kode; semua kunci di `docs/production-credentials.md` ada di kode. Tidak ada kunci salah nama.
- Placeholder `replace_me` memang ditolak validator (`TLS_ASK_TOKEN` < 16 karakter, bucket publik = privat); itu perilaku yang benar.
- Api tanpa `PAYOUT_GRANTOR_DATABASE_URL` di produksi berhenti dengan pesan jelas; worker dikecualikan (benar, sesuai `provision-roles.sh`).
- `VITE_API_URL` hanya build-arg web (terdokumentasi di `docs/deployment.md`), bukan env runtime.

### Skenario gagal (semua berhenti sebelum menyentuh database)

| Skenario                                                                                       | Hasil                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| env file hilang                                                                                | exit 1 "Environment file not found"                                                                          |
| path relatif                                                                                   | exit 2 usage                                                                                                 |
| env layanan (api.env) hilang                                                                   | exit 1; sebelumnya hanya pesan umum, kini ikut "the file named by API_ENV_FILE is not readable" (diperbaiki) |
| `DOIT_REFUNDS_ENABLED` api beda worker, atau hilang di salah satu (deploy nyata tanpa dry-run) | exit 1 "Refund flag check failed: nothing was started", tidak ada container                                  |
| URL role salah format / api dan worker beda login                                              | exit 1 "Role provisioning refused: ..."                                                                      |
| `MIGRATION_DATABASE_URL` di api.env                                                            | exit 1 "keep it in migrator.env only"                                                                        |
| role belum ada (audit setelah migrasi)                                                         | hanya lewat stub `test-deploy.sh` (audit gagal, layanan tidak start). Belum dicoba dengan Postgres nyata     |

## Caddy (`caddy:2.10-alpine`, tag dipin di `compose.yaml`)

- `caddy validate`, `caddy adapt`, `caddy fmt --diff`: lulus untuk `deploy/caddy/Caddyfile`. `Caddyfile.edge.example` lulus dengan sertifikat sementara buatan sendiri.
- Smoke lokal (salinan tanpa TLS di port 8080, upstream tiruan di jaringan docker):
  - Header keamanan: Caddy menggantikan nilai app, tidak dobel (HSTS tanpa includeSubDomains, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin).
  - Batas body: JSON 150 kB lolos, 3 MB 413; multipart dan PUT 11 MB lolos, 13 MB 413.
  - `X-Forwarded-Host` selalu diganti host asli; peer tak tepercaya: XFF diganti alamat peer; peer tepercaya (disimulasikan): XFF dilanjutkan dan Caddy menambah peer, jadi `TRUST_PROXY=2` mengambil IP klien (client, Cloudflare, Caddy).
  - WebSocket (`/api/emergency/ws`, notifikasi realtime): tetap hidup lewat `read_body` 6 dtk dan `idle` 5 dtk (versi pendek), jadi timeout 5m/2m aman.
  - `/api/internal/tls/ask` dan variasi huruf besar, encoding, `//`, `/./`: 404.
  - Tidak ada direktif `log`: log akses mati, tidak ada token/cookie/query yang ditulis.

### Diperbaiki

1. `/api/internal` (tanpa garis miring akhir) lolos ke API; kini 404 (Caddyfile cloud dan edge).
2. Header `X-Tls-Ask-Token` kiriman klien diteruskan ke API di jalur publik; kini dibuang (`header_up -X-Tls-Ask-Token` di semua proxy publik).
3. Front edge tanpa batas body; kini `max_size 12MB`. README edge dan `docs/deployment.md`: `TRUST_PROXY=1` di edge, karena tanpa itu semua perangkat outlet berbagi satu bucket rate limit.
4. Pesan `deploy.sh` saat env layanan hilang kini menyebut penyebabnya.
5. Bukti: `deploy/caddy/test-caddyfile.sh` (baru), kasus env hilang di `deploy/single-vm/test-deploy.sh`.

## Sisa (butuh VM atau founder)

- Daftar IP Cloudflare di `trusted_proxies` cocok dengan daftar yang saya ketahui; belum dibandingkan dengan `cloudflare.com/ips` (tanpa akses luar).
- TLS on-demand, penerbitan sertifikat ACME, Cloudflare Full (strict), dan firewall 80/443 hanya dari Cloudflare: perlu VM dan domain.
- Penanganan apex/www dan domain tenant bergantung pada pemeriksaan domain aktif oleh API (`ask`); belum diuji tanpa DB tenant nyata.
- Audit role dengan Postgres dan image migrator nyata, serta `deploy.sh` tanpa `--dry-run`: perlu image terbangun di VM.
- Log error Caddy (bukan log akses) bisa memuat URI dengan query; tidak ada token di path saat ini.
