# 658 payout GL + step-up: konteks bersama subagent

Cabang `ws/payroll-payout-gl` (worktree `.worktrees/payout-gl-658`, dari `milestone/m1`). Migrasi 0534-0537. Area uang + akses: jangan sampai rugi.

Desain: `docs/design/payroll-disbursement.md` §4.6, §6 (R9, R10), §7.7-7.9, §8, §9. Format BCA: `docs/design/payroll-disbursement-manual-bca.md`.

Kode ada: `apps/api/src/services/payroll-payout*.ts`, `payroll-gl-consumer.ts`, `payroll-events.ts`; tes `apps/api/src/test/payroll-payout-core.test.ts`, `payroll-payout-manual.test.ts`, `payroll-gl-consumer.test.ts`.

## Keputusan CTO (14 Nov)
- `paid_by` run = penyetuju terakhir batch. Pengonfirmasi tetap tercatat di kolom/audit sendiri.
- Fee manual dijurnal otomatis per item `succeeded`: Dr beban bank / Cr akun kas/bank sumber, dari nilai fee tersimpan per item. Tidak dipotong dari gaji (founder Q15, PT tanggung Rp5.000). Finance tidak mencatat terpisah.

## Kerja
1. wnkep.5: tabel `payroll_payout_gl_postings` (0534, +kunci pemetaan `payout_deposit`, `bank_charges` bila perlu). Settle per item di bawah `pg_advisory_xact_lock` batch, kunci jurnal `payroll-payout:<item_set_hash>`, tautkan `items.gl_posting_id` di transaksi sama (jumlah tertaut harus = terpilih, else rollback). Jurnal fee, return (`failed` sesudah `succeeded` / `returned`), overpaid. `payroll.paid` dengan `settledPerItem: true` tidak memposting apa pun di level run. Kirim event `payroll.paid`.
2. f5n9y (L5): kunci bukti pembayaran diikat ke storage tenant; step-up resolve/konfirmasi minta ulang password bila `mfa_verified_at` hanya dari pendaftaran MFA pertama.

## Test gagal-dulu
Σ kredit = Σ net pay tepat sekali; replay/konfirmasi ganda tidak menggandakan jurnal; fee hanya ke beban bank, tidak mengurangi gaji; return membalik tepat sekali; run-level `paid` tidak memposting lagi; tenant lain tidak tersentuh; bukti tenant lain ditolak.

## Aturan
Tipe brand pakai helper. Tabel/migrasi baru: FK inline di CREATE TABLE, daftar di `data-import-registry.test.ts` dan tes cakupan tabel schema. Izin/label/event baru: katalog root + label teks. Satu token heavy: hanya satu subagent jalankan tsc/vitest. Jangan merge, deploy, `pkill`, `pnpm test` penuh.

## Kontrak dari test-writer (tes sudah ada di apps/api/src/test/payroll-payout-{gl,evidence}.test.ts + payroll-payout-fixtures.ts; baca tes, jangan ubah kecuali salah)
GL (implementer A):
- `services/payroll-payout-gl.service.ts`: `settleBatchPayouts(tx, actor, batchId)`, idempoten.
- `payroll-payout-manual.service.ts`: `returnManualItems(tx, actor, batchId, {itemIds, evidenceKey, note})` dua orang, bukan pembuat; succeeded -> returned + jurnal. Tes lama manual yang menegaskan nol `payroll.paid` dibalik.
- Tabel `payroll_payout_gl_postings` (id, tenant_id, batch_id, kind settle|settle_skipped|return|overpaid, item_set_hash, journal_key, total_encrypted, posted_at); `items.gl_posting_id` jadi FK.
- Kunci jurnal = `journal_entries.idempotency_key`: `payroll-payout:<hash>`, `payroll-payout-fee:<hash>`, `payroll-payout-return:<itemId>`. Akun 2103 (salaries_payable), 1103 (bank sumber manual), 1102 (tunai), role `bank_charges` -> 8101. Fee Rp5.000 per item, tidak mengurangi gaji.
- `paid_by` run = `batch.approvedBy`; `confirmed_by` item = pengonfirmasi. Payload `payroll.paid` + `settledPerItem?: boolean`; di outbox `settledPerItem: true` sekali saat run `paid`; consumer tidak memposting.
Evidence/step-up (implementer B):
- Kunci bukti harus `tenants/<tenantId>/payroll-payout/<batchId>/<file>`; tenant lain atau `..` ditolak kode `PAYOUT_EVIDENCE_INVALID` di confirm, resolve (2 langkah), konfirmasi tunai.
- Rute prefix `/api/hris/payroll/disbursement-batches/:id`: `/confirm {results, password?}`, `/resolve {..., password?}`, `/confirm-cash {itemIds, evidenceKey?, password?}`. Sesi dengan MFA hanya dari pendaftaran, tanpa password: 401 `REAUTH_REQUIRED`; password salah 401/403; benar 200.
Pembagian file: A pegang manual.service, payout.service, routes, shared events/coa/posting-rules, gl-consumer, schema payout. B pegang identity.ts, identity-mfa.service.ts, schema session, file baru `services/payroll-payout-evidence.ts` (`assertEvidenceKeyForBatch`, `verifyReauthPassword`), validators password. Penyambungan B ke manual.service/routes dilakukan SETELAH A selesai.
Migrasi: A 0534 (+0535 backfill role akun bila perlu), B 0536.
