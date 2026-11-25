# 1268 W4 captain review (ed42e0ef4): TIDAK LULUS, 1 P1 2 P2 2 P3

1. **P1 server** create/submit/fire butuh `pos.sale.create` (`apps/api/src/routes/pos-order.routes.ts:100`); Supervisor/Captain dan Waiter hanya punya `order.create` (`packages/shared/src/access/roles.ts`). PRD: Waiter captain order tanpa akses bayar.
   **Keputusan CTO (akses, paling sempit):** JANGAN tambah `pos.sale.create` ke peran mana pun. Rute create, submit, fire menerima `order.create` HANYA bila pesanan berkanal `captain` (create: dari body tervalidasi; submit/fire: dibaca dari baris pesanan di bawah kunci, bukan dari klien) dan outlet sama; kanal lain tetap `pos.sale.create`. Tidak membuka bayar, void, diskon, tiket, parkir, display. Rute baca yang dipakai layar: pakai `order.view`. Cek juga daftar izin sesi edge (`packages/shared/src/edge/staff-session.ts`).
   Test server gagal-dulu: waiter buat/kirim/fire captain = ok; waiter kanal takeaway/dine_in/ojol = 403; waiter fire pesanan kasir = 403; waiter bayar/void/diskon = 403; outlet lain = 403; kasir tidak berubah.
2. **P2** hold reservasi: JANGAN beri `reservation.view` (data pribadi). Server: tambah penanda hold tanpa nama/telepon (mis. `reservedFrom`/jumlah tamu saja) pada baca papan meja yang sudah berizin `floor.table.view`; layar memakai itu. Bila penanda tak terbaca, peringatan lunak seperti sekarang.
3. **P2** `hooks.ts:408` intent yatim saat sesi tutup: tampilkan intent tertunda per outlet+aktor tanpa bergantung sesi terbuka, lengkap aksi kirim ulang/tutup.
4. **P3** `api.ts:573`: bila ada intent fire tertunda untuk order itu, lewati pra-cek dan ulang kunci sama.
5. **P3** `api.ts:505,424`: limit 100 tanpa kursor; hilang bersama no. 2, untuk `:424` baca semua halaman.

Izin menjadi tingkat K: review architect sesudah perbaikan.

## Review K akses 26 Nov (7d34546d2): TIDAK LULUS, 1 P1, 4 P2, 1 P3

1. **P1** `services/pos-order.service.ts:697,953`: pemanggil `captainOnly` dengan `customerProfileId` tidak null = 403 (poin sendiri lolos lewat waiter lain). Test gagal-dulu.
2. **P2, keputusan CTO (paling membatasi, PRD D10 dan baris 604: bayar di muka = dapur sesudah lunas):** untuk pemanggil `captainOnly`, sesi `pay_first` ditolak 409 dengan kode sendiri saat create, submit, dan fire (dibaca dari sesi di bawah kunci); layar captain menahan sebelum create dengan teks "Meja ini bayar di muka. Arahkan tamu ke kasir." Sesi `open_bill`: submit memanggil `assertOpenBillWithinLimit`, `OpenBillLimitExceeded` jadi 409, bukan 500. Pengguna dengan `pos.sale.create` tidak berubah. Alternatif (captain titip pesanan ke kasir) menunggu founder.
3. **P2** tender nontunai dari pesanan captain tanpa shift: dikerjakan di W3 (legend-9yw78.7), bukan di sini.
4. **P2** `services/floor.service.ts:384`: penanda hold dibatasi hari bisnis berjalan outlet. Test.
5. **P2** `ws04-pos-order/api.ts:429`: baca juga draft milik sesi sebagai "belum terkirim", aksi lanjut submit (kunci yang sama, tanpa create kedua). Test.
6. **P3** test: fire pesanan kanal lain via `itemIds`, badan diskon lengkap, waiter outlet A ke order outlet B untuk submit/fire.

## Review delta 26 Nov (35a7fde8c): TIDAK LULUS, 1 P2, 1 P3 (no. 1, 2, 4, 6 benar; import lazy aman)

1. **P2 dapur dobel** `ws04-pos-order/api.ts:675`, `captain-flow.ts` `continueDraft`: balasan create hilang -> "Lanjutkan" memakai kunci baru `draft:<id>` padahal intent create masih tersimpan dan keranjang tidak dihapus; "Kirim ulang" lalu mengulang create, submit 409 final, keranjang terbuka lagi, kirim berikutnya = pesanan kedua. Perbaikan: bila sesi masih punya intent create tertunda, "Lanjutkan" lewat `resendCaptainOrder` dengan kunci sama (atau tombol disembunyikan); di `placeOrder`, 409 transisi submit sesudah create diulang = terkirim, keranjang dihapus. Test web urutan ini.
2. **P3** `pos-order.service.ts:254-263`: `captainSessionOf` pada fire mengunci sesi `for("share")` sesudah kunci pesanan (urutan terbalik, bisa deadlock -> 500). Baca tanpa kunci; paling buruk 409.
