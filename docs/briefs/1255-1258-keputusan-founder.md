# 1255-1258 Kartu dari keputusan founder 21 Nov

Sumber: `docs/founder/keputusan-2026-11-21.md` (founder: "setuju semua"). Setup, prinsip, gate, budget SAMA dengan `docs/briefs/1241-1247-rilis1-gelombang1.md`: base `milestone/m1` (6f418df53), worktree `../legend-<kartu>`, cabang `ws/<kartu>-<slug>`, fail-first, pra-gate AGENTS.md, commit + push, lapor SHA/merah->hijau/yang belum. Maks 40 tool call.

## 1255 reset kata sandi pelanggan lewat email (Sonnet, auth = tingkat K)
Fakta: login email+password aktif (`apps/api/src/lib/auth.ts:31`), tanpa pengirim email, tanpa lupa sandi. Founder: email dulu, WhatsApp sesudah.
- Pengirim email SMTP generik (bekerja dengan penyedia mana pun; jangan pilih vendor). Env `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, validasi di `config/env.ts` (semua atau tidak sama sekali), tambah ke `.env.example` dan `docs/production-credentials.md`. Dependency: `nodemailer` boleh (kecil, standar).
- Better Auth `sendResetPassword` (cek API versi terpasang lewat Context7). Token sekali pakai, kedaluwarsa 1 jam. Respons sama untuk email ada/tidak ada (tanpa bocor akun). Rate limit tetap.
- SMTP tidak dikonfigurasi: endpoint lupa sandi menjawab 503 jelas, tautan "Lupa kata sandi" di web disembunyikan (flag dari API/health atau config publik yang sudah ada).
- Web: layar lupa sandi + atur sandi baru di `_auth/`, teks ke katalog text-contract.
- Test: reset sukses, token kedua kali ditolak, email tak dikenal = respons sama, tanpa SMTP = 503. Jangan log token/email.
- Jangan nyalakan `requireEmailVerification` (bead terpisah bila perlu).

## 1256 Sentry (Sonnet)
Bead legend-17az7. `@sentry/node` di API, `@sentry/react` atau SDK TanStack Start di web (Context7). Aktif hanya bila `SENTRY_DSN` / `VITE_SENTRY_DSN` ada; tanpa DSN = no-op. Scrub: cookie, header auth, body, query, email, nomor HP (beforeSend). `sendDefaultPii: false`. Env ke `.env.example`, `config/env.ts`, `docs/production-credentials.md`. Test: tanpa DSN tidak init; beforeSend membuang cookie/authorization.

## 1257 sembunyikan fitur belum siap (Sonnet, web)
Bead legend-ff393. Di perangkat bersama: menu reservasi, Tanya AI KDS, operations/fasilitas disembunyikan dan route-nya `notFound()` (bukan 403 kosong). Cek juga menu di nav backoffice untuk reservasi/Tanya AI bila belum ada backend final; laporkan daftar yang disembunyikan. Test web/nav. Screenshot 390+1280 lewat `heavy` ke `docs/review/img/`. Tutup ff393 bila selesai.

## 1258 runbook refund manual (doc-writer)
Bead legend-mtbq9 dan keputusan no.2. `docs/runbooks/refund-manual.md` Bahasa Indonesia sederhana untuk manajer dan finance:
(a) Refund Duitku: transfer manual, persetujuan manajer, catat lewat layar/endpoint `settleRefundManually` (baca kode untuk langkah nyata).
(b) Refund penjualan kasir offline: tunai oleh manajer, lalu finance mengecek daftar pengecualian `edge_refund_unreconciled` (cabang 1244); cara menandai selesai bila ada.
(c) Yang tidak boleh: refund tanpa bukti penyedia (founder no.9).
Hanya dokumen; sebut berkas:baris sumber tiap langkah.

## 1259 tombol "catat refund manual" di layar refund (Sonnet ui-engineer, uang = tingkat K)
Temuan 1258: endpoint `settleRefundManually` (`packages/shared/src/payment/admin.ts:993`, route `payment-admin.routes.ts:364`) TIDAK punya layar; finance tidak bisa menutup refund Duitku manual (founder no.8). Tambah aksi di `apps/web/src/features/ws05-payment-admin/components/refund-followup-dialog.tsx` (atau refunds-panel) memakai pola dialog yang sudah ada: isian sesuai `manualRefundSettlementInputSchema` (tanggal transfer, jumlah = jumlah refund, referensi transfer, catatan), konfirmasi dua langkah, MFA sesuai pola layar admin lain, tampilkan kode tolak (409 REFUND_NOT_SETTLEABLE, REFUND_AT_PROVIDER, REFUND_PAYOUT_IN_FLIGHT, SETTLEMENT_AMOUNT_MISMATCH, 422 tanggal) dalam Bahasa Indonesia via katalog. Tombol hanya untuk pemegang `payment.reconcile` (presentasi; server tetap memeriksa). Idempotency key pola `attempt-key.ts`. Test web (hook + dialog), screenshot 390+1280 lewat `heavy` ke `docs/review/img/` untuk review founder. Lalu perbarui `docs/runbooks/refund-manual.md` bagian A memakai tombol itu.

## 1260 batch GL terparkir terlihat (Sonnet)
Bead "inventory_gl_blocked tidak terlihat". Base `milestone/m1` + merge `ws/1252-production-journals` (4544071e2) ke cabang `ws/1260-gl-blocked-visible`. (1) log warn terstruktur (pino, tanpa data pribadi) saat sumber diparkir di `inventory_gl_blocked`. (2) Tutup periode akuntansi: hitung baris `inventory_gl_blocked` periode itu; ada baris -> tampil di checklist/peringatan tutup buku yang sudah ada (cari service period close), atau tolak tutup bila pola checklist yang ada memang menolak. Pilih pola yang sudah dipakai untuk pengecualian lain. Test. Teks baru ke katalog.

## 1261 template deploy production lengkap (Sonnet)
Sumber `docs/qa/release-gate-audit-2026-11-21.md`. Base `int/batch106`. Cabang `ws/1261-deploy-template`. (1) `deploy/single-vm/runtime.env.example`: komentar production `:6,8`, buka `:25` MAINTENANCE_DATABASE_URL, betulkan `:74`, tambah blok STORAGE_S3_*, DUITKU_CALLBACK_BASE_URL/RETURN_URL, DOIT_REFUNDS_ENABLED/DOIT_RECURRING_ENABLED (=false), AI, selfie seal, opsional, SMTP_* dan SENTRY_DSN/VITE_SENTRY_DSN (dikomentari). (2) `docs/deployment.md:735` `read_body` 5m. (3) compose: `mem_limit` job migrate/provision-roles; service `clamav` (image resmi clamav/clamav versi tetap, mem_limit 1536m, healthcheck, volume definisi) + `CLAMD_HOST`/`CLAMD_PORT` di api env; catat di docs bahwa VM minimal 4 GB RAM. (4) `docs/production-credentials.md`: daftar final kunci yang diisi founder, dikelompokkan, plus langkah operator (firewall, Cloudflare, restore drill, uptime). Jalankan `deploy/single-vm/test-deploy.sh`, `node scripts/check-compose-env.mjs` bila ada, prettier.

## 1262 redrive dead-letter `stock.moved` (Opus, uang/stok = K)
Bead legend-fp3eu. Base `int/batch106` (memuat 1252). Cabang `ws/1262-stock-moved-redrive`. Cari dead-letter consumer inventory GL / outbox (tabel dead-letter + `retryBlockedInventoryGl`, `worker-main.ts`). Buat redrive per event: idempoten (event yang sudah terposting tidak dobel), hanya event yang gagal karena sebab sementara atau yang penyebabnya sudah diperbaiki, izin `accounting` yang ada + audit (aktor, alasan, event id). Endpoint API saja (layar menyusul) + CLI pola `set-gateway.ts`. Test fail-first: draw dead-letter -> redrive -> batch PRODUCTION_INCOMPLETE terposting sekali, GL 1301 = kartu stok; redrive kedua no-op; tanpa izin 403.
