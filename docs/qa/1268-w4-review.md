# 1268 W4 captain review (ed42e0ef4): TIDAK LULUS, 1 P1 2 P2 2 P3

1. **P1 server** create/submit/fire butuh `pos.sale.create` (`apps/api/src/routes/pos-order.routes.ts:100`); Supervisor/Captain dan Waiter hanya punya `order.create` (`packages/shared/src/access/roles.ts`). PRD: Waiter captain order tanpa akses bayar.
   **Keputusan CTO (akses, paling sempit):** JANGAN tambah `pos.sale.create` ke peran mana pun. Rute create, submit, fire menerima `order.create` HANYA bila pesanan berkanal `captain` (create: dari body tervalidasi; submit/fire: dibaca dari baris pesanan di bawah kunci, bukan dari klien) dan outlet sama; kanal lain tetap `pos.sale.create`. Tidak membuka bayar, void, diskon, tiket, parkir, display. Rute baca yang dipakai layar: pakai `order.view`. Cek juga daftar izin sesi edge (`packages/shared/src/edge/staff-session.ts`).
   Test server gagal-dulu: waiter buat/kirim/fire captain = ok; waiter kanal takeaway/dine_in/ojol = 403; waiter fire pesanan kasir = 403; waiter bayar/void/diskon = 403; outlet lain = 403; kasir tidak berubah.
2. **P2** hold reservasi: JANGAN beri `reservation.view` (data pribadi). Server: tambah penanda hold tanpa nama/telepon (mis. `reservedFrom`/jumlah tamu saja) pada baca papan meja yang sudah berizin `floor.table.view`; layar memakai itu. Bila penanda tak terbaca, peringatan lunak seperti sekarang.
3. **P2** `hooks.ts:408` intent yatim saat sesi tutup: tampilkan intent tertunda per outlet+aktor tanpa bergantung sesi terbuka, lengkap aksi kirim ulang/tutup.
4. **P3** `api.ts:573`: bila ada intent fire tertunda untuk order itu, lewati pra-cek dan ulang kunci sama.
5. **P3** `api.ts:505,424`: limit 100 tanpa kursor; hilang bersama no. 2, untuk `:424` baca semua halaman.

Izin menjadi tingkat K: review architect sesudah perbaikan.
