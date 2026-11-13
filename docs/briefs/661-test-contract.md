# Kontrak test 661 (payroll payout hardening)

Dipilih penulis test untuk `apps/api/src/test/payroll-payout-hardening.test.ts`. Engineer boleh mengganti nama, tetapi ubah test dan berkas ini bersama. Nomor migrasi 0542-0545.

## legend-8codi

- Approve dan unduh file ekspor manual ditolak `409` bila role `bank_charges` belum dipetakan atau rekening bank sumber (`payroll_payout_configs.manual_source_bank_account_id`) tidak bisa dipakai. Kolom itu NOT NULL di DB, jadi celah nyatanya rekening dinonaktifkan (`bank_accounts.is_active = false`) atau terhapus. Kode: `PAYOUT_BANK_CHARGES_MAPPING_MISSING`, `PAYOUT_SOURCE_ACCOUNT_MISSING`.
  - Approve ditolak: batch tetap `pending_approval`, `approved_by` kosong, item tetap `prepared`.
  - Ekspor ditolak: batch tetap `approved`, `exported_at` kosong (unduhan satu-satunya tidak terpakai), item tetap `approved`.
  - Konfirmasi hasil bank tetap BOLEH tanpa mapping (uang sudah keluar): tidak ada jurnal fee.
- NEW kolom `payroll_payout_gl_postings.fee_posted boolean NOT NULL DEFAULT true`. `false` bila fee dilewati (kind `settle` maupun `settle_skipped`); `true` bila jurnal fee terposting.
- NEW `repostSkippedFees(tx, actor, batchId)` di `services/payroll-payout-gl.service.ts`: posting fee (Dr 8101 / Cr akun sumber, kunci `payroll-payout-fee:<item_set_hash>`) untuk posting `fee_posted = false`, lalu set `true`. Tepat sekali (ulang atau paralel tidak menggandakan; boleh no-op atau ditolak). Mapping masih hilang: `409 PAYOUT_BANK_CHARGES_MAPPING_MISSING`, tidak ada yang terposting.
- NEW `GET /api/hris/payroll/payout-fee-reposts` (izin `payroll.view`): `{ data: [{ postingId, batchId, feeIdr }] }`, hanya posting `fee_posted = false`.
- NEW `POST /api/hris/payroll/disbursement-batches/:id/repost-fees` body `{}` (izin `payroll.disburse.approve`, tanpa step-up, hanya mencatat beban fee yang tersimpan). Tanpa izin: `403`. Ulang: bebas 200 atau 4xx, jurnal tetap satu.

## legend-qxkm6

- NEW `POST /api/hris/payroll/disbursement-batches/:id/return` body `{ itemIds, evidenceKey, note, password? }`: izin `payroll.disburse.approve` (tanpa izin `403`), step-up sama dengan `confirm`/`resolve` (tanpa password pada sesi hanya-pendaftaran: `401 REAUTH_REQUIRED`; password salah: 401/403), memanggil `returnManualItems`. Dua orang berbeda bukan pembuat batch; langkah pertama tercatat di `returned_by` dan item tetap `succeeded`; langkah kedua menjadikan `returned` dan memposting jurnal kebalikan sekali (`payroll-payout-return:<itemId>`, Dr akun sumber asli / Cr 2103, walau konfigurasi sudah pindah rekening). Pembuat, orang yang sama dua kali, dan panggilan sesudah `returned`: 4xx tanpa jurnal baru. Dua langkah kedua serentak: satu menang.
- NEW `recordOverpaidItem(tx, actor, itemId, { evidenceKey, note })` di `services/payroll-payout-gl.service.ts` (dipakai jalur "00 terlambat" Duitku nanti; belum ada route): item `failed` yang slipnya sudah punya percobaan `succeeded` lain menjadi `overpaid`; jurnal Dr 1204 (`employee_receivable`) / Cr akun sumber, kunci `payroll-payout-overpaid:<itemId>`; baris posting `kind = 'overpaid'`, `items.gl_posting_id` ditautkan. Tidak membuat item atau batch baru, jurnal settle tidak berubah, status run tetap `paid`. Slip tanpa percobaan sukses lain: ditolak 4xx, item tetap `failed`, tanpa jurnal. Ulang atau serentak: satu jurnal.
- Trigger DB `payroll_disbursement_items`: `succeeded -> returned` wajib `returned_by` dan `returned_by_2` terisi dan berbeda dalam UPDATE yang sama (dan `return_evidence_key`, `returned_at`); tanpa itu ditolak sebagai error database (pg `code` ada). Test lama `l4-succeeded-frozen` di `payroll-payout-core.test.ts` (baris ~1748) harus mengisi dua penyelesai pada kontrolnya, bukan melonggarkan trigger.
