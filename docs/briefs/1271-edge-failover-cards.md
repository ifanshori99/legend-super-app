# 1271 Edge -> cloud failover: cards for `int/rc2`

Architect, 26 Nov 2026. Source: `docs/design/edge-cloud-failover.md` (9 Nov, written for
`integ/m1-batch3`) + founder decision 29 (`docs/founder/keputusan-2026-11-21.md`). Base:
`origin/int/rc2` (last migration 0527) **after `origin/ws/1269-e3` is merged** (adds 0528,
`services/pos-edge-outlet.ts`, `middleware/pos-on-cloud.ts`, `edge/shift-day-applier.ts`).
Paths below are relative to `apps/api/src/` unless they start with `packages/`, `apps/web/`, `e2e/`, `docs/`.

## Decisions that change the 9 Nov design (rc2 topology: POS always served by the edge, E1/E3 ingest edge -> cloud)

- D1. **No full sync-back of failover orders to the edge** (drops design S4 and S6). The cloud already
  holds every edge sale (E1) and shift/day (E3). Copying cloud-written sales onto the edge would make
  the edge re-emit them up = double sale/cash. Failover rows stay cloud-only, so the echo is impossible.
  Cost to users: after return, void/refund of an `F` receipt is done from back office (cloud refund
  path), not at the edge cashier; the edge's own day screen shows edge sales only (note on screen).
  CTO: tell the founder in plain words; it does not change decision 29.
- D2. **Cash = close-and-reopen, not bridge movements.** The switchover count C1 (per device) is the
  forced blind count of the interrupted edge shift (variance C1-E1 stays with the edge shift). The
  failover shift in the cloud opens with float C1 and closes with count C2. After return the cashier
  opens a new edge shift with float C2. Every rupiah sits in exactly one shift; no new
  `cash_movements.type`, no journal-neutral movement to get wrong. The edge closes its own shift
  (single writer), applied from the window-closing event; E3 mirrors the close up as usual.
  If that edge shift has any sale/cash movement after the C1 count time (split brain), the applier
  refuses, records an `edge_sync_conflicts` row and alerts managers: never guesses.
- D3. **Numbering unchanged from design:** `receipt_sequences.series` (`device` | `cloud` | `failover`),
  F-run per device held in the cloud only (never edge-bound), prefix `^F[0-9]{1,4}$` reserved both ways.
- D4. **E3 gate:** `assertPosWriteNotOnEdge` returns (allows) on the cloud while the outlet's window is
  `active`; on the edge it throws `FAILOVER_ACTIVE` while the local window copy is `active`/`returning`.
  `allocateReceipt` takes the F-run instead of `RECEIPT_DEVICE_ON_EDGE` while `active`.
- D5. **Tutup Hari** (founder: cloud data allowed): existing stale-edge cloud close (Q24,
  `assertDayClosesOnCloud`) stays. Edge Tutup Hari refused while window `active`/`returning`. When the
  edge later closes a day that has failover rows, the E3 mirror compares edge figures with cloud
  figures **without** failover rows, then stores the cloud's **full** recap (edge + failover).
- D6. Freeze trigger (design W4) dropped: no batch is built from frozen rows, and back-office refunds
  of failover orders must stay possible. Kill switch: env `EDGE_FAILOVER_ENABLED` (default false).
- Migration number: next free after 0528, assigned by CTO (expected 0529). One migration only (F1).

## Cards

| Card | Tier | Model | Hours | Depends | Parallel |
|---|---|---|---|---|---|
| F0 design delta doc | S | Sonnet 5.5 (tech-writer) | 1 | none | yes, anytime |
| F1 contract + schema + migration | K | Opus 5.5 | 6 | E3 merged into int/rc2 | alone (owns migration) |
| F2 receipt F-series | K | Opus 5.5 | 7 | F1 | parallel with F3, F5, F6a |
| F3 cloud window service + gate | K | Opus 5.5 | 8 | F1 | parallel with F2, F5, F6a |
| F4 edge applier + forced shift close + edge status | K | Opus 5.5 | 8 | F1, F3 | parallel with F2, F5, F6b |
| F5 day recap with failover rows | K | Opus 5.5 | 5 | F1 | parallel with F2, F3, F4 |
| F6a mockup | S | Codex designer | 3 | none | yes; founder review before F6b |
| F6b terminal + back office UI | S | Opus 5.5 ui-engineer | 9 | F1, F3, F6a approved, POS edge/cloud API target (1268/E10 card) | parallel with F4, F5 |
| F7 e2e + runbook | S | Sonnet 5.5 | 4 | F2-F6b | last |

