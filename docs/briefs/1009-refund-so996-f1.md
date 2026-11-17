# 1009 Perbaikan SO 996 F1: lunas setelah refund provider sebagian

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore alur payment.paid + refund provider, test-writer gagal-dulu, implementer).

Sumber: docs/qa/second-opinion-refund-charge.md F1. Base: `ghostex/980-refund-sisa-4-kartu` (08187d8b0). Cabangmu antre SESUDAH 980.
Kartu legend-6i91b (P1): bila provider sudah mengembalikan sebagian dana sebelum event `payment.paid` dikonsumsi, penjualan tidak boleh dianggap lunas penuh. Nilai teralokasi = dibayar dikurangi refund provider (pakai netAllocatedIdrSql 980 bila cocok, jangan salin aturan). Order tetap punya sisa tagihan sebesar refund.
Test wajib: urutan event terbalik (refund dulu, paid kemudian) dan normal; webhook ganda; nominal sisa tepat; outlet tidak rugi; tenant lain tidak tersentuh. Gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0628-0629.
Bukti: test pembayaran/refund terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
