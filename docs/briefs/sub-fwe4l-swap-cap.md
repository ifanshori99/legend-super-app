# Sub-brief legend-fwe4l: refund setelah tukar item dibatasi nilai item pengganti

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pti5r-promo-refund`, cabang `ws/pti5r-promo-refund` (tip caadce36, kode = b36d5d3c). Jangan rebase/force-push. Konteks: `docs/briefs/sub-pbwzq-codex422.md` (Putaran 2), `docs/briefs/sub-pti5r-promo-refund.md` (Round 3-4).

## Keputusan founder (Q17)

Order PROMO: kopi Rp30.000 (issue A) refund gagal final; kopi dilaporkan ulang dan di-swap ke teh Rp20.000 (+voucher selisih); teh gagal, manual_refund B. Sekarang B me-replay jumlah A (via `toOriginal`) -> tamu dapat refund kopi + voucher (dobel). HARUS: refund B dibatasi nilai baris pengganti (teh), jadi voucher selisih tidak dobel. Order tanpa promo sudah benar sejak b36d5d3c (pendahulu harus baris yang sama -> B dibayar normal).

## Kontrak (dipakai implementer dan test-writer)

- `recoveryRefundReplaySplit` (`apps/api/src/services/order-recovery-refund-amount.ts`) dapat input opsional `capIdr?: number`. Bila ada dan `< wantedIdr`: jumlah yang diminta jadi `capIdr`, bagian split (gross, discount, service, pbjt) dipotong proporsional dengan cara yang sama seperti `cutToRoom` (jumlah bagian tetap = amount). Lalu batas room berlaku seperti biasa. `wantedIdr` di hasil = setelah cap; `shortfallIdr` hanya dari room (cap bukan kekurangan, uangnya memang tidak terutang).
- `findRecoveryRefundReplay` mengembalikan juga `rootOrderItemId` (item issue akar rantai). Caller (`order-recovery-refund.ts`): bila `replay.rootOrderItemId !== issue.orderItemId` (akar adalah item lain = ada swap di rantai), `capIdr` = `recoveryRefundSplit({ order, lineTotalIdr: line.lineTotalIdr, priorLinesIdr, releasedIdr }).wantedIdr` (nilai baris pengganti tanpa promo: baris pengganti tidak ikut harga promo). Rantai A(kopi) -> B(teh, dipotong cap) -> B gagal final -> C(teh) juga terpotong (akar tetap kopi).
- Audit `refund_requested` boleh mencatat `swapCapIdr` bila cap berlaku.

## Test gagal-dulu (test-writer)

1. Unit di `apps/api/src/test/order-recovery-refund-amount.test.ts`: replay split dengan `capIdr` < wanted -> amount = cap, bagian proporsional, jumlah bagian = amount, shortfall 0; cap >= wanted -> tidak berubah; cap + room lebih kecil -> room menang, shortfall dihitung dari wanted setelah cap.
2. DB, file baru `apps/api/src/test/order-recovery-refund-swap-cap.test.ts` (pakai pola swap dari T6 di `order-recovery-refund-codex422.test.ts`, termasuk `uuidToUlid` untuk id baris pengganti, dan seed promo dari `order-recovery-refund-promo-final-failure.test.ts`): order promo pay-first, kopi gagal final (provider_declined), swap ke menu lebih murah, baris pengganti gagal -> refund B = nilai normal baris pengganti (bukan jumlah kopi), split order.refunded konsisten, ledger promo tidak berubah, voucher tidak dobel (refund B + voucher <= nilai kopi yang dibayar). Varian rantai: B gagal final lalu C -> tetap dibatasi. Varian open bill bila murah. Satu assertion isolasi tenant.

## Aturan

- Implementer hanya `order-recovery-refund.ts` + `order-recovery-refund-amount.ts`. Test-writer hanya dua file test di atas.
- Jangan jalankan `pnpm test` (agent utama yang menjalankan). Typecheck `heavy pnpm --filter @starter/api typecheck`, prettier bersih. Jangan commit. Jangan baca `.env*`.
- Lapor: file, perubahan, keraguan.
