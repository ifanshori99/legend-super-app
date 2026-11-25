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
