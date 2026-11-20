# Keputusan yang ditunggu dari founder (21 Nov 2026)

Menggantikan `keputusan-2026-11-20.md`. Selama belum dijawab, sistem memakai aturan paling aman: tidak membayar lebih, tidak menghitung laba lebih tinggi, tidak menjalankan fitur yang belum pasti.

Cara menjawab: cukup tulis nomor dan "setuju usulan" atau pilihan lain.

## A. Perlu dijawab sebelum rilis 1

1. **Rilis tanpa GoFood/Grab/Shopee dan mesin EDC bank.**
   Usulan: ya. Kasir mencatat pembayaran kartu secara manual. Integrasi menyusul saat akun mitra dan bank siap.
2. **Refund penjualan kasir offline.**
   Penjualan yang dibuat saat kasir offline (server outlet) belum bisa direfund dari pusat di rilis 1. Bila kasir offline tetap mencatat refund, refund itu muncul di daftar "perlu dicek" bagian keuangan dan tidak bisa dibayar dua kali.
   Usulan: terima untuk rilis 1. Refund penjualan offline dilakukan manajer secara tunai lalu dicek keuangan. Refund dari pusat menyusul.
3. **Tutup hari saat internet outlet putus.**
   Bila server outlet tidak terhubung lebih dari 15 menit, manajer boleh menutup hari dari aplikasi pusat. Pesanan yang masuk sesudahnya tetap tercatat di tanggalnya sendiri, tetapi belum diberi tanda "terlambat".
   Usulan: terima. Tanda "terlambat" menyusul.
4. **Absen staf tanpa paket data.**
   Layar absen di perangkat outlet belum ada. Staf yang tidak bisa absen dari HP-nya dikoreksi manual oleh supervisor.
   Usulan: terima untuk rilis 1.
5. **Gaji dibebankan ke outlet mana.**
   Usulan: ke outlet tempat karyawan terdaftar. Staf pusat atau staf bersama dibagi sesuai porsi penjualan. Selama belum dijawab, bagi hasil per outlet ditahan.
6. **Gaji akhir karyawan keluar: uang ganti cuti dan THR.**
   Gaji terakhir, BPJS, dan PPh21 sudah otomatis. Uang ganti cuti dan THR karyawan keluar dihitung manual oleh HR.
   Usulan: tetap manual di rilis 1.
7. **Voucher permintaan maaf.**
   Sekarang semua voucher maaf tanpa laporan item gagal harus disetujui atasan.
   Usulan: tetap begitu. Pilihan lain: sebutkan batas nominal yang boleh tanpa persetujuan.
8. **Refund pembayaran Duitku.**
   Usulan: rilis 1 lewat transfer manual dengan persetujuan manajer dan catatan di sistem. API refund menyusul.
9. **Refund saat jalur refund DOIT dimatikan.**
   Usulan: refund tidak boleh dicatat tanpa bukti dari DOIT. Paling aman, tidak ada refund ganda.
10. **Login dan notifikasi pelanggan: WhatsApp, email, atau keduanya.**
    Butuh minimal satu. WhatsApp perlu akun Meta Business terverifikasi atau Kirimdev, plus nomor khusus. Email perlu akun pengirim email.
    Usulan: email dulu (lebih cepat siap), WhatsApp menyusul.
11. **SMS.** Usulan: tidak perlu.
12. **Kurir pengiriman.** Usulan: tidak di rilis 1.
13. **Pemantau error (Sentry atau sejenis).** Usulan: ya, paket gratis cukup. Founder membuat akunnya.
14. **Fitur yang belum siap: reservasi, Tanya AI di layar dapur, menu fasilitas di perangkat bersama.**
    Usulan: disembunyikan di rilis 1.

## B. Perlu dilihat founder

15. Layar fasilitas, pembayaran, Wi-Fi, HRIS (desain v2).
16. Mockup pemilih QRIS/EDC saat menagih tukar menu di kasir.
17. Katalog 105 laporan standar. Di rilis 1, laporan keuangan, absen, gaji, dan kinerja tampil "Segera hadir" sampai datanya tersambung.
18. Dialog koreksi PTKP, dialog batal persetujuan bagi hasil, banner payout beku. Screenshot di `docs/review/img/`.

## C. Akun dan kunci (di akhir, tidak lewat chat)

- DOIT dan Duitku: founder sudah siap. Diisi di akhir ke `deploy/single-vm/runtime.env`. Tim hanya memeriksa nama kuncinya lengkap.
- Kunci sandbox DOIT dan Duitku untuk uji coba sebelum rilis, bila ada. Mempercepat uji pembayaran nyata.
- Akun email pengirim atau WhatsApp (sesuai jawaban no. 10), dan akun pemantau error (no. 13).

## D. Pertanyaan baru (21 Nov, sesudah "setuju semua")

19. **Tutup buku bulanan saat ada batch produksi yang tertahan** (diperbarui 21 Nov siang).
    Batch produksi ditahan bila catatan bahan yang dipakai tidak pernah sampai dari server outlet ke pusat. Selama ada batch tertahan, tutup buku bulan itu ditolak, supaya laporan tidak salah.
    Temuan tim: tombol "kirim ulang" dari pusat tidak bisa menolong, karena catatan yang hilang tertahan di server outlet. Jalur pemulihan dari outlet butuh desain sendiri dan baru siap sesudah rilis 1. Kalau tetap ditolak tanpa jalan keluar, tutup buku bulan itu bisa tertahan terus.
    Usulan baru: pemilik atau finance manager boleh menutup buku dengan alasan tertulis. Sistem menyimpan siapa yang menutup, alasannya, dan daftar batch yang tertahan. Batch itu dibukukan di bulan berikutnya begitu datanya lengkap. Tidak ada uang yang dibayarkan, jadi tidak ada risiko bayar lebih.
    Pilihan lain: tetap ditolak sampai jalur pemulihan outlet siap (sesudah rilis 1).
