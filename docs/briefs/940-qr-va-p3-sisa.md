# 940 QR/VA sisa P3 (legend-24ogm, legend-154wr, legend-gp3fw)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Uang: architect xhigh. Spawn paralel dalam satu giliran (Explore, test-writer gagal-dulu per kartu, implementer per kartu dengan file terpisah, test-runner, architect). Lapor sekali; Monitor untuk job latar. Typecheck penuh sekali sebelum lapor; batas 1 tsc bila free < 60%.
Cabang: worktree-mu dari `milestone/m1` (c17c60df7); commit dan push tanpa force. Migrasi sementara mulai 0450 bila perlu. Tidak merge, tidak deploy.
Kartu: baca `bd show` tiap kartu (24ogm: parkir lewat poll biasa tanpa notifikasi staf, paid_without_amount/settlement_failed tidak melambat, jeda baca penyedia; 154wr: kata tamu QRIS_HOLD_ACTIVE di VA split, kode penyedia terbit tapi tak tersimpan bila cek ulang menolak; gp3fw: replay idempotensi saat kembaran commit sebelum cek kode aktif).
Aturan tetap (jangan dilonggarkan): satu kode bayar aktif per order/split, antrean release tidak tutup karena waktu, Duitku paid + uang tercatat final, DOIT paid tetap poll 24 jam, Q93 force release finance.
Jangan sampai rugi: test bukti tidak ada pembayaran ganda dan outlet tidak rugi.
Bukti: test gagal-dulu lalu hijau, test payment/QR/VA/bill-split + kontrak pemindai lewat heavy setelah commit terakhir, pra-gate AGENTS.md, architect xhigh tanpa P1.
Laporan: SHA, migrasi, test, temuan architect, angka subagent. Komentari kartu.
