# Edge node dicuri (legend-jmsdx)

Runbook ini untuk owner tenant dan operator cloud. Dipakai saat box edge sebuah outlet hilang atau dicurigai dibawa orang lain.

Latar belakang singkat: setiap outlet punya pepper PIN sendiri (versi 2 ke atas). Box edge yang dicuri hanya membawa pepper outlet itu, jadi PIN staf outlet lain tidak ikut terbuka. Namun PIN 6 digit staf outlet itu tetap bisa ditebak offline, sehingga PIN mereka harus diganti. Keputusan lengkap ada di `docs/DECISIONS.md` 2026-11-10 "Pepper PIN per outlet".

## Kapan dipakai

- Box edge outlet hilang, dicuri, atau tidak bisa dipastikan ada di tempatnya.
- Ada tanda box dibuka atau diakses tanpa izin.

Jangan menunggu bukti kuat. Cabut dulu, selidiki kemudian.

## Langkah

Urutannya penting. Cabut akses dulu, baru rotasi, lalu reset PIN.

1. **Cabut node edge.** Ambil ID node dari daftar node outlet:

   ```
   GET /api/edge-nodes?outletId=<outletId>
   ```

   Cabut node itu. Penutupan ini terminal, dan link node ditutup. Node yang masih punya kredensial valid akan menarik pepper baru pada sync berikutnya, jadi langkah ini wajib pertama.

   ```
   POST /api/edge-nodes/<edgeNodeId>/revoke
   { "outletId": "<outletId>" }
   ```

   Butuh izin `device.registry.revoke` di outlet itu.

2. **Cabut semua device outlet itu.** Token device juga harus dicabut. Ambil daftar device:

   ```
   GET /api/devices?outletId=<outletId>
   ```

   Cabut tiap device. Ini terminal.

   ```
   POST /api/devices/<deviceId>/revoke
   ```

   Butuh izin `device.registry.revoke` di outlet itu.

3. **Naikkan versi pepper di cloud.** Di env cloud, naikkan `STAFF_PIN_PEPPER_CURRENT_VERSION` ke angka berikutnya (misalnya dari `2` ke `3`). Jangan diturunkan. Lalu restart cloud. Jangan mengubah `STAFF_PIN_PEPPER` (root) untuk kejadian ini.

   PIN baru dan PIN yang diganti setelah ini memakai versi baru. Pepper yang dicuri hanya cocok untuk hash outlet itu dan tidak berguna untuk PIN baru.

4. **Reset PIN semua staf outlet itu.** Termasuk staf yang sama di outlet lain, karena PIN yang sama sering dipakai ulang. Setiap staf diatur PIN barunya lewat:

   ```
   PUT /api/staff-pins/<outletId>/<userId>
   ```

   Staf boleh mengatur PIN sendiri. Untuk staf lain butuh izin `device.registry.manage` di outlet tempat baris PIN itu berada. Untuk staf yang sama di outlet lain, lakukan `PUT` dengan `outletId` outlet lain itu.

   Belum ada endpoint bulk untuk reset. Daftar user ID staf per outlet belum saya verifikasi dari route, jadi ambil daftar itu dari sumber yang sudah dipakai tim (misalnya daftar staf back-office) dan catat siapa saja yang sudah direset.

5. **Cek outlet lain tidak terdampak.**
   - Outlet lain tetap bisa verifikasi PIN. Dari device outlet itu, `POST /api/staff-pins/verify` dengan header `X-Device-Token` harus tetap berhasil untuk staf yang PIN-nya tidak berubah.
   - Node edge outlet lain tidak ikut tercabut: `GET /api/edge-nodes?outletId=<outletIdLain>` tetap menampilkan node yang aktif.

## Yang TIDAK perlu dilakukan

- Tidak perlu merotasi pepper outlet lain. Pepper curian tidak cocok untuk hash outlet lain.
- Tidak perlu mengganti `STAFF_PIN_PEPPER` (root). Root tidak ada di edge dan tidak ikut dicuri dari box edge.
- Tidak perlu reset PIN staf outlet lain yang tidak bekerja di outlet yang dicuri.

## Risiko tersisa

- Sebelum PIN staf direset, PIN lama masih berlaku, dan pepper curian masih bisa dipakai menebak PIN 6 digit itu offline. Karena itu reset harus selesai secepat mungkin.
- Verifikasi ulang PIN lama di cloud akan menulis ulang hash ke versi baru. Ini tidak menggantikan reset, karena PIN lama tetap diterima sampai diganti.
- Jika root `STAFF_PIN_PEPPER` ikut bocor (misalnya dari cloud), ini kejadian lain. Versi pepper tidak menolong karena semua turunannya berasal dari root yang sama. Jalurnya root baru dan reset semua PIN. Pemetaan versi ke root baru belum dibangun.
