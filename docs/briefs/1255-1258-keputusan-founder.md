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
