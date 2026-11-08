# Brief: engineer — perbaikan review K ws/journals (aafe04c)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/journals`, cabang `ws/journals`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus
1. Tinggi — `services/accounting-journal-manual.service.ts:728` (+ `:610`, `worker-main.ts:393`): jurnal manual macet permanen di `pending_approval` bila `postApproved` gagal (PERIOD_CLOSED / akun nonaktif) setelah chain approved. Withdraw/reject → `INVALID_TRANSITION`; consumer lempar ulang sampai event dead, `deliverEvent` untuk `approval.resolved` tak jalan. Fix: settle approved yang gagal karena periode/akun → `rejected` dengan alasan sistem (`decidedBy` null), consumer tangkap error domain ini. Test: chain approved lalu periode ditutup.
2. Sedang — `services/accounting-journal-recurring.service.ts:525-537` (`:508`): resume membuang bulan yang jatuh tempo saat template masih aktif (melewati `skipRecurringJournalPeriod` yang wajib periode closed + alasan). Fix: simpan `pausedAt` saat pause; resume hanya lompati bulan setelah jeda; tunggakan sebelum jeda wajib lewat skip-period; catat tiap bulan dilompati di `recurring_journal_runs` + audit.
3. Migration bentrok dengan main (0063–0067): merge `main`, renumber via drizzle-kit, jangan edit `_journal.json` tangan.

## Temuan architect
(menyusul)

## Bukti selesai
Test regresi per temuan; gerbang penuh (`heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`); reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru.
