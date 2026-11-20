# Checklist credential production integrasi eksternal

Untuk founder: dokumen ini mendaftar semua credential yang harus dipasang di production, dari mana mendapatkannya, URL yang didaftarkan di penyedia, cara mengujinya, dan apakah kodenya sudah siap.

**Dasar pemeriksaan.** Semua rujukan `berkas:baris` dibaca dari cabang integrasi `int/batch94` (komit `9aecc79a2`, 19 Nov 2026), karena cabang kerja ini tertinggal dan belum memuat kode pembayaran. Perintah untuk melihat satu rujukan: `git show int/batch94:apps/api/src/config/env.ts | cat -n | sed -n '276p'`. Setelah batch landing ke `milestone/m1`, nomor baris bisa bergeser; nama key dan path tetap.

**Cara membaca.**

- "Rahasia" berarti nilainya tidak boleh masuk chat, log, atau git. Kirim lewat `ghostex secret request`, jangan lewat chat.
- "Env" berarti variabel lingkungan server API (berkas `.env` production). "Layar admin" berarti diisi lewat aplikasi Legend, disimpan terenkripsi, dan hanya bisa ditulis (tidak bisa dibaca balik).
- Status kode: **Siap** (bisa dipasang dan dipakai), **Sebagian** (sebagian jalan, ada bead tersisa), **Belum** (belum ada kode yang bekerja).

## Ringkasan status

| Integrasi                             | Status kode        | Yang menahan                                                                         |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| Duitku (QRIS, VA, e-wallet, kartu)    | Sebagian           | Gerbang sandbox: `legend-7tqe8`, `legend-1yig6`; refund `legend-mtbq9`               |
| DOIT (pembayaran dan refund)          | Sebagian           | Akun, kunci, dan KYC dari founder: `legend-saov` (P0); saklar refund `legend-1nb85`  |
| EDC (mesin kartu bank)                | Belum              | Spesifikasi ECR dan terminal uji dari bank: `legend-mooi` (P0), adapter `legend-vpx` |
| KirimDev (WhatsApp, bukan kurir)      | Sebagian           | Pesan keluar `legend-w8dfz` (review)                                                 |
| Kurir / pengiriman                    | Belum ada kode     | Perlu konfirmasi founder, bead `legend-qgdp6`                                        |
| GoFood, GrabFood, ShopeeFood          | Belum              | Akses partner dari founder: `legend-9tzc` (P0), adapter `legend-im8n`                |
| Email (SMTP)                          | Sebagian           | Hanya untuk login member; tidak ada penyedia email transaksional                     |
| Web push (VAPID)                      | Sebagian           | `legend-ofq4f` sedang dikerjakan                                                     |
| AI (LLM)                              | Siap               | Kunci per tenant; rotasi terjadwal `legend-rg8yl`                                    |
| Object storage S3/R2                  | Siap (dua set key) | Lihat bagian Storage                                                                 |
| Login Google                          | Siap               | Hanya dua key                                                                        |
| Antivirus ClamAV                      | Siap               | Opsional                                                                             |
| Kunci inti (database, enkripsi, auth) | Siap               | Wajib semuanya                                                                       |
| Sentry (pemantau error)               | Siap               | Opsional; lihat bagian 11                                                            |
| SMS, vendor kunci pintu, vendor wifi  | Belum ada kode     | Lihat celah                                                                          |

## 0. Kunci inti production (wajib, bukan vendor)

Aplikasi menolak start di production bila ini kurang (validasi di `apps/api/src/config/env.ts`). Semua rahasia.

