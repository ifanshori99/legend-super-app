# Sub-brief: provisioning default entitas dan outlet (legend-a7x7, legend-4ryw)

Worktree: `.worktrees/provisioning-default`, cabang `ws/provisioning-default`. Semua path relatif ke root worktree.
Tingkat: a7x7 = K (mapping akun menentukan ke mana uang dijurnal). 4ryw = S.

## Tujuan

Tenant, entitas legal, dan outlet yang dibuat lewat panel langsung siap: bagan akun standar F&B + mapping default per entitas legal, katalog UOM standar per tenant, enam lokasi stok per outlet. Semua idempoten, dalam transaksi yang sama dengan pembuatan, tercatat di audit, tidak pernah mengubah baris yang sudah ada.

## Fakta kode (sudah dipetakan)

- Transaksi: `withTenant(db, context, async (tx) => ...)` di `apps/api/src/db/tenant.ts:13`. Tipe tx: `TenantTransaction` dari `apps/api/src/services/accounting-shared.ts:17`.
- Audit: `auditAccountingChange(tx, context, {actorId, action, objectType, objectId, before, after})` di `accounting-shared.ts:122` (actorId null = system). Umum: `recordAudit(tx, context, input)` di `services/core-audit.ts:16`.
- CoA: `standardFnbChartTemplate` (rows: code, name, type, reportGroup, parentCode, roles[]) dan `POSTING_ACCOUNT_ROLES`, `accountMappingIssues`, `chartOfAccountsIssues`, `accountMapFor` di `packages/shared/src/accounting/coa.ts`. Tabel `chartOfAccounts` dan `accountMappings` di `apps/api/src/db/schema/accounting.ts:53,133`; unique `(tenant_id, legal_entity_id, code)` dan `(tenant_id, legal_entity_id, role)`. Pola insert + validasi: `createAccount` dan `replaceAccountMappingsForEntity` di `services/accounting-accounts.service.ts:123,266`. Cek trigger DB migrasi 0025/0026 (mis. mapping wajib lengkap, deferred constraint).
- Inventori: `uoms` (unique `(tenant_id, code)`), `stock_locations` (tenantId, outletId, name, type CHECK warehouse|chiller|freezer|bar|kitchen|pastry; TIDAK ada unique per tipe) di `apps/api/src/db/schema/inventory.ts:54,181`. Zod `stockLocationTypeSchema` di `packages/shared/src/inventory/schemas.ts:131`. Fixture UOM: `packages/shared/src/inventory/fixtures.ts:130` (kg, g, l, ml, pcs, pack).
- Pembuatan: `createLegalEntity` `services/org.service.ts:291`, `createOutlet` `services/org.service.ts:427` (keduanya tanpa actor, tanpa audit), `createTenant` `services/platform-org.service.ts:187` (pakai `platformTenantScope(tenantId)`).
- Jangan sentuh: refund/pembayaran, `order-promo-refund.ts`, sinkron edge (`edge/bootstrap.ts`), konfigurasi pajak default, `db/seed-dev-tenant.ts`.

## Kontrak antar potongan (signature tetap, jangan diubah sepihak)

### S1. Katalog UOM standar (shared)
`packages/shared/src/inventory/standard-uoms.ts`, diekspor dari entry `@starter/shared/inventory`:
```ts
export const STANDARD_UOM_CATALOG: readonly { code: string; name: string }[]
```
Code ≤10 char, lowercase, unik. Isi minimal kg, g, l, ml, pcs, pack (nama sama dengan fixture) + karton (`ctn`), botol (`btl`), kaleng (`can`), sachet (`sachet`), dus/box (`box`), porsi (`porsi`). Juga:
```ts
export const STANDARD_STOCK_LOCATIONS: readonly { type: StockLocationType; name: string }[]
// warehouse "Gudang Utama", chiller "Chiller", freezer "Freezer", bar "Bar", kitchen "Dapur", pastry "Pastry"
```
Test unit kecil boleh di `packages/shared` bila pola test ada.

### S2. Provisioning inventori (API)
`apps/api/src/services/inventory-provisioning.service.ts`:
```ts
export async function provisionStandardUoms(tx: TenantTransaction, context: ScopedTenantContext, actorId: UserId | null): Promise<{ inserted: number }>
export async function provisionOutletStockLocations(tx: TenantTransaction, context: ScopedTenantContext, outletId: string, actorId: UserId | null): Promise<{ inserted: number }>
export async function backfillTenantInventoryDefaults(tenantId: string): Promise<{ uomsInserted: number; outlets: number; locationsInserted: number }>
```
- UOM: insert `onConflictDoNothing` pada `(tenant_id, code)`. Baris lama tidak diubah.
- Lokasi: `pg_advisory_xact_lock` per outlet (mis. `hashtextextended('stock_locations:'||outletId, 0)`), lalu insert hanya tipe yang belum ada untuk outlet itu (cek tipe, bukan nama). Lokasi lama tidak diubah.
- Audit satu baris per pemanggilan yang benar-benar menyisipkan (inserted > 0): action `inventory.uoms.provisioned` / `inventory.stock_locations.provisioned`, after = daftar code/tipe yang disisipkan. Tidak menyisipkan apa-apa: tidak ada audit.
- Backfill: `withTenant(db, platformTenantScope(tenantId), ...)`, UOM tenant + lokasi tiap outlet tenant.

