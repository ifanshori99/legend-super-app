# Sub-brief: stok opname backend (legend-j5x, INV-03)

Repo root (worktree): `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/stock-opname`, branch `ws/stock-opname`. Deps installed. Read `AGENTS.md` conventions. PRD: `docs/PRD.md` §3 F16 Stok Opname (~line 740, 776 INV-03), §4 Alur J (~1207). Do NOT read `.env*`. Do NOT edit `apps/web/`, POS/payment/purchasing/recipe, or existing inventory service files (`inventory*.service.ts` other than the new `inventory-count*`). Do NOT edit `drizzle/meta/_journal.json` by hand (drizzle-kit writes it). Do not commit; the engineer commits. Keep only your own files (listed per part). Run `pnpm --filter <pkg> exec tsc --noEmit` or the package `typecheck`/`lint` only for your files' package if cheap; the engineer runs the full gate.

## Fixed design decisions (all parts must follow exactly)

### Concepts

- A **stock count** (opname session) is for ONE stock location (`stock_locations`, outlet-owned). Type `full` (all active inventory items of the tenant + any item with a `stock_balances` row at the location) or `cycle` (the given `inventoryItemIds`). Contract enums already exist in `packages/shared/src/inventory/schemas.ts` (~line 660-830): `stockCountTypeSchema`, `stockCountStatusSchema` (draft, counting, pending_approval, approved, posted, cancelled), `stockCountActionSchema` (start, submit, approve, reject, post, cancel), `stockCountSchema`, `stockCountLineSchema`, `stockCountDetailSchema`, `transitionStockCount`, `assertStockCountApproval`, `stockCountVarianceIdr`. Endpoints exist in `packages/shared/src/inventory/endpoints.ts` (`listStockCounts`, `getStockCount`, `createStockCount`, `updateStockCountLine`, `postStockCountTransition`). Keep their shapes unchanged (apps/web mocks depend on them).
- **Snapshot**: at `create` lines are made with `system_qty` = current `stock_balances.quantity` (0 if no row) and `unit_cost_idr` = current `avg_cost_idr` (0 if none). At `start` (draft→counting) the snapshot is REFRESHED for every line and `snapshot_at` set. That is "stok sistem saat opname dimulai".
- **Transactions during the count = delta method (no freeze)**: sales/receipts keep posting to the location during counting. The physical count describes stock at the snapshot moment, so the posted adjustment per line is `counted_qty − system_qty(snapshot)`, NOT `counted − current balance`. Movements after the snapshot stay in the ledger untouched, so final balance = counted + movements since snapshot. (Document this in the service header comment.)
- **One open count per location**: partial unique index on `(tenant_id, location_id)` where status in (draft, counting, pending_approval, approved) → second create gets 409 `STOCK_COUNT_LOCATION_BUSY`.
- **Blind count** (`blind=true`): the system quantity and variance must never reach a counter through the API.
  - New counter endpoints (no `systemQty`/`varianceIdr`/`unitCostIdr` fields at all): `getStockCountSheet` and `updateStockCountSheetLine` (see contract part).
  - Existing `getStockCount` (full detail with systemQty/variance): for a blind count it returns 403 `STOCK_COUNT_BLIND_HIDDEN` when the count is in draft or counting (for everyone), or when the viewer is a counter of it (creator `counted_by` or any line `counted_by`) and status is not `posted`/`cancelled`, or when the viewer lacks `inventory.adjustment.approve` and status is not posted/cancelled. Non-blind: needs `inventory.stock.view` only.
  - Existing `createStockCount`: for a blind count the response is `{ count, lines: [] }` (schema-valid, no leak); non-blind returns full lines.
  - Existing `updateStockCountLine`: for a blind count returns 409 `STOCK_COUNT_BLIND_USE_SHEET`; non-blind works and returns the full line.
