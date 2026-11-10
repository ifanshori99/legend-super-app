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

## Putaran 2 (temuan architect F1 atas 631344cf)

P1 `apps/api/src/services/order-recovery-refund.ts` ~600: cap hanya dipasang bila ada replay. Order promo, kopi dilaporkan lalu LANGSUNG di-swap ke air (tanpa refund A), voucher 20.000; air gagal, manual_refund B -> replay null, recompute promo menganggap kopi gagal -> B = 8.085 (+ledger 7.000). Tamu 28.085 > 25.000; refund > approval ORD-09 5.000. Rantai: B gagal final, lalu C (baris sama) -> akar B, cap tidak berlaku, C replay 8.085.

Perbaikan:

1. Syarat cap: baris yang dilaporkan adalah baris pengganti (`originalOf.has(issue.orderItemId)`), di jalur replay MAUPUN recompute promo. Nilai cap tetap: `recoveryRefundSplit` baris itu tanpa promo, `.wantedIdr`.
2. `recoveryRefundSplit` dapat `capIdr?` dengan aturan sama seperti `recoveryRefundReplaySplit` (jumlah dan bagian dipotong seperti `cutToRoom`, lalu room; shortfall hanya dari room). Unit test-nya ikut.
3. Ledger promo tetap mencatat `goodsIdr` SEBELUM cap (kopi keluar penuh dari promo; refund item lain berikutnya tetap benar). Pastikan `recordPartialRefundPayout` menerima goods pra-cap, dan amount refund pasca-cap.
4. Audit `swapCapIdr` saat cap memotong.

Test gagal-dulu (tambah ke `order-recovery-refund-swap-cap.test.ts` dan `order-recovery-refund-amount.test.ts`): swap langsung lalu gagal (pay-first promo, open bill promo) -> B = 3.885 persis, voucher + B <= 25.000, ledger paid +7.000 (pra-cap); rantai swap langsung -> B gagal final -> C -> C = 3.885; unit `recoveryRefundSplit` dengan capIdr. Order tanpa promo: swap langsung lalu gagal -> tidak berubah dari sekarang (nilai baris sendiri).
