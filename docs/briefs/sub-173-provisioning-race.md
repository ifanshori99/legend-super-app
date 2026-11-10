# Sub-brief 173: provisioning race (legend-dq0n, legend-hd1m)

Worktree (edit ONLY here): `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/provisioning-race` (branch `ws/provisioning-race`). Do not commit. Do not touch `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/*`, auto-journal, refund, `pos-shift.service.ts`.
Background: `docs/briefs/130-second-opinion-tax-default.result.md`, `docs/briefs/122-second-opinion-provisioning.result.md` (main checkout `/Users/ifanshori99/Projects/legend super app/legend`).

Shared lock module already written: `apps/api/src/services/tenant-config-locks.ts` (`lockChartOfAccounts`, `lockOutletStockLocations`, `lockTaxConfig`, `lockServiceChargeConfig`; keys unchanged; header documents lock order). Do not edit it; report if it needs a change. Take the advisory lock FIRST in the tx (before row `FOR UPDATE` locks and before reading the guarded table), right after cheap permission checks is fine as long as no guarded read happened before.

## A. Tax (implementer) — files: `tax-provisioning.service.ts`, `tax.service.ts`
- `provisionDefaultTaxConfig`: replace inline lock with `lockTaxConfig`. Move `lockServiceChargeConfig` out of tax-provisioning: re-export from `tenant-config-locks.ts` is NOT wanted; update `tax.service.ts` and `org.service.ts`/others importing it to import from `./tenant-config-locks` (grep `lockServiceChargeConfig`). `org.service.ts` import-only change is allowed.
- Owner writers in `tax.service.ts` take `lockTaxConfig(tx, context.tenant.tenantId)`: `createTaxRule`, `updateTaxRule`, `publishTaxRule` (before `lockTaxRule`), `createTaxSettings`, `publishTaxSettings` (before its row read/lock). Add any other tax-rule/settings insert/update writer you find.
- Fix the header comment of tax-provisioning ("Tax routes do not take this lock" is now false) and the backfill-script comment in `apps/api/src/db/backfill-tenant-defaults.ts` about owner publishing racing the unique version key only if it becomes untrue.

## B. CoA (implementer) — files: `accounting-provisioning.service.ts`, `accounting-accounts.service.ts`
- `provisionStandardChart`: use `lockChartOfAccounts`.
- `createAccount`, `updateAccount`, `replaceAccountMappingsForEntity` take `lockChartOfAccounts(tx, tenantId, legalEntityId)` before reading the chart/mappings (legal entity id from input or from the locked row: for update, read the account's legalEntityId first with a plain select, lock, then proceed; keep the existing behaviour otherwise).
- Update doc comments to say owner writers share the lock.

## C. Locations (implementer) — files: `inventory-provisioning.service.ts`, `apps/api/src/test/provisioning-defaults.test.ts` (only the location tests)
- Use `lockOutletStockLocations`.
- A missing standard type whose default name is taken (case-insensitive) is still added, with a deterministic unique alternative name: `${name} 2`, then `${name} 3`, ... first free name (check against existing names AND names chosen earlier in the same batch). Existing rows never change. Respect any name length limit in schema/validation.
- Fix the preservation test (~:625) to expect the colliding type present with the alternative name, and add one test: outlet has a `warehouse` named `Dapur`, provisioning adds `kitchen` as `Dapur 2`, production location resolution (`inventory-production.service.ts` `productionLocation`) then finds exactly one kitchen.
- Update header comment.

## D. Race tests (test-writer, isolated worktree on pre-fix code) — new file `apps/api/src/test/provisioning-race.test.ts`
Pattern: `apps/api/src/test/inventory-edge-source-race.test.ts` (owner `pg.Pool`, `advisoryLockStates`, `waitFor`). Deterministic interleave, no sleeps:
1. Tax: T0 (owner pool client) `BEGIN; LOCK TABLE tax_rules IN SHARE MODE`. Start owner `createTaxRule` (tenant-wide, code `CUSTOM-PBJT`, food_beverage, channels covering dine_in) — wait until a pg_locks row shows a non-granted lock on relation `tax_rules`. Start `backfillTenantTaxDefaults(tenantId)`; wait until it is blocked (second waiter: non-granted relation lock on tax_rules OR non-granted advisory on `tax:provisioning:<tenantId>`; record which). `COMMIT` T0. Await both. Expect: tenant has exactly one tax rule, code `CUSTOM-PBJT`; backfill `rulesInserted === 0`; the backfill waited on the advisory lock (`advisoryLockStates` saw `false`). Use a fresh tenant with no tax rules and no tax settings.
2. CoA: same shape with `chart_of_accounts`: owner `createAccount` (code `9999`) on a legal entity with an empty chart vs `backfillTenantCharts(tenantId)`. Expect chart has only `9999`, no template accounts, no mappings; backfill status `already_present`; backfill waited on advisory `chart_of_accounts:<tenant>:<entity>`.
Fixtures: read how `provisioning-defaults.test.ts` / `tax-provisioning.test.ts` build an empty tenant + entity + owner actor with permission. Run it on the pre-fix code (it MUST fail: two rules / mixed chart, or advisory never waited) and report the failure lines. Run: from the isolated worktree root, `pnpm worktree:setup` once, then `heavy bash -c 'LEGEND_TEST_FILES="src/test/provisioning-race.test.ts" pnpm test' 2>&1 | tail -60`. Report the absolute path of the file you wrote.