| Key env                                                                             | Fungsi                                                                                                                                               | Rujukan                                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                                                                      | Database PostgreSQL (login pemilik, untuk migrasi)                                                                                                   | `env.ts:83`                                                      |
| `APP_DATABASE_URL`                                                                  | Login database terbatas yang dipakai API; wajib di luar development                                                                                  | `env.ts:92`, `env.ts:867-877`                                    |
| `PAYOUT_GRANTOR_DATABASE_URL`                                                       | Login khusus langkah payout; API production tidak mau start tanpa ini                                                                                | `env.ts:97`, `env.ts:845-866`                                    |
| `BETTER_AUTH_SECRET`                                                                | Rahasia sesi login, minimal 32 karakter                                                                                                              | `env.ts:101-103`                                                 |
| `DATA_ENCRYPTION_KEY`                                                               | Kunci enkripsi semua credential di bawah (base64 dari 32 byte). Wajib di production. Jangan diganti sembarangan: rahasia tersegel jadi tidak terbuka | `env.ts:104-113`, `docs/deployment.md:595`                       |
| `STAFF_PIN_PEPPER`                                                                  | Rahasia PIN staf; harus berbeda dari `BETTER_AUTH_SECRET`; jangan dipasang di node edge                                                              | `env.ts:354-359`, `env.ts:813-843`                               |
| `CONTACT_HASH_SECRET`                                                               | Sidik nomor WA dan email; disarankan di production                                                                                                   | `env.ts:301-306`                                                 |
| `BETTER_AUTH_URL`, `WEB_URL`, `COOKIE_DOMAIN`, `PLATFORM_DOMAIN`, `TRUSTED_ORIGINS` | Alamat dan domain (bukan rahasia). Semua https di production                                                                                         | `env.ts:148-190`                                                 |
| `TLS_ASK_TOKEN`                                                                     | Rahasia kecil yang dikirim Caddy saat meminta izin sertifikat domain tenant (min 16 karakter)                                                        | `env.ts:351-353`, `apps/api/src/routes/platform-tls.routes.ts:4` |
| `SSR_SHARED_SECRET`                                                                 | Opsional, min 32 karakter; nilai sama di `api.env` dan `web.env`                                                                                     | `env.ts:247-250`, `docs/deployment.md:680`                       |
| `VITE_API_URL` (web)                                                                | Alamat API untuk browser; saat build, bukan rahasia                                                                                                  | `apps/web/src/lib/env.ts:7`                                      |

Cara uji aman: `GET https://<api>/api/health` harus menjawab status ok (`apps/api/src/routes/index.ts:197`). Daftar lengkap dan checklist keamanan ada di `docs/deployment.md` (bagian "Production environment" dan "Security checklist", baris 94 dan 673).

## 1. Duitku

- **Layanan dan fungsi.** Payment gateway Indonesia. Dipakai tamu membayar lewat QRIS, virtual account, e-wallet, dan kartu.
- **Credential (layar admin, per tenant, atau per outlet bila diisi).** Tersimpan terenkripsi, unik per tenant, outlet, dan penyedia (`apps/api/src/db/schema/platform-integrations.ts:2-3`, `:44`, `:85`).
  - Rahasia: `merchantCode`, `apiKey` (`packages/shared/src/platform/integrations.ts:200-201`).
  - Bukan rahasia: `environment` (`sandbox` atau `production`), `notificationEmail`, `vaName` (opsional, maks 20 huruf) (`integrations.ts:202-206`).
  - Layar: panel kredensial Duitku di `apps/web/src/features/ws05-payment-admin/components/duitku-credentials-panel.tsx`.
- **Credential (env).** Keduanya bukan rahasia dan wajib diisi supaya adapter Duitku aktif; bila kosong, adapter tidak terdaftar:
  - `DUITKU_CALLBACK_BASE_URL`: alamat publik API, https (`env.ts:272-278`).
  - `DUITKU_RETURN_URL`: halaman tujuan pelanggan sesudah bayar (`env.ts:279`).
