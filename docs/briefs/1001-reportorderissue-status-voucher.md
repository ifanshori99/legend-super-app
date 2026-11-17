# 1001 reportOrderIssue: tolak voucher dicabut/kedaluwarsa dan promo nonaktif (legend-c1gnr)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore alur voucher/promo + test-writer gagal-dulu).

Base: cabang `ghostex/995-refund-voucher-hardening-kecil` (892f58a11; berisi validasi tenant/outlet legend-o8quo di `reportOrderIssue`). Cabangmu masuk antrean merge SESUDAH 995.
Kartu: legend-c1gnr. Sekarang `reportOrderIssue` menolak voucher dari tenant lain atau promo yang tidak berlaku di outlet, tapi belum memeriksa status voucher (dicabut, kedaluwarsa, sudah habis dipakai) dan status promo (nonaktif, di luar periode). Tolak 422 sebelum insert, dengan kode error yang konsisten dengan validasi 995. Pakai helper validasi voucher yang sudah ada bila ada; jangan menyalin aturan.

Jangan sampai rugi: test wajib membuktikan voucher dicabut/kedaluwarsa/habis dan promo nonaktif/di luar periode tidak bisa dipakai sebagai kompensasi, voucher sah tetap diterima, batas pemakaian tidak terlewati saat dua laporan bersamaan, tenant lain tidak tersentuh. Test gagal-dulu di base.
Tanpa migrasi kecuali terbukti perlu (bila perlu: nomor kerja 0610, lapor CTO).
Jangan sentuh: payout*, order-charge*, payment-refund* selain yang dipanggil `reportOrderIssue`.

Bukti selesai: test terarah lulus, prettier/eslint, typecheck API lewat heavy, `db:generate` kosong. Commit, push tanpa force. Hapus worktree subagent milikmu sebelum lapor.
Laporan sekali di akhir (Monitor, bukan sleep loop): perilaku baru, test, temuan architect, SHA, angka subagent.
