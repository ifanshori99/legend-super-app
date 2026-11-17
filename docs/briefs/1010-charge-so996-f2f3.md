# 1010 Perbaikan SO 996 F2+F3: charge setelah void POS, split jurnal refund charge

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer gagal-dulu per temuan, satu implementer per kartu).

Sumber: docs/qa/second-opinion-refund-charge.md F2, F3. Base: `ghostex/847b580a` (af6845a55, 994 di atas 985 dan 982). Cabangmu antre SESUDAH 994. Catatan SO: 980 bukan leluhur 982; jangan bergantung pada kode 980.
Kartu:
- legend-vl6bk (P1): charge yang belum dibayar tidak bisa ditagih (tunai/QRIS/EDC) setelah transaksi POS asal di-void final; charge ikut dibatalkan atau ditolak 409 dengan kode jelas.
- legend-0zfr1 (P2): split jurnal refund charge hanya menghitung refund yang benar-benar berhasil; refund yang kemudian gagal tidak mengubah split refund berikutnya. Jurnal tetap seimbang.
Test wajib: void lalu tagih -> ditolak, tidak ada uang masuk; refund gagal lalu refund baru -> split dan total tepat, tidak melebihi nilai charge; bersamaan; tenant lain tidak tersentuh. Gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0630-0631.
Bukti: test charge/refund terarah lulus (sebut berkas), prettier/eslint, typecheck API (+web bila tersentuh) lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per kartu, test, temuan architect, SHA, angka subagent.
