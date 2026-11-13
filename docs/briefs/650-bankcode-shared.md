# 650 bank_code karyawan: konteks bersama (legend-86he4)

Worktree: .worktrees/bankcode-650, cabang fix/employee-bank-code (dari ws/payroll-disbursement-manual).
Kolom `employees.bank_code` (text, CHECK ^[0-9]{3}$, nullable) sudah ada (db/schema/hris.ts:211). Tidak ada API yang mengisinya.

Rencana (engineer):
- packages/shared/src/hris/organization.ts: `updateEmployeePiiInputSchema` tambah `bankCode` (3 digit, dari daftar tetap, nullable agar bisa dikosongkan). Dipakai juga oleh createEmployee (piiInput). Respons detail (`employeePiiSchema`/`employeeDetailSchema`) ikut menampilkan `bankCode` (bukan rahasia, bukan masked).
- apps/api/src/services/hris-employee.service.ts: updateEmployeePii (~l.613) dan createEmployee (~l.809) tulis kolom `bankCode`, audit via recordAudit seperti bankAccount (tanpa nomor rekening di log; kode bank boleh di audit).
- Daftar kode bank tetap: ambil yang sudah ada di repo (cek packages/shared/src/hris/payroll, apps/api/src/lib/payroll-export/bank-formats.ts) atau buat konstanta di shared.
- Izin/scope: ikut izin field rekening (bankAccount) di route.

Bukti: item batch manual (payroll-payout-manual) tidak lagi `bank_code_missing` setelah bank_code diisi; 422 untuk kode tidak valid; tenant lain tidak bisa mengubah.
