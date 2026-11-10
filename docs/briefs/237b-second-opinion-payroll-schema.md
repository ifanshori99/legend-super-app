# Brief Codex second-opinion: payroll (area gabungan, satu run)

File ini belum ada saat engineer `ws/payroll-caps` menulis; bagian di bawah dibuat olehnya. CTO: gabungkan dengan bagian skema `ws/payroll-schema-api` (f99d9d2e).

## Bagian: batas kasbon + reimburse (`ws/payroll-caps`, tingkat K uang)

- Rentang diff: `f99d9d2e..dd72324c (commit kode 75b11175 reimburse, 27603b9e kasbon + migrasi 0169, docs b591bb40 dan dd72324c)` (cabang `ws/payroll-caps`, worktree `.worktrees/payroll-caps`).
- Kartu: legend-8399r dan legend-fij0l (keduanya review). Migrasi `apps/api/drizzle/0169_payroll_loan_policy.sql` (+ snapshot 0169, journal idx 162).
- File: `apps/api/src/services/payroll-loans.service.ts` (`assertLoanAllowed`), `apps/api/src/db/schema/payroll.ts` (`payrollLoanPolicies`, unique index receipt), test `payroll-loans-caps.test.ts`, `apps/api/src/services/payroll-reimbursements.service.ts`, `apps/api/src/routes/payroll-reimbursements.routes.ts`, test `payroll-reimbursements-caps.test.ts` dan `payroll-reimbursements-api.test.ts`.
- Periksa: (1) batas bulanan di bawah advisory lock per karyawan+kategori+bulan, hitung submitted (jumlah klaim) + approved/paid (jumlah disetujui); cek ulang saat approve. (2) receipt: UUID, tenant sama, purpose `receipt`, outlet = outlet karyawan, umur maks 24 jam, sekali pakai (lock per ref). (3) `receiptUrl` ditandatangani sesudah transaksi lewat signer yang disuntik, respons idempotent tidak menyimpan URL. (4) factory route `createPayrollReimbursementRouters` tanpa perubahan nama ekspor.
- Periksa tambahan kasbon: (5) `assertLoanAllowed` di bawah advisory lock per tenant+karyawan saat ajukan dan setujui (hanya loan pending); lock order approve = FOR UPDATE baris lalu advisory. (6) tanpa baris policy = ditolak; kelipatan gaji pakai jumlah komponen `base_salary` aktif (disegel), tidak ada = 0. (7) migrasi 0169: RLS forced, REVOKE DELETE/TRUNCATE, CHECK, unique(tenant_id).
- Sudah diketahui (jangan dilaporkan ulang): klaim bisa diberi tanggal mundur ke bulan lama (aturan bisnis menunggu keputusan founder); `singleOpenLoan=false` tidak membatasi total kasbon terbuka (keputusan produk); belum ada endpoint/seed penulis policy kasbon; unique index receipt bisa gagal di DB integ dengan ref ganda; `core_storage_objects` tanpa kolom uploader; signer belum dipasang di bootstrap produksi.

---
## Bagian skema (dari ws/payroll-schema-api, 42ee5c28..f99d9d2e)
# Second opinion (Codex): payroll schema + config API (legend-gfcr)

Tingkat K: uang, migrasi, data pribadi gaji (HR-03). Mode baca saja, jangan edit.

- Repo: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payroll-schema-api`, cabang `ws/payroll-schema-api`, diff `git diff milestone/m1...ws/payroll-schema-api`.
- Kontrak: `packages/shared/src/hris/payroll/` (endpoints.ts, components.ts, policies.ts, statutory.ts, loans.ts, reimbursements.ts, service-charge.ts, run.ts, payslips.ts).
- PRD: `docs/PRD.md` §30 (sekitar baris 925-935), HR-03, PAYR-01..05, R20.
- Kartu: `bd show legend-gfcr` (catatan zjwa).

Periksa:
1. `apps/api/drizzle/0167_payroll_core.sql` + `apps/api/src/db/schema/payroll.ts` + `payroll.custom.sql`: celah RLS tenant/outlet, FK komposit, REVOKE/GRANT kolom, trigger `statutory_rates_guard` dan `payroll_runs_lock_guard` (bisa diakali?), CHECK yang tidak cocok kontrak.
2. HR-03: `apps/api/src/lib/payroll-sealed.ts` (AAD, versi kunci) dan pemakaiannya di `services/payroll-components.service.ts`. Apakah nominal gaji bocor ke audit, log, respons tanpa izin, atau kolom mentah?
3. Route `apps/api/src/routes/payroll-*.routes.ts` + service: izin per route sesuai header `endpoints.ts`, self route hanya baris milik sendiri (HR-01), idempotensi, transisi status, merge-lalu-parse ulang di `updatePayComponent`/`updatePayrollPolicy`.
4. Apakah desain tabel run (`payroll_runs`, `payslips`, `bank_transfer_files`, `payroll_tax_exports`) memaksa migrasi ulang untuk siklus run (legend-07eg)?

Laporan: temuan nyata saja, urut dari paling berat, `file:baris`, skenario gagal konkret, di bawah 600 kata.

## Tambahan sesudah brief ditulis

Commit 2145f2ea (reversed check COALESCE + payroll-core-db.test.ts), 74bac4d4 (tipe id + cursor statutory), 752ce641 (temuan architect putaran 2: pembayar ≠ pengaju, karyawan non-aktif, cursor 422, cancel kasbon). Review rentang `42ee5c28..HEAD`.


## legend-hjaot dan keputusan founder 9 Nov (cabang ws/payroll-loan-policy-api, dd72324c..5bda30ac)

- File: `apps/api/src/services/payroll-loan-policy.service.ts`, `routes/payroll-loan-policy.routes.ts`, `payroll-loans.service.ts` (`assertLoanAllowed`, jumlah total terbuka), `payroll-reimbursements.service.ts` (jendela 30 hari), `packages/shared/src/hris/payroll/loans.ts`, migrasi 0169 DIUBAH (kolom `max_total_open_idr`), test `payroll-loan-policy-api.test.ts`, `payroll-loans-caps.test.ts`, `payroll-reimbursements-caps.test.ts`.
- Periksa: PUT policy hanya payroll.run; audit tidak membocorkan data pribadi; total terbuka = sisa pokok kasbon lain + pengajuan di bawah lock per karyawan yang sama; jendela 30 hari memakai jam bisnis server; 0169 diubah di tempat sehingga DB yang sudah menjalankan 0169 lama tidak punya kolom baru.
