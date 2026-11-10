# Brief 174b: second opinion — balanced payroll journal (legend-s8a3, tingkat K)

Peran: `second-opinion` (Codex, `gpt-6.1-sol`, effort xhigh: uang dan migrasi). Baca `~/.agents/team/roles/second-opinion.md`. Read only. Jangan mengubah kode, commit, atau push.

Repo: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payroll-journal`, cabang `ws/payroll-journal`. Diff: `git diff 7b486d73..ws/payroll-journal`.

## Yang diubah

- Placeholder `payroll_run.completed` diganti `payroll.locked` dan `payroll.reversed` (jurnal balik PAYR-05) di `packages/shared/src/accounting/posting-rules.ts`; jumlah dihitung `payrollJournalAmounts(totals)` di `packages/shared/src/accounting/payroll-journal.ts`.
- `payrollRunTotalsSchema` (`packages/shared/src/hris/payroll/payslips.ts`) membawa `pph21EmployerBorneIdr`, `pph21RefundIdr`, `pph21EmployerRefundIdr` dengan invariant `pph21 = W + B + R − rf − erf`.
- Role baru `reimbursement_expense` (6110) dan `pph21_borne_expense` (6111); aturan `employee_loan.disbursed` dan `reimbursement.paid#cash` mengkredit `petty_cash` 1102.
- Migrasi data `apps/api/drizzle/0134_*.sql`: backfill akun 1204/6110/6111 dan mapping `employee_receivable`/`reimbursement_expense` untuk setup lama.

## Periksa

1. Bukti seimbang: debit = gross − rf + bpjsCo + B + R = kredit, untuk semua kombinasi (telat, pinjaman, B, refund karyawan dalam gross, refund perusahaan, piutang dan tagihannya, pph21 negatif). Cari kasus di mana identitas totals bisa lolos schema tapi jurnal tidak seimbang atau salah akun.
2. Benar secara akuntansi Indonesia: B dan refund perusahaan di 6111 Beban PPh 21 Ditanggung Perusahaan (koreksi fiskal), potongan telat/custom mengurangi Beban Gaji, cicilan kasbon mengkredit Piutang Karyawan 1204, refund karyawan mengurangi utang PPh 21, service charge mendebit Utang Service Charge 2106.
3. Jurnal balik `payroll.reversed` = cermin persis jurnal lock.
4. Migrasi: idempoten, hanya menambah, aman bila tenant punya akun 1204/6110 buatan sendiri, RLS dan trigger `0027` dihormati, tidak bentrok dengan provisioning (cabang `ws/provisioning-race` mengubah lock backfill CoA).
5. Kontrak event: perubahan totals schema (strict) terhadap fixture dan konsumen lain.

## Laporan

Temuan berurut dari paling parah: file:baris, skenario gagal dengan angka Rupiah, saran perbaikan. Tidak ada temuan: tulis itu.
