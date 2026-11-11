# legend-eajpb, legend-5g9sn, legend-pqm3t: sisa aturan Q25 (voucher + refund <= dibayar)

Cabang `ws/rat9r-followups` dari `origin/ws/rat9r-voucher-cap` (391a5514) + merge
ti19m 79923008. Worktree `.worktrees/rat9r-followups`. Latar: `docs/briefs/sub-rat9r-voucher-cap.md`.

## Keputusan (CTO, 11 Nov)

- Rumus voucher tukar tetap `min(selisih daftar, dibayar - voucher rantai - refund hidup rantai)`.
- Tukar setelah refund `rejected` boleh selama total voucher + refund <= dibayar.
- Aturan global "Jangan sampai rugi": test membuktikan tidak ada pihak dibayar
  lebih dan outlet tidak rugi. Ragu: pilih aturan yang membatasi, catat untuk CTO.

## Kartu

1. **legend-eajpb** voucher maaf staf tanpa rantai tukar: batasi ke nilai dibayar
   tamu per baris. `voucherRoomOf` (`order-recovery-paid-value.ts:333`) memberi
   `null` (tanpa batas) bila rantai tidak punya `paidValueIdr`. Ganti: tanpa
   `paidValueIdr`, hitung nilai dibayar baris dari order (sama dengan
   `swapPaidValueOf`: promo hidup = dry-run recompute; tanpa promo =
   `recoveryRefundSplit(...).wantedIdr`) lalu `max(0, dibayar - voucher rantai -
   refund hidup rantai)`. Pemakai: `issueApologyVoucherForStaff`
   (`apology-voucher.service.ts` ~874), `voucherRoom`/`systemVoucherSettlement`/
   `voucherOffer` (`order-recovery.service.ts` ~904, ~1286). Skenario wajib:
   laporan biasa baris dibayar 8.085 + voucher staf 100.000 ditolak 422; refund
   manual sudah dibayar lalu laporan kedua di baris sama: voucher <= sisa; order
   tanpa promo; isolasi tenant; replay idempoten voucher yang sudah terbit tetap
   mengembalikan hasil tersimpan.
2. **legend-5g9sn** `refundPosOrder` (`pos-order-corrections.ts:583`) ikut
   menghitung voucher: voucher (selisih tukar + maaf) + refund POS + refund
   recovery untuk baris/order itu <= yang dibayar. Tentukan level (baris atau
   order) dari cara `refundPosOrder` memilih jumlah; bila hanya level order,
   batasi `dibayar order - Σ voucher terkait order - Σ refund hidup`. Kunci:
   ikuti urutan issue lalu order; jangan buat deadlock dengan consumer refund.
3. **legend-pqm3t** preview pilihan tukar (`order-recovery.service.ts` ~859,
   `differenceIdr = harga baru * qty - lineTotal`; UI
   `apps/web/src/features/ws03-qr-order/components/recovery/issue-choices.tsx:186`)
   memakai credit nilai dibayar (sama dengan `swapSettlement` ~1164, tanpa
   kunci, read-only). Tukar lama tanpa `paid_value_idr` (sebelum migrasi 0235):
   hitung dari order; bila tidak bisa dihitung, tolak tukar atau minta approval.

## Aturan kerja

- Test gagal-dulu per kartu (jalankan test baru di 391a5514 sebelum fix, catat
  jumlah gagal). Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test`
  dari root worktree, `run_in_background`.
- Typecheck api dan web dengan `NODE_OPTIONS=--max-old-space-size=6144` lewat
  `heavy`; eslint + prettier untuk file yang berubah.
- Architect xhigh atas diff gabungan tiga kartu. Commit + push tiap langkah.
- Temuan Codex (brief 460) menyusul dari CTO.
- Jangan `git stash`, jangan rebase/force-push, jangan baca `.env*`.
