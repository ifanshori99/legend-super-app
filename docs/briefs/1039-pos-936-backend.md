# 1039 POS 936 backend: kontrak kasir bayar sisa (legend-hpgyw)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Tingkat K (uang): architect effort xhigh sekali di akhir.
Langkah pertama: pecah dan spawn subagent paralel dalam satu giliran (Explore kontrak, test-writer gagal-dulu per bagian: voucher, poin, EDC ditolak, tiket fasilitas; implementer per kelompok file tidak bertumpuk).
Base: `ghostex/pos-panel-bayar-sisa-5w6` 48c1788ef (UI 936, founder Q19 setuju 18 Nov) di-merge ke `origin/milestone/m1`. Daftar kontrak: apps/web/src/features/ws04-pos-kasir/CONTRACT-GAPS.md dan `bd show legend-hpgyw`.
Aturan: tiket fasilitas = item biasa di tagihan POS (alur bayar/refund/shift/pajak yang ada), tiket tidak terbit sebelum lunas; server hitung ulang pajak+service setelah potongan; potongan voucher/poin tidak melebihi sisa tagihan; EDC ditolak tidak mengubah tagihan. Ganti mode mock di web dengan API nyata.
Test: tamu tidak dibayar/dipotong lebih, outlet tidak rugi, voucher/poin tidak terpakai ganda (bersamaan dan replay), tenant/outlet lain, refund tiket. Migrasi kerja 0670-0673.
Bukti: test terarah (sebut berkas), prettier/eslint, typecheck API + web lewat heavy, db:generate kosong, text-contract. Commit, push tanpa force. Laporan sekali di akhir: perilaku, test, temuan architect, SHA, migrasi, angka subagent (total, puncak, pemegang heavy).
