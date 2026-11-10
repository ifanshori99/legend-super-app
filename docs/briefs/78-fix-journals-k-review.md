# Brief: engineer — perbaikan review K ws/journals (aafe04c)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/journals`, cabang `ws/journals`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus
1. Tinggi — `services/accounting-journal-manual.service.ts:728` (+ `:610`, `worker-main.ts:393`): jurnal manual macet permanen di `pending_approval` bila `postApproved` gagal (PERIOD_CLOSED / akun nonaktif) setelah chain approved. Withdraw/reject → `INVALID_TRANSITION`; consumer lempar ulang sampai event dead, `deliverEvent` untuk `approval.resolved` tak jalan. Fix: settle approved yang gagal karena periode/akun → `rejected` dengan alasan sistem (`decidedBy` null), consumer tangkap error domain ini. Test: chain approved lalu periode ditutup.
2. Sedang — `services/accounting-journal-recurring.service.ts:525-537` (`:508`): resume membuang bulan yang jatuh tempo saat template masih aktif (melewati `skipRecurringJournalPeriod` yang wajib periode closed + alasan). Fix: simpan `pausedAt` saat pause; resume hanya lompati bulan setelah jeda; tunggakan sebelum jeda wajib lewat skip-period; catat tiap bulan dilompati di `recurring_journal_runs` + audit.
3. Migration bentrok dengan main (0063–0067): merge `main`, renumber via drizzle-kit, jangan edit `_journal.json` tangan.

## Temuan architect
1. Tinggi — migration 0063–0065 bentrok dengan main, dan `when` cabang (0063 = 1794141926717) lebih kecil dari 0067 main (1794142693714). Drizzle 0.45 hanya menjalankan migration dengan `folderMillis` > `created_at` terakhir → 0063/0064 DILEWATI diam-diam, 0065 gagal "relation recurring_journal_runs does not exist". Fix: merge main, hapus 0063–0065 + snapshot, `drizzle-kit generate` ulang jadi 0068+ (skema, RLS custom, skips); sesuaikan test `upTo0064`.
2. Sedang — `accounting-journal-recurring.service.ts:601`: setelah merge, `assertPeriodOpenForPosting` dari main menolak posting ke bulan open/tanpa baris bila bulan sesudahnya closed; skip ditolak 409 `PERIOD_NOT_CLOSED` → template macet. Fix: izinkan skip bila posting ke bulan itu akan gagal `PERIOD_CLOSED` (helper `accounting-period.service.ts`).
3. Sedang — sama dengan temuan 1 reviewer (chain approved lalu periode ditutup/akun nonaktif → macet; consumer `handleJournalApprovalResolved` jangan melempar untuk kasus bisnis).
4. Rendah — sama dengan temuan 2 reviewer (resume membuang bulan; simpan `paused_at` atau tulis baris run skip per bulan).
5. Rendah — `:788-791`: kegagalan job hanya `console.error`, `{failed}` diabaikan `worker-main.ts`. Fix: `last_error`/`failed_at` di template atau notifikasi finance.
6. Rendah — `:432-440`, `accounting-journal-manual.service.ts:717-739`: penolakan oleh sistem tidak diaudit. Fix: `auditAccountingChange`.

## Bukti selesai
Test regresi per temuan; gerbang penuh (`heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs`); reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru.
