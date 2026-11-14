# 731 impl: celah API payout (legend-zoqh1, legend-2bl54, legend-396pf)

Worktree: `.worktrees/payout-api-gaps`, cabang `ws/payout-api-gaps` (base `origin/milestone/m1`). Tingkat K (uang, data pribadi, migrasi). Jangan commit; engineer menggabung. Jangan sentuh file di luar bagianmu. Jangan menjalankan suite penuh; test terarah hanya lewat `heavy` (lihat AGENTS.md "Test terarah"), satu run sekaligus per subagent.

## Kontrak bersama (sudah ditulis engineer, jangan diubah tanpa lapor)
- `packages/shared/src/types/api.ts`: `PayrollDisbursementItemDto.accountHolderName: string | null`, `.maskedAccountNumber: string | null`; `PayrollPayoutEvidenceUploadDto { evidenceKey, contentType, sizeBytes }`.
- `packages/shared/src/validators/payroll-payout.ts`: `listPayoutBatchesQuerySchema` (cursor, limit, legalEntityId?, status?), `PAYOUT_EVIDENCE_CONTENT_TYPES` (pdf, jpeg, png), `PAYOUT_EVIDENCE_MAX_BYTES` (5 MiB).
- `apps/api/src/services/payroll-payout.service.ts`: `toItemDto` dan `toBatchDto` sekarang diekspor.

