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

## Ronde 2: temuan architect (wajib dibetulkan, file sama dengan bagianmu)
- A1 (A, medium): JPEG/PNG disimpan mentah. Decode lalu re-encode lewat sharp seperti upload gambar lain di repo (cari pemakaian `sharp(` di `services/`), `limitInputPixels`, format hasil decode harus sama dengan tipe sniff, buang metadata (EXIF/GPS). Simpan byte hasil re-encode; `sizeBytes` = ukuran hasil. Gagal decode = 415.
- A2 (A): tambah step-up MFA seperti route resolve/return (`requireTenantStepUpMfa(...)` atau yang dipakai di `routes/payroll-payout.routes.ts` resolve) setelah permission.
- A3 (A): hanya batch `channel = 'manual_bank'` dan status tempat resolve atau return bisa berjalan (lihat guard status di `payroll-payout-manual.service.ts` resolve/return). Lainnya 409 atau 422 sesuai pola error di service itu, sebelum blob disimpan.
- C1 (C): cursor: tanggal mustahil (`2026-02-30 ...`) sekarang 500 (22008). Emit cursor dengan `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, regex ketat, parse lewat `Date`/cek valid; selain itu 422. Tidak bergantung DateStyle/TimeZone.
- C2 (C): batasi `limit` route ini maks 20 (default 20): ubah `listPayoutBatchesQuerySchema` di `packages/shared/src/validators/payroll-payout.ts` (override `limit`). File shared itu milik C di ronde ini.
- B1 (B): `openPayeeBankSnapshot` yang gagal dibuka saat buat batch sekarang 500. Petakan ke 422 `PAYROLL_BANK_ACCOUNT_UNREADABLE` (HttpError), tanpa membocorkan isi.
- T2 (test-writer, hanya menulis, jangan menjalankan test; engineer menjalankan): tambah ke tiga file test: upload tanpa header Origin ditolak (requireTrustedOrigin); scanner menolak (infeksi) dan scanner `acceptsDocuments:false` untuk PDF = gagal tertutup tanpa blob; upload JPEG/PNG asli (buat lewat sharp di test) tersimpan tanpa EXIF dan `contentType` benar, file JPEG rusak 415; batch cash atau draft ditolak; tanpa step-up MFA ditolak (ikuti cara test resolve existing); return service menerima key upload batch sendiri dan menolak key batch lain; trigger snapshot: cek pesan `PAYOUT-24`; nomor rekening non-digit = `maskedAccountNumber` null, nama tetap ada; daftar: dua batch dengan `created_at` sama (set lewat SQL) tidak dobel/terlewat antar halaman; cursor tanggal mustahil = 422; `limit=21` = 422.
