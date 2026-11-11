# 538-G2b Fix temuan architect payroll (ws/payroll-engine)
Peran: engineer. Worktree .worktrees/payroll-engine. Test gagal-dulu tiap temuan (payroll-gross-engine.test.ts / payroll-service-charge-distribution.test.ts), commit per temuan, jangan merge. Urut:
- P0 `payroll-components.service.ts:908-945`: lembur dibayar dari menit absensi tanpa persetujuan/batas. PRD: lembur wajib diajukan + disetujui (`overtime_requests`, 1-720 menit, `dayType`). Fix: menit dari overtime_requests yang approved dalam periode, tarif sesuai dayType, tidak pernah lebih dari menit absensi hari itu. Ganti test baris 478 (600 menit tanpa persetujuan harus 0).
- P1 `:846`: karyawan keluar/masuk tengah bulan dibayar penuh. Fix: hari dihitung dalam joinDate..endDate karyawan.
- P1 `payroll-service-charge.service.ts:636`: distribusi ke run hr_approved/approved diterima. Fix: hanya draft/simulated (keputusan founder Q42 bisa mengubah ini nanti; default membatasi).
- P2 `payroll-components.service.ts:452,634`: cek periode terkunci bisa balapan. Fix: SELECT ... FOR SHARE pada payroll_runs entitas itu dengan period_end >= effectiveFrom.
- P2 `:807`: potongan nonaktif ikut terbuang (net naik). Fix: lewati earning nonaktif saja, potongan tetap.
- P3 `:754`: komentar vs kode pembulatan jam lembur; samakan ke bawah per jam penuh bila tidak ada aturan lain (membatasi bayar).
- Sekalian temuan reviewer rendah: urutan cek izin sebelum karyawan (403 dulu), FOR SHARE pada run beku terakhir (8xf32).
Bukti: test terarah via heavy, tsc api, eslint/prettier. Lapor dengan angka subagent. Lalu CTO menjalankan re-review architect.