Total ~51 h; critical path F1 -> F3 -> F4 -> F7 = 26 h. No two parallel cards share a file
(file owners below). Review: one architect subagent per K branch (xhigh: F1, F2, F4, F5 money/numbers;
high: F3 access). Second opinion Codex once for the whole area (xhigh), before the release gate.

### F0. Design delta (S)
- `docs/design/edge-cloud-failover.md`: add section "Delta rc2 (26 Nov)" = D1-D6 above; mark §5, S4, S6, W4, W7 superseded.
- Done: prettier check passes.

### F1. Contract, schema, migration (K)
- `packages/shared/src/edge/failover.ts` (new: window status enum, window DTO, activate/cancel/return
  bodies with `idempotencyKey`, `reason`, `override`; cloud_to_edge payloads `pos.failover.window_state`
  and `pos.failover.window_closed` {windowId, status, businessDates, shifts:[{deviceId, cashierId,
  countedAt, counts, totalIdr}]}), `packages/shared/src/edge/index.ts`,
  `packages/shared/src/edge/node-status.ts` (optional `failover` field on edge status, so F4 and F6b stay parallel)
- `packages/shared/src/pos/errors.ts` (`FAILOVER_EDGE_HEALTHY`, `FAILOVER_ACTIVE`, `FAILOVER_OPEN_WORK`,
  `FAILOVER_NOT_ACTIVE`, `FAILOVER_DISABLED`; HTTP 409, 403 for disabled), `packages/shared/src/pos/receipts.ts`
  (series type; `receiptPrefixSchema` refuses `^F[0-9]+$`)
- `packages/shared/src/access/permissions.ts`, `roles.ts`: `pos.failover.manage` for owner, store manager, `supervisor`
- `db/schema/edge-failover.ts` + `edge-failover.custom.sql` (new: `outlet_failover_windows`, partial unique
  one `active|returning` per outlet, forward-only status trigger, no delete, RLS like other edge tables),
  `db/schema/index.ts`
- `db/schema/pos-receipt.ts` + `pos-receipt.custom.sql`: `series` NOT NULL default `device`; current-run
  unique index becomes (tenant, outlet, device, series) WHERE retired_at IS NULL; check
  `(series='failover') = (prefix ~ '^F[0-9]{1,4}$')`; check `series<>'failover' OR edge_node_id IS NULL`;
  preflight aborts if a `device` prefix matches `^F[0-9]+$`
- `db/schema/pos-order.ts`, `pos-shift.ts`: nullable `failover_window_id` (composite FK to the window)
- `services/edge-failover-window.ts` (new, read helper only: `activeFailoverWindow(tx, tenantId, outletId)`, `windowTouchesDate`)
- `drizzle/05xx_edge_failover.sql` + `meta`; `tests/pos-contract.test.mjs`; `test/edge-failover-schema.test.ts`
- Done: schema test proves one open window, forward-only, no delete, both prefix checks, F-run cannot be edge-bound,
  preflight abort; `pnpm db:generate` empty; contract test; API + web typecheck via `heavy`.

### F2. Receipt F-series (K)
- Owns `services/pos-receipt.service.ts`, `services/edge-device-sync.ts`.
- `allocateReceipt`: device sale on an edge outlet in the cloud -> window `active` ? F-run : `RECEIPT_DEVICE_ON_EDGE`.
  `ensureFailoverSequence` under `lockOutletSequences`, next free `F<n>` of the outlet, run kept across outages.
- Filter `series='device'` in every per-device/claim path: `findSequenceRow`, `ensureSequence`,
  `provisionReceiptSequence`, `provisionNextDeviceReceiptSequence`, `backfillDeviceReceiptSequences`,
  `claimDeviceReceiptSequencesForEdge`, `listDeviceReceiptSequences`, `applyCloudDeviceReceiptSequence`,
  `retireUnlistedDeviceReceiptSequences`, `mergeDeviceReceiptRun`, `reportBehindMerge`. `prefixesOfOutlet` keeps all series.
- Test `test/edge-failover-receipt.test.ts` (fail first): 2 terminals x 50 concurrent sales = F1-000001..50 and F2-...
  gapless, no duplicate; P-run untouched; claim never binds an F-run; retire-unlisted never retires it; edge pull lists
  no F-run; no window -> `RECEIPT_DEVICE_ON_EDGE`. Existing must pass: `pos-receipt-provisioning`, `pos-receipt-kfix`,
  `pos-receipt-seq-edge`, `pos-receipt-restore-detect`, `edge-receipt-run-applier`, `pos-day-receipt-gaps`.

### F3. Cloud window service, routes, E3 gate (K, access)
- Owns `services/edge-failover.service.ts` (new), `routes/edge-failover.routes.ts` (new), `routes/index.ts`,
  `config/env.ts`, `services/pos-edge-outlet.ts`, `services/pos-shift.service.ts`, `services/pos-order.service.ts`.
