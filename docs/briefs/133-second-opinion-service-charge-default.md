# Brief 133: second-opinion, default service charge 5% (legend-2qz7)

Tingkat K (uang dan pajak). Tinjau independen, baca saja, jangan mengedit.

## Rentang diff
Repo `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/service-charge-default`.
`git diff 9a057246..50a64ffb` (cabang `ws/service-charge-default`). Non-test kira-kira 270 baris (maks 800 per run): satu run cukup.

## Berkas berisiko (urut)
0a. `apps/api/src/services/tax.service.ts`: `assertNoServiceChargeOverlap` (cek tabrakan per pasangan saat publish, legend-mdh0), kunci `lockServiceChargeConfig` di `createServiceChargeRule` dan `publishServiceChargeRule`.
0b. `apps/api/src/routes/org.routes.ts` dan `org.service.ts`: actor pembuat outlet diteruskan ke seed.
0. `apps/api/src/services/pos-order.service.ts`: guard `createPosOrder` (legend-6u81), `reservation` hanya untuk `dine_in`.
1. `apps/api/src/services/tax-provisioning.service.ts`: `provisionDefaultServiceChargeRule`, `auditProvisioning`.
2. `apps/api/src/services/org.service.ts` (`createOutlet`, satu pemanggilan seed).
3. `apps/api/src/services/platform-org.service.ts` (`createTenant`, satu pemanggilan seed).
4. Pembanding, tidak diubah: `packages/shared/src/tax/calculate.ts` (`resolveServiceChargeRule`, `computeGroup`), `apps/api/src/db/schema/tax.ts` (`service_charge_rules`).

## Invariant
- Tenant baru: tepat satu aturan `SC-DINE-IN`, tenant-wide, 500 bp, `orderTypes ["dine_in", "reservation"]`, `itemClasses ["food_beverage"]`, v1 published, aktif, efektif 2024-01-01.
- Outlet baru: satu aturan outlet-scoped yang sama, kecuali tenant sudah punya aturan service tenant-wide (kode, status, versi apa pun). Aturan outlet tidak boleh mengalahkan aturan owner.
- Tenant dan outlet lama tidak berubah: tidak ada backfill, `backfillTenantTaxDefaults` tidak menyentuh service.
- Takeaway dan delivery tidak kena service; reservasi dine-in ikut (keputusan CTO legend-9flj, `DEFAULT_SERVICE_CHARGE_ORDER_TYPES`). Mesin hitung tidak diubah. Urutan: diskon, service, pajak (PBJT `includeServiceInBase`).
- Idempoten dan tanpa race: kunci advisory per tenant; aturan yang sudah diubah atau dimatikan owner tidak ditimpa dan tidak dibuat ulang.
- Satu transaksi dengan pembuatan tenant/outlet; audit `tax.service_charge.provisioned` tanpa teks bebas, outlet id tercatat untuk aturan outlet.
- Isolasi tenant (RLS) terjaga.
- Publish aturan service aktif yang sama peringkat dan cakupannya beririsan dengan aturan berlaku lain ditolak (`TAX_RULE_AMBIGUOUS` 409) dan di-rollback; tanpa mengubah `calculate.ts`. Dua publish bersamaan tidak bisa sama-sama lolos (kunci advisory pertama).
- Aturan outlet dan audit memakai user pembuat outlet bila ada.

## Yang diharapkan diperiksa
Celah pada cek tabrakan (tanggal, zona, channel, tombstone, override outlet satu kode), urutan kunci vs deadlock, jalur yang menulis `service_charge_rules` tanpa lewat publish (seed dev).

## Bukti
`LEGEND_TEST_FILES="src/test/tax-service-default.test.ts" pnpm test` (16 test), `src/test/tax-service-overlap.test.ts` (15 test), dan `src/test/pos-order.test.ts` (guard reservasi).
