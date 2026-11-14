# 773 heavy: tiket ganda satu pid dari job browser (legend-t747l)
Peran: engineer (Codex, kartu S, tooling). Folder kerja: ~/.claude/scripts (heavy) dan tests/; bukan repo Legend. Cadangan berkas sebelum edit di /tmp/legend-t747l-backup.
Masalah: lihat `bd show legend-t747l` (dari repo Legend) dan Retro 29 di ~/.agents/team/RETRO.md (temuan 1). Retro sudah menutup akibatnya (older_waiting melewati pid sendiri); cari dan tutup asalnya: job browser yang mengeksekusi ulang heavy (HEAVY_BROWSER_HELD=1, sekitar baris 745-770 dan 1096) mendaftar dua tiket dalam satu detik.
Tambahan: `ram-guard status` (atau heavy --status) memberi peringatan bila antrean diam > 5 menit padahal ada lajur bebas.
Bukti: test shell gagal-dulu di ~/.claude/scripts/tests/ (direktori kunci sementara lewat env, bukan kunci asli); semua test-*.sh lulus. Jangan pkill/killall; jangan ganggu job heavy yang sedang jalan; jangan ubah batas jalur/RAM/browser.
Lapor: berkas diubah, test dijalankan, angka subagent.
