# Catatan rilis: batas refund POS (ws/pos-refund-ceilings)

## Perubahan perilaku

- Void tunai kini dihitung sebagai refund (Q63): memakai batas kumulatif penyetuju yang sama dengan refund, tidak boleh melebihi yang dibayar, ditolak di mode edge (`REFUND_HISTORY_UNVERIFIED`), dan ditolak bila ada fakta refund edge yang belum direkonsiliasi.
- Total refund POS tidak lagi menghitung refund kelebihan bayar (dana tak teralokasi) dan refund pembayaran terlambat; hanya intent milik tender pesanan itu yang dihitung. Refund biasa tetap dihitung penuh. Jalur refund admin tidak berubah (tetap lebih ketat).
- Pencarian riwayat refund edge hanya membaca event dengan `aggregate_type = 'order'`.

## Cek data production sebelum rilis

- Peran kustom dengan batas refund 0 tetap tidak bisa menyetujui refund apa pun (perilaku aman, tidak diubah). Cek di production apakah ada peran kustom yang memegang `pos.refund.approve` tetapi bukan template owner, general_manager, outlet_manager, atau supervisor; bila ada, pemegangnya akan ditolak dan perlu dipindah ke salah satu template itu.