- **Counter**: creator is `counted_by` on the count. Each line stores `counted_by` (last user who entered it) and `counted_at`. Lines editable only in `counting`. Every line edit increments `stock_counts.count_version`.
- **Variance value**: per line `variance_idr = stockCountVarianceIdr({systemQty, countedQty, unitCostIdr}, mode)`; rounding mode: use what waste uses for its loss value (check `inventory-waste.service.ts`/`inventory-ops.shared.ts`; default `"half_up"` if the tenant setting is not obvious). Computed on `submit` and stored. Money = integer IDR (bigint column via `idrColumn`), quantities NUMERIC(14,4) via `decimal4Column` (decimal strings, never JS float math; use `parseDecimal4`/`formatDecimal4` bigint helpers from shared).
- **Approval through `approval_requests`** (`apps/api/src/services/platform-approval.service.ts`):
  - `submit` (counting→pending_approval, needs every line counted, actor needs `inventory.opname.count`): compute variances, `lines_hash` = sha256 of canonical JSON of sorted `[lineId, countedQty, systemQty, unitCostIdr]`, then `openApprovalRequest(tx, context, { sourceModule: "inventory_count", actionType: "stock_adjustment", objectType: "stock_count", objectId: count.id, amountIdr: <sum of |variance_idr|>, outletId, requestedBy: actor, source: "user", requestReason: note?.trim() || "Persetujuan selisih stok opname", payload: { countVersion, linesHash, totalVarianceIdr, grossVarianceIdr }, idempotencyKey })` inside the same tenant transaction. If `required:false` → throw 409 `PRECONDITION_FAILED`-style error (`STOCK_COUNT_APPROVAL_UNROUTED`): INV-03 always needs a second person, fail closed. Store `approval_chain_id`, `approval_version` (= count_version at submit), `lines_hash`, `counted_at`=now.
  - `approve` (actor needs `inventory.adjustment.approve`): first `assertStockCountApproval` + reject if actor is any line counter (`STOCK_COUNT_SELF_APPROVAL`). Then, if the chain is still pending, call `decideApprovalRequest(tenant, actorUserId, <id of current pending level request of the chain>, { decision: "approve", reason: note?.trim() || "Selisih stok opname disetujui" }, { idempotencyKey, mfaVerified, now })` (it runs its own transaction; see `routes/platform-approval.routes.ts` for how `mfaVerified` is obtained via `sessionMfaVerifiedAt(req)` — the route passes it into the service). Then **settle** (below). Approvals done in the generic approval inbox are also honoured: `post` just settles.
  - `reject` (actor needs `inventory.adjustment.approve`, not a counter): decide `reject` on the current level (if still pending), then settle → status back to `counting`, `approval_chain_id`/`approval_version`/`lines_hash`/variances cleared, so lines can be recounted and resubmitted (new chain).
  - `cancel`: from draft/counting/pending_approval by `inventory.opname.count`; if a chain is pending call `cancelApprovalRequest`.
  - **settle(tx, row locked FOR UPDATE)**: `getApprovalChainOutcome(tx, {chainId, sourceModule:"inventory_count"})`; pending past deadline counts as expired (see `staff-override.service.ts` `settlePending` ~line 525 for the pattern). approved → verify last level `decidedBy` is not `counted_by` nor any line counter, that `count_version === approval_version` and recomputed `lines_hash` equals stored (approval is bound to that version; mismatch → `STOCK_COUNT_VERSION_MISMATCH`, no posting), set `approved`/`approved_by`/`approved_at`, then POST in the same transaction (PRD J.4 posts automatically) → `posted`, `posted_at`. rejected/expired/cancelled → back to `counting` as in reject (cancelled by module → cancelled).
  - **Approval is single-use**: posting happens only via the row-locked transition `approved→posted`; the stored chain id is consumed (status `posted` is terminal). A replayed `approve`/`post` on a posted count returns the posted count without new ledger rows.
