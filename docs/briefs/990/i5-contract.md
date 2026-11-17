# I5 kontrak: bukti return wajib nomor referensi bank (legend-nsqhm)

Route (tidak berubah): `POST /api/hris/payroll/disbursement-batches/:id/return`
(`payroll-payout-return.routes.ts`, tanpa perubahan kode; input lewat `returnManualItemsSchema`).

Body final: `{ itemIds: uuid[], evidenceKey: string(1-200), bankRef: string, note: string(1-500), password }`.
- `bankRef` WAJIB: trim, 4-64 karakter (validator zod, 400 bila kurang/hilang).
- Service menormalkan: hapus semua spasi, huruf besar (`normalizeReturnBankRef`), lalu 4-64 lagi (422 `PAYOUT_RETURN_BANK_REF_REQUIRED` bila jadi terlalu pendek). SQL menormalkan hal yang sama.
- Dikirim di LANGKAH 1 (propose) dan LANGKAH 2 (confirm): nilai ternormalisasi harus sama.

Respons: tidak berubah (`{ data: { batchStatus, returned, proposed } }`).

Galat:
- `bankRef` sudah dipakai klaim return lain di tenant yang sama: 409 `PAYOUT_RETURN_BANK_REF_REUSED` (unique `payroll_payout_return_claims_bank_ref_key`; tenant lain boleh pakai ref sama).
- Langkah 2 dengan ref berbeda dari klaim: SQL PAYOUT-89 (23514) -> 409 `PAYOUT_GUARD_REFUSED` (pemeta generik).
- Fungsi SQL dipanggil tanpa/ref terlalu pendek: PAYOUT-88 (23514).
- Klaim return terbuka sebelum 990 (bank_ref NULL) tidak bisa di-confirm maupun diajukan ulang. Migrasi 0583 berhenti dengan `PAYOUT-89: open return claims without a bank reference must be settled before 990` selama masih ada klaim seperti itu; ops menyelesaikannya dulu sebelum 990 diterapkan.

SQL (0583, signature lama di-DROP):
- `app.payout_return_propose(p_batch uuid, p_item_ids uuid[], p_key varchar, p_note text, p_grant text, p_bank_ref varchar) RETURNS uuid`
- `app.payout_return_confirm(p_claim uuid, p_key varchar, p_grant text, p_bank_ref varchar) RETURNS integer`
- `app.payout_normalize_bank_ref(p_ref varchar) RETURNS varchar` (PAYOUT-88 bila bukan 4-64 setelah normalisasi)
- Tersimpan di `payroll_payout_return_claims.bank_ref` dan `payroll_disbursement_items.return_bank_ref` (langkah 1). Trigger `payroll_disbursement_items_return_bank_ref_trg`: hanya `legend_payout` yang boleh mengisi/mengubahnya.
