# Brief: second-opinion — pemilik dan sumber objek storage (legend-pszrm)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit atau commit.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/storage-object-owner`, cabang `ws/storage-object-owner` (dasar `ws/support-storage-access` b800ae30). Rentang: `git diff b800ae30...ws/storage-object-owner -- apps/api/src packages/shared/src apps/api/drizzle ':!apps/api/src/test'`. Test hanya dibaca bila perlu bukti.

## Berkas

- `apps/api/drizzle/0177_storage_object_owner.sql` (kolom `owner_user_id`, `source_kind`, `source_id`, dua check, satu index)
- `apps/api/src/db/schema/core-storage.ts`
- `packages/shared/src/storage/index.ts` (`storageSourceKindSchema`, `storageSourceKindPurpose`, `storageDefaultSourceKind`, `sourceKind` di metadata upload)
- `apps/api/src/services/core-storage-access.ts` (resolver: baca per `objectId`, peta izin per kind, peta legacy ketat)
- `apps/api/src/services/core-storage.ts` (`uploadStorage` mengisi pemilik dan kind, `linkStorageObjectSource`)
- `apps/api/src/routes/core-storage.routes.ts` (belum dipasang; `actorUserId`, batas multer)
- `apps/api/src/services/hris-contract.service.ts`, `apps/api/src/services/hris-leave-request.service.ts` (pengisian kolom saat menautkan)
- Test: `apps/api/src/test/core-storage-access.test.ts`, `core-storage-service.test.ts`, `core-storage-routes.test.ts`, `core-storage-schema.test.ts`

## Fokus

- Lensa penyerang: reviewer satu fitur membaca objek fitur lain (mis. `purchasing.invoice.match` membaca receipt reimburse); karyawan membaca selfie atau receipt orang lain; objek tenant atau brand lain; outlet di luar cakupan; objectId huruf besar/kecil; oracle keberadaan objek.
- Penautan: objek orang lain ditautkan ke dokumen milik penyerang untuk mengubah `source_kind` atau `owner_user_id`; tautan ganda; purpose tidak cocok; race dua tautan serentak.
- Upload: kind yang tidak sesuai izin pengunggah; kind tidak cocok purpose; upload tanpa kind (null) yang kemudian terbaca reviewer yang salah.
- Data lama (`source_kind` null): hanya kode pengelola di `storageLegacyReadMap`.
- Backfill di 0177: tautan lama dari `employment_contracts`, `employee_documents`, `leave_requests.attachment_key` (satu baris per objek, hanya `source_id` null). Penautan baru: outlet objek harus sama dengan outlet dokumen; objek tanpa pemilik tidak pernah ditautkan (lampiran cuti wajib milik peminta; render PDF menu sistem tanpa pemilik). Receipt wajib punya kind saat upload.
- Migrasi: aman di tabel berisi data, RLS FORCE tetap, `when` 1794256000000, prevId = id snapshot 0171.

## Effort

xhigh (akses dan data pribadi).

## Laporan

Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal konkret, saran. Tidak ada temuan: satu baris.

## Larangan

Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