- **Posting** (INV-01): for each line with `counted_qty − system_qty ≠ 0` append one ledger row via the existing exported `recordStockMovementInTransaction(tx, context, input)` from `apps/api/src/services/inventory.service.ts` (do not modify that file): `movementType: "adjustment"`, `sourceType: "stock_count"`, `sourceId: count.id`, signed quantity = delta, unit cost = line `unit_cost_idr` (snapshot moving-average cost) where the API takes one, `idempotencyKey` = deterministic `stock-count:<countId>:<lineId>` (+ fingerprint as that API requires) so double posting never duplicates. Lock locations like waste does (`lockLocations` in `inventory-ops.shared.ts`). Follow how waste/transfer handle batch-tracked items for negative quantities (FEFO) if the ledger API requires a batch; positive adjustment on a batch-tracked item: follow the ledger API's rules (report what you chose). Zero-delta lines post nothing.
- **Permissions** (`packages/shared/src/access/permissions.ts`): `inventory.opname.count` (create, start, line entry, submit, cancel, sheet view), `inventory.adjustment.approve` (approve, reject, full detail of blind count), `inventory.stock.view` (list, non-blind detail). Service re-checks permissions and outlet scope like `inventory-waste.service.ts` / `inventory-ops.shared.ts` do.
- **Idempotency**: `createStockCount` and transitions carry `idempotencyKey`. Create: unique `(tenant_id, create_idempotency_key)` + fingerprint; replay same body → same count; different body → 409 `IDEMPOTENCY_KEY_REUSED`. Transitions: replaying an action whose target state is already reached returns the current count (no side effects).

### DB tables (part B owns; part C codes against these names)

File `apps/api/src/db/schema/inventory-count.ts` (export from `apps/api/src/db/schema/index.ts` with one line), RLS in `apps/api/src/db/schema/inventory-count.custom.sql`. Pattern: copy style of `inventory-ops.ts` + `inventory-ops.custom.sql` (tenant + outlet RLS FORCE via `app.enforce_tenant_rls` / `app.enforce_outlet_rls`).

`stock_counts` (drizzle export `stockCounts`):

- `id` uuid pk (default random uuid like other uuid tables), `tenant_id` (tenantIdColumn) NOT NULL, `outlet_id` uuid NOT NULL, `location_id` uuid NOT NULL, `type` varchar check in ('full','cycle'), `status` varchar check in the six statuses, `blind` boolean NOT NULL, `business_date` (businessDate col), `note` text null,
- `counted_by` uuid NOT NULL (creator), `count_version` integer NOT NULL default 0, `snapshot_at` timestamptz null, `counted_at` timestamptz null,
- `approval_chain_id` uuid null, `approval_version` integer null, `lines_hash` varchar(64) null, `total_variance_idr` bigint null, `gross_variance_idr` bigint null,
- `approved_by` uuid null, `approved_at` timestamptz null, `posted_at` timestamptz null, `cancelled_at` timestamptz null,
- `create_idempotency_key` varchar NOT NULL, `create_fingerprint` varchar(64) NOT NULL, `created_at`, `updated_at` timestamptz NOT NULL default now().
- Constraints: unique `(tenant_id, id)` and `(tenant_id, outlet_id, id)` (for composite FKs), unique `(tenant_id, create_idempotency_key)`, composite FK `(tenant_id, outlet_id, location_id)` → stock_locations (same columns the other inventory tables use), partial unique index `(tenant_id, location_id) WHERE status IN ('draft','counting','pending_approval','approved')`, checks: approved/posted ⇒ approved_by & approved_at not null; posted ⇒ posted_at not null; pending_approval/approved/posted ⇒ approval_chain_id, approval_version, lines_hash, counted_at not null. Index `(tenant_id, outlet_id, created_at)`.

`stock_count_lines` (export `stockCountLines`):

