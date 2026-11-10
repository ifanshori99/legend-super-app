# Sub-brief: repro test QR service charge default (legend-xx22n)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/qr-service-charge-default`. Do not commit.

## Claim to reproduce (Codex 133)
New tenant with default provisioning (`provisionDefaultTaxConfig` + `provisionDefaultServiceChargeRule(tx, ctx, null, null)` in `apps/api/src/services/tax-provisioning.service.ts`: PBJT-FNB 10% incl. service in base, tenant-wide `SC-DINE-IN` 500bp orderTypes [dine_in, reservation], effectiveFrom 2024-01-01). Zone `serviceChargeBp: 0`. QR dine-in subtotal Rp100.000 must give service 5_000, PBJT 10_500, total 115_500. Codex says QR gives service 0. Code reading says `selectServiceChargeRules` (qr-order-pricing.ts:560) already falls back — the test decides.

## Write: `apps/api/src/test/qr-service-charge-default.test.ts`
Copy setup patterns from `apps/api/src/test/qr-order-api.test.ts` (lines 55-400: createIsolatedTenant, staffOfIsolatedTenant, asOwnerTenant seeding menu category/item/price list `dine_in`, FakeGateway, `as(guest)` quote/checkout helpers, afterAll). Do NOT insert tax_rules/tax_settings manually; instead provision via the real services inside `withTenant(db, scopedTenantContext, tx => ...)` (see `backfillScope` in tax-provisioning.service.ts ~322 for context construction).

Cases:
1. Zone bp 0, one item Rp100.000 qty 1: POST quote → serviceCharge.amountIdr 5_000, rateBp 500, taxIdr 10_500, totalIdr 115_500. Checkout (POST orders) → 201, order serviceChargeIdr 5_000, taxIdr 10_500; also read `orders` row from DB (`db/schema/qr-order.ts`) and assert persisted service_charge_idr 5_000.
2. Zone bp 1000 (explicit zone override): quote service 10_000.
3. Parity: `loadTaxConfig` (qr-order-pricing.ts:436) from DB inside withTenant, then `computePosBill` (pos-order-pricing.ts:312, see ws03-service-charge-parity.test.ts for call shape) with same zone row + channel dine_in → same service/tax/total as QR quote. Same config with channel `takeaway` (check MenuChannel enum name) → service 0.
4. Cross-tenant: second isolated tenant whose own tenant-wide service rule is 1000bp (insert published service_charge_rules row as owner) — first tenant's QR quote still 5_000; and second tenant with NO service rule and zone 0 → service 0 (first tenant's SC-DINE-IN doesn't leak).

Run: `bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/test/qr-service-charge-default.test.ts" pnpm test 2>&1 | tail -40'`. Report pass/fail per case with actual numbers. Do not change non-test files.
