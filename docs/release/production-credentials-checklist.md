# Checklist kredensial dan pengaturan produksi (untuk founder)

Sumber: `.env.example`, `apps/api/src/config/env.ts`, `docs/deployment.md` (branch `milestone/m1`), dan `RESEAL_DATABASE_URL` dari `ws/1198-reseal-so1196`. Draf awal: nama dan status diambil dari `.env.example`; verifikasi detail terhadap `docs/deployment.md` sebelum rilis. Tidak ada nilai rahasia di berkas ini.

Legenda "Siapa": **F** = founder/akun penyedia, **K** = dibuat oleh kami (generate), **I** = infrastruktur/ops. "Rahasia" = simpan di secret store, jangan commit.

## A. Mode dan alamat

| Nama | Arti | Siapa | Wajib | Rahasia |
|---|---|---|---|---|
| NODE_ENV=production | Mode jalan Node | K | Wajib | Tidak |
| DEPLOYMENT_MODE=production | Menandai lingkungan produksi | K | Wajib | Tidak |
| EDGE_MODE=false | Server cloud (true hanya untuk kotak outlet) | K | Wajib | Tidak |
| DATA_CLASSIFICATION | `real` bila data asli, `synthetic` untuk uji | F memutuskan | Wajib | Tidak |
| BETTER_AUTH_URL, WEB_URL, VITE_API_URL | Alamat publik API dan web (HTTPS) | F (domain) | Wajib | Tidak |
| API_INTERNAL_URL | Alamat privat web ke API | I | Opsional | Tidak |
| TRUSTED_ORIGINS | Asal browser tambahan | F | Opsional | Tidak |
| COOKIE_DOMAIN, PLATFORM_DOMAIN | Domain cookie dan domain platform | F | Wajib bila multi-domain | Tidak |
| TRUST_PROXY (=2), WEB_TRUST_PROXY_HOPS (=2) | Jumlah proxy (Cloudflare + Caddy) agar IP asli terbaca | I | Wajib | Tidak |
| PUBLIC_RATE_LIMIT_* , PUBLIC_RATE_LIMIT_INTERNAL_IPS | Batas permintaan publik; IP jaringan internal compose | I | Opsional (ada default) | Tidak |
| LOG_LEVEL, LOG_SQL | Tingkat log | I | Opsional | Tidak |
| VITE_API_MOCK, VITE_API_MOCK_LATENCY_MS | Mode tiruan; harus kosong di produksi | K | Harus kosong | Tidak |

## B. Rahasia inti (dibuat oleh kami)

| Nama | Arti | Siapa | Wajib | Rahasia |
|---|---|---|---|---|
| BETTER_AUTH_SECRET | Kunci sesi login | K | Wajib | Ya |
| CONTACT_HASH_SECRET | Rahasia hash kontak | K | Wajib | Ya |
| STAFF_PIN_PEPPER (+ _CURRENT_VERSION) | Pepper PIN staf; berbeda dari BETTER_AUTH_SECRET; ganti = semua PIN reset | K | Wajib | Ya |
| DATA_ENCRYPTION_KEY / DATA_ENCRYPTION_KEYS / DATA_ENCRYPTION_ACTIVE_KEY_VERSION | Kunci enkripsi data sensitif (rotasi lihat docs) | K | Wajib | Ya |
| HRIS_PII_KEYS / HRIS_PII_ACTIVE_KEY_VERSION / BLIND_INDEX_ACTIVE_VERSION | Kunci data HR dan payroll | K | Wajib bila HRIS aktif | Ya |
| ATTENDANCE_SELFIE_SEAL_KEYS / _ACTIVE_KID | Kunci segel selfie absensi (keputusan founder Q88) | K | Wajib bila absensi selfie | Ya |
| SSR_SHARED_SECRET | Sama di api.env dan web.env, min 32 karakter | K | Opsional (disarankan) | Ya |
| TLS_ASK_TOKEN | Token sama untuk Caddy dan API (sertifikat domain kustom) | K | Wajib | Ya |
| MCP_TOKEN_TTL_SECONDS | Umur token MCP | K | Opsional | Tidak |

## C. Database dan antrean

