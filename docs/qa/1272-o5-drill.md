# Drill kasir offline (O5, legend-wasr7.9)

Untuk founder atau QA di outlet. Satu tablet kasir, satu shift terbuka, internet bisa dimatikan. Waktu: sekitar 20 menit. Catat hasil tiap langkah (lulus atau gagal, jam, nomor struk `L...`).

## Persiapan
1. Tablet online. Buka shift (modal awal Rp100.000). Tunggu 1 menit supaya tablet mengambil bekal offline (bekal berlaku 24 jam).
2. Pastikan satu orang supervisor ada di outlet (untuk langkah 8).

## A. Jual saat offline
1. Matikan internet tablet (mode pesawat atau cabut Wi-Fi). Dalam sekitar 10 detik muncul banner "Offline".
2. Pilih 2 menu dine-in. Harga yang tampil harga daftar; tertulis "Promo tidak berlaku saat offline".
3. Bayar tunai, uang pas. Hasil: layar "Tersimpan" dengan nomor `L...`, antrean bertambah 1.
4. Jual satu lagi, bayar EDC manual. Nomor slip wajib diisi. Hasil: tersimpan, nomor `L` berikutnya (urut, tanpa loncat).
5. QRIS, poin, voucher dan DP tidak tersedia saat offline. Hasil: hanya Tunai dan EDC manual.
6. Buka "Lihat antrean": 2 penjualan, tanpa tombol hapus.

## B. Pesanan belum pasti (hanya bila terjadi: kirim pesanan lalu internet putus tanpa jawaban)
7. Menu yang sama dengan pesanan belum pasti tidak bisa dibayar offline. Hasil: tombol bayar mati, ada tulisan alasan dan tombol "Ini pelanggan lain".
   - Tekan "Ini pelanggan lain", tulis alasan (minimal 4 huruf, mis. "meja 4, pelanggan lain"), tandai. Hasil: keranjang bisa dibayar, tertulis "Ditandai pelanggan lain".
   - Penjualan ini nanti muncul untuk dicek Finance (langkah 12).

## C. Tutup shift ditahan
8. Selama antrean belum kosong, tekan Tutup shift. Hasil: ditolak, tertulis jumlah penjualan belum terkirim dan tunai di tablet. Keluar akun juga ditahan.

## D. Online lagi
9. Nyalakan internet. Hasil: banner "sedang dikirim", antrean menjadi 0 sendiri dalam sekitar 1 menit. Bila berhenti (banner "Pengiriman berhenti"): catat jumlahnya dan hubungi CTO.
10. Matikan lalu nyalakan internet sekali lagi tanpa jualan. Hasil: tidak ada penjualan ganda.

## E. Cek laporan
11. Di Laporan penjualan hari ini: 2 (atau 3) penjualan offline ada, nomor `L...` sama dengan yang tercatat di tablet, total sama, masing-masing hanya SATU kali.
12. Notifikasi supervisor/Finance: untuk penjualan "pelanggan lain" ada pesan "Penjualan offline perlu dicek" memuat alasan kasir. Penjualan biasa tidak ada pesan.
13. Hitung laci: tunai penjualan offline ikut dalam jumlah yang diharapkan (modal + tunai online + tunai offline).
14. Tutup shift: berhasil sesudah antrean 0. Tutup hari: bila ada shift yang masih terbuka sejak kemarin, shift itu tampil dengan tautan tutup paksa.

## F. Kafe terkunci? (tutup paksa)
15. Bila tablet rusak dengan antrean belum terkirim: supervisor memakai Tutup paksa (hitung ulang, saksi, alasan minimal 10 huruf). Penjualan yang masuk sesudah shift ditutup tetap tercatat dan bertanda "perlu dicek" ke Finance.

## Lulus bila
Semua penjualan offline masuk tepat satu kali, nomor `L` urut, kas di laci cocok, shift tidak bisa ditutup dengan antrean tersisa, dan tidak ada langkah yang membuat kafe terkunci.
