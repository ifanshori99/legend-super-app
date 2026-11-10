# Sub-brief 178: tolak retur sebagian yang menggugurkan promo (legend-ob9o)

Worktree `.worktrees/refund-promo-guard`, cabang `ws/refund-promo-guard` dari `ws/pos-refund-void` aae97551. Jangan edit service (engineer yang mengedit). Test: `LEGEND_TEST_FILES="src/test/<file>" pnpm test` dari root worktree, output ke berkas lalu baca ekornya.

## Keputusan founder Q29 (pilihan B)
Retur sebagian POS yang membuat sisa pesanan tidak lagi memenuhi syarat promo yang sudah dipakai (minimum belanja, cakupan item, dst.) DITOLAK: HTTP 422, kode `REFUND_BREAKS_PROMO`, pesan bahasa Indonesia menyebut nama promo dan syaratnya, mengarahkan kasir ke refund seluruh pesanan. Refund seluruh pesanan (semua sisa item diretur) tetap boleh. Berlaku untuk retur pertama maupun berikutnya.

## Kode (hasil peta)
- `apps/api/src/services/pos-order-corrections.ts:469` `refundPosOrder`, blok promo 541-650; `recomputeAfterPartialRefund` di :570 (`crm-promo-refund.ts:299`).
- Promo gugur = entri `recomputed.withdrawn` (`promotionId`, `discountIdr`, `reason`), `crm-promo-refund.ts:491-523`. `returnsAll` (`keptLines.length === 0`, :311) = refund seluruh pesanan.
- Pola galat: `throw new HttpError(422, "CODE", "pesan")`, respons `{error:{code,message}}`.

## Test (T1, `apps/api/src/test/pos-refund-promo-db.test.ts`, pakai helper `seedPromotion({minSpendIdr})`, `promoSale`, `refundBody`, `pos().refund`, `refundRows`, `application`, `spentOf`)
Contoh bead: X Rp195.000, Y Rp5.000, Z Rp5.000, promo Rp50.000 min belanja Rp200.000, dibayar Rp155.000.
1. Retur Z: sisa Rp200.000 masih memenuhi → sukses (perilaku sekarang).
2. Lalu retur Y: sisa Rp195.000 < Rp200.000 → 422 `REFUND_BREAKS_PROMO`, pesan memuat nama promo; tidak ada baris refund baru, `spent_idr` promo, redemption, stok, dan persetujuan tidak berubah.
3. Retur Y+Z sekaligus dari pesanan utuh → 422 yang sama, tidak menulis apa pun.
4. Setelah (1), retur X+Y (semua sisa) → sukses: refund seluruh sisa tetap boleh, promo dilepas seperti sekarang.
5. Retur seluruh pesanan sekaligus → sukses.
6. Promo cakupan item (bila helper mendukung): retur semua item dalam cakupan sementara item lain tersisa → 422.
Test lama yang mengharapkan retur sebagian menggugurkan promo lalu sukses (sekitar :616) diubah mengharapkan 422 (perubahan perilaku yang disengaja); laporkan test mana yang diubah.
Semua test baru harus GAGAL di aae97551; laporkan baris kegagalannya.
