# 1016 Refund provider: kelebihan bayar yang direfund provider tidak membatalkan penjualan sah (legend-g6ept)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore jalur net 980/1009, test-writer gagal-dulu, implementer).

Base: `ghostex/1009-so996-f1-lunas-refund` (daf8ace2a). Cabangmu antre SESUDAH 1009. Thread 1013 bekerja di berkas akuntansi/breakfast di base yang sama; jangan sentuh berkas itu.
Masalah (dari laporan 1009): kode QR/POS yang lebih bayar, lalu provider merefund kelebihan yang diparkir, dihitung net < tagihan sehingga penjualan di-void dan net direfund. Outlet tidak rugi, tapi penjualan sah hilang. Test di 1009 gagal setup `AMOUNT_MISMATCH`; susun setup lebih bayar yang benar.
Perilaku: refund provider atas kelebihan yang diparkir mengurangi kelebihan dulu, bukan porsi tagihan; penjualan tetap lunas bila net >= tagihan. Default membatasi: bila tidak bisa dibuktikan bahwa refund itu atas kelebihan, tetap void + refund (perilaku 1009).
Test wajib: lebih bayar lalu kelebihan direfund provider -> penjualan lunas, tidak ada refund ganda, kelebihan yang tersisa tetap tercatat; refund provider melebihi kelebihan -> void + refund net (1009); event ganda; tenant lain; outlet tidak rugi dan tamu tidak dibayar lebih. Gagal-dulu di base.
Tanpa migrasi kecuali perlu (nomor kerja 0634-0635).
Bukti: test terarah lulus (sebut berkas, termasuk berkas 1009/980), prettier/eslint, typecheck API lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
