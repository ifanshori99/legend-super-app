# Fix legend-72we dari review architect (8 Nov)

Cabang `ws/fiscal-close-lock`, worktree `.worktrees/fiscal-close-lock`, commit dasar 03dd8b3. Tidak ada deadlock dan tidak ada posting ke periode tertutup. Betulkan:

1. **Medium: tutup memblokir insert lain selama snapshot.** Close mengambil entity `FOR UPDATE` (`accounting-period.service.ts:110`), bentrok dengan KEY SHARE implisit dari FK di 12 tabel yang merujuk `legal_entities` (outlets, employees, chart_of_accounts, journal_entries, budgets, fixed_assets, …), selama `cumulativeBalances` (`accounting-period-close.service.ts:161-202`) menjumlah seluruh riwayat jurnal. Posting terus-menerus juga bisa membuat close menunggu tanpa batas. Fix:
   - Close dan approve: `FOR NO KEY UPDATE`. Posting dan permintaan buka ulang: `FOR SHARE` (baris 98, 110, 166).
   - Snapshot = snapshot periode sebelumnya + baris periode ini (bukan seluruh riwayat).
   - `lock_timeout` pada close, kembalikan 409 yang bisa dicoba ulang.
   - Test baru: insert FK tak terkait (misal `outlets`) saat close berjalan tidak terblokir.
2. **Low:** buka ulang bisa diminta untuk periode tertutup yang bukan terakhir; tidak pernah bisa disetujui dan tidak bisa ditarik. Tambah cek periode tertutup lebih baru di `assertReopenRequestable` (`packages/shared/src/accounting/period.ts:199`).
3. **Low:** `getPeriodSnapshot` (`accounting-period-close.service.ts:335`) mengembalikan snapshot lama setelah periode dibuka ulang. Sertakan status dan versi periode.

Sudah dicatat sebagai kartu lanjutan (jangan dikerjakan di sini): guard DB di trigger `app.assert_journal_entry` untuk periode tertutup, dan `idr(Number(sum))` di atas 2^53.

Bukti selesai: test di `accounting-period-close.test.ts` lulus termasuk test baru, gate penuh (`heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `color.mjs`, `tenant-hardcode.mjs`), `git status` bersih, commit lokal merujuk legend-72we. Reviewer konteks segar cek diff. Jangan push/merge.
