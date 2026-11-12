# 549 Payroll: temuan second opinion + formula lembur + rapel
Peran: engineer (~/.agents/team/roles/engineer.md). Worktree `.worktrees/payroll-engine`, cabang `ws/payroll-engine` (HEAD d6dce374). Jangan merge. Migrasi baru: 0381-0385, `when` di atas migrasi terakhir cabang.
Aturan founder: tiap perubahan uang dibuktikan test bahwa tidak ada yang dibayar lebih dan outlet tidak rugi. Ragu: pilih aturan yang membatasi pembayaran, laporkan.

Urutan (test gagal-dulu tiap butir, commit per butir):
1. P1 `apps/api/src/services/payroll-components.service.ts:879`: basis lembur dihitung per tanggal lembur dari riwayat komponen (tanggal efektif, baris nol, celah riwayat = basis 0). Regresi: lembur sebelum mulai dan sesudah komponen berhenti (contoh SO: basis Rp6 jt berhenti 11 Juni, lembur 20 Juni harus Rp0, bukan Rp52.023).
2. legend-g5v69 (`bd show`): gross lembur memakai formula yang dipatok `overtime_requests.formulaId` (helper `hris-overtime.service.ts:1024-1083`), bukan parameter pemanggil. Regresi: parameter baru lebih mahal tidak menaikkan bayaran request lama.
3. P2 `payroll-components.service.ts:503`: guard periode beku juga memeriksa run historis lewat karyawan→payslip→run (kasus outlet pindah badan hukum A→B lewat `org.service.ts:643-649`, run Juni A locked). Kunci baris yang sama.
4. P2 `apps/api/drizzle/0350_payroll_run_approvers_not_creator.sql:7`: keputusan CTO: constraint `NOT VALID` (berlaku untuk tulis baru), plus preflight query di runbook yang menghitung baris lama pembuat=approver; data lama tidak diubah. Test upgrade dengan baris lama.
5. Rapel legend-svqew (`bd show`; founder Q44: wajib sebelum rilis): selisih kenaikan backdate ke periode beku dihitung dan dibayar di run berikutnya sebagai komponen rapel; run lama tetap beku; jejak audit; persetujuan HR + finance; idempoten. Test wajib: tidak dibayar dua kali (run diulang, rapel dihitung ulang, dua kenaikan berurutan), penurunan gaji backdate tidak menjadi potongan otomatis tanpa persetujuan (laporkan pilihanmu), prorata per hari (founder Q43).
Paralel: Explore per butir, test-writer, implementer per butir (butir 1-3 berbagi file: satu worker berurutan), reviewer di akhir. Test terarah lewat `heavy`, tsc api/shared, eslint/prettier. Lapor dengan angka subagent, commit, dan apa yang belum diuji.
Jangan sentuh area edge, HRIS non-payroll, akuntansi, refund, CRM, inventory.
