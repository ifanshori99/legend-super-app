# Brief Codex 172b: second opinion refund promo + void POS non-tunai

Peran: second-opinion (tingkat K: uang, refund, budget promo). Read-only. Cabang `ws/pos-refund-void`, diff `5e227f59..aae97551` (dasar milestone/m1 batch9).

## Berkas berisiko

- `apps/api/src/services/crm-promo-refund.ts` (diskon yang dipertahankan per baris redemption setelah refund sebagian)
- `apps/api/src/services/order-promo-refund.ts` (rekonsiliasi `promotion_redemptions.discount_idr` dan `promotions.spent_idr`, naik dan turun)
- `apps/api/src/services/pos-order-corrections.ts` (`refundPosOrder` jumlah payout; `voidPosOrderCorrection` tender non-tunai)
- Test: `apps/api/src/test/pos-refund-promo-db.test.ts`, `apps/api/src/test/pos-order-void-noncash.test.ts`

## Invariant (PRD v1.7 §3.10, §3.21; keputusan founder Q19, Q19b, Q41)

1. Total refund sebuah pesanan berpromo tidak bergantung pada cara retur dibagi: retur bertahap = retur sekaligus untuk himpunan item yang sama.
2. Tidak ada sisa uang tamu yang terkunci: setelah semua item diretur, total refund = yang dibayar lewat tender (DP tidak dikembalikan lewat refund POS).
3. `promotions.spent_idr` tidak pernah negatif dan tidak pernah melebihi `budget_idr` (CHECK `promotions_budget_check`); void penuh berikutnya (`releasePromotions`) tidak membuatnya negatif.
4. Jumlah `discount_idr` baris redemption yang masih applied sama dengan `promotion_order_applications.total_discount_idr`, atau selisihnya tercatat di audit.
5. Void penjualan selesai hanya mengembalikan tunai; penjualan yang memegang uang lewat gateway, EDC, atau poin tidak boleh di-void diam-diam (uang non-tunai lenyap dari pembukuan).
6. Refund yang ditolak tidak menulis apa pun: baris refund, ledger promo, budget, stok, persetujuan.

## Pertanyaan

- Cari skenario angka Rupiah yang melanggar invariant 1 sampai 6 (urutan retur, beberapa promo bertumpuk, voucher nilai, diskon manual, pajak/service, DP, anggaran promo habis di antara dua refund, refund berulang dengan idempotency key sama).
- Cari tender method/status yang lolos dari penolakan void.
- Laporkan P1/P2 dengan file:line, angka reproduksi, dan saran fix. Tulis hasil ke `docs/briefs/172b-second-opinion-pos-refund-void.result.md`.
