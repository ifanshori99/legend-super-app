# 558 Second-opinion Codex: perbaikan payroll + rapel
Peran: second-opinion (~/.agents/team/roles/second-opinion.md). Read-only, jangan edit/commit. Test terarah boleh lewat `heavy` bila perlu.
Cabang ws/payroll-engine (worktree .worktrees/payroll-engine), commit 98177b3b..df4fffcd (brief docs/briefs/549-payroll-so-fix-rapel.md) vs d6dce374.
Keputusan final: rapel dibayar di run berikutnya, run lama beku, prorata harian (founder Q43), persetujuan HR + finance; penurunan backdate tidak jadi potongan otomatis; koreksi lembur lama manual.
Cari: rapel dibayar dua kali (run diulang, rapel dihitung ulang, dua kenaikan berurutan, dua approver bersamaan), rapel untuk karyawan keluar/pindah entitas, basis lembur per tanggal salah, formula terpatok bisa diganti, guard periode beku lintas entitas bocor, NOT VALID 0350 menahan UPDATE yang sah. Laporan: P0-P3, file:line, skenario, fix. Maks 400 kata.
