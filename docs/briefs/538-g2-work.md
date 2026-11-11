# 538-G2 kerja bersama (worktree .worktrees/payroll-engine, cabang ws/payroll-engine)
Aturan: docs/briefs/538-gelombang-backend-umum.md dan 538-g2-payroll.md. Kartu: `bd show legend-<id>`.
Uang tingkat K: gaji tidak boleh dibayar lebih; periode run terkunci tidak boleh berubah; ragu -> aturan yang membatasi pembayaran, laporkan.
Migrasi 0350-0354 (nama berkas 03xx_*.sql + entri _journal.json idx lanjut dari 278, `when` > semua when m1 dan 0340-0341).
Tidak boleh menyentuh: payment-refund*, pos-order-corrections*, edge/catalog*, edge/promo*, edge-catalog-*, ai-gateway test, preflight 0301.

Kartu dan berkas:
- 8di9d: apps/api/src/services/payroll-components.service.ts (+ test), packages/shared/src/hris/payroll/components.ts, statutory.ts:661. Susun gross dari pay_components + lembur, hasil ke payslip.
- sko14 (setelah 8di9d, berkas payroll-statutory.service.ts): BPJS + THR berversi, snapshot tarif ke run terkunci. Pure calc statutory.ts:554,710.
- pf9u7: apps/api/src/services/payroll-service-charge.service.ts, distributeServiceChargePool (service-charge.ts:217), hris.ts:203.
- 8xf32: setEmployeePayComponent (payroll-components.service.ts ~532-548) tolak effectiveFrom <= periode run terkunci terakhir kecuali alur rapel. Lifecycle run: legend-07eg; hris-payroll-lock.ts.
- 7ui6v: apps/api/src/db/schema/payroll.ts:500-503 payroll_runs_distinct_approvers_check: tambah approved_by_finance <> created_by dan approved_by_hr <> created_by, lewat migrasi.

Catatan: 8di9d, 8xf32 berbagi payroll-components.service.ts -> berurutan.

## Peta Explore (12 Nov) dan aturan desain
Migrasi: tag 0350-0354, journal idx lanjut 279.., `when` mulai 1794420000000 (> 0340/0341 = 1794416000000/1794416100000).
- 8di9d: tidak ada gross/lembur/payslip. Tambah `computeEmployeeGross` di payroll-components*.service.ts: baca employee_pay_components aktif di periode (buka segel `sealPayrollAmount`), pisah earning/deduction, basis overtimeBase = monthlyBase untuk `computeOvertimePay` (statutory.ts:661, overtimeMinutes hris-attendance.ts:307), hasil ke PayslipCalculation tersegel. Aturan uang: tidak ada nominal negatif untuk earning, deduction tidak boleh membuat net < 0 (cap), tidak ada komponen ganda untuk periode yang sama, lembur dari menit absensi yang sudah disetujui saja.
- 8xf32: guard di setEmployeePayComponent setelah cek riwayat, sebelum penutupan baris: tolak 409 PAYROLL_PERIOD_LOCKED bila effectiveFrom <= periodEnd run terkunci/paid/reversed terakhir (legal entity karyawan). Alur rapel = di luar scope, tolak saja (catat di laporan).
- sko14: service baru payroll-statutory-calc*.service.ts (bukan CRUD) memanggil statutoryVersionsForRun + computeBpjsContribution + computeThr; snapshot tarif ke run terkunci, tambah hash parameter bila murah. Risiko: potongan karyawan tidak boleh melebihi upah (cap), THR tidak boleh melebihi thrWageIdr (plafon), THR ganda sudah dicegah index unik.
- pf9u7: payroll-service-charge.service.ts hanya punya list/create. Tambah calculate+distribute: satu transaksi, `FOR UPDATE` baris pool, hanya status approved -> distributed, idempoten (distributed ditolak), SUM(alokasi) == pool.amount_idr (tambahkan assert + tolak bila tak sama), pool terkait run terkunci tidak boleh berubah, peserta = karyawan aktif dengan service_charge_points > 0, pool>0 tanpa peserta -> ditolak (PAYROLL_INVALID_TRANSITION dari shared).
- 7ui6v: migrasi 0350: DROP lalu ADD payroll_runs_distinct_approvers_check dengan finance<>hr, finance<>created_by, hr<>created_by (NULL-guard seperti aslinya, pola 0278). Update schema payroll.ts:500. Cek data lama: tidak ada kode yang insert payroll_runs.

