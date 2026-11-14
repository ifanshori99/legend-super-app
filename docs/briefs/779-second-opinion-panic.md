# 779 Second opinion area alert panik fasilitas
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Effort high. Read-only.
Cakupan: diff origin/milestone/m1...origin/ui/panic-copy-subnav (berisi ui/panic-alert-wiring) beserta API alert panik yang dipanggilnya (Grep "panic" di apps/api/src).
Cari: alert yang tidak sampai ke petugas (gagal diam-diam), satu tombol memicu banyak notifikasi/biaya kirim, petugas outlet lain menerima atau menanggapi alert outlet lain, status "menuju lokasi" yang bisa diklaim orang yang tidak berwenang, data lokasi/nama yang bocor.
Tanpa heavy kecuali satu test terarah.
Hasil: docs/qa/second-opinion-panic.md di worktree-mu (P0-P3, berkas:baris, skenario, usul test). Lapor ringkasannya.
