# Brief legend-3sy9b: share allocation versions through the approval matrix

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/3sy9b-share-alloc` (branch `ws/3sy9b-share-alloc-approval`, base `ws/8s992-profit-rules`). All paths below relative to `apps/api/src` unless noted.

## Bug

`share_allocation_versions` (SH-03) are approved by `decideShareAllocationVersionService` (`services/profit-share-registry.service.ts:1270`) straight from the decide route: any non-requester holding `profit_share.distribution.approve` approves. The tenant's `shareholder_version` approval matrix (roles, levels) is never consulted. Same class of bug as Codex 377 on distribution runs, fixed in commits d473a788 / 54b76963.

## Reference pattern (copy it, do not invent)

- Distribution run: `services/profit-share-distribution.service.ts` submit (~1359 `openApprovalRequest`), `distributionChainOf` (~1390), `settleLoadedRun` (~1603), `settleDistributionRunForApproval`, `decideDistributionRunService` (~1680: chain null → re-open, `opened.required` → commit then 409 `APPROVAL_PENDING`; chain present → settle or 409; reject → `cancelApprovalRequest` first, `approved` outcome → `INVALID_TRANSITION`).
- Recipient version: `services/profit-share-registry.service.ts:512-763` (`requestRecipientChange`, `settleShareholderRecipientVersionForApproval`).
- Consumer: `services/profit-share-approval-consumers.ts`; ids in `services/profit-share-approval.ts`.
- Tests: `test/profit-share-approval-chain.test.ts`, `test/profit-share-recipient-version.test.ts` (policy seeding `shareholder_version` ~278-290, `decideApprovalRequest` + `handleProfitShareApprovalResolved`).

## Design (decided)

1. Migration `apps/api/drizzle/0256_share_version_approval.sql` (temporary number 0256; journal `idx` 256, tag `0256_share_version_approval`, `when` greater than 0252's `1794318165482`; snapshot `meta/0256_snapshot.json` from `pnpm db:generate`, then rename file/tag from what drizzle-kit picks):
   - `share_allocation_versions.id uuid NOT NULL DEFAULT gen_random_uuid()` + unique `(tenant_id, id)` (`share_allocation_versions_tenant_id_key`). Existing rows get a uuid. This is the approval `objectId` (approval `object_id` is varchar(36), the composite key does not fit).
   - `CREATE OR REPLACE FUNCTION app.share_allocation_versions_guard()`: add `id` to the identity tuple (immutable); allow `pending_approval → cancelled` (chain expired / cancelled; decided_by stays NULL, note NULL per existing checks). Mirror the exact same function in `db/schema/accounting-profit-share.custom.sql`.
   - TS schema `db/schema/accounting-profit-share.ts` `shareAllocationVersions`: add `id`, unique.
2. `services/profit-share-approval.ts`: `SHARE_ALLOCATION_VERSION_OBJECT_TYPE = "share_allocation_version"` (matrix action `shareholder_version`).
3. Submit (`submitShareAllocationVersionService`): after the transition, `openApprovalRequest` with `sourceModule profit_share`, `actionType "shareholder_version"`, `objectType SHARE_ALLOCATION_VERSION_OBJECT_TYPE`, `objectId row.id`, `amountIdr null`, `outletId` = entity's outlet (or null), `requestedBy actorId`, `source "user"`, reason `Versi porsi saham <entity name> v<version>`. `APPROVAL_POLICY_MISSING` propagates (fail closed, 409). `required:false` → version stays pending with no chain, decide keeps the direct path (distribution parity).
4. `shareVersionChainOf(tx, tenantId, versionId)`: latest chain head by (tenant, source module, object type, object id), like `distributionChainOf`.
5. `settleShareAllocationVersionForApproval(tx, context, profitEntityId, version, now)` exported: lock entity then version (same order as decide), return unchanged if not `pending_approval` or no chain; `resolveApprovalChainOutcome`; pending → unchanged; decider = last level `decidedBy` if ≠ requester else null.
   - cancelled / expired → `cancelled` (decidedBy null, note null); audit `share_version.cancelled` with reason `approval <outcome>`.
   - decider null → `cancelled`, reason `approval approver invalid`.
   - rejected → `rejected` by decider, note `approval rejected`.
   - approved → `assertEffectiveFromAdvances(latestApprovedEffectiveFrom(...))` and sum/unique checks (via `transitionShareAllocationVersion` approve with decider); an `AccountingError` inside a savepoint → `rejected` by decider with note `approval refused: <code>`; else `approved` by decider. Audit `share_version.approved` / `share_version.rejected`.
6. Decide (`decideShareAllocationVersionService`): keep idempotency claim. Approve: run the state-machine guard first (pending + caller ≠ requester). Chain null → re-open via the same open helper (requestedBy = row.requestedBy); `required` → commit then throw 409 `APPROVAL_PENDING` after the transaction; else direct approve as today. Chain present → settle; still pending → 409 `APPROVAL_PENDING` ("Persetujuan belum selesai di kotak masuk approval."). Reject: chain present → `cancelApprovalRequest`; outcome `approved` → `AccountingError("INVALID_TRANSITION")`; then reject as today.
7. Consumer: accept `objectType === SHARE_ALLOCATION_VERSION_OBJECT_TYPE`; head row (id = chainId, objectType share version) → `objectId` → version row by `(tenant, id)` → settle. Update the header comment.
8. Shared `packages/shared/src/accounting/profit-share.ts` state machine: no change needed unless types force it.

## Tests (fail first) — new file `test/profit-share-share-version-approval.test.ts`

Build like `test/profit-share-recipient-version.test.ts` (same app/fixture style, `shareholder_version` policy seeded as owner with an approver role; save + restore policies). Cases:
- T1 submit opens a `shareholder_version` chain (`approval_requests` row source_module `profit_share`, object_type `share_allocation_version`, object_id = version id, pending); version `pending_approval`.
- T2 decide approve by a non-requester holding `profit_share.distribution.approve` while the chain is pending → 409 `APPROVAL_PENDING`; version still `pending_approval`, no approved row.
- T3 inbox approve (`decideApprovalRequest` by the approver-role user) + `handleProfitShareApprovalResolved` → version `approved`, `decided_by` = inbox approver.
- T4 inbox reject + consumer → `rejected`, decided_by = approver, note set.
- T5 chain cancelled/expired + consumer → `cancelled`.
- T6 policy missing → submit 409 `APPROVAL_POLICY_MISSING`, version stays `draft`.
- T7 decide reject while chain pending → chain cancelled, version `rejected`.
- T8 consumer replay (same event twice) idempotent; event for unknown object ignored.
- T9 legacy pending version with no chain (raw SQL as owner) → decide approve opens a chain and answers 409; a second decide still 409.
- T10 approved via chain but a later-effective version got approved first → `rejected` with note `approval refused: ...` (optional if fixture is costly).

Also update `test/profit-share-registry.test.ts`: its `approve()` route helper now gets 409 when a chain is open. Seed a `shareholder_version` policy there and approve through the inbox (`decideApprovalRequest` + consumer), or add a helper. Do not weaken asserts; keep four-eyes / transition asserts meaningful.

Run tests: `pnpm test` from repo root with `LEGEND_TEST_FILES=<file>` (see TEAM.md gate rule; never `node --test` directly). Heavy commands through `heavy`.
