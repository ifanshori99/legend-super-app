# 1026 Rantai 1012: kelola perangkat ditolak ACTING_STAFF_NOT_ALLOWED (legend-a6aq6)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore route device + test, test-writer, implementer).

Base: `ghostex/6acce68c` (e3cb158f2, 1024; ujung rantai 1006-1024). Cabangmu antre SESUDAH 1024.
Masalah: `apps/api/src/test/device-shared-mode.test.ts` 6 dari 24 gagal sejak 1012 (juga di 0069c8c59): guard default-tertutup menolak `revokeDevice`/`setDeviceSharedMode` dengan 403 ACTING_STAFF_NOT_ALLOWED sebelum handler jalan.
Kerja: cari premis tiap test yang gagal. Default membatasi: kelola perangkat (cabut, nyala/matikan mode bersama) adalah aksi backoffice dari perangkat pribadi; dari tablet bersama tetap ditolak. Bila ada alur sah dari tablet itu sendiri (mis. owner mematikan mode bersama di tablet), izinkan hanya dengan verifikasi ulang owner (password/step-up yang sudah ada), bukan cookie saja. Sesuaikan test ke keputusan, jangan dilonggarkan; catat tiap test yang diubah dan alasannya. Keputusan 1024 dipertahankan: cabut/matikan mode bersama menutup sesi tablet.
Test wajib: kelola perangkat dari perangkat pribadi lulus; dari tablet bersama ditolak (atau lulus hanya dengan step-up bila alur itu dipilih); sesi tablet tertutup setelahnya; test kontrak 1012 tetap hijau. Seluruh berkas `device-*`, `shared-device-*`, `kds-realtime*`, `acting-staff-*` hijau.
Tanpa migrasi. Bukti: test terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): premis per test, keputusan, test, temuan architect, SHA, angka subagent.
