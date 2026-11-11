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
