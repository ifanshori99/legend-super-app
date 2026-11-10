# Sub-brief: lanjutan pesanan latihan (legend-0v3b3 shift kas, legend-13avp stok)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/training-orders-followup (apps/api). Helper ada: `isTrainingOrder(tx, tenantId, orderId)` di `services/device-training.ts`. Pola tes pesanan latihan: `test/accounting-auto-journal-training.test.ts`, `test/inventory-gl-training.test.ts` (tandai latihan lewat INSERT `pos_orders.is_training=true`, atau `session_replication_role = replica` untuk UPDATE pesanan selesai).
Tugas test-writer: tulis tes GAGAL-DULU (jalankan, tunjukkan gagal karena perilaku lama), JANGAN ubah src non-test. Jalankan: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/<file>" pnpm test'` (path `src/test/...`). Satu run per perubahan.

## Kartu A: legend-0v3b3 (file tes: apps/api/src/test/pos-shift-training.test.ts)

Perilaku baru: `computeShiftAggregates` (services/pos-shift-support.ts ~:252) tidak menghitung tender tunai, refund tunai, dan void tunai milik pesanan latihan. Shift campuran (1 pesanan nyata + 1 latihan, keduanya tunai di shift yang sama) -> kas diharapkan = modal + hanya penjualan nyata; tutup shift dengan hitungan fisik = nyata -> selisih 0, tidak ada journal `cashier_shift.closed` selisih palsu.
Kasus: (1) tender tunai latihan tidak masuk cashSalesIdr; (2) refund tunai pesanan latihan tidak mengurangi; (3) void tunai pesanan latihan tidak mengurangi; (4) shift campuran tutup: differenceIdr 0; (5) kontrol: shift tanpa pesanan latihan hasilnya identik dengan sebelumnya; (6) isolasi tenant/shift: pesanan latihan di shift lain tidak mengubah shift ini. Pola seed: test/pos-shift.test.ts / pos-shift-db.test.ts.

## Kartu B: legend-13avp (file tes: apps/api/src/test/recipe-deduction-training.test.ts)

Keputusan founder Q63: pesanan latihan tidak memotong stok. `recipe-deduction.service.ts` `consumeInTransaction` (~:844) melewati pesanan latihan: `order.paid` -> tidak ada baris `recipe_deductions`, tidak ada `stock_ledger`, tidak ada `stock.moved`; `order_issue.recorded` (remake/comp) sama; `order.voided` pesanan latihan tanpa deduksi sebelumnya -> tidak ada tombstone/return; `day.closed` -> `postPendingDeductions` tidak memposting deduksi pending milik pesanan latihan (juga tidak menyumbat batch). Void pesanan latihan yang SUDAH punya deduksi (dari sebelum aturan) tetap membalik (return). Pesanan biasa tidak berubah (kontrol di tiap kasus: deduksi dan stok persis sama). Pola seed: test/recipe-pos-hpp.test.ts, test/order-issues.test.ts, test/recipe-bom.test.ts (resep + bahan + pesanan).

## Putaran 2 (hasil review architect; src sudah diperbaiki, tes baru harus LULUS)

Tambah ke apps/api/src/test/pos-shift-training.test.ts, jangan ubah src:

- (7) Refund tunai pesanan latihan yang ditahan (`needs_approval=true`) dan void tunai pesanan latihan yang ditahan tidak mengubah `heldCorrectionCashIdrOf` (nilai 0), sehingga tutup shift (normal dan paksa) tidak mencatat selisih palsu; kontrol: refund/void ditahan pesanan nyata tetap dihitung.
- (8) Tender tunai pesanan tanpa baris `pos_orders` (QR bayar-dulu, hanya baris `orders` channel qr + tender di shift) tetap masuk cashSalesIdr.