- **Dari mana.** Dashboard Duitku: menu proyek/merchant, ambil Merchant Code dan API Key. Sandbox dan production punya pasangan berbeda. (Letak menu persisnya di dashboard Duitku: cek langsung di sana.)
- **URL yang didaftarkan di Duitku.** Callback: `https://<api>/api/webhooks/payments/duitku/<tenantId>`. Pola dari `apps/api/src/app.ts:410` (mount `/api/webhooks/payments`) dan `apps/api/src/routes/payment-webhook.routes.ts:168`; URL dibentuk di `apps/api/src/services/payment-duitku.ts:456`. Satu URL per tenant. Tanda tangan diperiksa dengan credential tenant (`apps/api/src/services/payment-duitku-webhook.service.ts:4`). Tidak ada IP whitelist di sisi Legend.
- **Cara uji aman.**
  1. Isi `environment = sandbox` dulu.
  2. Tekan tes koneksi di layar admin. Di belakangnya: `POST /api/org/integrations/:integrationId/test` (`platform-integrations.routes.ts:120-134`; hanya untuk payment gateway: `apps/api/src/services/payment-gateway-connection.service.ts:36-39`).
  3. Bayar satu transaksi sandbox, pastikan webhook masuk (tabel `gateway_webhook_events`, `apps/api/src/db/schema/payment-gateway-webhook.ts`).
  4. Baru pindah ke `production` dan ganti merchant code serta API key.
- **Status: Sebagian.** Bead terbuka: `legend-7tqe8` (cek domain `paymentUrl` dan field kartu di sandbox sebelum e-wallet dan kartu tamu dinyalakan, P1), `legend-1yig6` (bukti sandbox), `legend-mtbq9` (refund Duitku). Jangan nyalakan e-wallet dan kartu untuk tamu sebelum `legend-7tqe8` selesai.

## 2. DOIT

- **Layanan dan fungsi.** Payment gateway (pembayaran, refund, tagihan berulang). Perusahaan pemilik akun: PT Sultan Solusi Nusantara (menurut `legend-saov`).
- **Credential (layar admin Pengaturan Tenant, Integrasi).** Per tenant atau outlet, terenkripsi, hanya bisa ditulis (`apps/web/src/features/ws01-tenant-settings/integrations-lib.ts:101-140`).
  - Rahasia: `apiKey`, `webhookSecret`.
  - Bukan rahasia: `environment` (`sandbox` atau `production`), `merchantName`.
  - Hanya `webhookSecret` yang punya masa tenggang saat diganti (`integrations.ts:194-198`).
  - Layar: `kelola/pengaturan/integrasi` (`apps/web/src/routes/_kelola/kelola.pengaturan_.integrasi.tsx`).
- **Credential (env, saklar, bukan rahasia).** Dua-duanya mati secara bawaan, dan sebaiknya tetap mati sampai diverifikasi:
  - `DOIT_REFUNDS_ENABLED`: bayar refund lewat DOIT (`env.ts:255-261`). Bead `legend-1nb85` (P1) meminta saklar ini dirancang ulang sebelum dinyalakan.
  - `DOIT_RECURRING_ENABLED`: tagihan berulang (`env.ts:262-271`). Jalur adapter belum cocok dengan dokumentasi DOIT (`/v1/recurring/*` lawan `/v1/billing/*`); bead `legend-bcb4p`, `legend-p6key`.
- **Dari mana.** Akun merchant DOIT dari PT Sultan Solusi Nusantara, setelah KYC selesai (bead `legend-saov`, P0, butuh founder). Kunci API sandbox dan live dari dashboard DOIT. Secret webhook dibuat di sisi DOIT saat mendaftarkan URL di bawah.
- **URL yang didaftarkan di DOIT.** `https://<api>/api/webhooks/payments/doit/<tenantId>` (`payment-webhook.routes.ts:135`). Webhook refund dan tagihan berulang masuk ke URL yang sama. Header tanda tangan: `PayBridge-Signature: t=<unix>,v1=<HMAC-SHA256>` (`apps/api/src/services/payment-doit-wire.ts:12`, `:41`). Ada batas waktu tanda tangan dan pembatas gagal per IP dan tenant (`payment-webhook.routes.ts:33`). Tidak ada IP whitelist.
- **Cara uji aman.** DOIT tidak punya saklar sandbox di Legend: awalan kunci API yang menentukan sandbox atau live, dengan host yang sama `https://pay.doit.id` (`payment-doit-wire.ts:5`, `:37-39`). Pasang kunci sandbox dulu, tekan tes koneksi (sama dengan Duitku, `platform-integrations.routes.ts:120`), bayar satu transaksi uji, pastikan webhook masuk. Jangan memasang kunci live sebelum yakin.
- **Status: Sebagian.** Pembayaran dan webhook ada. Yang menahan: akun dan kunci dari founder (`legend-saov`), refund (`legend-1nb85`, `legend-0ogy`), tagihan berulang (`legend-bcb4p`, `legend-p6key`).

