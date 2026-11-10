# 186b hasil architect 1 (review ganda Claude, brief 225)

Kode: `milestone/m1` 94d769c6. Kartu: legend-s7rx, legend-wkl3, legend-15by, legend-8v2yl (review).

Hasil: **Bersih** (tidak ada P1/P2 baru).

## Jawaban
- Bayar lebih dari yang dibayar tamu / item gratis menghasilkan uang: tidak ditemukan. `pos-order-corrections.ts:731` `owedIdr = min(dueBill, paid - refunded)` dan `assertRefundWithinPaid` (765). Item gratis BOGO: retur unit gratis menggugurkan promo (`stillEarned`), harga yang disimpan = yang dibayar, `dueBill = 0`, baris Rp0. Contoh: 2 x 50.000 BOGO + diskon manual 10.000, bayar 40.000; retur 1 unit: keptGoods 45.000, keptPayableBill 45.000, due 0.
- Pelunasan tanpa item: hanya bila sudah ada refund (641), promo gugur ditolak 422 `REFUND_SETTLEMENT_NEEDS_ADMIN` (678-687). Edit promo: snapshot aturan dipakai; baris pra-snapshot memakai aturan hari ini, tetapi diskon yang disimpan dibatasi `min(share, original)` (`crm-promo-refund.ts:654`), jadi tamu paling banyak menerima bagian pro-rata. Perubahan anggaran tidak mengubah nominal payout (hanya ledger, diaudit `budgetShortIdr`).
- FIFO per tender (`pos-order-corrections.ts:486-548`): total per metode tetap dari `refundAllocation(stillRefundableByMethod)`; bagian per metode tidak melebihi sisa metode (largest remainder, jumlah <= bobot), lalu dibagi ke tender dengan sisa per tender hasil replay baris lama (baris bertender dari tendernya, baris lama FIFO). Sisa yang tidak muat ditulis tanpa tender/intent (fail-closed).
- Pembaca `pos_order_refunds.lines`: `pos-day.service.ts:532-542` dan `pos-shift-support.ts:287, 394, 592` menjumlah per metode, jadi beberapa baris per metode aman; baris Rp0 punya `lines=[]` dan `amountIdr=0` (cek keseimbangan lolos). Event `order.refunded` tetap satu baris per metode (858-866). Atribusi intent: `pos-intent-attribution.ts` membaca `tenderId`/`paymentIntentId`.
- DP: tender dipakai lebih dulu; Rp0 + `depositOwedIdr` hanya bila tender habis (735-743). Uang tunai yang masih di tender tidak bisa disembunyikan. Pendapatan item pada retur Rp0 DP sudah dikartu legend-pk38k.

## Catatan P3
- Flake legend-4fzhu (in_progress) menyentuh test describe ini; tidak dinilai ulang.
