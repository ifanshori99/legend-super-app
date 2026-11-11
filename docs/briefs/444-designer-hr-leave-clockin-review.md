# 444 Mockup tinjauan HR: absen masuk saat cuti disetujui

Peran: designer. Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/ui-standard.md`.

## Konteks
Keputusan founder: karyawan dengan cuti disetujui tetap boleh clock-in; absensinya ditandai untuk ditinjau HR (W8 Q21). HR boleh membatalkan cuti hanya untuk hari karyawan datang, bukan seluruh rentang cuti (W8 Q27). Saldo cuti dan gaji tidak berubah sampai HR memutuskan.
API: cabang `origin/ws/9y6ri-leave-clockin-flag` (alasan `leave_approved`, aksi `keep_leave` / `cancel_leave`). Usulan awal: `git show origin/ws/9y6ri-leave-clockin-flag:docs/PROGRESS.md`, cari "Usulan UI".

## Layar (cari dulu antrean tinjauan HR yang sudah ada di `apps/web`, ikuti gayanya)
1. Daftar antrean tinjauan HR dengan item "Absen saat cuti" (lencana, nama, tanggal, jenis cuti, jam masuk/keluar).
2. Detail item: dua aksi "Tetap cuti" dan "Batalkan cuti hari ini, hitung hadir". Jelaskan dampaknya ke saldo cuti dan gaji dalam satu kalimat. Cuti beberapa hari: jelaskan hanya hari itu yang dibatalkan.
3. Konfirmasi tiap aksi, lalu keadaan sesudah diputuskan ("Tetap cuti" tidak dilabeli "Ditolak").
4. HR tanpa hak membatalkan: tombol nonaktif + alasan. Antrean kosong.
Lebar 1280 (desktop HR) dan 390.

## Keluaran
PNG per layar di `design/mockups/hr-leave-clockin-review/` cabang `ws/design-hr-leave-clockin` dari `origin/milestone/m1` (worktree `.worktrees/design-hr-leave-clockin`) + `README.md` (alur, teks tiap layar). Commit dan push. Jangan ubah kode aplikasi. Laporan: daftar layar, keputusan desain, angka subagent.
