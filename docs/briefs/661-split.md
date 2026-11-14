# 661 pembagian kerja implementer

Konteks: docs/briefs/661-payroll-payout-hardening.md, kontrak test docs/briefs/661-test-contract.md, test apps/api/src/test/payroll-payout-hardening.test.ts. Aturan: "jangan sampai rugi" (tidak ada pihak dibayar lebih), gagal tertutup, pesan error Indonesia, `payoutRefuse(status, code, message)` di services/payroll-payout.service.ts:99. Jangan commit, jangan sentuh berkas milik potongan lain, jangan jalankan pnpm test penuh. Test terarah: `LEGEND_TEST_FILES="src/test/payroll-payout-hardening.test.ts" heavy pnpm test`.

## Potongan A (legend-8codi), milik A
- apps/api/drizzle/0542_payout_fee_posted.sql + entri baru di apps/api/drizzle/meta/_journal.json (idx berikutnya, `when` > 1794586500000) -- HANYA A menyentuh _journal.json.
- schema payroll_payout_gl_postings (db/schema/payroll-payout*.ts): kolom fee_posted boolean NOT NULL default true.
- services/payroll-payout-gl.service.ts (SELURUH berkas milik A): settle set fee_posted=false saat fee dilewati; `repostSkippedFees`; di akhir berkas tambahkan `export * from "./payroll-payout-overpaid.service.js";` (potongan B membuat berkas itu).
- Gerbang approve (services/payroll-payout.service.ts approveDisbursementBatch) dan ekspor (services/payroll-payout-manual.service.ts exportManualBatch, CAS di baris ~335) gagal tertutup 409 PAYOUT_BANK_CHARGES_MAPPING_MISSING / PAYOUT_SOURCE_ACCOUNT_MISSING sebelum perubahan status. Konfirmasi hasil bank tetap boleh tanpa mapping.
- routes/payroll-payout.routes.ts (milik A): GET /payout-fee-reposts, POST /disbursement-batches/:id/repost-fees.
- Test A: bagian legend-8codi di test hardening.

## Potongan B (legend-qxkm6), milik B
- apps/api/drizzle/0543_payout_return_two_person_guard.sql: kembalikan guard dua orang di trigger item (succeeded->returned wajib resolved_by, resolved_by_2 berbeda, resolution_evidence_key dalam UPDATE yang sama). Buat sebagai migrasi baru yang CREATE OR REPLACE fungsi guard; jangan ubah migrasi lama. JANGAN sentuh _journal.json: tulis nama tag di laporan, engineer utama yang menambah.
- Berkas baru services/payroll-payout-overpaid.service.ts dengan `recordOverpaidItem` (kontrak test). Jangan edit payroll-payout-gl.service.ts; helper yang perlu diekspor dari sana: tulis di laporan, jangan ubah.
- Berkas baru routes/payroll-payout-return.routes.ts (POST /disbursement-batches/:id/return, rantai middleware seperti /confirm + passwordStepUp), daftar di routes/index.ts; validator di packages/shared/src/validators/payroll-payout.ts.
- Perbaiki test lama `l4-succeeded-frozen` di apps/api/src/test/payroll-payout-core.test.ts (isi dua penyelesai, jangan longgarkan trigger).
- Test B: bagian legend-qxkm6 di test hardening.
