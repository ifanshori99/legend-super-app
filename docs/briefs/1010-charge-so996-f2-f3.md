# 1010 SO 996 F2+F3 (charge setelah void POS, split jurnal refund charge)

Worktree: /Users/ifanshori99/Projects/legend super app/legend-87f2253d (base af6845a55). Sumber temuan: `git show ef4c42693:docs/qa/second-opinion-refund-charge.md` (F2, F3). Jangan bergantung pada kode 980.

## Kartu legend-vl6bk (F2, P1)
Charge belum dibayar bisa ditagih (tunai/QRIS/EDC) setelah transaksi POS asal di-void final via `voidPosOrderCorrection` (`pos-order-corrections.ts`; order tetap `completed`, bukti void di `pos_order_voids`). Jalur collect: `order-recovery-charge.ts:~639` (cashierQris), `order-recovery-charge-pos-nontunai.ts:~111`, `order-recovery-charge-pos.ts:~174`; semuanya hanya menolak `orders.status='voided'`. `order-recovery-charge-void.ts:123` `paidChargesOfOrder` hanya charge paid.
Target: setelah void final, charge belum dibayar ditolak 409 dengan kode jelas di semua jalur collect + consumer webhook QRIS (QRIS terbit sebelum void, terbayar sesudah: tidak boleh jadi `charge_paid`; uang masuk diarahkan ke satu refund penuh), di bawah lock order (race webhook vs void aman). Atau charge ikut dibatalkan di transaksi void.

## Kartu legend-0zfr1 (F3, P2)
`order-recovery-charge-refund.ts:~151`: `refundedBefore` (baris ~144, ~285-303) menjumlah semua refund selain `failed`, termasuk reservasi yang kemudian gagal; split gross/PBJT dibekukan di event saat request dibuat (~212). Skenario: charge 10 (gross 9/PBJT 1). A=5 (4/1), B=5 (5/0), A gagal, B selesai, C=5 pakai priorIdr=5 -> 5/0. B+C membalik gross 10, PBJT 0 > gross awal. `chargeRefundedFactOf` (`accounting-auto-journal-amounts.ts:~2224-2267`) memakai komponen event.
Target: split hanya menghitung refund yang benar-benar berhasil; refund gagal tidak mengubah split berikutnya; total reversal gross/service/PBJT = charge persis; jurnal seimbang; serialisasi per charge.

## Test wajib (gagal-dulu di base)
void lalu tagih -> ditolak, tidak ada uang/event masuk (3 metode + webhook QRIS setelah void + race); refund gagal lalu refund baru -> split dan total tepat, tak melebihi nilai charge; bersamaan; tenant lain tidak tersentuh. Pakai endpoint `corrections/void` sungguhan, bukan set status voided langsung.
Migrasi hanya bila perlu (nomor 0630-0631).
