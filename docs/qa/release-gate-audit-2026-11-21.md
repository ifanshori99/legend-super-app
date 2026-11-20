# Audit gerbang rilis 21 Nov 2026 (`int/batch106`, baca saja, architect)

Kesimpulan: kode tidak memblok. Celah ada di template deploy, satu nilai docs salah, dan langkah operator. Perbaikan template = kartu 1261.

## 1. Security checklist (`docs/deployment.md` ~:723)
| Butir | Status | Bukti / perbaikan |
|---|---|---|
| HTTPS + NODE_ENV=production | OK | `env.ts:771-784`, `runtime.env.example:5,83-84` |
| TRUST_PROXY sesuai hop | OK | `env.ts:199-205`, example `=2` |
| 80/443 hanya Cloudflare | KURANG (operator) | firewall cloud/DOCKER-USER + uji curl dari IP non-Cloudflare |
| SSR_SHARED_SECRET, WEB_TRUST_PROXY_HOPS | OK | `env.ts:187` |
| Rate limit publik + rule Cloudflare `/api/qr/` | KURANG (operator) | default ada `env.ts:145-173`; rule Cloudflare belum |
| COOKIE_DOMAIN | OK | `auth.ts:818` |
| Satu instance API | OK | compose |
| Batas body/slow upload | KURANG (docs) | Caddyfile `read_body 5m`, docs `:735` bilang 60s -> ubah docs |
| Batas per user AI | OK | `ai-gateway.service.ts:308-309` |

## 2. Deployment checklist (~:974) dan `deploy/single-vm`
| Butir | Status | Bukti / perbaikan |
|---|---|---|
| Batas memori | OK | postgres 768m, api 512m, web 512m, worker 384m, caddy 128m; job migrate/provision-roles tanpa batas (opsional) |
| Healthcheck | OK | Caddy tanpa healthcheck (opsional) |
| TLS | OK kode | on-demand TLS + ask token; operator: Cloudflare Full (strict) |
| Header keamanan | OK | Caddyfile, web `start.ts:26-31` |
| pgBackRest | OK | WAL archive, backup.sh, 2 repo S3 terenkripsi, timer 02:00 |
| Restore drill | OK, belum pernah dijalankan | operator jalankan `backup/restore-drill.sh`, catat waktu |
| ClamAV | KURANG | tanpa service, upload PDF 503 (`deployment.md:348,363`) -> keputusan CTO: tambah service (kartu 1261) |
| Alarm + uptime luar | KURANG (operator) | `monitoring/README.md:21` |

## 3. Env (kode vs `runtime.env.example`)
KURANG: komentar production untuk DEPLOYMENT_MODE/DATA_CLASSIFICATION (`:6,8`); MAINTENANCE_DATABASE_URL masih dikomentari (`:25`) padahal wajib worker production (`production-config.ts:151-156`); komentar STAFF_PIN_PEPPER_CURRENT_VERSION salah (`:74`, kode default 2); belum ada STORAGE_S3_* (6), DUITKU_CALLBACK_BASE_URL, DUITKU_RETURN_URL, DOIT_REFUNDS_ENABLED, DOIT_RECURRING_ENABLED, ANTHROPIC_API_KEY/AI_PROVIDER, ATTENDANCE_SELFIE_SEAL_KEYS/_ACTIVE_KID, kunci rotasi opsional (HRIS_PII_KEYS, DATA_ENCRYPTION_KEYS, BLIND_INDEX_ACTIVE_VERSION), opsional VAPID_*, PLATFORM_DOMAIN, KIRIM_API_KEY, DELIVERY_*_WEBHOOK_SECRET, CLAMD_*, REDIS_URL.
OK: RESEAL_DATABASE_URL, SMTP_* (1255), VITE_API_URL. SENTRY_DSN: cek ulang sesudah 1256 digabung.

## Langkah operator (di akhir, bersama kredensial)
Firewall + bukti curl, rule Cloudflare + Full (strict), restore drill dicatat, uptime check luar.