- `id` uuid pk, `tenant_id` NOT NULL, `outlet_id` uuid NOT NULL, `stock_count_id` uuid NOT NULL, `inventory_item_id` uuid NOT NULL, `system_qty` decimal4 NOT NULL, `unit_cost_idr` decimal4 NOT NULL, `counted_qty` decimal4 null (check ≥ 0), `variance_qty` decimal4 null, `variance_idr` bigint null, `counted_by` uuid null, `counted_at` timestamptz null, `created_at`, `updated_at`.
- Unique `(tenant_id, stock_count_id, inventory_item_id)`, unique `(tenant_id, id)`; composite FK `(tenant_id, outlet_id, stock_count_id)` → stock_counts `(tenant_id, outlet_id, id)` on delete cascade; FK `(tenant_id, inventory_item_id)` → inventory_items as other tables do. Check counted_by/counted_at both null or both set.
- Both tables: tenant RLS + outlet RLS (FORCE) in the custom sql.
- Migration: run from `apps/api`: `pnpm db:generate` (drizzle-kit generate) to create `0063_*.sql` for the tables, then `pnpm exec drizzle-kit generate --custom --name stock_count_rls` (or the repo's script equivalent; check `apps/api/package.json` + how `0058_invbe_rls.sql` was made) and paste the custom.sql statements into that custom migration. Never hand-edit `_journal.json`. Run `node --test` / guard `src/db/outlet-rls.test.ts` expectations: read it to see if new outlet tables must be registered somewhere (if it's a list in a file you don't own, report back instead).

## Parts (one implementer each; own only listed files)

### Part A — shared contract (`packages/shared/src/inventory/schemas.ts`, `endpoints.ts`, `errors.ts`, plus `index.ts` only if needed)

Additive only, existing shapes unchanged.

- `stockCountSheetLineSchema` = strictObject `{ id, tenantId, stockCountId, inventoryItemId, countedQty: decimal4.nullable(), countedBy: userId.nullable(), countedAt: isoDateTime.nullable() }` — no system qty, cost or variance. `stockCountSheetSchema` = `{ count: stockCountSchema, lines: z.array(stockCountSheetLineSchema) }`. Types exported.
- Endpoints: `getStockCountSheet` GET `/api/inventory/stock-counts/:stockCountId/sheet` → `dataResponseSchema(stockCountSheetSchema)`; `updateStockCountSheetLine` PATCH `/api/inventory/stock-counts/:stockCountId/sheet/lines/:lineId`, body `updateStockCountLineInputSchema`, → `dataResponseSchema(stockCountSheetLineSchema)`.
- Error codes (add to the inventory error code list, with HTTP status mapping if that file maps statuses): `STOCK_COUNT_BLIND_HIDDEN` (403), `STOCK_COUNT_BLIND_USE_SHEET` (409), `STOCK_COUNT_LOCATION_BUSY` (409), `STOCK_COUNT_LINES_INCOMPLETE` (422 or the repo's validation status), `STOCK_COUNT_APPROVAL_UNROUTED` (409), `STOCK_COUNT_VERSION_MISMATCH` (409), `STOCK_COUNT_NOT_EDITABLE` (409). Check whether `apps/api` maps InventoryError codes to HTTP status somewhere (grep `STOCK_COUNT_SELF_APPROVAL` in apps/api); if that mapping is in a file outside your list, tell the engineer the file + lines to add.
- Update the `stockCountSchema` doc comment to say blind counts are enforced by the API (sheet endpoints).
- Verify: `pnpm --filter @starter/shared typecheck` (or the package's script) and its tests if fast.

### Part B — DB schema + migration (`apps/api/src/db/schema/inventory-count.ts`, `inventory-count.custom.sql`, one export line in `schema/index.ts`, generated files under `apps/api/drizzle/`)

As specified above. Report the migration file names and the drizzle export names/columns (property names in camelCase).

### Part C — service (`apps/api/src/services/inventory-count.service.ts`, optional helper `inventory-count.shared.ts`)

Exported API (routes call these; keep these names/signatures):

```ts
listStockCounts(context: ScopedTenantContext, actorUserId: string, query: StockCountQuery): Promise<CursorPage<StockCount>>
getStockCountDetail(context, actorUserId, stockCountId): Promise<StockCountDetail>      // blind rules above
getStockCountSheet(context, actorUserId, stockCountId): Promise<StockCountSheet>
createStockCount(context, actorUserId, input: CreateStockCountInput): Promise<StockCountDetail> // blind → lines []
updateStockCountLine(context, actorUserId, stockCountId, lineId, input): Promise<StockCountLine> // non-blind only
updateStockCountSheetLine(context, actorUserId, stockCountId, lineId, input): Promise<StockCountSheetLine>
transitionStockCount(context, actorUserId, stockCountId, input: TransitionStockCountInput, options: { mfaVerified: boolean; now?: Date }): Promise<StockCount>
```

(`context` = `ScopedTenantContext` as in `inventory-waste.service.ts`; get `TenantContext` for `decideApprovalRequest` from it the way other services do.) Use `withTenant` transactions as existing services do. Mapping rows → contract schemas via `.parse`. Use part B's table names exactly as listed (camelCase drizzle props). Throw `InventoryError`/`CoreError` with the codes from part A (if part A's codes are not yet in shared when you typecheck, still use them; the engineer merges). Read `inventory-waste.service.ts`, `inventory-ops.shared.ts`, `inventory.service.ts` (`recordStockMovementInTransaction` ~l.921), `platform-approval.service.ts` (`openApprovalRequest` l.491, `getApprovalChainOutcome` l.697, `cancelApprovalRequest` l.710, `decideApprovalRequest` l.972) and `staff-override.service.ts` (open l.331, settle l.525).

### Part D — routes (`apps/api/src/routes/inventory-count.routes.ts`, plus registration line(s) in `apps/api/src/routes/index.ts`)

`createInventoryCountRouter()` mounted on `/inventory` like `createInventoryOpsRouter()` (index.ts ~l.92-96). Copy middleware/permission style of `routes/inventory-ops.routes.ts` (`requireAuth, requireTrustedOrigin, requireTenantContext`, `requireOutletPermission`, `jsonBody`, strict Zod from `@starter/shared/inventory`). Endpoints: list, get detail, get sheet, create, patch line, patch sheet line, post transition (pass `mfaVerified: (await sessionMfaVerifiedAt(req)) !== null`, see `platform-approval.routes.ts` l.99). Outlet for item routes: load from the count (service enforces scope); route-level permission: list/detail `inventory.stock.view` (query outlet), create/sheet/line `inventory.opname.count`, transitions: check in service (action-dependent). Status codes: create 201, others 200. Make sure Express route order doesn't let `/:stockCountId` swallow `/sheet`.

### Part E — tests (`apps/api/src/test/inventory-count.test.ts`)

Vitest integration test in the style of `apps/api/src/test/inventory-ops.test.ts` (seeding via owner pool, RLS via app pool, `signedIn`, `asTenant`, `insertUser`, `assignRole`; seed an approval policy for `stock_adjustment` the way `platform-approval.test.ts`/`staff-override` tests do, threshold 0 so every count routes to an approver). Write tests against the HTTP API (and service where needed) for:

1. full count: all items incl. one with a balance; cycle count: only listed items.
2. blind: counter's create response has `lines: []`; sheet has no `systemQty`/`varianceIdr`/`unitCostIdr` keys; `GET /stock-counts/:id` → 403 for the counter (and for anyone during counting); `PATCH /lines/:id` on blind → 409; after submit an approver (other user) sees systemQty + variance.
3. variance + value: counted 8 vs system 10 at avg cost 1500 → varianceIdr −3000; positive variance; zero-variance line.
4. approval by another user via `transitions {action:"approve"}` → status `posted`, ledger has `adjustment`/`stock_count` rows = counted − snapshot; balances updated.
5. counter rejected approving own count (`STOCK_COUNT_SELF_APPROVAL`), and a line counter too; no ledger rows.
6. ledger empty while `pending_approval`; reject → back to counting, still no ledger rows; resubmit opens new chain.
7. double approve/post replay → no duplicate ledger rows; concurrent `post` twice (Promise.all) → one set of rows.
8. approval done in the generic approval inbox (`decideApprovalRequest` or its route) then `post` → posted.
9. version binding: edit not possible after submit (409 `STOCK_COUNT_NOT_EDITABLE`).
10. transactions during count: start (snapshot 10) → record a sale/consumption movement of −2 via `recordStockMovement` → count 7 → post → adjustment −3, final balance 5 (= 7 − 2).
11. one open count per location → 409 `STOCK_COUNT_LOCATION_BUSY`; idempotent create replay.
12. isolation: tenant B cannot list/get/transition tenant A's count (404/403), RLS app pool sees zero rows of the other tenant in `stock_counts`/`stock_count_lines`; outlet-scoped user without the outlet gets 403/404.
    Use the endpoint paths and error codes from this brief. Tests will be run by the engineer (`pnpm test` creates a disposable Postgres); you may try `cd apps/api && pnpm exec vitest run src/test/inventory-count.test.ts` only if `STARTER_TEST_*` env is provided by the root runner — otherwise just typecheck. Don't weaken expectations to match code; the code must follow this brief.

## Wave 2 — review fixes (service: `inventory-count.service.ts`/`.shared.ts`, schema `inventory-count.ts` + NEW generated migration; tests: `inventory-count.test.ts`)

F1 Blind leak via approval inbox: the requester (counter) can read `payload`/`amountIdr` of their own approval request. For a **blind** count open the chain with `amountIdr: null` (every tier applies, fail closed) and payload `{ countVersion, linesHash, blind: true }` only — no variance totals. Non-blind keeps amount = gross variance and the totals.
F2 Multi-level chain: in settle, check EVERY level's `decidedBy` (all rows of the chain): none may be a counter, and each must hold `inventory.adjustment.approve` at the outlet; otherwise revert to counting (no post).
F3 `reject` must never post: if the chain is already approved when `reject` arrives, throw `STOCK_COUNT_INVALID_TRANSITION` (409) and change nothing. Only `approve`/`post` may settle into posting.
F4 Recount after reject/expiry/inbox rejection: `revertToCounting` refreshes the snapshot (system_qty, unit_cost_idr from current balance, snapshot_at = now) and clears every line's counted_qty/variance/counted_by/counted_at so the recount is against the new snapshot; bump count_version.
F5 Expiry revert: before reverting a pending-past-deadline chain call `cancelApprovalRequest` so a resubmit isn't blocked by the open request.
F6 Counter history: add `counter_ids text[] NOT NULL DEFAULT '{}'` to `stock_counts` (append the editor id if absent on every line edit, never removed, creator included at create). Counter set = counted_by ∪ counter_ids. Generate a NEW migration with `pnpm db:generate` from `apps/api` (0065…); do not touch 0063/0064 or hand-edit `_journal.json`.
Semantics fix: `post` after an inbox rejection returns 200 with the settled count (status `counting`), no ledger rows.

## Wave 3 — architect second opinion (supersedes earlier rules where they conflict)

T2 Per-line snapshot at entry (replaces the "delta vs start snapshot" rule). A physical count reflects stock at the moment the line is entered. In `editLine` (service ~~683), under `lockLocations`, set the line's `system_qty` and `unit_cost_idr` to the CURRENT balance/avg cost at that moment (re-entry refreshes again). Posted adjustment = counted − system_qty(at entry). Example: snapshot 10 at start, sale −2 (balance 8), counter enters 7 → system_qty 8 → adjustment −1 → final 7. Sales after entry stay untouched. Update the service header comment. Start still snapshots (provisional, for non-blind display).
S3 Found stock valued Rp0: unit cost for a line = location avg cost if > 0, else the item's latest positive `unit_cost_idr` in `stock_ledger` (tenant, any location) as reference cost; if still 0 and the line has a positive delta → `submit` fails 422 `STOCK_COUNT_COST_MISSING` (new shared error code, 422 mapping).
T1 (scope widened, CTO approved) Quantity reads must not leak a blind count: `apps/api/src/routes/inventory.routes.ts` + its service list functions for stock balances, stock ledger and batches (and any other quantity read in `inventory.service.ts` you find on the same router). For every OPEN blind count (status draft/counting/pending_approval/approved) hide rows for its (location_id, inventory_item_id) pairs from a viewer who is in that count's counter set OR lacks `inventory.adjustment.approve` at the outlet. Hide = exclude the rows in SQL (NOT EXISTS against stock_counts/stock_count_lines), so pagination stays consistent. Put the reusable SQL helper in a NEW file `apps/api/src/services/inventory-count.visibility.ts` (exports e.g. `blindCountHiddenFilter(...)` and `isBlindHiddenFor(...)`), and call it from the existing list functions with minimal edits.
S4 Counters never see a blind detail: `getStockCountDetail` on a blind count → 403 `STOCK_COUNT_BLIND_HIDDEN` for anyone in the counter set at ANY status (incl. posted/cancelled). Also record deciders: new column `decider_ids text[] NOT NULL DEFAULT '{}'` on `stock_counts` (new drizzle-generated migration), append the approver/rejecter on approve/reject/settle (every chain level's `decidedBy`); a decider who then tries to enter a line → 403 `STOCK_COUNT_DECIDER_CANNOT_COUNT` (new code).
R5 Blind approval payload is `{ countVersion, blind: true }` only — no `linesHash` (it can be brute-forced to the system qty). The hash stays only on the stock_counts row.
R6 `approve` on a chain past its deadline → 409 `STOCK_COUNT_APPROVAL_EXPIRED`, no state change in that request. (`post`/`cancel` still settle an expired chain back to counting as before.)
R8 A counter (or approver without `inventory.adjustment.approve`) who approved any level in the inbox: do NOT reset the counted lines. Instead keep the count `pending_approval` with its lines, open a FRESH approval chain for the same version (new idempotency key) and store the new chain id, commit that, and then answer the triggering request 409 `STOCK_COUNT_SELF_APPROVAL` (throw after the transaction commits). No ledger rows.
Tests (test-writer): rewrite the delta test (~~:1505) to the real-stock example above (final 7, adjustment −1); add one test per item T2, S3 (reference cost used; 422 when none), T1 (counter GET balances/ledger/batches misses the blind pairs while open, sees them after post; approver non-counter sees them; non-blind count hides nothing), S4 (counter 403 after post and after cancel; decider entering line → 403), R5 (payload has no linesHash), R6 (approve after deadline → 409), R8 (counter inbox approval → 409, lines kept, new pending chain, a clean approver then posts).

## Wave 3b — T1 residual reads

Apply the same `blindCountHiddenFilter` (from `apps/api/src/services/inventory-count.visibility.ts`, see how `listStockBalances` in `inventory.service.ts` computes `canApprove` at the queried outlet) to the quantity reads in `apps/api/src/services/inventory-par-alerts.service.ts` (~202, `/stock-alerts`, `onHand`) and `apps/api/src/services/inventory-expiry.service.ts` (~85, ~235, `/expiry-alerts`, batch quantity/remaining). Hide = exclude those pairs' rows in SQL. If an alert is computed in JS from rows, filter the source rows. Tests: counter GET `/api/inventory/stock-alerts` and `/api/inventory/expiry-alerts` misses the open blind pair; approver (non-counter) still sees it; after posting the counter sees it.

## Wave 4 (review K round 2, brief 84)

Decided behaviour (already coded, tests must follow it):

- Quantity reads (`/inventory/balances`, `/stock-ledger`, `/batches`, `/stock-alerts`, `/expiry-alerts`, `/purchase-suggestions`) hide the (location, item) pairs of an open blind count (draft/counting/pending_approval/approved) from EVERYONE, approvers included. `visibility.ts` no longer takes a viewer.
- Blind detail `GET /stock-counts/:id`: still 403 BLIND_HIDDEN for counters (any status) and for everyone in draft/counting; an approver who is not a counter can open it in pending_approval/approved, and is then appended to `stock_counts.viewer_ids`.
- Line entry (sheet or full) by anyone in `viewer_ids` → 403 `STOCK_COUNT_VIEWER_CANNOT_COUNT`.
- Posting: a decrease (outflow) carries no unit cost, so the ledger values it at the moving average at posting; an increase keeps the entry cost (S3). `stock_count_lines.posted_value_idr` = signed IDR the ledger booked for the line.

Tests (in `apps/api/src/test/inventory-count.test.ts`):

- W4-1: `dual` (count + approve) who entered nothing, and `approver`, miss the pair in balances during draft/counting and pending_approval.
- W4-2: approver opens detail at pending_approval → `viewer_ids` has them; reject → count back to counting (check how reject works in the file) → approver line entry 403 VIEWER_CANNOT_COUNT; counter can still enter.
- W4-3: 10 @ 1.000 on hand, blind or non-blind count, counted 8 (line entry), then receipt 10 @ 2.000, then submit + approve (post). Assert: balance qty 18, balance value (qty × avg) equals Σ(ledger qty × unit cost) for the pair, the count's adjustment ledger row has unit cost = avg at posting (20 on hand at 1.500 after the receipt → row −2 @ 1.500; balance 18 @ 1.500 = 27.000 = ledger 10.000 + 20.000 − 3.000), and `posted_value_idr` of the line equals that row's qty × cost.
- Update every existing expectation that an approver/`dual`-before-counting SEES a pair of an open blind count: it is now hidden. Posted/cancelled/non-blind cases unchanged.
