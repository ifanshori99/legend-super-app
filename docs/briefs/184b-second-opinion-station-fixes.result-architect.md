# 184b result, architect 1 (review ganda Claude, brief 225)

Kartu: legend-4xai, legend-cy2e. Rentang 9a2c1e86..fb359f65 masuk ke `milestone/m1` lewat f5438770. Sesudah fb359f65, tidak ada commit lain yang menyentuh `permissions.ts`, `device.service.ts`, `menu.service.ts`, `station-access.ts`, `kds.service.ts` atau `scope.ts`, sampai `integ/m1-batch31`. Catatan: migrasi 0148 dari brief sekarang bernama `apps/api/drizzle/0150_station_printer_binding_cleanup.sql` di m1.

Hasil: Bersih untuk P1/P2. Ada dua catatan P3.

## Per invariant

1. Revoke printer: OK.
   - `revokeDevice` (`device.service.ts:425-463`) mengunci device FOR UPDATE, lalu meng-UPDATE stations dengan filter `printer_device_id`. `create/updateStation` mengambil kunci device FOR SHARE (`menu.service.ts:578-592`) sebelum menulis station. Urutan kuncinya sama (device lalu station), jadi tidak ada deadlock.
   - Bila bind masuk lebih dulu, bind itu commit, lalu statement UPDATE revoke (snapshot baru di READ COMMITTED) membersihkannya.
   - Bila revoke masuk lebih dulu, FOR SHARE mengevaluasi ulang WHERE `status='active' AND revoked_at IS NULL` dan menjawab 422.
   - Bila printer diganti dari X ke Y sementara X di-revoke, kedua urutan aman. Hasilnya 409 lewat versi station, atau WHERE revoke tidak cocok lagi.
   - Hanya `device.service.ts:456` dan `menu.service.ts` yang menulis `printer_device_id`.
2. Versi station: OK.
   - `printerDeviceId` tanpa `expectedUpdatedAt` dijawab 400 (`menu.service.ts:682`).
   - Pemeriksaan awal (`:713`) dilanjutkan dengan UPDATE bersyarat `date_trunc('milliseconds', updated_at)` (`:769`). UPDATE ini dievaluasi ulang sesudah menunggu kunci baris, jadi form lama dijawab 409 tanpa menulis apa pun.
   - Konversi µs ke ms di JS terpotong sama dengan `date_trunc`. Ini sudah dicek untuk 1000 nilai ms.
3. Union outlet A + station B1: OK.
   - `requireStationScopePermission` (`permissions.ts:197-260`) hanya dipakai di `menu.routes.ts:171` (listStations) dan `kds.routes.ts:63`. Rute kds.routes.ts:63 mencakup ticket detail, start, bump, recall, void, priority, dan item status.
   - listStations menyaring dengan `stationScopeCondition(permittedStationIds)`. Semua aksi tiket memanggil `assertTicketStationPermission` sebelum mengambil kunci (`kds.service.ts:781,1005,1083,1277`).
   - `stationReachOf` mengotorisasi per station, sehingga semua station A dan hanya B1 yang lolos. Tiket B2 dijawab not found.
4. Jangkauan bocor: OK. Context gabungan hanya disimpan di `stationScopes` dan dibaca lewat `getStationScope`. Fungsi itu hanya dipakai oleh handler di atas, dan `getScopedTenantContext` tidak berubah.
5. Isolasi tenant: OK. Revoke mengecek `tenantId` sesudah membaca device, dan update stations difilter per tenant di bawah RLS outlet. Migrasi 0150 mencocokkan tenant dan outlet. FORCE dilepas lalu dipasang lagi dalam satu transaksi migrasi.

## P3

- Migrasi 0150 membersihkan binding tanpa event menu dan tanpa audit. Klien KDS yang sedang terbuka baru melihat perubahan sesudah dimuat ulang. Migrasi ini hanya dijalankan sekali.
- Form yang mengirim ulang `printerDeviceId` yang sama dengan versi lama tetap dijawab 409, walau yang diubah hanya target waktu. Ini disengaja, aman, dan hanya sedikit merepotkan pengguna.

## Temuan P1/P2

Tidak ada.
