# Sub-brief 172: refund promo + void POS non-tunai (legend-a0i7, legend-ioyg)

Worktree: `.worktrees/pos-refund-void` (cabang `ws/pos-refund-void`). Semua path relatif ke sini. Jangan sentuh: auto-journal, `pos-shift.service.ts`, `completePosOrder` / kunci intent di `pos-order.service.ts`, `qr-order.service.ts`, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, adapter DOIT.

## A. P1 Codex 127 #1: refund promo bergantung pembagian retur

`apps/api/src/services/crm-promo-refund.ts:649`: `keptAmounts = min(share, original, rechecked, entry.line.discountIdr)`. `entry.line.discountIdr` = diskon yang dibawa baris SEKARANG, sudah diturunkan refund sebelumnya oleh `lowerAppliedDiscount` (`order-promo-refund.ts:92`, yang tidak pernah menaikkan). Akibat: retur bertahap membayar lebih kecil dari retur sekaligus.

Contoh (Codex): promo beli 2 kopi Rp30.000 gratis 1 pastry termurah; pesanan 4 kopi + 2 pastry Rp20.000 + 1 pastry Rp40.000 (subtotal Rp200.000, diskon Rp40.000, dibayar Rp160.000).
- Sekaligus retur 1 kopi + 2 pastry murah: kept 3 kopi + pastry 40k (130k), diskon kept min(share 26k, 40k, recheck 40k) = 26k, payable 104k, refund Rp56.000.
- Bertahap: retur 1 kopi (kept 170k, recheck 20k → kept 20k, refund Rp10.000, baris turun ke 20k), lalu 2 pastry murah (cap baris 20k → payable 110k, refund Rp40.000). Total Rp50.000. Salah: harus Rp56.000.

Fix:
1. `crm-promo-refund.ts`: hapus cap `entry.line.discountIdr`; diskon kept murni fungsi himpunan kept + snapshot awal (`min(share, original, rechecked)`).
2. `order-promo-refund.ts` `lowerAppliedDiscount` → rekonsiliasi dua arah: baris turun = `spent_idr` turun (seperti sekarang); baris naik = baris dan `spent_idr` naik dengan delta yang sama, atomik, dibatasi sisa anggaran (`promotions_budget_check`: spent <= budget). Kekurangan anggaran dicatat di audit (bukan error), supaya invariant `spent_idr >= jumlah baris applied` tetap dan void nanti tidak membuat spent negatif.

## B. P1 Codex 127 #2: sisa kewajiban terkunci

`pos-order-corrections.ts:593`: `payout = min(input.amountIdr, dueBill, tender tersisa)`. Kasir boleh minta kurang dari yang jatuh tempo, item tetap habis, refund berikut tanpa `items` ditolak untuk pesanan berpromo → sisa terkunci.

Contoh: 2 x Rp50.000, promo Rp20.000, dibayar Rp80.000. Refund item A = Rp40.000. Item B diminta Rp30.000 → dibayar Rp30.000, kuantitas habis, sisa Rp10.000 terkunci.

Fix: pesanan berpromo, bila `input.amountIdr < min(dueBill, tender tersisa)` → tolak 422 `REFUND_AMOUNT_BELOW_DUE` sebelum menulis apa pun (pesan menyebut jumlah yang harus dikembalikan). Minta lebih dari jatuh tempo tetap dibatasi diam-diam (perilaku lama, ada test).

## C. legend-ioyg: void penjualan selesai non-tunai

`voidPosOrderCorrection` (`pos-order-corrections.ts:181`) hanya mengembalikan tender `cash` captured, tapi membukukan total penuh. Tender gateway (`qris|va|ewallet|card`), EDC (`edc_card|edc_qris`), poin (`points`) lenyap; auto-journal memarkir `AUTO_JOURNAL_VOID_UNSUPPORTED`.

Keputusan awal (cek architect): TOLAK seperti void DP (`order.depositAppliedIdr > 0`, `CoreError("CONFLICT", ...)`). Bila ada tender `captured` dengan `tenderBucket(method) !== "cash"` → `CoreError("CONFLICT", "Transaksi ini dibayar non-tunai (QRIS/kartu/EDC/poin) dan tidak bisa di-void; gunakan refund.")`, dicek sebelum `consumeApproval` sehingga persetujuan tidak terpakai. Alasan: void tidak punya jalur pengembalian gateway/EDC/poin; refund sudah membagi per metode (`refundAllocation`) dan memancarkan `order.refunded` dengan bucket per metode.

## Test (test-writer)

Tambah ke `apps/api/src/test/pos-refund-promo-db.test.ts` (pakai fixture yang ada: `seedPromotion`, `promoSale`, `refundBody`, `pinApproval`, BOGO di sekitar baris 944-976 dan describe legend-15by baris 1091/1381):
- A1: skenario Codex #1 dengan angka di atas: bertahap total = Rp56.000 = sekaligus; cek `promotion_redemptions.discount_idr` dan `promotions.spent_idr` sama di dua jalur.
- B1: skenario Codex #2: refund B Rp30.000 → 422 `REFUND_AMOUNT_BELOW_DUE`, tidak ada baris refund baru, `refunded_paid_idr` tetap; lalu Rp40.000 lulus, total refund Rp80.000.

File baru `apps/api/src/test/pos-order-void-noncash.test.ts` (fixture dari `pos-order.test.ts` sekitar :583-:640 dan tender QRIS/EDC/poin dari `pos-order-qris-lifecycle.test.ts` atau yang ada):
- C1: void penjualan selesai dengan tender gateway/QRIS → 409 CONFLICT, tidak ada `pos_order_voids`, struk tidak di-void, persetujuan tidak terpakai.
- C2: sama untuk EDC dan poin (bila fixture ada; bila tidak, laporkan).
- C3: void penjualan tunai murni tetap lulus (regresi).

Test harus GAGAL di kode lama. Jalankan: `LEGEND_TEST_FILES="src/test/<file>" pnpm test` dari root worktree.
