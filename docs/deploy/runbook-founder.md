# Runbook deploy cloud-only (untuk founder)

Dasar: `docs/design/cloud-only-release.md`. Rilis ini hanya cloud: tablet kasir, dapur dan captain bicara langsung ke server. Tidak ada mini PC (edge). Semua saklar edge mati dan dijaga skrip deploy.

Aturan rahasia: nilai tidak pernah masuk chat atau git. Kirim lewat `ghostex secret request`. Daftar rinci per kunci: `docs/production-credentials.md`.

## 1. Yang founder siapkan

| Apa                                 | Dipakai untuk                      | Isinya                                                        | Masuk ke                                                  |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| VPS (min 4 vCPU, 8 GB, Jakarta)     | Menjalankan semua layanan          | IP dan akses SSH                                              | Tim (lewat `ghostex secret request`)                      |
| Domain dan akun Cloudflare          | Alamat app, alamat API, sertifikat | Domain, akses DNS                                             | Cloudflare; `BETTER_AUTH_URL`, `WEB_URL`, `COOKIE_DOMAIN` |
| Duitku                              | QRIS, VA, e-wallet                 | Merchant code dan API key (sandbox dan production)            | Diketik di aplikasi (layar admin), bukan di berkas env    |
| KirimDev                            | Login dan reset PIN lewat WhatsApp | API key, webhook secret, nomor WhatsApp                       | `KIRIM_API_KEY`, `KIRIM_WEBHOOK_SECRET`                   |
| Storage backup (dua tempat berbeda) | Salinan database                   | Endpoint, bucket, access key, region, masing-masing satu akun | `pgbackrest.conf` (repo1 dan repo2)                       |
| Storage berkas (R2 atau S3)         | Foto, dokumen, PDF                 | Dua bucket (privat dan publik), access key                    | `STORAGE_S3_*`                                            |
| Sentry                              | Pantau error                       | Dua DSN (API dan web)                                         | `SENTRY_DSN`; `VITE_SENTRY_DSN` saat build web            |
| Email pengirim (SMTP atau Brevo)    | Login email, notifikasi            | Host, user, sandi, alamat pengirim; SPF dan DKIM di DNS       | `SMTP_*`, `EMAIL_FROM` atau `BREVO_API_KEY`               |
| Perangkat                           | Kasir                              | Tablet Android, printer thermal, lisensi RawBT, modem 4G      | Keputusan beli: founder                                   |

Catatan:

- Kunci inti (rahasia login, enkripsi data, PIN) dibuat tim di VPS dengan `openssl rand`. Founder tidak perlu membuat.
- Duitku production baru dipakai setelah bukti sandbox. `DUITKU_ALLOW_SANDBOX` selalu `false` di production.
- Saklar uang (`DOIT_REFUNDS_ENABLED`, `DOIT_RECURRING_ENABLED`) tetap `false`. Hanya founder yang menyalakan.
- Backup: repo2 harus akun dan lokasi lain dari repo1, supaya satu kegagalan tidak menghapus keduanya. Berkas R2 sendiri belum ikut backup database; atur versioning atau replikasi bucket di Cloudflare.

## 2. Langkah deploy (dikerjakan tim, founder menyetujui)

Pertama kali di VPS:

1. Pasang Docker. Tutup semua port kecuali 80 dan 443 dari alamat Cloudflare. Cloudflare: proxy aktif, SSL Full (strict).
2. Bangun image dari commit rilis: API, web (dengan `VITE_API_URL` dan `VITE_SENTRY_DSN`), worker, migrator, dan postgres dengan backup (`docker build -f deploy/backup/Dockerfile -t <nama:tag> .`). Perintah lain: `docs/deployment.md`, bagian "Docker images".
3. Salin `deploy/single-vm/compose.env.example` dan `runtime.env.example` ke luar repo. Satu berkas per proses (`api.env`, `web.env`, `worker.env`, `migrator.env`). Mode: `DEPLOYMENT_MODE=production`, `DATA_CLASSIFICATION=real`, `EDGE_MODE=false`. Semua saklar edge tetap `false`.
4. Isi `pgbackrest.conf` dari `deploy/backup/pgbackrest.conf.example` (mode 0600, pemilik `postgres`).
5. Cek tanpa menjalankan: `deploy/single-vm/deploy.sh --env-file /path/compose.env --dry-run`.
6. Nyalakan database saja: `docker compose --env-file /path/compose.env -f deploy/single-vm/compose.yaml up -d --wait postgres`.
7. Buat login migrasi (sekali): `deploy/single-vm/provision-roles.sh --env-file /path/compose.env --migrator`.
8. Migrasi dan buat login terbatas: `deploy/single-vm/provision-roles.sh --env-file /path/compose.env`.
9. Backup: di container postgres sebagai user `postgres`, jalankan `pgbackrest --stanza=legend stanza-create`, lalu `pgbackrest --stanza=legend check`, lalu `/usr/local/bin/legend-backup`. Pasang timer harian dari `deploy/backup/legend-backup.*.example`.
10. Naikkan semuanya: `deploy/single-vm/deploy.sh --env-file /path/compose.env`.
11. Cek: `GET https://<api>/api/health` menjawab ok dan `scanner: "ok"` (pemindai butuh beberapa menit pertama).
12. Daftarkan webhook KirimDev ke `https://<api>/api/webhooks/whatsapp` (`docs/runbooks/kirimdev-webhook.md`).

