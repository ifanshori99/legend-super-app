# Brief: second-opinion — jurnal manual dan berulang (legend-vmyg)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/journals`, cabang `ws/journals`, SHA `aafe04c`.
Rentang diff: `git diff $(git merge-base main aafe04c)..aafe04c` (abaikan drizzle `meta/*.json`).

## Berkas berisiko
- `apps/api/src/services/accounting-journal-manual.service.ts`
- `apps/api/src/services/accounting-journal-recurring.service.ts`
- `apps/api/src/services/accounting-journal-approver.ts`
- `apps/api/src/services/accounting-journal-period-gate.ts`
- `apps/api/src/services/accounting-journal.service.ts`
- `apps/api/src/services/accounting-journal-consumers.ts`
- `apps/api/src/routes/accounting-journal.routes.ts`
- `apps/api/src/routes/accounting.routes.ts`
- `apps/api/drizzle/0063_accounting_journal_requests.sql`, `0064_accounting_journal_requests_rls.sql`, `0065_recurring_journal_skips.sql`

## Invariant (PRD)
- ACC-01: setiap jurnal seimbang. Jurnal final tidak bisa dihapus. Koreksi lewat jurnal pembalik.
- ACC-02: transaksi di periode tertutup ditolak kecuali periode dibuka ulang dengan approval.
- Matriks Approval: penyetuju selalu berbeda dari pemohon.
- Jurnal Manual & Berulang: jurnal umum, penyesuaian, dan berulang wajib approval.
- Tutup Periode: tutup bulan dengan snapshot saldo. Pembukaan ulang wajib alasan dan approval.
- Isolasi tenant dipaksa di setiap query dan setiap tabel baru.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
