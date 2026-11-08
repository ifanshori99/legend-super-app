# Sub-brief: perbaikan review K ws/journals (legend-vmyg)

Worktree `legend/.worktrees/journals`, cabang `ws/journals`, sudah merge `main` (eafb6b1d). Migration cabang 0063–0065 sudah dihapus; dibuat ulang di akhir (0068+) oleh engineer. Jangan baca `.env*`, jangan `pkill`, jangan edit `apps/api/drizzle/**` atau `_journal.json`.

Akar file:

- `apps/api/src/services/accounting-journal-manual.service.ts` (postApproved ~:728, :610, penolakan sistem :717-739)
- `apps/api/src/services/accounting-journal-recurring.service.ts` (pause/resume :508-537, skip :601, penolakan sistem :432-440, job failures :788-791)
- `apps/api/src/services/accounting-journal-consumers.ts` (`handleJournalApprovalResolved`)
- `apps/api/src/worker-main.ts` (:393 job + consumer)
- `apps/api/src/services/accounting-period.service.ts` (`assertPeriodOpenForPosting`, dari main)
- `apps/api/src/services/accounting-journal-period-gate.ts`
- `apps/api/src/db/schema/accounting-journal-requests.ts`
- Test: `apps/api/src/test/accounting-journal.test.ts`

## T1 — jurnal manual macet setelah chain approved (Tinggi)

Bila `postApproved` gagal karena PERIOD_CLOSED / periode terkunci / akun nonaktif setelah chain approved, jurnal tetap `pending_approval` selamanya. Fix: settle jadi `rejected` dengan alasan sistem (`decidedBy` null) + `auditAccountingChange`; consumer `handleJournalApprovalResolved` tangkap error domain bisnis ini (jangan lempar ulang), error infra tetap dilempar. Sama untuk template berulang bila ada jalur serupa. Test regresi: chain approved lalu periode ditutup → jurnal `rejected`, tak ada ledger, consumer tidak lempar; varian akun nonaktif.

## T2 — resume membuang bulan jatuh tempo (Sedang)

Resume saat ini melompati bulan yang jatuh tempo sebelum jeda. Fix: kolom `paused_at` di `recurring_journals`, diisi saat pause, dikosongkan saat resume. Resume hanya melompati bulan yang mulai jatuh tempo setelah `paused_at`; tunggakan sebelum jeda tetap wajib lewat `skip-period` atau dijalankan. Tiap bulan yang dilompati karena jeda dicatat sebagai baris `recurring_journal_runs` (skipped, `skipped_by` = aktor resume, `skip_reason` sistem) + audit. Test regresi.

## T3 — skip ditolak padahal posting akan gagal (Sedang)

Setelah merge, `assertPeriodOpenForPosting` menolak posting ke bulan open/tanpa baris bila bulan sesudahnya closed. Skip menolak 409 `PERIOD_NOT_CLOSED` → template macet. Fix: skip diizinkan bila posting ke bulan itu akan gagal `PERIOD_CLOSED` (pakai/ekspos helper dari `accounting-period.service.ts`, mis. probe tanpa efek samping). Test regresi: bulan N tanpa baris/open, N+1 closed → skip N sukses.

## T4 — kegagalan job senyap (Rendah)

Kegagalan per template di job hanya `console.error`. Fix: kolom `last_error` (varchar) + `failed_at` di `recurring_journals`, diisi saat gagal, dikosongkan saat sukses; `{failed}` dicatat di `worker-main.ts` (log terstruktur). Test.

## T5 — penolakan sistem tidak diaudit (Rendah)

Penolakan oleh sistem (rantai kedaluwarsa, approver tak berizin, T1) panggil `auditAccountingChange`. Test: baris audit ada.

## Skema

Kolom baru di `recurring_journals`: `paused_at timestamptz null`, `last_error varchar(500) null`, `failed_at timestamptz null`. Hanya engineer yang mengedit file schema.

## Pembagian (status: schema + migration 0068/0069 sudah di-commit b02386d2)

- Implementer M (manual): T1 + T5 untuk jurnal manual dan consumer. File: `accounting-journal-manual.service.ts`, `accounting-journal-consumers.ts`, `accounting-journal-approver.ts` bila perlu. Test BARU di `apps/api/src/test/accounting-journal-manual-settle.test.ts` (tiru setup dari `accounting-journal.test.ts`, jangan edit file itu; perlu helper bersama → lapor).
- Implementer R (recurring): T2, T3, T4 + T5 untuk template berulang. File: `accounting-journal-recurring.service.ts`, `accounting-period.service.ts` (helper probe, tambah saja, jangan ubah perilaku yang ada), `accounting-journal-period-gate.ts`, `worker-main.ts`, `accounting-journal.routes.ts` / `packages/shared/src/accounting/*` hanya bila DTO perlu kolom baru. Pemilik `accounting-journal.test.ts` (betulkan test lama yang rusak karena merge/perubahan); test regresi baru di `apps/api/src/test/accounting-journal-recurring-fixes.test.ts`.
- Jangan commit. Jangan edit schema/migration.

## Menjalankan test

`LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` dari root worktree (DB sekali pakai). `pnpm --filter @starter/api exec tsc --noEmit` untuk typecheck. Laporan: ringkas, file berubah, hasil test (angka lulus/gagal).
