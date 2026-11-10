# Brief: second-opinion — verifikasi fix putaran 2 pembayaran POS (legend-b0au, legend-94qt, legend-0gy1, legend-dahl)

## Peran
Baca `~/.agents/team/roles/second-opinion.md`. Read-only: jangan ubah kode, jangan commit. Hemat: fokus pada diff putaran 2 saja.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-payment-fixes`, cabang `ws/pos-payment-fixes`, HEAD `2f68a5c`. Diff putaran 2: `git diff 165f36d..2f68a5c` (abaikan isi merge dari main).

## Verifikasi temuan sebelumnya (CLOSED/OPEN dengan bukti)
1. P1 intent `failed` menolak webhook sukses terlambat → kini settlement terverifikasi setelah failed diterima sebagai pembayaran terlambat dan menghasilkan satu refund pending (`payment-lifecycle.ts`, `packages/shared/src/payment/index.ts`).
2. P1 `createIntent` balapan dengan pembatalan → cek ulang link di bawah lock (`payment.service.ts` ~:602-625).
3. P2 deadlock QR vs POS → urutan lock promo lalu DP di semua jalur (`qr-order.service.ts`, `lockSessionDeposit`).
4. P2 approval telepon 15 menit → dari `decidedAt` level terakhir (`pos-order-support.ts`).
5. Baru: order QR menunggu masa tenggang sebelum void; uang ke order QR yang sudah void → refund otomatis `system:qr` (`qr-order-late-payment.ts`).

## Fokus tambahan
Aturan baru WS-05 (settlement setelah `failed` diterima) berlaku lintas modul: pastikan POS, QR, reservasi tidak membukukan dua kali dan tidak ada jalur yang menerima settlement tanpa verifikasi gateway. Masalah baru dari diff ini.

## Laporan
Per temuan CLOSED/OPEN dengan bukti, lalu masalah baru urut paling berat: file:baris, skenario gagal, fix.
