# Sub-brief: pesanan latihan tidak boleh menjurnal (legend-gkc6b)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/training-orders-no-journal (apps/api). Jangan sentuh file src non-test; engineer yang memperbaiki.

Akar masalah: `pos_orders.is_training` (db/schema/pos-order.ts:101) tidak diperiksa oleh

- `services/accounting-auto-journal-consumer.ts` `postAutoJournal` (order.paid / order.refunded / order.voided; orderId di payload = ULID),
- `services/inventory-gl-consumer.ts` `postStockSourceToGl` (sourceType "order", movement sale/return, sourceId = ULID order).
  Perbaikan (engineer): helper `isTrainingOrder(tx, tenantId, orderId)` di `services/device-training.ts`, dipanggil di kedua titik -> `{status:"ignored"}`.

Tugas test-writer: tulis test GAGAL-DULU (jalankan, tunjukkan gagal karena jurnal terbentuk), jangan perbaiki src.
Perintah: bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="apps/api/src/test/<file>" pnpm test' (cek dari package.json path yang benar; satu run saja per perubahan).

Kasus wajib:

1. Pesanan latihan dibayar (order.paid) -> 0 journal_entries (dan tidak ada baris auto_journal_parked). Pesanan biasa dengan data identik -> tetap menjurnal sama persis.
2. Pesanan latihan di-void dan di-refund (event order.voided / order.refunded, juga bila sale journal tidak ada) -> 0 jurnal, 0 parked (jangan parkir AUTO_JOURNAL_SALE_MISSING).
3. Isolasi tenant: pesanan latihan tenant A tidak mengubah jurnal pesanan biasa tenant B; id order yang sama tidak mungkin lintas tenant, cukup pastikan pengecekan memakai tenant.
4. Jalur sweep/retry: baris parked order latihan (bila ada) tidak membuat jurnal.
5. COGS: stock_ledger movement sale pada order latihan -> deliverInventoryGlEvent dan postStockSourceToGl tidak membuat jurnal/inventory_gl_postings/blocked; order biasa tetap menjurnal.

File:

- A: apps/api/src/test/accounting-auto-journal-training.test.ts (pakai helper pola test/accounting-auto-journal.test.ts: makeTenant ~:195, seedPosOrder ~:460, orderPaid, orderRefunded, envelope, deliver, sweep; set latihan lewat UPDATE pos_orders SET is_training=true).
- B: apps/api/src/test/inventory-gl-training.test.ts (pola test/inventory-gl.test.ts dan test/recipe-pos-hpp.test.ts).

## Putaran 2 (hasil review architect; src sudah diperbaiki, test baru harus LULUS)

Perilaku baru:

- `isTrainingOrder` mengembalikan false untuk orderId bukan ULID (tidak melempar).
- `order.voided` / `order.refunded` pesanan latihan TETAP membalik bila jurnal `aj:sale:<orderId>` sudah ada (jurnal lama dari sebelum aturan); bila tidak ada -> ignored, tanpa parked.
- `postStockSourceToGl` sumber `order` latihan: bila sudah ada `inventory_gl_postings` untuk ledger sumber itu -> tetap diposting (return membalik); bila tidak -> `ignored` dan baris `inventory_gl_blocked` sumber itu dihapus.
  Pola setup "jurnal lama": buat pesanan biasa, jurnalkan, lalu tandai latihan lewat `session_replication_role = replica` (lihat AJ-TRAIN-04).

Tambah test:

- A (accounting-auto-journal-training.test.ts): (a) sale terjurnal lalu order ditandai latihan, refund + void tetap membalik jurnal; (b) orderId bukan ULID pada order.paid nol-rupiah / order.voided tidak melempar, hasil ignored (bukan crash).
- B (inventory-gl-training.test.ts): (a) baris blocked lama sumber latihan terhapus setelah sweep dan tidak dicoba ulang; (b) sale sudah diposting lalu order ditandai latihan, return tetap diposting.
