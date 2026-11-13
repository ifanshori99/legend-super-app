# Brief legend-0mn8: platform admin creates brand / outlet / legal entity for a tenant

Basis: GET list sudah ada (`routes/platform-tenant-resources.routes.ts`, `services/platform-tenant-resources.service.ts`, contract `platformEndpoints.listTenant*` di `@starter/shared/platform`). Yang kurang: POST create.

## Endpoint baru (di router `platformTenantResourcesRouter`, path /api/platform)
- `POST /tenants/:tenantId/brands`
- `POST /tenants/:tenantId/outlets`
- `POST /tenants/:tenantId/legal-entities`

## Aturan
- Guard sama seperti GET: noStore, requirePlatformAuth, requireTrustedOrigin, requirePlatformAdmin, requireSessionMfa(); body lewat `jsonBody`.
- Hanya admin platform. Tenant admin (walau punya izin brand/outlet di tenantnya) = 403. Non-login = 401.
- tenantId dari path (zod strict), bukan body. Body strict (`.strict()`), tanpa tenantId.
- Tenant tidak ada = 404. Semua tulis + audit dalam SATU transaksi (`withTenant(db, platformTenantScope(tenantId), ...)`, `recordAudit` dalam tx yang sama; before/after tanpa data privat).
- Gunakan logika create yang sudah ada di `org.service.ts` bila bisa (reuse, jangan duplikasi validasi: kode unik per tenant, outlet harus brand + legal entity milik tenant yang sama, dll). Fungsi baru bernama `...Any` di `platform-tenant-resources.service.ts` (atau file baru bila file terlalu besar).
- Tidak ada akses lintas tenant: brandId / legalEntityId di body outlet harus milik tenantId path; kalau tidak = 404/422, bukan bocor.
- DTO respons: pakai `brandSchema`, `legalEntitySchema`, `Outlet` yang sudah ada.
- Tanpa UI. Tanpa migrasi kecuali terpaksa (rentang 0456-0458). Jangan sentuh uang/QRIS/AI/edge.
- Teks error baru Indonesia; bila ada teks baru, cek text-contract (lihat AGENTS.md "Pra-gate").

## Bukti
Test gagal-dulu lalu hijau: `heavy env LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` (dari `apps/api` atau root sesuai CLAUDE.md). Satu token heavy: hanya satu subagent menjalankan test/tsc.