- Activate (permission, active primary, heartbeat >= 120 s stale or `override`+reason, idempotent per key,
  env flag), cancel (zero failover orders; closes empty failover shifts), start return (heartbeat < 60 s, no unpaid
  failover order, no open QRIS hold, every failover shift closed with count, else `FAILOVER_OPEN_WORK` + list),
  finish return when `sync_cursors.acked_out_seq` covers the closing event (checked on GET window and on manager retry).
  State/closing events via `enqueueEdgeEvent` (cloud_to_edge, aggregate `pos_failover_window`, deterministic ids).
  Audit `edge.failover.{activated,cancelled,return_started,closed}`; notify owner on override, managers on all.
- `pos-edge-outlet.ts`: D4 (cloud allows while `active`; edge refuses while local copy open).
- Shift open/order create in the cloud stamp `failover_window_id`; the failover shift open requires the opening count.
- Verify the cashier's cloud sign-in on a terminal (`routes/device-pin.routes.ts`) works for an edge outlet; if not, stop and report.
- Test `test/edge-failover.test.ts`: fresh heartbeat refused, override needs reason + notifies owner, idempotent,
  supervisor allowed / cashier 403, gate passes only while `active`, refused again in `returning`, cancel refused after
  one sale, return refused with open work, flag off refuses. E3 test `edge-shift-day-applier.test.ts` still passes.

### F4. Edge applier, forced shift close, edge status (K, money)
- Owns `edge/failover-applier.ts` (new), `edge/runtime.ts` (register), `services/pos-shift-failover-close.ts` (new;
  may export needed internals from `pos-shift.service.ts` only after F3 merged), `services/edge-status.service.ts` (fills the `failover` field F1 added).
- Applier: upsert window copy; on `window_closed`, per listed device force-close its open edge shift with count C1
  (existing forced-close path, approver = activating manager), refuse + conflict + alert if the shift has activity
  after `countedAt`; replay = no-op by event id; mark copy closed in the same transaction.
- Test `test/edge-failover-edge.test.ts`: edge refuses order/shift/cash/parked while open; worked example E1=1,000,000,
  C1=990,000 -> edge shift variance -10,000, failover shift S=300,000, C2=1,290,000 variance 0, new edge shift float
  1,290,000; total cash journals = edge sales + S exactly once; split-brain activity -> conflict, shift stays open;
  E3 mirror accepts the forced close; replay twice = one close.

### F5. Day recap with failover rows (K, money)
- Owns `services/pos-day.service.ts`, `edge/shift-day-applier.ts`.
- `computeRecap` with `edgeComparable` excludes `failover_window_id` orders and shifts; `writeDay` stores the cloud's
  full recap when the date has failover rows; edge `closePosDay` refuses `FAILOVER_ACTIVE` while window open (D5).
- Test `test/edge-failover-day.test.ts`: edge close of a failover date mirrored with edge + F totals (no double, nothing
  missing); cloud stale close during window, later edge close = `day_already_closed`, pre-outage edge orders = late
  adjustment; edge Tutup Hari refused while open. `edge-shift-day-applier.test.ts`, `pos-day-receipt-gaps.test.ts` pass.

### F6a. Mockup (designer, Codex) -> founder review
- `design/mockups/pos/failover/`: banner "Pindah ke mode cloud" (PIN manager/supervisor, reason), drawer count,
  mode-cloud cashier with `F1-000001` and on-screen QR receipt, return checklist, back office edge-node action, edge
  Tutup Hari note "penjualan mode cloud ada di back office". Widths 390 and 1280.

### F6b. UI (ui-engineer)
- `apps/web/src/features/ws02-edge/{api,queries,hooks,logic,types}.ts`, `components/connectivity-banner.tsx`,
  `components/failover-panel.tsx` (new), `components/edge-nodes-page.tsx`, pinned cloud target per device in the POS
  API target module built by the 1268/E10 card (do not create a second one), i18n messages, text-contract catalog.
- Done: `apps/web` tests for pin/unpin logic, text contract, screenshots 390/1280 via `heavy`.

### F7. E2E + runbook (S)
- `e2e/edge-failover.spec.ts` (via `heavy`): activate, count, 3 sales `F1-000001..3`, close failover shift, return,
  terminal unpins, edge shift closed with C1. `docs/runbook/edge-failover.md`: edge and internet both down = manual book.

## Risks left
- Edge local stock does not see failover sales until normal cloud -> edge stock flow; sold-out gating may lag (v1 accepted).
- F6b blocked if the POS edge/cloud API target card is not merged.
- QR guest orders stay refused during a window (design out of scope).
