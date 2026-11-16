# 916 Web tamu: pesan ORDER_CODE_ACTIVE / SPLIT_CODE_ACTIVE / QRIS_HOLD_ACTIVE (legend-yehnr bagian UI, legend-154wr bagian kata tamu)
Peran: engineer (baca ~/.agents/team/roles/engineer.md), Codex. UI kecil, ikuti ~/.agents/team/ui-standard.md. Tanpa backend uang, tanpa migrasi.
Cabang: worktree-mu dari `fix/qr-va-queue-after-paid-xzu4l` (c35d1c794); commit dan push tanpa force ke cabang barumu. Tidak merge, tidak deploy.
Tugas: halaman link bayar tamu (order, bill split, breakfast, recovery charge) menampilkan pesan jelas Bahasa Indonesia untuk 409 `ORDER_CODE_ACTIVE`, `SPLIT_CODE_ACTIVE`, `QRIS_HOLD_ACTIVE`, `FUNDS_UNRESOLVED` saat ganti metode/refresh: kode lama masih aktif, selesaikan atau tunggu kedaluwarsa, tampilkan kode lama bila tersedia; jangan galat umum. Cari pemetaan galat yang ada dengan Explore. Teks baru daftarkan ke katalog text-contract.
Bukti: test komponen/route untuk tiap kode galat (gagal-dulu), `node --test tests/text-contract.test.mjs`, prettier, eslint, typecheck web lewat heavy, satu reviewer.
Laporan: cabang, SHA, test, angka subagent. Komentari legend-yehnr dan legend-154wr.