## pf9u7: nama fungsi service (dari test-writer, 12 Nov)
Test: apps/api/src/test/payroll-service-charge-distribution.test.ts (belum dijalankan; gagal-dulu karena fungsi belum ada). Di payroll-service-charge.service.ts:
- `calculateServiceChargePoolAllocations(scope, actorUserId, poolId)`: draft|calculated -> calculated, tulis ulang alokasi (idempoten), SUM == pool.amount_idr, tanpa peserta + amount>0 -> PayrollError PAYROLL_INVALID_TRANSITION, status lain ditolak PAYROLL_INVALID_TRANSITION, tenant lain 404.
- `distributeServiceChargePoolToRun(scope, actorUserId, poolId, { payrollRunId })`: approved -> distributed + payroll_run_id, `FOR UPDATE`; non-approved/distributed -> PAYROLL_INVALID_TRANSITION (409); run locked/paid/reversed -> 409 (PAYROLL_RUN_FROZEN atau PAYROLL_INVALID_TRANSITION); SUM(alokasi) != amount (kurang/lebih/kosong) -> 409 atau 422, pool tetap approved; pool/run tenant lain atau run tak ada -> 404.
- Asumsi: peserta = karyawan active, home_outlet = outlet pool, positions.service_charge_points > 0, employment type di rule.

## 8di9d signature (test-writer, 12 Nov)
Test: apps/api/src/test/payroll-gross-engine.test.ts (belum dijalankan). Signature yang dipakai test, di payroll-components.service.ts:
`computeEmployeeGross(ctx, userId, { employeeId, periodStart, periodEnd, payslipId, overtimeParameters: OvertimeParameters })` -> `{ grossIdr, deductionsIdr, netIdr, overtimeIdr, overtimeMinutes, lines: PayslipLine[], sealed: { calculation: Buffer, keyVersion } }`.
`sealed.calculation` = sealPayrollValue(JSON {grossIdr, deductionsIdr, netIdr, overtimeIdr, lines}) dengan binding {tenantId, table:"payslips", rowId: payslipId, field:"calculation"}.
Asumsi: jumlah komponen = baris berlaku pada periodEnd (tanpa prorata), komponen nonaktif dilewati; lembur = attendance_logs type 'out' dalam periode, validity valid (atau flagged lalu accepted), pending/rejected tidak dihitung, tier per hari (workday); lembur dasar = jumlah earning ber-overtimeBase; potongan dipotong dari displayOrder terakhir bila > gross; tanpa komponen -> nol & lines []; input salah -> error status 4xx (404 untuk karyawan tak ada/lintas tenant).

## sko14 test gagal-dulu: nama fungsi service (test-writer, 12 Nov)
Test: apps/api/src/test/payroll-statutory-calc.test.ts (belum dijalankan; gagal karena berkas service belum ada).
Service baru: apps/api/src/services/payroll-statutory-calc.service.ts, fungsi MURNI (tanpa DB), ekspor:
- `captureStatutoryForLock({ tables, payDate, types })` -> `{ statutoryVersions: StatutoryVersionRef[], statutoryParametersHash }` (sha-256 hex 64 char atas parameter versi yang dipin).
- `calculatePayrollRunStatutory({ run, tables, employees, thrAsOfDate })` -> `{ statutoryVersions, statutoryParametersHash, lines[] }`; `run = { status, payDate, configSnapshot: null | { statutoryVersions, statutoryParametersHash } }`. Pakai `statutoryVersionsForRun`, `bpjsRateOf`, `computeBpjsContribution`, `computeThr`; hash snapshot tak cocok -> PAYROLL_SNAPSHOT_MISMATCH.
- Tipe: `PayrollRunStatutoryRun`, `PayrollRunStatutoryEmployee` = `{ employeeId, joinDate, bpjsWageBaseIdr, thrWageIdr, payableWageIdr, jkkRiskClass, bpjsProgrammes[] }`.
- Baris: `{ employeeId, contributions[{type,baseIdr,capped,employerIdr,employeeIdr(setelah cap)}], employerBpjsIdr, employeeBpjsDeductionIdr (<= payableWageIdr), deductionCapped, thr: {tenureMonths, amountIdr (<= thrWageIdr)} | null }`. `thr` null bila `thrAsOfDate` null.
Asumsi: cap potongan terhadap `payableWageIdr`; bagian perusahaan tidak dipotong saat cap; programme mana yang menanggung pemotongan tidak diasersi (hanya jumlah). Wage negatif ditolak (throw).