## 3. EDC (mesin kartu bank)

- **Layanan dan fungsi.** Mesin EDC bank (BCA, Mandiri, BNI, BJB menurut keputusan pemilik, `integrations.ts:19-22`) untuk bayar kartu di kasir.
- **Credential.** Tidak ada env rahasia dan tidak ada webhook. Per outlet, admin mengisi terminal di `payment_edc_terminals`: kode bank, terminal ID, merchant ID, jenis koneksi, alamat IP (`apps/api/src/db/schema/payment-admin.ts:28-42`). Layar: `apps/web/src/features/ws05-payment-admin/components/edc-panel.tsx`; API `/api/payments/admin/edc/terminals` (`apps/api/src/routes/index.ts:263`).
- **Env.** `EDC_AGENT_ENABLED` (bukan rahasia, bawaan mati). Nyalakan hanya di satu node edge utama yang memegang terminal outlet, dengan supervisor yang menyalakannya ulang (`env.ts:387-393`, `deploy/edge/legend-edge.service`).
- **Dari mana.** Dari bank: dokumen spesifikasi ECR (protokol sambung kasir ke EDC) dan terminal uji dari minimal dua bank. Ini kerja founder (bead `legend-mooi`, P0). Terminal ID dan merchant ID dari kontrak merchant tiap bank.
- **URL webhook.** Tidak ada. Agen edge memanggil terminal langsung lewat ECR (`apps/api/src/edge/edc/agent.ts:294`).
- **Cara uji aman.** Hanya ada simulator `EcrSimulator`, dan simulator ini sengaja melempar error di production (`apps/api/src/edge/edc/registry.ts:47-51`). Belum ada tombol tes koneksi di layar admin (tes hanya di dalam agen, `agent.ts:296`).
- **Status: Belum siap production.** Registry adapter production kosong sampai adapter bank didaftarkan (`registry.ts:37-38`). Bead: `legend-mooi` (P0, spesifikasi dan terminal uji, butuh founder), `legend-vpx` (adapter bank). Port dan protokol koneksi belum tercatat di kode, hanya alamat IP.

## 4. KirimDev (WhatsApp)

Catatan penting: di kode, **KirimDev adalah penyedia WhatsApp**, bukan kurir. Fungsinya: login pelanggan lewat WhatsApp (`MASUK <brand> <KODE>`) dan reset PIN slip gaji (`RESET PIN <KODE>`), lalu pesan keluar. Tidak ada kode kurir atau pengiriman barang (lihat celah).

- **Credential (env).**
  - `KIRIM_WEBHOOK_SECRET`: rahasia, boleh beberapa dipisah koma saat rotasi (`env.ts:307-318`). Bila kosong, webhook menjawab 503 (`apps/api/src/routes/identity-wa-webhook.routes.ts:54`).
  - `KIRIM_API_KEY`: rahasia, bentuk `kdv_live_` diikuti 24 karakter; hanya perlu untuk pesan keluar (`env.ts:319-329`).
  - `KIRIM_API_BASE_URL`: opsional, bawaan `https://api.kirimdev.com` (`env.ts:330-344`).
