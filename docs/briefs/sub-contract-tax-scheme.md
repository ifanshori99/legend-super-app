# Sub-brief: skema pajak di employment_contracts (bd legend-rhq5, tingkat K, migrasi)

Asal: legend-m9gx. Engine PPh 21 (`packages/shared/src/hris/payroll/pph21.ts`) butuh `contractTaxScheme` (gross | gross_up | net) untuk bulan yang hanya punya BPJS perusahaan. Skema pajak = atribut perjanjian kerja (keputusan CTO 2026-11-09).

## Keputusan CTO

- Baris lama: `'gross'`, backfill eksplisit di migrasi + catatan.
- FK/RLS mengikuti aturan FORCE RLS. Tidak ada bagian "FORCE RLS" di `docs/plan/contracts.md`; acuan yang ada: `docs/deployment.md` sekitar baris 373 dan 564. `employment_contracts` sudah `app.enforce_tenant_rls` (0048_hris_rls). Kolom baru tanpa FK, jadi tidak perlu policy baru.

## Rencana

1. Kolom `tax_scheme varchar(20) NOT NULL` + CHECK `employment_contracts_tax_scheme_check` (`IN ('gross','gross_up','net')`), varchar + CHECK seperti kolom lain di tabel ini.
2. Migrasi 0103 (drizzle generate lalu diedit tangan):
   - `ADD COLUMN "tax_scheme" varchar(20) NOT NULL DEFAULT 'gross'` mengisi semua baris lama dalam satu langkah DDL. Postgres mengisi nilai default tanpa UPDATE per baris, jadi tidak dievaluasi lewat policy RLS dan tidak butuh tenant context atau BYPASSRLS.
   - `ALTER COLUMN "tax_scheme" DROP DEFAULT`: baris baru wajib memilih skema, tanpa default diam-diam.
   - Lalu CHECK. Komentar SQL mencatat backfill-nya.
   - Alternatif: pola 0096 (`NO FORCE` → `UPDATE` → `FORCE` dalam satu transaksi) juga benar, tetapi lebih panjang. Default DDL dipilih (architect setuju).
3. Shared: `employmentContractSchema` (organization.ts) + `taxScheme: taxSchemeSchema`; fixtures.
4. API: `hris-contract.service.ts` `toContract` dan `CreateEmploymentContractInput` (wajib) + insert.
5. Web: tampilkan skema di `profile-contracts.tsx` (label `payrollConfig.taxScheme.*`), mock dan handler diperbarui.
6. Test: `hris-db.test.ts` membuat dan membaca kontrak dengan taxScheme; test migrasi backfill bila ada pola test migrasi.
7. Wiring ke run PPh 21 (pilih kontrak yang berlaku di periode → `contractTaxScheme`) = legend-07eg, di luar slice ini.

## Status implementasi (engineer)

- Selesai: kolom + CHECK (`apps/api/src/db/schema/hris.ts`), migrasi `apps/api/drizzle/0103_youthful_jack_murdock.sql` (ADD DEFAULT 'gross' → DROP DEFAULT → CHECK), DTO `employmentContractSchema.taxScheme` (organization.ts), service `hris-contract.service.ts` (`CreateEmploymentContractInput.taxScheme` wajib, insert, `toContract`, audit `after.taxScheme`), `HRIS_AUDIT_SAFE_FIELDS` + `taxScheme`.
- Subagent implementer: `packages/shared/src/hris/fixtures.ts` (kontrak fixture), web `apps/web/src/features/ws10-employee-master/*` (mock, `lib/mock/handlers/hris-directory.ts`, tampil di `profile-contracts.tsx` dengan label `payrollConfig.taxScheme.*` dari `ws10-payroll-config/labels.ts`). Tanpa form baru.
- Subagent test-writer: `apps/api/src/test/hris-db.test.ts` (buat + baca kontrak dengan taxScheme; create tanpa taxScheme ditolak DB/CHECK), dan test backfill migrasi bila repo punya pola test migrasi (cari `drizzle` / `migrat` di apps/api/src/test dan src/db/*.test.ts).

- Test migrasi (architect): `apps/api/src/test/contract-tax-scheme-migration.test.ts` mengikuti `payroll-pph21-policy-migration.test.ts`. Journal dipotong di idx 102, satu kontrak di-seed (sebagai superuser, jadi test ini tidak membuktikan klaim RLS). Klaim tanpa BYPASSRLS dibuktikan `edge-received-events-migration.test.ts`, yang menerapkan seluruh folder sebagai owner tanpa BYPASSRLS. Handler mock web tidak perlu diubah karena memakai fixture shared. Assert: baris = 'gross', `column_default IS NULL`, insert tanpa skema gagal 23502, 'foo' gagal 23514.
