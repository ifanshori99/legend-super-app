# Brief: absen masuk saat cuti disetujui (legend-9y6ri)

Keputusan founder W8 Q21: karyawan dengan cuti disetujui hari itu TETAP boleh clock-in. Absensi ditandai (flag) untuk ditinjau HR, alasan jelas, terlihat di daftar tinjauan HR (bila belum ada, tambahkan di respons API daftar absensi HR). Cuti TIDAK otomatis batal; saldo cuti dan payroll tidak berubah sampai HR memutuskan. Test: tidak ada bayaran ganda (cuti berbayar + hadir) tanpa keputusan HR. Aksi HR: tetap cuti / batalkan cuti (kembalikan saldo), pakai pola persetujuan yang ada. Layar baru: berhenti setelah API, tulis usulan UI.

Cabang: ws/9y6ri-leave-clockin-flag, worktree .worktrees/9y6ri (basis m1 + cherry-pick f0cbea6d). Migrasi bila wajib: nomor sementara 0276.
Service absensi: apps/api/src/services/hris-attendance.service.ts (clock) dan hris-attendance-admin.service.ts.
Test: apps/api/src/test/ (vitest). Jalankan: LEGEND_TEST_FILES="src/test/<file>" heavy pnpm test.