- **Credential (layar admin).** Per tenant: baris integrasi `whatsapp` berisi nomor penerima dan kata kunci login (`docs/deployment.md:668`). Pemetaan nomor pengirim per tenant atau outlet diisi admin platform (tabel `kirimdev_sender_mappings`; API `/api/platform/messaging/kirimdev-senders`, `routes/index.ts:205`).
- **Dari mana.** Dashboard KirimDev: buat akun dan paket, sambungkan satu nomor WhatsApp per tenant, selesaikan verifikasi Meta Business. `GET /v1/accounts` memberi `phoneNumberId`; `POST /v1/webhook_subscriptions` mengembalikan secret tanda tangan satu kali saja (`docs/deployment.md:660-669`).
- **URL yang didaftarkan di KirimDev.** `https://<api>/api/webhooks/whatsapp`, event `message.received`, difilter ke nomor tenant (`apps/api/src/app.ts:402-405`). Header: `X-Kirim-Signature`, `X-Kirim-Event-Id` (`identity-wa-webhook.routes.ts:62`). Tidak ada IP whitelist. Satu nomor hanya boleh aktif di satu tenant.
- **Cara uji aman.** KirimDev tidak punya sandbox. Jalankan uji production di `docs/runbooks/kirimdev-webhook.md` sekali sebelum rilis, dengan nomor sendiri. Pesan keluar tetap mati selama `NOTIFICATION_WHATSAPP_PROVIDER=disabled` dan `KIRIM_API_KEY` kosong (`docs/deployment.md:662`).
- **Status: Sebagian.** Webhook masuk siap. Pesan keluar produksi: `legend-w8dfz` (P1, review). Catatan: reset PIN slip gaji butuh nomor WhatsApp terverifikasi minimal 3 hari (`docs/deployment.md:671`).

## 5. GoFood, GrabFood, ShopeeFood

- **Layanan dan fungsi.** Pesanan dari aplikasi pesan-antar masuk ke KDS dan kasir Legend, plus sinkron menu, harga, dan stok habis.
- **Credential.** Dua tempat:
  - Env, satu rahasia per platform untuk seluruh sistem (bukan per tenant), boleh beberapa dipisah koma saat rotasi: `DELIVERY_GOFOOD_WEBHOOK_SECRET`, `DELIVERY_GRABFOOD_WEBHOOK_SECRET`, `DELIVERY_SHOPEEFOOD_WEBHOOK_SECRET` (`env.ts:345-350`). Platform tanpa secret dimatikan: webhook menjawab 503 (`apps/api/src/routes/delivery-webhook.routes.ts:70-74`).
  - Layar admin, per outlet: `storeId` (id toko di platform, tertulis di `delivery_channels.store_external_id`, `apps/api/src/db/schema/delivery.ts:66-67`) dan, per tenant, `clientId` serta `clientSecret` (rahasia) (`integrations-lib.ts:71-95`). Layar: Pengaturan, Integrasi, grup "ojol". Saat ini `clientId` dan `clientSecret` tersimpan tetapi belum dipakai kode mana pun, karena adapter belum ada.
- **Dari mana.** Dari portal mitra tiap platform (GoFood lewat GoBiz, GrabFood lewat Grab Merchant, ShopeeFood lewat Shopee Partner): akses partner dan API harus diajukan ke platform lebih dulu. Ini kerja founder (bead `legend-9tzc`, P0). Menu persis di portal: cek di portal masing-masing.
- **URL yang didaftarkan di platform.** `https://<api>/api/webhooks/delivery/<platform>` dengan `<platform>` salah satu `gofood`, `grabfood`, `shopeefood` (`app.ts:406-408`, `delivery-webhook.routes.ts:65`). Format tanda tangan buatan sendiri, bukan format asli platform: header `X-Delivery-Signature: t=<unix>,v1=<HMAC-SHA256>`, batas waktu 300 detik (`packages/shared/src/adapters/delivery-webhook.ts:6-24`). Skema asli tiap platform belum diketahui (`delivery-webhook.ts:2-10`), jadi URL ini belum bisa langsung dipasang di platform sungguhan. Tidak ada IP whitelist.
- **Cara uji aman.** Belum ada sandbox, health, atau tes koneksi untuk marketplace (tes koneksi hanya untuk gateway pembayaran).
- **Status: Belum.** Hanya kerangka: semua platform memakai `FakeDeliveryChannel` (`apps/api/src/services/delivery-ports.ts:4-6`, `:81`). Pesanan ojol saat ini dimasukkan manual lewat `apps/web/src/features/ws08-delivery/components/manual-order-sheet.tsx`. Bead: `legend-9tzc` (P0, akses partner, butuh founder), `legend-im8n` (P2, adapter nyata; juga mengingatkan risiko satu secret bersama antar tenant). GoBiz atau aplikasi pesan-antar lain: tidak ada kode dan tidak ada bead.

