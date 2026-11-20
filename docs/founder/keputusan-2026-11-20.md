# Keputusan yang ditunggu dari founder (20 Nov 2026)

Sampai founder memutuskan, sistem memakai aturan yang paling aman (tidak membayar lebih, tidak menghitung laba lebih tinggi).

1. **Rilis tahap 1 tanpa GoFood/Grab/Shopee dan integrasi mesin EDC bank?**
   Usulan tim: ya. Kasir tetap bisa mencatat pembayaran kartu secara manual. Integrasi menyusul setelah akun mitra dan bank siap (perlu waktu minggu sampai bulan).
2. **Gaji dibebankan ke outlet mana?**
   Usulan tim: gaji karyawan dibebankan ke outlet tempat dia terdaftar. Gaji staf pusat atau staf bersama dibagi ke outlet sesuai porsi penjualan.
   Selama belum diputuskan, bagi hasil per outlet ditahan. Ini supaya laba outlet tidak terlihat lebih besar dan bagi hasil tidak terbayar lebih.
3. **Gaji terakhir karyawan yang keluar.**
   Sementara, gaji terakhirnya dikeluarkan dari run gaji bulanan dan muncul di laporan untuk diproses manual oleh HR. Sistem tidak membayarnya otomatis.
   Pilihannya: tetap begini, atau dibuat alur pembayaran gaji akhir khusus.
4. **Voucher permintaan maaf.**
   Semua voucher maaf yang tidak disertai laporan item gagal harus disetujui atasan. Selama satu permintaan di outlet masih menunggu persetujuan, permintaan lain di outlet itu ikut tertahan.
   Pilihannya: setuju, atau batas nominal tertentu boleh tanpa persetujuan.
5. **THR karyawan keluar.**
   Kalau THR sudah dikunci sebelum periode terakhir karyawan yang keluar, run gaji bulan itu ditahan sampai THR dibalik dan dihitung ulang. Ini mencegah THR terbayar dobel.
6. **Review tampilan.**
   Layar yang perlu dicek: dialog koreksi PTKP, dialog batal persetujuan bagi hasil, dan banner payout beku. Screenshot ada di `docs/review/img/`.
7. **Akun layanan luar.**
   - DOIT dan Duitku sudah siap.
   - Yang masih dibutuhkan: WhatsApp Business API (untuk login dan notifikasi) dan provider email.
   - GoFood/Grab/Shopee dan bank EDC hanya diperlukan bila poin 1 dijawab "tunggu".
