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

## Desain architect (xhigh, 11 Nov) — wajib diikuti

Rumus tetap `credit = min(-difference, max(0, P - voucher rantai - refund hidup rantai))`.

1. Nilai dibayar saat tukar (read-only): file baru
   `apps/api/src/services/order-recovery-paid-value.ts`. Pindahkan dari
   `order-recovery-refund.ts` query `releasedResult`/`priorLinesIdr` (~361-380) dan
   pembangun kept-lines (~482-553); consumer memanggil kode yang dipindah.
   - Tanpa promo hidup: `recoveryRefundSplit({order, lineTotalIdr, priorLinesIdr,
     releasedIdr: 0}).wantedIdr`.
   - Promo hidup: di `tx.transaction(sp => ...)` panggil
     `recomputeAfterPartialRefund` (`deferPayout: true`, item asli dihitung gagal),
     lempar error `DryRun` membawa hasil, tangkap, lalu `recoveryRefundSplit({...,
     promo})`. Savepoint selalu rollback. 422 dari recompute = tukar ditolak
     ("minta bantuan staf").
2. Simpan: `apps/api/src/db/schema/kds-issues.ts:69` kolom
   `paidValueIdr: idrColumn("paid_value_idr")` nullable, `heavy pnpm db:generate`
   (migrasi baru, periksa SQL). `order-recovery.service.ts`: `Settlement` (~927)
   + `paidValueIdr`; `swapSettlement` (~1133-1187) hanya bila `difference < 0`:
   `P` = `paidValueIdr` swap sebelumnya di rantai, atau `swapPaidValueIdr`;
   `credit` ke `requireSwapCreditApproval` (~1168) dan `mintApologyVoucher`
   (~1187); credit 0 = tanpa voucher, tanpa approval. `settleIssue` (~954) tulis
   `paidValueIdr`. Audit (~1021) + `AUDIT_SAFE_FIELDS` (~107): `creditIdr`.
3. Consumer `order-recovery-refund.ts` (di bawah kunci issue+intent): query issue
   (~406) ambil `voucherId`, `paidValueIdr`; rantai = issue dengan
   `toOriginal(orderItemId) === toOriginal(issue.orderItemId)` kecuali issue ini;
   `chainCap = max(0, min(paidValueIdr) - Σ voucher - Σ refund hidup)` (refund hidup
   = refund terbesar per issue, lewati issue yang semua refundnya gagal);
   `capIdr = min(swapCapIdr, chainCap)` di filing pertama dan replay (~608); audit
   `voucherCapIdr` (~754). `paidValueIdr` null = tanpa cap tambahan.
4. Cegah bayar lebih saat cap memotong ke 0: cabang ini sudah me-merge
   `ws/k0ub4-zero-replacement` (jalur `nothing_left` mencatat
   `recoveryRefundGoodsIdr` ke ledger promo, sekali per issue, audit
   `nothing_left` sebagai penanda). Perluas kondisinya dari `swapCapIdr === 0`
   ke "cap (swap atau voucher) memotong ke 0" untuk order promo. Jangan buat
   jalur payout kedua.
5. Test baru tambahan: setelah voucher, refund teh tidak membayar uang kopi.
   Test 7 kombinasi di `order-recovery-swap-voucher-paid-cap.test.ts` (sudah ada,
   13/17 gagal di 326bfbfa) harus lulus tanpa diubah ekspektasinya; bila satu
   ekspektasi salah menurut desain, laporkan, jangan ubah diam-diam.
6. Di luar cakupan (catat saja): refund kasir POS (`refundPosOrder`) mengabaikan
   voucher.