## A. legend-zoqh1: unggah bukti resolve/return
File: BARU `apps/api/src/routes/payroll-payout-evidence.routes.ts`, BARU `apps/api/src/services/payroll-payout-evidence-upload.service.ts`, edit `apps/api/src/routes/storage-api.routes.ts` (mount saja).
- `POST /api/hris/payroll/disbursement-batches/:id/evidence`, multipart satu part `file`. Pola: `routes/shareholder-documents.routes.ts` (multer memoryStorage, limits, parseUpload, 503 sebelum multer bila storage/scanner tidak ada) + `services/shareholder-documents.service.ts` (`deps.storage.put`, scanner, hapus blob bila gagal). Router dibuat `createPayrollPayoutEvidenceRouter({ storage, scanner })`, di-mount di `storage-api.routes.ts` di bawah `/hris/payroll` hanya untuk path `^/disbursement-batches/[^/]+/evidence$` (seperti `PAYROLL_EXPORT_PATH`), sebelum apiRouter.
- Guard: `requireAuth`, `requireTrustedOrigin`, `requireTenantContext`, `requireTenantPermission("payroll.disburse.approve")` (sama dengan resolve/return), params `payoutBatchParamsSchema`.
- Batch harus ada di tenant pemanggil (lewat `withTenant`, filter tenant di SQL) sebelum blob disimpan: tidak ada/tenant lain = 404 yang sama.
- Validasi byte: kosong 422; > `PAYOUT_EVIDENCE_MAX_BYTES` 413; tipe dari magic bytes (`%PDF-`, JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`) harus salah satu `PAYOUT_EVIDENCE_CONTENT_TYPES`, selain itu 415. Scanner wajib (PDF: `assertScannerAcceptsDocuments`).
- Key: `tenants/<tenantId>/payroll-payout/<batchId>/<randomUUID>.<pdf|jpg|png>`. Wajib lolos `assertEvidenceKeyForBatch` (`services/payroll-payout-evidence.ts`) untuk batch yang sama, dan <= 200 karakter (validator resolve/return `text(200)`). Cek adapter storage (`deps.storage.put` lookup `{tenantId, outletId:null, reference, key}`) supaya objek tersimpan private dan bisa dicari dari key itu.
- Respons 201 `{ data: PayrollPayoutEvidenceUploadDto }`. Upload TIDAK mengubah status batch/item apa pun.

## B. legend-2bl54: snapshot rekening di item
File: `apps/api/src/db/schema/payroll-payout.ts` (tabel items), `apps/api/src/services/payroll-payout.service.ts` (`createDisbursementBatch` ~692, planning item ~895-935, `toItemDto` ~513), migrasi baru `apps/api/drizzle/0600_*.sql` lewat `pnpm db:generate` (dari `apps/api`; ubah nama/nomor bila perlu, tag journal sesuai) + bagian SQL tangan di file yang sama.
- Kolom item: `account_holder_name varchar(150)` dan `masked_account_number varchar(...)`, nullable (cash dan item lama null). CHECK: cash = keduanya null; masked cocok `^\*{4}[0-9]{4}$` (keluaran `maskAccountNumber`, `packages/shared/src/accounting/banking.ts:83`).
- Isi saat item dibuat dari `openPayeeBankSnapshot` (`services/payroll-bank-snapshot.service.ts:72`): `accountHolder` dan `maskAccountNumber(accountNumber)`. Nomor penuh tidak pernah disimpan polos dan tidak pernah di DTO.
- Trigger baru (fungsi + trigger sendiri, jangan mengganti `payroll_disbursement_items_guard` dari 0351): kedua kolom tidak boleh berubah setelah INSERT, kecuali bersamaan dengan pergantian `bank_snapshot_id` saat status `prepared`/`blocked` (cek apakah ada jalur yang mengganti snapshot; bila tidak ada, bekukan mutlak). Jangan merusak bypass reseal (reseal tidak menyentuh kolom ini).
- Cek tipe `ItemRow`/select lain di service yang membangun item (mis. `insert ... returning`) supaya kolom baru ikut. `toItemDto` memetakan kedua kolom.
- Jangan sentuh migrasi lama. Setelah generate: `pnpm db:generate` kedua kali harus kosong.

## C. legend-396pf: daftar batch
File: BARU `apps/api/src/services/payroll-payout-batch-list.service.ts`, edit `apps/api/src/routes/payroll-payout.routes.ts` (satu route baru).
- `GET /api/hris/payroll/payout-batches?legalEntityId=&status=&cursor=&limit=` pakai `listPayoutBatchesQuerySchema`. Guard sama dengan GET lain di file itu (`payroll.view`), `withTenant`, filter `tenant_id` di SQL juga.
- Urutan `created_at desc, id desc`, cursor keyset (pola `routes/edge-sync-conflicts.routes.ts:96-108` + `packages/shared/src/edge/sync-conflicts.ts:103`; cursor tidak bisa memalsukan tenant). Respons `{ data: PayrollDisbursementBatchDto[], meta: { limit, nextCursor } }`.
- Item semua batch di halaman dimuat dalam SATU query (`inArray(batchId)` + tenant), lalu `toBatchDto(row, items)`. Tanpa N+1. Cek bahwa daftar route di file tidak membuat `payout-batches` tertabrak route lain.

## T. test-writer: test gagal-dulu (file baru saja)
File BARU di `apps/api/src/test/`: `payroll-payout-evidence-upload.test.ts`, `payroll-payout-item-snapshot.test.ts`, `payroll-payout-batch-list.test.ts`. Fixture: `payroll-payout-fixtures.ts` (`installPayoutWorld`, `exportedBatch`, `evidenceKeyFor`, `actorOf`), storage `FakeObjectStorage` dari `@starter/shared/adapters`, scanner `NoopMalwareScanner` (contoh `shareholder-documents-wire.test.ts`). Lewat HTTP (`createApp`) bila fixture memungkinkan.
Wajib dibuktikan:
1. Upload: key yang dikembalikan berbentuk `tenants/<tenant>/payroll-payout/<batch>/<file>` dan diterima resolve/return batch itu; key batch A ditolak di resolve batch B (422 `PAYOUT_EVIDENCE_INVALID`); batch tenant lain = 404 dan tidak ada blob tersimpan; tipe salah 415, terlalu besar 413, tanpa permission 403, tanpa storage 503; upload tidak mengubah status batch/item; resolve kedua pada item yang sudah final ditolak (tidak ada bayar ganda).
2. Snapshot: item bank membawa `accountHolderName` dan `maskedAccountNumber` `****` + 4 digit terakhir; nomor penuh tidak muncul di JSON respons batch mana pun (cari string nomor penuh di body); mengganti rekening karyawan setelah batch dibuat tidak mengubah kedua nilai; UPDATE langsung kolom snapshot ditolak trigger; item cash null.
3. Daftar: hanya batch tenant sendiri; filter legalEntityId dan status; paginasi cursor tanpa duplikat/terlewat; 403 tanpa `payroll.view`; 422 untuk query tidak valid.
Jalankan sekali lewat `heavy` di base kontrak (sebelum implementasi digabung, test harus merah karena sebab yang benar: 404 route tidak ada / field undefined, bukan setup). Laporkan perintah + ringkas hasil merah.
