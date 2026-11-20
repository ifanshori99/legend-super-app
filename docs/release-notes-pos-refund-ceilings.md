# Catatan rilis: batas refund POS (ws/pos-refund-ceilings)

## Perubahan perilaku

- Void tunai kini dihitung sebagai refund (Q63): memakai batas kumulatif penyetuju yang sama dengan refund, tidak boleh melebihi yang dibayar, ditolak di mode edge (`REFUND_HISTORY_UNVERIFIED`), dan ditolak bila ada fakta refund edge yang belum direkonsiliasi.
- Total refund POS tidak lagi menghitung refund kelebihan bayar (dana tak teralokasi) dan refund pembayaran terlambat pada batas "tidak boleh melebihi yang dibayar"; hanya intent milik tender pesanan itu yang dihitung. Batas kewenangan penyetuju tetap menghitung semuanya. Refund biasa tetap dihitung penuh. Jalur refund admin tidak berubah (tetap lebih ketat).
- Tunai yang sudah di-void dihitung ke total kumulatif refund pesanan itu (refund admin dan POS berikutnya).
- Void edge yang menutup transaksi final dan masih diparkir (belum ada baris `pos_order_voids`) membuat void cloud, refund, dan penghitungan total refund ditolak dengan `REFUND_HISTORY_UNVERIFIED` sampai direkonsiliasi.
- Pencarian riwayat refund edge hanya membaca event dengan `aggregate_type = 'order'`.

## Syarat rilis

- Semua edge wajib di-upgrade sebelum fitur ini dirilis.
- Void edge final yang diparkir memblokir void dan refund pesanan itu sampai direkonsiliasi (belum ada jalur otomatis; siapkan prosedur dukungan). Bila void pusat sudah tercatat lebih dulu daripada void edge yang baru diparkir, pusat tidak bisa mendeteksi pembayaran ganda itu; cek manual rekonsiliasi edge lama.
- Edge produksi hanya boleh memakai build rilis 1 (menolak semua refund dan void tunai, Q63). Kueri pasca go-live: `SELECT count(*) FROM edge_deferred_events WHERE event_name='order.refunded'` harus 0. Bila tidak 0, itu insiden: pengecualian finance `edge_refund_unreconciled` mendaftarkan tiap pesanan terkait.
- Prosedur finance untuk `edge_refund_unreconciled`: refund edge lama yang diparkir tidak dijurnal di pusat (pendapatan dan kas terlalu besar). Buat jurnal balik manual dan cek laci edge **sebelum tutup periode atau distribusi bagi hasil**. Refund pusat berikutnya untuk pesanan itu ditahan (`REFUND_HISTORY_UNVERIFIED`) tanpa batas waktu; belum ada tombol tutup (bead lanjutan).

## Cek data production sebelum rilis

- Peran kustom dengan batas refund 0 tetap tidak bisa menyetujui refund apa pun (perilaku aman, tidak diubah). Cek di production apakah ada peran kustom yang memegang `pos.refund.approve` tetapi bukan template owner, general_manager, outlet_manager, atau supervisor; bila ada, pemegangnya akan ditolak dan perlu dipindah ke salah satu template itu.