Deploy berikutnya: langkah 5 lalu 10 saja. `deploy.sh` berhenti sebelum migrasi bila ada saklar edge menyala, bila `DOIT_REFUNDS_ENABLED` atau setelan Duitku beda antara API dan worker, atau bila gerbang pre-deploy gagal.

## 3. Hasil latihan backup dan restore (27 Nov 2026)

Dijalankan di Mac (Colima), PostgreSQL 16 dan pgBackRest 2.60.1 dari `deploy/backup/Dockerfile`, memakai skrip repo apa adanya.

| Uji                                                                            | Hasil                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------ |
| `stanza-create` dan `check` (dua repo, terenkripsi)                            | Lolos, WAL terkirim ke repo1 dan repo2     |
| Backup penuh ke dua repo (data 30 MB)                                          | 14 detik                                   |
| Restore repo2 ke titik waktu T (setelah 300 baris, sebelum 200 baris terakhir) | 5300 baris, 0 baris sesudah T: benar       |
| Restore repo1 keadaan terakhir                                                 | 5500 baris: lengkap                        |
| Waktu restore dan start                                                        | sekitar 1-2 detik (data kecil, disk lokal) |

Temuan dan perbaikan:

- `restore-drill.sh` memeriksa database saat WAL masih diputar ulang (`in_recovery = t`), jadi angka bisa setengah jadi dan waktu pemulihan terlalu pendek. Sudah diperbaiki: skrip menunggu pemulihan selesai (maks 30 menit) sebelum mengecek. Terbukti: sebelum perbaikan pemeriksaan kedua masih `t`, sesudahnya `f`.
- Image postgres backup tidak punya folder `/etc/pgbackrest`; `compose.yaml` memasang berkasnya langsung, jadi aman di VPS.

Belum terbukti:

- Repo S3 asli (R2 atau Biznet) dan TLS-nya: latihan memakai folder lokal. Ulangi sekali di VPS dengan storage asli, dan catat RTO untuk ukuran data sebenarnya.
- Perilaku saat storage tidak terjangkau (WAL menumpuk, disk penuh) dan alarm backup terlewat.
- RPO nyata: batas teoritis sekitar 60 detik (`archive_timeout`), belum diukur di VPS.

## 4. Celah yang ditemukan audit

Sudah ditutup di cabang ini:

- Skrip deploy tidak menjaga saklar edge. Sekarang `deploy.sh` menolak bila `EDGE_MODE`, `EDGE_NODES_ENABLED`, `EDGE_FAILOVER_ENABLED` atau `EDC_AGENT_ENABLED` menyala di `api.env` atau `worker.env` (tes: `deploy/single-vm/test-deploy.sh`). Satu edge yang terdaftar tidak sengaja akan memblokir penjualan cloud di outletnya.
- `EDC_AGENT_ENABLED=false` ditambahkan ke `runtime.env.example`.

Belum, perlu keputusan atau kartu lain:

- KirimDev keluar (kirim pesan) belum terhubung di kode: `NOTIFICATION_WHATSAPP_PROVIDER` hanya menerima `disabled`, dan `KIRIM_API_KEY` belum dipakai di jalur produksi. Yang jalan hanya masuk dan reset PIN lewat WhatsApp (webhook masuk). Rencana "uji OTP dan notifikasi KirimDev" di dokumen rancangan butuh kartu kode dulu.
- Monitoring edge (`MONITOR_OPERATIONAL_ENABLED`) tidak berlaku untuk cloud-only; biarkan mati.
- Compose (`deploy/single-vm/compose.yaml`) tidak memuat layanan edge: sudah bersih.
