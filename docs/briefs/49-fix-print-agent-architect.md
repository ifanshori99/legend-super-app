# Brief: fix review architect — ws/print-agent (legend-46p)

Cabang `ws/print-agent` (HEAD 71e9429), worktree `.worktrees/print-agent`. Tiap fix butuh test yang gagal sebelum fix.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (file tidak bertumpuk). Merge `main` dulu.

## Kerjakan
1. **Blocker edge-print.routes.ts:57-62** — `PRINT_WRITE_PERMISSIONS` sama dengan read; staf dapur (`kds.ticket.process`) bisa reprint struk dan laporan shift. Fix: `PRINT_WRITE_PERMISSIONS = ["pos.sale.create"]`; job `shift_report` juga butuh `shift.cash.view_all` atau `shift.cash.approve_close` di `reprintPrintJobForOutlet`. Test: user KDS-only dapat 403; kasir tanpa izin shift tidak bisa reprint laporan shift.
2. **Medium edge-print.routes.ts:143 + store.ts:114-127** — GET `/print-jobs` mengembalikan `content` penuh ke semua role baca. Fix: sembunyikan `content` tanpa `pos.sale.create`; `shift_report` hanya untuk pemegang `shift.cash.*`.
3. **Medium edge-print.service.ts:224-227** — retry job gagal fase write/sweep (`STALE_CLAIM_ERROR`) bisa mencetak salinan penuh tanpa tanda "CETAK ULANG". Fix: retry untuk kegagalan fase write/sweep lewat `markReprint` (job reprint baru) dan butuh izin reprint; retry kegagalan fase connect tetap biasa.
4. **Low edge-print.ts:111-115** — CHECK di DB: `device_path ~ '^/dev/(usb/lp|lp)[0-9]+$'`, port 9100-9102, host alamat LAN privat (bukan loopback/link-local). Migration via drizzle-kit, jangan edit `_journal.json`.
5. Risiko sisa (konfirmasi status printer setelah cetak) cukup dicatat sebagai bead.

## Bukti selesai
Test terkait lulus, `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus, `git status` bersih, subagent reviewer konteks segar cek diff. Commit lokal merujuk legend-46p. Jangan push, jangan merge. Lapor per temuan.
