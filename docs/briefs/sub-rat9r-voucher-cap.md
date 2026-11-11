# legend-rat9r: voucher selisih tukar + refund item <= nilai dibayar tamu

Cabang `ws/rat9r-voucher-cap` dari `ws/pti5r-promo-refund` (326bfbfa). Worktree
`.worktrees/rat9r-voucher-cap`.

## Keputusan founder (W4 Q25, 11 Nov)

- Voucher selisih tukar dihitung dari nilai yang DIBAYAR tamu untuk item itu
  (setelah promo/diskon, termasuk service dan PBJT), bukan harga daftar.
- Total voucher + refund untuk item itu (termasuk refund item pengganti, refund
  ulang/replay) <= nilai dibayar.
- Contoh founder: kopi promo dibayar 8.085 (goods 7.000 x 1,155), ditukar ke air
  (cap refund air 3.885), harga daftar memberi voucher 20.000. Hasil yang benar:
  voucher 8.085, refund 0.
- Aturan global "Jangan sampai rugi": test membuktikan tidak ada pihak dibayar
  lebih, outlet tidak rugi. Ragu: pilih aturan yang membatasi, catat untuk CTO.

## Rumus kerja (dipilih agent, cocok dengan contoh founder)

- `paidIdr` = nilai dibayar baris asli = `wantedIdr` refund baris itu dengan
  promo, sebelum cap dan potongan ruang (sama dengan yang dihitung consumer
  refund untuk baris asli).
- Voucher = `min(selisih harga daftar, paidIdr)` (selisih daftar tetap batas
  atas lama; nilai dibayar memotongnya).
- Refund apa pun untuk item itu (baris asli atau pengganti, filing pertama atau
  replay) dipotong ke `paidIdr - voucher - refund item itu yang sudah hidup`,
  di atas cap fwe4l yang ada.
- Catatan untuk CTO: rumus yang lebih membatasi adalah `paidIdr - harga
  pengganti`; contoh founder (voucher 8.085) tidak cocok dengan itu, jadi tidak
  dipakai.

## Kode

- Voucher: `apps/api/src/services/order-recovery.service.ts` `swapSettlement`
  (~1112), selisih ~1133, mint ~1187 (`mintApologyVoucher`,
  `apology-voucher.service.ts:224`), approval ~1168.
- Refund: `apps/api/src/services/order-recovery-refund.ts` swap cap ~395, ~608,
  `capIdr` ~634/639, `nothing_left` ~670, audit `swapCapIdr` ~754.
- Nilai dibayar: `order-recovery-refund-amount.ts` `promoParts` ~162,
  `recoveryRefundSplit` ~242; recompute promo di `order-promo-refund.ts`.
- Test terkait: `order-recovery-swap-credit`, `order-recovery-swap-double-credit`,
  `order-recovery-refund-swap-cap`, `order-recovery-refund-promo`,
  `order-recovery-refund-amount`, `apology-voucher`; fixture
  `order-recovery-helpers.ts`.

## Kombinasi wajib test gagal-dulu

1. Tukar ke lebih murah di order promo: voucher <= paid (contoh founder 8.085).
2. Tukar + voucher, lalu item pengganti gagal -> refund <= paid - voucher (0 di
   contoh founder).
3. Sama dengan 2, refund gagal final, lapor ulang (replay) -> tetap <= sisa.
4. Order tanpa promo: voucher dan refund tidak berubah (regresi).
5. Tukar ke item lebih mahal: tidak ada voucher, aturan lama.
6. Kirim ulang event / idempoten: voucher sekali, refund tidak dobel.
7. Isolasi tenant.

## Aturan kerja

- Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari
  root worktree, `run_in_background`, tunggu notifikasi, jangan sleep.
- Jangan commit, jangan `git stash`. Jangan baca `.env*`.
