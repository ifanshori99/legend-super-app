# Brief: engineer (Opus) — WS-05 adapter multi-gateway (ganti gateway) + Duitku

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Latar
Founder, 10 Nov: DOIT hanya dipakai di awal. Admin tiap brand (tenant) dan Super Admin harus bisa mengganti gateway. Gateway kedua: Duitku (https://docs.duitku.com/payment-gateway/). PRD v1.7 D11 dan §2 "Payment gateway": adapter multi-gateway dikonfigurasi di Super Admin dan per tenant; §4 Super Admin mengatur "gateway yang tersedia". Kartu lama `legend-pa21` (Duitku, pascarilis) ditarik ke m1 oleh kartu ini.

Yang sudah ada di m1 (petakan dulu dengan `Explore`, jangan tulis ulang):
- `apps/api/src/services/payment-gateway.ts`: `PaymentGatewayPort` (health, createIntent, getStatus, channels, methods, cancel). Satu adapter DOIT (`payment-doit.ts`) dengan kredensial per outlet lewat `tenant_integrations` (`db/schema/platform-integrations.ts`).
- `payment-routing.service.ts`: aturan per metode, tenant (outlet null) atau override outlet, `provider` + `fallbackProvider`.
- CHECK constraint `provider IN ('doit','duitku', ...)` sudah ada di `pos_order_tenders` dan `gateway_webhook_events`.
- `gateway_webhook_events` (simpan-lalu-proses, dedupe), poller DOIT pending (`ws/doit-pending-poller`, batch43), failover "bayar di kasir" (`legend-8vgid`).
- UI admin routing (`legend-sgg`) dan panel platform "gateway tersedia" (`legend-y6s`) sudah ada: cek endpoint apa yang mereka harapkan.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/gateway-adapter-duitku` dari `milestone/m1` ujung terbaru. Syarat: m1 sudah berisi batch43 (`git log --oneline -30 milestone/m1` memuat merge `ws/doit-pending-poller`). Belum: lapor ke CTO dan berhenti. Worktree `.worktrees/gateway-adapter-duitku`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Disk Mac sempit: jangan buat worktree tambahan.

Migrasi bila perlu: `0211`, `when` 1794290000000, satu migrasi.

Cabang lain yang menyentuh area pembayaran dan belum masuk m1: `ws/split-bill` (`payment.service.ts`, `qr-order-payment.ts`, `qr-order-consumers.ts`). Hindari mengubah berkas itu; bila terpaksa, ubah sesempit mungkin dan sebut di laporan.

## Tujuan
`legend-pa21` + kartu baru adapter (lihat `bd show` kartu yang di-associate CTO). Tingkat K: uang, kredensial, webhook.

1. Registry gateway: port dipilih per provider, bukan satu adapter global. Pemanggil (payment link, POS, refund, poller, health/failover) meminta adapter lewat provider dari aturan routing atau dari intent yang sudah ada (intent lama tetap di gateway asalnya walau aturan diganti; PAY-05).
2. Super Admin: daftar gateway yang tersedia di platform (nyala/mati per gateway, gateway bawaan untuk tenant baru), izin tingkat platform, audit. Mematikan gateway tidak memutus pembayaran yang sedang berjalan.
3. Admin tenant (brand): pilih gateway dari daftar yang dinyalakan Super Admin, per metode, tenant-wide dan override outlet (pakai aturan routing yang ada), isi kredensial merchant sendiri (tersimpan terenkripsi seperti DOIT, tidak pernah dikirim balik utuh), tes koneksi. Pakai izin `org.settings.manage` yang ada.
4. Adapter Duitku yang memenuhi port: buat transaksi (inquiry v2), status transaksi, daftar metode aktif dari endpoint Duitku (bukan ditulis tetap), callback dengan verifikasi signature dan nominal, sandbox dan production lewat konfigurasi. Metode: QRIS, VA, e-wallet, kartu sesuai yang dilaporkan endpoint. Baca dokumentasi resmi Duitku lewat subagent `web-fetch`; jangan tebak rumus signature.
5. Webhook Duitku: route sendiri, simpan-lalu-proses di `gateway_webhook_events`, idempoten, lalu `confirmPayment` seperti DOIT. Refund Duitku: bila API refund tidak ada atau berbeda, jangan buat jalur baru; tandai butuh refund manual lewat jalur yang ada dan buat kartu.

Mulai dengan `Explore` (paralel: port dan adapter DOIT; routing dan integrasi tenant; webhook dan poller; endpoint yang diharapkan UI `legend-sgg`/`legend-y6s`) dan `web-fetch` untuk dokumentasi Duitku. Desain registry, skema konfigurasi platform, dan aturan perpindahan gateway lewat satu subagent `architect`, catat di `docs/DECISIONS.md`. Sesudah desain: registry dan konfigurasi platform/tenant, adapter Duitku, dan webhook Duitku lewat `implementer` paralel di berkas terpisah.

## Keputusan founder
Dijawab founder 10 Nov:
- Q72: Super Admin menyalakan gateway yang boleh dipakai dan gateway bawaan; admin brand (tenant) memilih dari daftar itu dan mengisi akun merchant miliknya sendiri (uang langsung ke brand, Legend tidak memegang dana).
- Q73: dua gateway boleh aktif bersamaan per metode, dengan cadangan otomatis saat gateway utama gangguan.
- Q74: Duitku dibangun sekarang, sebelum rilis pertama; dinyalakan per brand begitu akun Duitku ada.

Catatan CTO: repo 119connect (`/Users/ifanshori99/Projects/119connect-portal-alumni`) punya modul penyedia pembayaran. CTO sedang memeriksa kecocokannya; hasil dan bagian yang boleh dipindahkan ditambahkan di sini. Bila sudah ada, pindahkan bagian itu (klien HTTP Duitku, rumus signature, test) alih-alih menulis ulang.

## Kartu
Awal: `ghostex board associate <kartu>` untuk kartu adapter dan `legend-pa21`, `bd update <id> --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa. UI yang perlu berubah: kartu terpisah, jangan kerjakan.

## Scope
Boleh: `payment-gateway*.ts`, adapter DOIT bagian registry, `payment-duitku*.ts` baru, routing, integrasi tenant bagian gateway, konfigurasi platform gateway, route webhook Duitku, migrasi 0211, `packages/shared/src/payment/*` dan `platform/*` bagian gateway, `config/env.ts` (nama key baru di `.env.example`, nilai kosong), test. Jangan: UI web, jurnal akuntansi (cukup pastikan provider baru lolos aturan jurnal yang memakai daftar provider), split bill, settlement/rekonsiliasi, sub-merchant DOIT (F49).

## Rahasia
Jangan baca `.env*`. Test pakai mock HTTP Duitku dan kredensial palsu. Akun sandbox Duitku dari founder belum ada: jangan minta di chat; tulis di laporan nama key yang dibutuhkan.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS bila ada tabel baru.
- Test gagal-dulu: tenant memilih gateway yang dimatikan Super Admin ditolak; ganti gateway tidak memindahkan intent yang sedang berjalan (status dan webhook tetap ke gateway asal); callback Duitku dengan signature salah atau nominal beda ditolak dan tidak menandai lunas; callback ganda hanya sekali; isolasi tenant dan outlet pada kredensial dan aturan; kredensial tidak pernah keluar di respons atau log; cadangan otomatis memakai gateway kedua saat yang utama `down`; alur DOIT yang ada tetap lulus.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'` untuk test baru dan semua test pembayaran yang memakai service yang berubah; sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- Typecheck api dan shared lewat `heavy` sekali; eslint + prettier berkas berubah, daftar berkas ditulis ke berkas sementara lalu `xargs` (jangan ekspansi array zsh di satu baris). Jangan `pnpm check` penuh atau `pnpm test` penuh.
- Review tingkat K: satu subagent `architect` untuk diff gabungan.
- Tulis brief Codex `docs/briefs/302b-second-opinion-gateway-adapter.md` (uang: xhigh), jangan dijalankan.

## Laporan
Sekali di akhir: keputusan desain, SHA, migrasi (`when`, prevId), bukti, file berubah, kontrak untuk UI, nama key env baru, kartu baru, risiko, jumlah subagent dan puncak bersamaan.
