# Desain architect (xhigh, 11 Nov) untuk alur A/B/C — wajib diikuti

Tanpa migrasi baru (0235 belum di main). Komentar kolom `kds-issues.ts:75` diubah karena arti berubah.

## Fungsi bersama
- `recoveryChainOf` (`order-recovery-paid-value.ts:274`): hanya alur A mengubah; signature tetap.
- `recoveryReleasedOf`, `findRecoveryRefundReplay`: hanya alur B; boleh tambah field, jangan ubah yang ada (A memanggil).
- Baru `orderGivenOf(tx, tenantId, orderId)` di `services/order-given.ts`: milik alur C; A memakainya.
- Urutan merge: C, B, A.

## Alur A (tukar + voucher)
- hhm5m 1+2 `swapPaidValueOf` (:379): param `lock` (preview `false`). Basis dari baris ASLI rantai (`chain.toOriginal(lineId)`): `paidValueIdr` tersimpan terkecil di rantai, else hitung dari order seperti sekarang. Baca charge selisih tukar rantai di bawah kunci order: `paid` -> tambah `amountIdr`; `waived`/`expired` -> kurangi `differenceIdr` dari basis daftar; `open`/`routed_pos`/tukar lebih mahal tanpa baris charge -> 422 "selesaikan tagihan selisih dulu". Kembalikan `{baseIdr, paidValueIdr: base + paidExtra, givenIdr, listBaseIdr}`.
- `swapSettlement` (service :1186-1233): panggil untuk SEMUA tukar. `difference = harga pengganti*qty - listBaseIdr`; `credit = min(-difference, max(0, paidValueIdr - givenIdr))`. Simpan `paidValueIdr = baseIdr` di semua tukar (jangan base+extra: extra dibaca live).
- `recoveryChainOf` (:285-324): paid = tersimpan terkecil + charge `paid` rantai, satu SQL.
- eajpb `voucherRoomOf` (:333): tidak pernah null; room = `max(0, paid - given)` lalu dijepit room level order dari `orderGivenOf`. Hapus cabang `room !== null` di `voucherOffer` (:904), `systemVoucherSettlement` (:1315), cabang voucher staf (:1580), `issueApologyVoucherForStaff` (apology-voucher :874-885). Early return voucher yang sudah terbit (apology :850, service :1489) tetap SEBELUM cek room.
- pqm3t preview (service :849-866): per issue open, satu baca nilai dibayar `lock=false`; `differenceIdr = -credit` untuk lebih murah (UI `issue-choices.tsx:186` tanpa ubah logika). 422 (mis. tukar lama tanpa nilai, tidak bisa dihitung) -> swap `allowed=false` dan voucher `allowed=false`.
- Kunci: issue -> order -> dry-run promo di savepoint (selalu rollback). Tidak ambil kunci intent.
- Invarian: per rantai item, voucher + refund hidup <= nilai dibayar asli + extra tukar yang benar-benar dibayar.

## Alur B (consumer refund)
- hhm5m 3 (refund.ts :600, :725-734): bila `promo !== undefined && replay === null`, catat goods penuh ke ledger promo dengan `recoveryRefundGoodsIdr({order, lineTotalIdr: originalLineTotalIdr, priorLinesIdr, promo})` sebelum cap/potong ruang, termasuk jalur Rp0 (buang syarat `capIdr === 0`); menggantikan `split.goodsIdr` di jalur filing; satu transaksi dengan baris refund atau catatan `nothing_left`.
- hhm5m 4 `findRecoveryRefundReplay` (paid-value :638-673): tanpa jam. Ada refund pendahulu masih hidup -> null; else ada refund `failureReason='rejected'` -> `REPLAY_REJECTED` (rejected tidak pernah di-refile, refund.ts:1067); else replay. Jumlah dari `refundId` filing pertama; sama untuk lookup akar :702-712. `filingSeq` tetap untuk memilih antar issue.
- hhm5m 5: `recoveryReleasedOf` (:126) juga mengembalikan gross/discount/service/PBJT yang sudah dibalik oleh `order.refunded` hidup. Fungsi murni baru `capPartsToRemaining` di `order-recovery-refund-amount.ts`, dipakai setelah split (refund.ts :548-567), pay-first saja: service dan PBJT dijepit sisa; gross = amount + discount - service - PBJT; gross > sisa -> amount dipotong. Tambah test level jurnal bila fixture memungkinkan (PBJT Rp2 tidak dibalik Rp3).
- Kunci tetap: issue -> order -> intent -> promo.

## Alur C (POS)
- 5g9sn level ORDER. `orderGivenOf`: voucher issue order (via `order_issues.voucher_id` dan `apology_vouchers.order_issue_id`, tanpa dobel), refund POS, refund recovery hidup terbesar per issue, charge `paid`. Dibayar = tender captured (POS) atau total - deposit + charge paid.
- `pos-order-corrections.ts:767`: `owedIdr = min(dueBill, paid - refunded - vouchers - recovery)`; `:801`: `assertRefundWithinPaid` menerima `refunded + vouchers + recovery`.
- Kunci: hanya kunci order dari `lockPosOrder`, baca tanpa kunci. JANGAN kunci issue (deadlock dengan sisi voucher issue -> order).

## Risiko (lapor CTO)
- Dry-run promo di preview mengunci baris promo sebentar.
- 422 baru untuk tamu saat charge tukar masih pending.
- Baris POS bisa `REFUND_NOTHING_DUE` setelah voucher menghabiskan bayar.
- Potongan ruang membuat tamu kurang bayar; uang tetap di outlet (pilihan "batasi").
