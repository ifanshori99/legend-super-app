# SO inventori + stok (1208, 20 Nov, architect, int/batch100)
Verdict: TIDAK (1 P1, 1 P2; angka stok dan laba rugi salah)
## P1 Opname menghitung penjualan dua kali bila penjualan diposting sesudah baris diisi
`inventory-count.service.ts:813-836` systemQty = saldo saat ini; `:1601` delta = counted - systemQty. Mode `close_of_day` (`inventory-settings.service.ts:93`): saldo 10, terjual 2 (pending, `recipe-deduction.service.ts:551`), opname 8 -> -2 susut; tutup hari -2 HPP lagi -> stok 6 vs fisik 8. Sama di real_time saat outbox tertinggal / order edge telat, repost (`recipe-deduction-repost.service.ts`), void sesudah opname.
## P2 Stok negatif lalu restock: nilai GL persediaan tidak sama dengan kartu stok
`packages/shared/src/inventory/schemas.ts:460-464` receipt ke saldo <=0 reset avg ke biaya receipt. Item avg 0 dijual 5, terima 10 @100: kartu 500, GL 1000, HPP kurang 500 permanen. Tidak ada jurnal revaluasi (`purchasing-receipt-journalize.service.ts`, `inventory-gl-consumer.ts`).
Dicek OK: transfer, waste, selisih retur pembelian, yield produksi, scope tenant lokasi.
Belum: opening stock `inventory-setup.service.ts`, `petty-purchase.service.ts`, pembulatan UOM, sisi inventori edge sync, par alert.
## Keputusan CTO: kartu 1211 (engineer Opus, desain baru di HPP). Pilih desain paling sederhana yang benar untuk semua jalur telat (pending, outbox, edge telat, repost, void); diff kecil.
