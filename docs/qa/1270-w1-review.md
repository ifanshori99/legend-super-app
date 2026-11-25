# 1270 WFC W1 review K (07ba9eb45): TIDAK LULUS, 1 P1 4 P2

Path relatif `apps/api`; "0526" = `drizzle/0526_wfc_paid_schema.sql`. Semua dibetulkan di migrasi 0526 (belum masuk int/rc2), test gagal-dulu di `src/test/wfc-schema.test.ts`.

1. **P1** 0526:119,128: lunas tidak dibuktikan DB. FK link (tenant, outlet, id) + trigger INSERT/UPDATE yang mengunci link: diskon 0, subtotal = harga, paid = total > 0. Test negatif: belum bayar, beda outlet, beda nominal, diskon, link terbatal.
2. **P2** 0526:95-129: snapshot beku (harga, kredit, slot, kursi, versi), transisi status sah saja, paid tidak turun dan refund tidak turun; `refunded`/`no_show` tidak bisa kembali `confirmed`.
3. **P2** 0526:60: `approval_request_id` NOT NULL unik, FK ke `approval_requests`, trigger cocokkan pengusul, penyetuju, status.
4. **P2** 0526:125, `src/services/crm-promo-engine.ts:1588`: trigger cocokkan produk saat INSERT; tolak WFC di simpan, evaluasi, redeem promo `facility_entitlement`.
5. **P2** `src/services/floor.service.ts:497,571`: kunci yang sama dengan kursi; ubah `isWfc`/status/hapus saat ada klaim atau kuota = 409.
6. **P3 betulkan** `wfc-sales-gate.ts:68` pakai `businessDateOf`; `wfc-seat.service.ts:453` kuota <= `wfc_seats`, `:554` `wfc:null` tidak menyentuh produk non-WFC, `:196` tolak zona nonaktif; `tenant-config-outlet.ts:760` impor membawa jenis WFC.
7. **P3 test** flag bawaan diuji tanpa di-set; isolasi baris semua tabel baru; balapan klaim vs kursi mati.

Diterima: nonaktif sampai W1b, `menu_item_id` kosong, kuota hari x jam. Migrasi aditif dan rantainya baik.
Risiko: urutan kunci link/klaim (deadlock dengan pelunasan) — tetapkan satu urutan (link dulu, baru klaim), uji bersamaan; pajak belum diputus, jadi trigger membaca total link, bukan menghitung pajak.
W1b: rumus boleh mulai; simpan settings menunggu no. 3. W2 menunggu no. 1, 2, 4, 5. W4: unik link (0526:131) menghalangi banyak kunjungan per link bulanan, ubah di 0527.

## Re-review 26 Nov (60b98aa8d): TIDAK LULUS, 0 P1 2 P2 4 P3

"guard" = `src/db/schema/wfc-seat.custom.sql` (isi sama di 0526). Butir 1, 2, 4, 5, 6, 7 tutup.

1. **P2** guard:156-164: `refunded_idr` masih bisa naik di `completed`/`no_show` (test :1145 mengesahkannya, ubah). Aturan: `checked_in`/`no_show`/`completed` -> `refunded` dan kenaikan `refunded_idr` ditolak; `confirmed` -> `cancelled`/`refunded` hanya bila `clock_timestamp() < starts_at`; `cancelled` -> `refunded` boleh. Pengecualian: jumlah `payment_provider_refunds` intent link >= total link, dicek trigger. Jam test di masa depan.
2. **P2** guard:51-60: approval wajib `source_module='wfc'`, `object_id = NEW.id::text`, payload memuat semua angka + version + `effective_from` yang sama. Test: modul inbox, object lain, satu angka beda.
3. **P3** guard:169-200: `paid_idr` hanya boleh naik langsung ke `price_idr`.
4. **P3** `src/services/crm-promo.service.ts:474`: izinkan transisi promo lama ke nonaktif; test lewat `createPromotion`/`updatePromotion`.

Urutan: guard + 0526, test gagal-dulu, crm-promo, review delta no. 1-3. Diterima: unik payment_links (cek jumlah baris dan deploy saat sepi di gerbang rilis), kuota butuh settings disetujui.
W2: boleh mulai di luar refund/batal, gabung sesudah no. 1 dan 3; pakai `lockWfcClaim`, tangani 55P03; putuskan klaim yang hold-nya lewat lalu lunas (paling membatasi: tidak disahkan bila kursi sudah tidak bebas, uang jadi bayar telat). W3: payout refund memakai total link. W1b: `lockOutletSeats`, tolak `wfc_seats` < kuota tertinggi.

## Re-review 26 Nov (a35c76829): TIDAK LULUS, 0 P1, 1 P2 (no. 2-4 tertutup, penomoran 0527 benar)

1. **P2** guard `wfc-seat.custom.sql:195-213` (isi sama di 0527): SUM semua intent tautan; bayar dobel + refund dobel membuat klaim terpakai bisa `refunded` padahal uang asli masih kita pegang. Test `wfc-schema.test.ts` (50.000 + 19.999 + 1, tiga intent) mengesahkannya, harus dibalik.
   Perbaikan, per transaksi pelunas: EXISTS satu intent `i` (tenant, outlet, tautan sama; `paid_at` dan `provider_ref` terisi; `amount_idr >= total tautan`), tanpa baris `payment_unallocated_funds` pada `i`, dengan SUM `payment_provider_refunds` (intent `i`, `provider = i.provider`, `provider_payment_ref = i.provider_ref`) `>= total tautan`. Kasus lain: Finance manual.
   Test gagal-dulu: refund dobel di intent kedua dan di transaksi kedua intent yang sama, gabungan antarintent, ref beda: ditolak; refund bertahap pada transaksi pelunas: diterima; total memuat pajak.
2. W1b wajib membuat id versi settings sebelum membuka approval.
3. W3 WFC: rancang fakta refund provider untuk Duitku (sekarang hanya DOIT yang mencatat; untuk Duitku pengecualian belum pernah menyala, aman).
4. Sesudah perbaikan: CTO cek diff guard + test, tanpa review architect ulang bila SQL sesuai no. 1.

## Cek CTO 26 Nov (774babc22): LULUS

SQL guard sama dengan spesifikasi no. 1; test pembayaran dobel, transaksi kedua, refund terpecah, ref/provider lain ditolak; refund bertahap pada transaksi pelunas diterima. Syarat: pembayaran dobel wajib selalu tercatat di `payment_unallocated_funds` (dijaga W3 WFC).
