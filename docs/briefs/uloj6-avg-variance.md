# legend-uloj6: jurnal selisih rata-rata retur supplier (keputusan CTO: B)

## Masalah
Retur supplier mengeluarkan stok pada biaya penerimaan c_r, tetapi avg_cost saldo (a) tidak berubah. Jurnal mengkredit persediaan pada q x c_r, sedangkan sub-ledger turun q x a. GL persediaan melenceng dari qty x avg sebesar q x (c_r - a).

## Keputusan
Avg dan HPP TIDAK berubah. Tambah satu pasang jurnal yang menyeimbangkan sendiri:
- D = jumlah semua baris retur dari (lineValueIdr - round(q x avgSebelumRetur)).
- D > 0: Dr persediaan, Cr `inventory_price_variance` (akun 5106 "Selisih Harga Persediaan").
- D < 0: sisi dibalik. D = 0: tanpa baris.
- Utang ke supplier (nota debit, GRNI/AP) tidak berubah.

## Perubahan
- Payload event `purchase_return.recorded`: field opsional `movingAvgVarianceIdr` (integer IDR bertanda, default 0 untuk event lama; tidak perlu bump versi bila opsional). Schema di `packages/shared/src/inventory/purchasing/events.ts`.
- Emitter: `apps/api/src/services/purchase-return.service.ts` (~:695-725 payload; ~:933-969 nilai baris; ~:1060-1085 loop stok). Baca avg sebelum pergerakan di bawah kunci saldo: `recordStockMovementInTransaction` (`inventory.service.ts` ~:971-1030, `lockStockBalance` ~:1018, `balance.avgCostIdr`). Kembalikan avg-sebelum dari fungsi itu atau baca `stockBalances.avgCostIdr` di bawah kunci tepat sebelum loop. Mode pembulatan: ikuti yang dipakai applyStockMovement.
- Jumlah: `apps/api/src/services/accounting-auto-journal-amounts.ts` ~:2191-2216, tambah kunci `returnMovingAvgVarianceIdr` (bertanda) ke `amounts`.
- Aturan: `packages/shared/src/accounting/posting-rules.ts` ~:416-428 (dikerjakan implementer lain): ["inventory","debit",key], ["inventory_price_variance","credit",key].
- Akun dan migrasi 0384 (implementer lain): coa.ts, i18n, drizzle/0384_inventory_price_variance.sql.
- Tes: `apps/api/src/test/purchase-return-avg-variance.test.ts` (test-writer, gagal-dulu).

## Batas
Jangan ubah `applyStockMovement`, avg, HPP. Tidak ada backfill retur lama.