### S3. Provisioning CoA (API, tingkat K)
`apps/api/src/services/accounting-provisioning.service.ts`:
```ts
export type ChartProvisionResult = { legalEntityId: string; status: "provisioned" | "already_present"; accounts: number; mappings: number }
export async function provisionStandardChart(tx: TenantTransaction, context: ScopedTenantContext, legalEntityId: string, actorId: UserId | null): Promise<ChartProvisionResult>
export async function backfillTenantCharts(tenantId: string): Promise<ChartProvisionResult[]>
```
- Kunci `pg_advisory_xact_lock` per entitas. Lalu: entitas sudah punya akun SATU PUN → `already_present`, tidak menyisipkan apa pun (bagan tenant tidak pernah dicampur dengan template). Bagan kosong → sisipkan semua baris template (parent dulu, `parentId` dari `parentCode`), lalu mapping default dari `roles` tiap baris.
- Mapping hanya disisipkan bila entitas belum punya mapping sama sekali.
- Validasi kandidat dengan `chartOfAccountsIssues` + `accountMappingIssues` SEBELUM insert; ada issue → throw (template rusak = bug, jangan diam).
- Satu audit `accounting.chart.provisioned` (objectType `legal_entity`, objectId entitas) berisi jumlah akun, jumlah mapping, daftar role→code. Tidak ada audit untuk `already_present`.
- Tenant tetap bebas mengubah bagan setelahnya (pakai route CoA yang ada; jangan tambah kunci).
- Backfill: tiap entitas legal tenant dalam `withTenant(db, platformTenantScope(tenantId), ...)`.

### S4. Wiring + skrip backfill
- `createLegalEntity`: setelah insert sukses (DI LUAR try/catch uniqueViolation NPWP, tapi di tx yang sama) panggil `provisionStandardChart(tx, context, row.id, null)`.
- `createOutlet`: setelah insert sukses, di tx yang sama, `provisionStandardUoms(tx, context, null)` (tenant lama yang belum punya UOM ikut terisi) lalu `provisionOutletStockLocations(tx, context, row.id, null)`.
- `createTenant`: di tx yang sama, `provisionStandardUoms(tx, context, null)` (actorId = actorUserId bila tipenya cocok).
- Skrip: `apps/api/src/db/backfill-tenant-defaults.ts` (pola skrip lain di `apps/api/src/db/`), menelusuri semua tenant, memanggil `backfillTenantCharts` dan `backfillTenantInventoryDefaults`, mencetak ringkasan per tenant (tanpa data pribadi). Tambah script `db:backfill-defaults` di `apps/api/package.json` dan root bila pola `db:*` ada di root. Opsi `--tenant <id>`.

### S5. Test
`apps/api/src/test/provisioning-defaults.test.ts` (pola dari `apps/api/src/test/accounting-core.test.ts` dan `platform-org-api.test.ts`):
1. POST `/api/org/legal-entities` → GET akun entitas = jumlah baris template, GET mapping = semua role template; satu audit `accounting.chart.provisioned`.
2. POST `/api/org/outlets` → 6 lokasi (satu per tipe), UOM tenant memuat katalog standar.
3. Panggil ulang `provisionStandardChart`, `provisionOutletStockLocations`, `provisionStandardUoms`, `backfillTenantCharts`, `backfillTenantInventoryDefaults` → tidak ada baris baru, status `already_present`, tidak ada audit tambahan.
4. Bagan yang sudah diubah tenant (akun custom ditambah/diganti nama) → backfill tidak mengubah satu baris pun.
5. Isolasi: tenant A tidak melihat akun/lokasi/UOM tenant B; backfill tenant A tidak menyentuh baris B.
6. Setelah provisioning, tenant tetap bisa membuat akun baru dan mengganti mapping lewat route CoA.
7. POST tenant (platform) → UOM standar ada.

Jalankan: `LEGEND_TEST_FILES="src/test/provisioning-defaults.test.ts" pnpm test` dari root worktree.

## Aturan
- Hanya file di atas. Butuh file lain: lapor ke engineer, jangan edit.
- Tidak ada migrasi kecuali benar-benar perlu; bila perlu, lapor dulu.
- Komentar file baru: rujuk PRD v1.7 §3.19 / §16 Lokasi Stok dan bead id.
