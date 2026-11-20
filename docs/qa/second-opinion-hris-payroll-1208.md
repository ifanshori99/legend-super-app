# SO HRIS + payroll (1208, 20 Nov, architect, int/batch100)
Verdict: TIDAK (2 P1 uang). Temuan lama 777, 852, 955/1007 tertutup.
## P1 Satu karyawan ikut dua run payroll periode sama (dua kebijakan)
`payroll-run-simulate.service.ts:574-576` pilih karyawan dari badan usaha + employmentType saja; `packages/shared/src/hris/payroll/policies.ts:90-96`, `payroll-policy.service.ts:213-230` hanya tolak kode kelompok sama; slip unik per run (`0167_payroll_core.sql:205`). STAFF [pkwtt,pkwt] + MANAJER [pkwtt] -> pkwtt digaji 2x, BPJS dan potongan kasbon ganda.
## P1 Ganti siklus kebijakan -> hari yang sudah dibayar dibayar lagi
`payroll-policy.service.ts:313-316` simpan cycle tanpa cek run; unique hanya `period_start` (`0167:375`, `payroll-run-lifecycle.service.ts:154,226`). Run 1-31 Okt dibayar, cutoff jadi 26 -> run 26 Okt-25 Nov lolos, 26-31 Okt dibayar 2x.
Belum: PPh21, rapel, payout/recon/GL, reimburse batal, cuti kolektif, matriks akses `hris-access.ts`, payslip-pin. Kedua P1 dari baca kode, belum dibuktikan test.
## Keputusan CTO: kartu 1213. Tolak kebijakan dengan jenis kerja beririsan di badan usaha sama; guard DB-level periode beririsan per karyawan di simulate + lock (di bawah entity lock); tolak ganti cycle bila periode baru beririsan run hidup. Fail-first test dulu (buktikan P1).