| Nama | Arti | Siapa | Wajib | Rahasia |
|---|---|---|---|---|
| POSTGRES_USER / POSTGRES_PASSWORD (compose.env) | Superuser bootstrap Postgres; tanpa `$ \ "` | I | Wajib | Ya |
| MIGRATION_DATABASE_URL | Login migrator `legend_migrator_<16hex>` | K (script provision) | Wajib | Ya |
| DATABASE_URL = APP_DATABASE_URL | Login runtime `legend_runtime_<16hex>` (API+worker) | K | Wajib | Ya |
| WORKER_DATABASE_URL | Login antrean `legend_worker_<16hex>` (worker saja) | K | Wajib | Ya |
| PAYOUT_GRANTOR_DATABASE_URL | Login `legend_grant_<16hex>` (api.env saja) | K | Wajib (produksi) | Ya |
| MAINTENANCE_DATABASE_URL | Login `legend_maint_<16hex>`, retensi audit (worker) | K | Opsional | Ya |
| **RESEAL_DATABASE_URL** (baru, 1198; belum di m1) | Login `legend_reseal_<16hex>` untuk re-seal kolom beku; worker saja. Tanpa ini baris tabel beku dilewati dan kunci lama tidak bisa dipensiunkan. Jangan pakai login app/queue/migrator | K (provision-roles) | Opsional, wajib sebelum pensiun kunci lama | Ya |
| MIGRATION_LOCK_TIMEOUT / MIGRATION_STATEMENT_TIMEOUT | Batas waktu migrasi | I | Opsional | Tidak |
| REDIS_URL | Penyimpanan rate-limit bersama bila API lebih dari 1 instance | I | Opsional (wajib multi-instance) | Ya |
| WORKER_TRANSPORT=builtin | Transport outbox worker | K | Wajib (worker) | Tidak |

## D. Penyedia pihak ketiga

| Nama | Arti | Siapa | Wajib | Rahasia |
|---|---|---|---|---|
| DUITKU_CALLBACK_BASE_URL, DUITKU_RETURN_URL | Alamat callback dan halaman kembali pembayaran Duitku. Merchant code/API key Duitku tidak ada di env API; perlu dipastikan di docs apakah per-tenant di database | F (akun Duitku) | Wajib bila terima pembayaran | URL tidak |
| DOIT_REFUNDS_ENABLED, DOIT_RECURRING_ENABLED | Saklar refund dan langganan berulang (default false); API dan worker harus sama | F memutuskan | Opsional | Tidak |
| NOTIFICATION_EMAIL_PROVIDER (disabled/brevo), BREVO_API_KEY, NOTIFICATION_EMAIL_FROM, _FROM_NAME | Email notifikasi via Brevo; domain pengirim butuh SPF/DKIM | F (akun Brevo) | Provider wajib diset; kunci wajib bila brevo | API key ya |
| SMTP_HOST/PORT/SECURE/USER/PASS, EMAIL_FROM | Email masuk member via SMTP; semua atau tidak sama sekali | F | Opsional | PASS ya |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | Login Google; redirect `<BETTER_AUTH_URL>/api/auth/callback/google` | F (Google Cloud) | Opsional (keduanya atau tidak) | Secret ya |
| NOTIFICATION_PUSH_PROVIDER, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT | Notifikasi push alarm panik; di API dan worker. Buat sekali di server (`npx web-push generate-vapid-keys`) | K | Wajib agar alarm panik sampai ke HP | Private ya |
| NOTIFICATION_WHATSAPP_PROVIDER | Saat ini `disabled` (template WA belum ada) | K | Wajib diset | Tidak |
| KIRIM_API_KEY, KIRIM_API_BASE_URL, KIRIM_WEBHOOK_SECRET | WhatsApp Kirimdev: login pelanggan `MASUK`, reset PIN slip gaji. Perlu akun, nomor, verifikasi Meta, daftar webhook, baris `tenant_integrations` | F (akun Kirimdev/Meta) | Wajib bila WA dipakai | Ya |
| DELIVERY_GOFOOD/GRABFOOD/SHOPEEFOOD_WEBHOOK_SECRET | Rahasia webhook pesan-antar | F (portal mitra) | Opsional per kanal | Ya |
| STORAGE_S3_* (ACCESS_KEY_ID, SECRET_ACCESS_KEY, PRIVATE_BUCKET, PUBLIC_BUCKET, PUBLIC_BASE_URL, ENDPOINT, REGION, FORCE_PATH_STYLE) dan/atau OBJECT_STORAGE_* | Penyimpanan file S3 (Biznet Gio / R2). Dua kelompok nama ada; konfirmasi mana yang dipakai kode | F (akun storage) | Wajib | Key/secret ya |
| CLAMD_HOST/PORT/TIMEOUT_MS/MAX_* | Pemindai malware ClamAV untuk unggahan | I | Wajib bila unggah dipindai | Tidak |
| AI_PROVIDER, ANTHROPIC_API_KEY, AI_MODEL, AI_EFFORT, AI_BASE_URL, AI_API_KEY, AI_TIMEOUT_MS, AI_CHATGPT_ENABLED, AI_CHATGPT_MODEL | Fitur AI | F (akun Anthropic/OpenAI) | Opsional | Key ya |
| pgBackRest (2 repo terenkripsi: Biznet S3 + off-site) | Backup database; wajib latihan restore sebelum launch | F + I | Wajib | Ya |

