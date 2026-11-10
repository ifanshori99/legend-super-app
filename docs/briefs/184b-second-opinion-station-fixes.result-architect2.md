# 184b hasil architect 2 (review ganda Claude, Q43)

Kode: milestone/m1 94d769c6. Station fixes digabung di f5438770 (migrasi brief 0148 sekarang `0150_station_printer_binding_cleanup.sql`). Tidak ada perubahan lanjutan pada file ini sesudah merge.

Hasil: bersih. Tidak ada P1/P2. Tidak ada kartu baru.

## Invarian
1. Printer dicabut, tidak ada binding tersisa: OK. revokeDevice mengunci device FOR UPDATE (device.service.ts:424-429), lalu UPDATE stations WHERE tenant_id dan printer_device_id (:455-463), lalu event per stasiun dan audit clearedStationIds (:464-492). createStation/updateStation mengunci device FOR SHARE di assertStationPrinter (menu.service.ts:571-592) sebelum menulis stasiun. Urutan kunci sama (device lalu station), jadi tidak deadlock. Revoke dulu: FOR SHARE membaca ulang dan melihat revoked, hasilnya 422. Simpan dulu: UPDATE stations di revoke berjalan dengan snapshot baru dan ikut membersihkan stasiun itu. Device tidak bisa pindah outlet atau ganti status selain revoke (packages/shared/src/edge/schemas.ts:249-255), dan tidak ada penulis printer_device_id lain.
2. Form basi: OK. Ada printerDeviceId tanpa expectedUpdatedAt: 400 (menu.service.ts:682-687). Cek awal 409 (:722-723). Penjaga sebenarnya adalah WHERE date_trunc ms (:768-772), dicek ulang Postgres sesudah menunggu kunci baris. Revoke dan migrasi menaikkan updated_at, jadi form lama dijawab 409.
3. Outlet A + station B1: OK. Union di middleware/permissions.ts:220-251. Route yang memakainya, semuanya disempitkan per stasiun:
   - KDS (routes/kds.routes.ts:114-234): GET /tickets/:id, POST start, bump, recall, void, PATCH priority, dan POST /ticket-items/:id/status. Semuanya lewat assertTicketStationPermission (kds.service.ts:781, 1005, 1083, 1277) pada bacaan tanpa kunci sebelum ada kunci. Stasiun B2 atau stasiun null dijawab 404 (station-access.ts:55-68).
   - Menu GET stations (menu.routes.ts:171, 253-263): permittedStationIds dan stationScopeCondition (menu.service.ts:536-551). Daftar kosong menjadi `false`.
4. getStationScope hanya dipakai di kds.routes.ts dan menu.routes.ts (list stations). Route lain tidak mendapat jangkauan outlet dari grant stasiun. OK.
5. Tenant: setiap query yang disentuh memfilter tenant_id, dan migrasi mencocokkan d.tenant_id = s.tenant_id. OK.

## P3
- Migrasi 0150 menghapus binding tanpa jejak (tanpa audit, tanpa event menu, tanpa cadangan pasangan station-printer). Klien KDS/menu baru tahu saat muat ulang. Saran: catat baris yang dibersihkan dalam tabel atau NOTICE sebelum UPDATE.
- 0150 mengandalkan migrator sebagai pemilik tabel (NO FORCE RLS). Kalau migrasi gagal, transaksi di-rollback dan FORCE kembali. Polanya sama dengan 0096.