## 6. Email

- **Fungsi.** Pengiriman email login member (`legend-k2l`). Tidak ada email transaksional lain (struk, tagihan).
- **Credential (env).** Isi keempatnya bersama atau tidak sama sekali; bila kosong, login lewat email menjawab 503 (`docs/deployment.md:121-123`):
  - `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (rahasia), `EMAIL_FROM`; opsional `SMTP_PORT` (bawaan 465) dan `SMTP_SECURE` (`env.ts:503-511`).
  - Penyedia SMTP yang tertulis di kode: SumoPod `smtp.sumopod.com:465` (`apps/api/src/lib/email-sender.ts:11`, `:21`). Penyedia lain boleh, selama SMTP.
- **Dari mana.** Dashboard penyedia SMTP (menu SMTP atau kredensial pengirim). Domain pengirim harus diverifikasi lewat DNS (SPF dan DKIM) supaya email tidak masuk spam.
- **Webhook.** Tidak ada.
- **Cara uji aman.** Coba login email dengan alamat sendiri. Tidak ada endpoint tes khusus.
- **Status: Sebagian.** Layar integrasi `email` per tenant ada, tetapi adapter penyedia email per tenant belum ada (hanya antarmuka `EmailProvider`, `apps/api/src/services/notification-delivery.ts:51`).

## 7. Web push (notifikasi)

- **Credential (env).** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (rahasia), `VAPID_SUBJECT` (alamat `mailto:` nyata atau https), `NOTIFICATION_PUSH_PROVIDER` (`env.ts:535-540`; aturan subjek `env.ts:601-613`). Langganan perangkat disegel dengan `DATA_ENCRYPTION_KEY`.
- **Dari mana.** Buat sendiri, tanpa akun vendor: pasangan kunci VAPID (`npx web-push generate-vapid-keys`; dari paket `web-push`, belum dijalankan di sini).
- **Webhook.** Tidak ada. FCM tidak dipakai.
- **Status: Sebagian.** `legend-ofq4f` (P0, dikerjakan): menyambungkan registrasi langganan di web dan menyiapkan VAPID di env production.

## 8. AI (LLM)

- **Fungsi.** Fitur AI (misalnya ulasan, MCP). Penyedia dipilih per tenant.
- **Credential (layar admin, per tenant).** Penyedia kompatibel OpenAI atau lainnya, kunci terenkripsi (`apps/api/src/db/schema/ai-provider.ts:33`, bead `legend-dwrr`).
- **Credential (env, opsional, bawaan untuk seluruh sistem).** `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY` (rahasia), `ANTHROPIC_API_KEY` (rahasia), `AI_MODEL`, `AI_TIMEOUT_MS` (`env.ts:446-468`). Login ChatGPT/Codex bawaan mati (`AI_CHATGPT_ENABLED=false`, `env.ts:450`); butuh persetujuan pemilik tenant.
- **Dari mana.** Dashboard penyedia AI (menu API keys): OpenAI, Anthropic, atau penyedia kompatibel.
- **Rotasi kunci.** Job harian 03:15 Asia/Jakarta (`docs/deployment.md:466`, bead `legend-rg8yl`, sedang dikerjakan).
- **Cara uji aman.** Pasang kunci di satu tenant uji, jalankan satu fitur AI, cek biaya di dashboard penyedia. Batas pemakaian per tenant di sisi penyedia disarankan (kuota dan biaya, bukan di kode).
- **Status: Siap.**

## 9. Object storage (S3 atau R2)

Ada **dua set key yang berbeda**, untuk dua fitur berbeda. Dua-duanya opsional; bila kosong fiturnya mati, bukan error. Bila diisi sebagian, aplikasi menolak start.

- **Set A, unggahan umum (foto absensi, gambar menu, dokumen HRIS).** Rahasia: `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`. Bukan rahasia: `STORAGE_S3_PRIVATE_BUCKET`, `STORAGE_S3_PUBLIC_BUCKET`, `STORAGE_PUBLIC_BASE_URL` (https); opsional `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_FORCE_PATH_STYLE`. Rujukan: `.env.example:296-310`, `apps/api/src/services/core-storage-runtime.ts:15-27`. Tanpa set ini, unggahan menjawab 503.
- **Set B, dokumen hasil sistem (PDF statement bagi hasil, `legend-33im6`).** `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID` dan `OBJECT_STORAGE_SECRET_ACCESS_KEY` (rahasia), `OBJECT_STORAGE_PRIVATE_BUCKET`, `OBJECT_STORAGE_PUBLIC_BUCKET`, `OBJECT_STORAGE_PUBLIC_BASE_URL`, opsional `OBJECT_STORAGE_ENDPOINT`. Kedua bucket harus berbeda (`env.ts:524-530`, `env.ts:615-640`, `.env.example:104-115`). Tanpa set ini, statement tidak diterbitkan.
- **Dari mana.** Dashboard penyedia (AWS S3 atau Cloudflare R2): buat dua bucket (privat dan publik), lalu buat access key terbatas pada bucket itu. Untuk R2, isi endpoint.
- **Cara uji aman.** Unggah satu foto uji di tenant uji dan buka lewat tautan bertanda tangan; cek `GET /api/health` (pemindai).
- **Status: Siap.** Bead: `legend-dzh9q` (set A, selesai), `legend-33im6` (set B).

## 10. Login Google, antivirus, Redis

- **Login Google (pelanggan).** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (rahasia), isi keduanya atau tidak sama sekali (`env.ts:497-498`, `docs/deployment.md` bagian env, `.env.example:116`). Dari Google Cloud Console, menu Credentials, OAuth client; daftarkan redirect URL yang diminta Better Auth (`<BETTER_AUTH_URL>/api/auth/callback/google`, pola bawaan Better Auth: cek saat menguji). Status: Siap.
- **Antivirus ClamAV.** `CLAMD_HOST`, `CLAMD_PORT` (kosong berarti pemindai mati); `GET /api/health` melaporkan `scanner: ok | unavailable | disabled` dan tetap status 200 (`env.ts:476-477`, `docs/deployment.md:318`, bead `legend-w9hwh`). Status: Siap, opsional.
- **Redis.** `REDIS_URL` opsional (rahasia bila memuat password): berbagi batas laju antar instance API; tanpa Redis tiap instance menghitung sendiri (`env.ts:246`, `docs/deployment.md:343`). Pasang bila API lebih dari satu instance. Status: Siap.

## 11. Sentry (pemantau error)

- **Fungsi.** Melaporkan error tak terduga (500 di API, error di browser) supaya tim tahu tanpa membuka log (`legend-17az7`). Paket gratis cukup untuk tahap 1.
- **Credential.** Dua DSN dari satu proyek Sentry (bukan rahasia berat, tetapi jangan dibagikan):
  - `SENTRY_DSN` di env API (`apps/api/src/config/env.ts`, dipakai `apps/api/src/lib/sentry.ts`, dipasang di `apps/api/src/server.ts`).
  - `VITE_SENTRY_DSN` untuk web: diisi saat build image (`--build-arg VITE_SENTRY_DSN=...`, `apps/web/Dockerfile`), karena nilai VITE ikut tertanam di bundel browser.
- **Dari mana.** sentry.io: buat akun, buat proyek (platform Node untuk API, React untuk web, atau satu proyek untuk keduanya), lalu Settings, Client Keys (DSN). Dibuat oleh founder.
- **Kosong = mati.** Tanpa DSN tidak ada yang diinisialisasi dan tidak ada data keluar.
- **Data yang dibuang sebelum dikirim.** Cookie, header auth, isi request, query string, email, nomor HP, identitas pengguna (`packages/shared/src/sentry/index.ts`); `sendDefaultPii` mati.
- **Cara uji aman.** Pasang DSN di lingkungan staging, picu satu error uji, cek di dashboard Sentry bahwa tidak ada cookie atau email di event.
- **Status: Siap.** Belum dipasang di proses worker dan belum menangkap error render SSR web (hanya browser).

## Urutan pemasangan yang disarankan

1. **Kunci inti (bagian 0).** Tanpa ini aplikasi tidak start. Uji: `/api/health`.
2. **Storage (bagian 9), SMTP (bagian 6), dan Google (bagian 10).** Tanpa vendor berbayar yang berisiko uang, bisa dipasang kapan saja. Uji dengan akun sendiri.
3. **KirimDev (bagian 4).** Perlu verifikasi Meta Business yang lama: mulai paling awal. Uji dengan nomor sendiri.
4. **Duitku sandbox (bagian 1).** Selesaikan `legend-7tqe8` dan `legend-1yig6` dulu. Baru Duitku production, e-wallet dan kartu tamu sesudahnya.
5. **DOIT (bagian 2).** Sesudah KYC dan akun live (`legend-saov`). Pasang kunci sandbox dulu. `DOIT_REFUNDS_ENABLED` dan `DOIT_RECURRING_ENABLED` tetap mati.
6. **Web push (bagian 7).** Sesudah `legend-ofq4f` selesai.
7. **AI (bagian 8).** Kapan saja, pasang batas biaya di penyedia.
8. **EDC (bagian 3), lalu marketplace (bagian 5).** Menunggu bank dan platform; tidak bisa dipasang hari ini.

Aturan uang (jangan sampai rugi): untuk Duitku dan DOIT, uji dengan nominal kecil di sandbox, dan nyalakan refund (`DOIT_REFUNDS_ENABLED`) hanya setelah bead `legend-1nb85` selesai dan lewat test bukti tidak ada pembayaran berlebih.

## Celah: yang dikira ada tetapi kodenya belum ada

| Celah                                                                                                               | Bukti                                                                                                                                   | Bead                         |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Kurir atau pengiriman barang: tidak ada kode apa pun; KirimDev hanya WhatsApp                                       | Pencarian `kurir`, `courier`, `shipping` di `int/batch94` hanya menemukan kunci tes `apps/api/src/test/edge-hris-contracts.test.ts:300` | `legend-qgdp6`               |
| SMS (OTP atau notifikasi): tidak ada env maupun kode                                                                | `env.ts` tidak memuat key SMS                                                                                                           | `legend-2ggcc`               |
| Tombol tes koneksi untuk EDC dan marketplace: tes koneksi hanya untuk Duitku dan DOIT                               | `platform-integrations.routes.ts:127` memanggil `testGatewayConnection`                                                                 | `legend-w4wjv`               |
| Adapter marketplace asli (GoFood, GrabFood, ShopeeFood)                                                             | `delivery-ports.ts:4-6`                                                                                                                 | `legend-im8n`, `legend-9tzc` |
| Adapter EDC bank asli                                                                                               | `registry.ts:37-38`                                                                                                                     | `legend-vpx`, `legend-mooi`  |
| Vendor kunci pintu (`lock_vendor`) dan vendor wifi (`wifi_vendor`): ada di daftar provider tetapi tidak ada adapter | `integrations.ts:34`, `:36`                                                                                                             | `legend-s20` (ditunda)       |

## Yang belum terverifikasi (perlu dicek CTO)

- Letak menu persis di dashboard tiap penyedia (Duitku, DOIT, KirimDev, bank, platform ojol) ditulis berdasarkan praktik umum, bukan dibaca dari kode.
- Pola redirect URL Google (`/api/auth/callback/google`) berasal dari konvensi Better Auth, belum dibuktikan di kode.
- Perintah `npx web-push generate-vapid-keys` belum dijalankan.
- Apakah layar admin web Duitku ikut mendarat di `milestone/m1` (ada di `int/batch92` lewat `ghostex/duitku-fe-ws05`).
- Cakupan pasti `legend-wnkep` (pencairan gaji lewat Duitku, epic terbuka): tidak ada key env atau webhook yang ditemukan; belum masuk dokumen ini sampai kodenya mendarat.