## E. Hanya kotak edge (outlet)

EDGE_CLOUD_URL (wss://.../api/edge-link), EDGE_NODE_CREDENTIAL (muncul SEKALI saat registrasi di `/api/edge-nodes`, rahasia), EDGE_NODE_ROLE, EDGE_NODE_VERSION, EDGE_DEVICE_SYNC_*, EDGE_CREDENTIAL_ROTATION_GRACE_HOURS, EDGE_LINK_AUTH_*, EDGE_QUEUE_ACKED_RETENTION_DAYS, EDGE_SELFIE_*, EDGE_STATE_DIR, EDGE_OFFLINE_*, EDGE_QR_KEY_DAYS_AHEAD, EDC_AGENT_ENABLED. Semua opsional/berdefault kecuali URL dan credential. Edge butuh STAFF_PIN_PEPPER dan kunci segel selfie yang cocok dengan cloud.

## F. Langkah manual sekali jalan (docs/deployment.md)

1. Siapkan VM, Cloudflare Full (strict), batasi port 80/443 hanya ke IP Cloudflare (di security group atau DOCKER-USER; Docker melewati ufw). Jangan publikasikan Postgres, API, web, ask bridge.
2. Salin `deploy/single-vm/compose.env.example` ke luar repo; buat env terpisah api/web/worker/migrator.
3. Siapkan config pgBackRest, start Postgres, init stanza, pastikan base backup ke dua repo.
4. Buat login migrator: `deploy/single-vm/provision-roles.sh --env-file <compose.env> --migrator` (sebelum migrasi pertama).
5. Jalankan pre-deploy check (gerbang rilis 1, drift migrasi, cek duplikat langganan) lewat `docker compose ... --profile migration run --rm migrate node dist/predeploy-check.js`.
6. Jalankan migrasi (`pnpm db:migrate`) sekali per rilis. Rilis dengan migrasi refund (mis. 0496): hentikan API dan worker, migrasi, lalu start (jangan rolling).
7. Provision role runtime/worker/maint/grant (dan reseal dari 1198) SETELAH migrasi; deploy script tidak melakukannya. Restart API dan worker sesudahnya.
8. Daftarkan webhook Kirimdev (`POST /v1/webhook_subscriptions` ke `/api/webhooks/whatsapp`) dan isi `tenant_integrations`.
9. Generate VAPID, kunci enkripsi, pepper di server; simpan di secret store.
10. Urutan rilis edge: **cloud dulu, baru edge** (pepper, selfie seal, restore-proof 854 butuh cloud lebih dulu). Registrasi node edge di cloud, simpan credential sekali tampil.
11. Latihan restore backup, uji alert dan monitoring, verifikasi isolasi tenant dan penerbitan sertifikat domain kustom.

## G. Checklist keamanan (ringkas)
HTTPS + NODE_ENV=production; TRUST_PROXY sesuai hop; SSR_SHARED_SECRET sama di api/web atau sengaja kosong; rate limit sesuai venue; rate-limit bersama bila multi-instance; batas body di proxy; role `admin` dibatasi; keputusan verifikasi email dan reset password; tidak ada konten tak tepercaya di bawah COOKIE_DOMAIN.

## Catatan
- Terverifikasi CTO 20 Nov: (1) merchant code + API key Duitku diisi di aplikasi (menu integrasi pembayaran, disegel di database), bukan env; env hanya callback/return URL. (2) Dua kelompok storage sama-sama dipakai saat ini: STORAGE_S3_* untuk file inti (foto, nota, dokumen), OBJECT_STORAGE_* untuk slip bagi hasil. Isi keduanya dengan bucket yang sama sampai kartu penyatuan selesai. (3) 1198 mengubah docs/deployment.md (langkah reseal); daftar ini mengikuti versi 1198 setelah mendarat.
