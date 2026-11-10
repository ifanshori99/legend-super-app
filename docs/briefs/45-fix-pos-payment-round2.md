# Brief: fix putaran 2 — ws/pos-payment-fixes (temuan second-opinion Codex)

Cabang `ws/pos-payment-fixes` (HEAD 165f36d), worktree `.worktrees/pos-payment-fixes`. Kartu: legend-b0au, legend-94qt, legend-0gy1. Uang: tiap fix butuh test regresi yang gagal sebelum fix.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (file tidak bertumpuk). Pastikan `node_modules` worktree bukan symlink ke checkout utama (legend-meki): bila symlink, hapus lalu `pnpm install --offline --frozen-lockfile`.
Merge `main` dulu (ada fix flaky test c9e0c62; 422 di platform tenants bukan urusanmu).

## Kerjakan
1. **P1 pos-order-payment.ts:523** — intent `failed` menolak webhook sukses terlambat sebelum `payment.paid`. Setelah pelanggan bayar metode pengganti, uang QRIS lama hilang (tidak tercatat, tidak ada refund). Fix: settlement terverifikasi setelah failed masuk jalur dana terlambat yang idempoten (catat sebagai kelebihan/refund pending sesuai jalur pos-order-late-payment). Test: gateway gagal, bayar metode lain, webhook sukses, lalu replay webhook.
2. **P1 payment.service.ts:774 / createIntent:618** — pembatalan tidak menahan createIntent yang sedang menunggu gateway; POS terima tunai dan tutup link, lalu intent baru tetap disimpan. Fix: setelah memegang lock dan sebelum insert, cek ulang status/expiry link dan saldo; tolak bila sudah ditutup. Test: gateway tertunda bersamaan dengan pembatalan.
3. **P2 qr-order.service.ts:1615** — urutan lock QR checkout (DP lalu promo) terbalik dari POS (promo lalu DP), menyebabkan `40P01`. Fix: satu urutan lock untuk semua jalur. Test regresi konkuren.
4. **P2 pos-order-support.ts:711** — batas 15 menit approval telepon memakai waktu proses. Fix: pakai `approval_requests.decidedAt` level terakhir. Test: consumer/poll tertunda lebih dari 15 menit ditolak.
5. **Bukan di sini:** `approveRefund` (payment-admin.service.ts:380) masih stub 503 di main, jadi refund dana terlambat berhenti di `pending`. Sudah dicatat sebagai bead legend-rbjw. Cukup pastikan refund pending tercatat benar dan menahan saldo.

## Bukti selesai
Test terkait lulus, `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus, `git status` bersih, subagent reviewer konteks segar cek diff. Commit lokal merujuk kartu. Jangan push, jangan merge. Lapor per temuan: fix, test, commit.
