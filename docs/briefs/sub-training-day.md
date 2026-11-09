# Sub-brief: laporan harian tanpa pesanan latihan (legend-fbxzw)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/training-orders-followup (apps/api). Tugas test-writer: tulis tes GAGAL-DULU, jalankan, tunjukkan gagal karena perilaku lama, JANGAN ubah src non-test. Jalankan: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/pos-day-training.test.ts" pnpm test'`. Pola seed: `test/pos-day.test.ts` (getEndOfDayRecap, closePosDay) dan `test/pos-shift-training.test.ts` (menandai pesanan latihan: INSERT pos_orders is_training=true).

Perilaku baru: `computeRecap` (services/pos-day.service.ts ~:299) mengecualikan pesanan latihan dari SEMUA bagian: himpunan penjualan (jumlah pesanan, kotor, diskon, service, pajak, pembulatan, total, per kanal, per perangkat), tender captured per metode, void (jumlah dan nilai) dan refund (jumlah dan nilai). Satu hari dengan 1 pesanan nyata + 1 pesanan latihan -> rekap sama persis dengan hari yang hanya berisi pesanan nyata. Pemeriksaan keseimbangan (tender = total penjualan) tetap lulus, tidak melempar CONFLICT.

File: apps/api/src/test/pos-day-training.test.ts. Kasus:

1. Hari campuran (nyata + latihan, tunai): rekap = hanya nyata (orderCount, totalIdr, tender tunai, kanal, perangkat); tidak melempar.
2. Pesanan latihan non-tunai (mis. QRIS/kartu) juga tidak masuk tender per metode.
3. Void pesanan latihan pada hari itu: voidedOrderCount/voidedAmountIdr tidak berubah; void nyata tetap terhitung.
4. Refund pesanan latihan: refundCount/refundAmountIdr tidak berubah; refund nyata tetap.
5. Kontrol: hari tanpa pesanan latihan hasilnya identik dengan sebelum perubahan (pakai angka tes pos-day.test.ts).
6. Hari yang hanya berisi pesanan latihan: rekap kosong (nol), tutup hari tidak melempar karena ketidakseimbangan.
