# Brief: second-opinion — tindak lanjut jurnal payroll (legend-75kr, legend-k8sz, legend-1coh)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payroll-journal-followups`, cabang `ws/payroll-journal-followups`.
Rentang diff: `git diff 12c91f6b..ws/payroll-journal-followups` (base `milestone/m1` 12c91f6b; abaikan `apps/api/drizzle/meta/*.json` dan `docs/`). Jangan pakai `merge-base main`.

## Berkas berisiko
- `packages/shared/src/accounting/posting-rules.ts` (PAYROLL_JOURNAL_LINES, `payroll.locked#service_charge_expense`, `employee_loan.disbursed#cash/#bank`)
- `packages/shared/src/accounting/payroll-journal.ts` (amount keys `lateDeductionsIdr`, `customDeductionsIdr`)
- `packages/shared/src/accounting/coa.ts` (role `payroll_custom_deduction`, `POSTING_ROLE_ALLOWED_TYPES`, `accountMappingIssues`, `payrollLockedVariant`)
- `packages/shared/src/hris/payroll/payslips.ts` (`customDeductionsIdr` default 0, refine)
- `packages/shared/src/hris/payroll/events.ts` (`disbursedVia` opsional)
- `apps/api/src/services/payroll-gl-consumer.ts` (pemilihan varian, cross-check reversal)
- `apps/api/drizzle/0155_payroll_custom_deduction_role.sql` (backfill mapping)

## Invariant (PRD)
- §3 Jurnal Payroll, PAYR-04, PAYR-05: jurnal payroll.locked seimbang untuk semua totals yang lolos schema; reversal mencerminkan entri yang benar-benar terposting.
- Potongan custom (titipan, misal iuran koperasi) bisa diarahkan ke liabilitas; LATE tetap mengurangi Beban Gaji. Totals lama tanpa `customDeductionsIdr` terposting persis seperti sebelumnya.
- Pembayaran service charge lewat payroll tidak pernah mendebit akun pendapatan, termasuk mapping lama yang sudah salah tipe.
- Kasbon: `disbursedVia` bank mengkredit bank, cash mengkredit kas kecil; event lama tanpa field tetap kas kecil.
- Backfill 0155 idempoten, tidak mengubah/menghapus mapping yang ada, lintas tenant (RLS FORCE dikembalikan).

## Effort
xhigh (uang dan migrasi).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
