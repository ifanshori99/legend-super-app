# I3 note: syarat jurnal fee overpaid (untuk I4 recon)

Jurnal `payroll-payout-overpaid-fee:<item id>` WAJIB ada dan seimbang bila dan hanya bila
posting overpaid item itu (`payroll_payout_gl_postings`, kind `overpaid`, `id = item.gl_posting_id`)
punya `fee_idr > 0` (NULL dianggap 0).

Alasan: service (`payroll-payout-overpaid.service.ts`) hanya mengisi `feeIdr` bila
`locked || feeOnly` (:256-258) dan fee > 0 (:340); selain itu `feeIdr` tetap 0 (tidak ada jurnal fee:
tidak ada jurnal locked dan akuntansi mati, atau fee 0). Nilai yang sama ditulis ke `fee_idr` posting (:381).
Jadi recon cukup membaca `fee_idr` posting; tidak perlu membaca fee item (tersegel).

Jurnal fee: `idempotency_key = payroll-payout-overpaid-fee:<item id>`, legal_entity = batch.legal_entity_id,
source_type `payroll`, source_id = batch.payroll_run_id; sum(debit) > 0 dan = sum(credit)
(`app.payout_item_journal_ok`). "Reversed" dinilai seperti jurnal net overpaid.

DB (0582): cabang `failed -> overpaid` di `app.payout_item_money_commit_check()` menolak commit dengan
PAYOUT-90 (23514) bila `COALESCE(fee_idr,0) > 0` dan jurnal fee tidak ok. Cek jurnal net lama tetap
(hanya bila jurnal locked ada). Tidak ada cek nominal jurnal = fee_idr (tidak dipastikan oleh rule).
