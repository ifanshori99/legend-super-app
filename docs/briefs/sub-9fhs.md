# Sub-brief: legend-9fhs edge `order.*` events stall the edge→cloud link (tier K, offline sync)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/fix-9fhs`, branch `ws/fix-9fhs` (from m1). Do not commit.

## Bug (confirmed by reading)

- Edge transport queues every `cloud-sync` outbox row edge_to_cloud (`apps/api/src/worker/transport.ts:71-84`), including POS `order.*` (aggregate type `order`, `appendPosEvent` in `services/pos-order-support.ts:529`).
- Cloud `applyInbound` (`apps/api/src/edge/db-link-store.ts:247-365`): aggregate `order` has no classifier → `EdgeEventUnclassifiedError` (~:253) outside any savepoint → whole batch rolls back, cursor never advances, retried forever → link-wide stall (also blocks `stock.moved`, so no HPP from edge outlets).
- Registry: `apps/api/src/edge/applier-registry.ts` (`registerEdgeEventHandler(direction, eventType, handler)` :95, `registerEdgeAggregateKind(aggregateType, kind)` :111). Templates: `edge/stock-moved-applier.ts`, `edge/qr-order-applier.ts`; registration calls in `edge/runtime.ts` (~:327, ~:469).

## Fix

- New durable inbox table `edge_deferred_events` (new file `apps/api/src/db/schema/edge-deferred-event.ts`, export from `db/schema/index.ts`): `tenant_id` (NOT NULL, tenant FK), `outlet_id` NOT NULL, `edge_node_id`, `event_id` (text), `aggregate_type`, `aggregate_id`, `aggregate_sequence`, `event_name`, `envelope` jsonb (full event), `received_at` default now. PK/unique (tenant_id, event_id). Index (tenant_id, aggregate_type, received_at). RLS tenant + outlet (custom SQL like `db/schema/*.custom.sql`; engineer generates migrations — do NOT create drizzle files).
- New applier `apps/api/src/edge/deferred-event-applier.ts`: `registerDeferredEdgeAggregate(aggregateType, eventNames)` registers kind `transaction_event` and an edge_to_cloud handler per event name that: checks direction is edge_to_cloud, event tenant = context tenant, event outlet in node scope and = the node's outlet (same checks as stock-moved-applier; refusal = CoreError 4xx so the link records an `applier_refused` conflict instead of stalling); inserts the envelope into `edge_deferred_events` ON CONFLICT DO NOTHING (replay = no-op). It must NOT append to the cloud outbox and must NOT call any domain service (no order mirror, no recipe deduction, no GL) — see legend-078n: a future POS-order applier will backfill from this table.
- Register aggregate `order` with every catalog event name starting with `order.` (read from `packages/shared/src/events/catalog.ts`, do not hand-list). Wire the call in `edge/runtime.ts` next to the stock applier, cloud side only (same place/condition as `stock.moved`).
- Do not touch EDC/DOIT files, `pos-order.service.ts`, `payment-refund.service.ts`.

## Tests (test-writer, new file `apps/api/src/test/edge-order-deferred.test.ts`)

Reuse fixtures from `src/test/edge-stock-moved-applier.test.ts` (real DB, `createDbLinkStore`) and `src/test/edge-link.test.ts`.

- (a) Repro: an edge→cloud batch with an `order.paid` event followed by a `stock.moved` event → before the fix the batch throws/stalls; after: both applied, cursor advanced, `stock.moved` ledger row present on cloud.
- (b) `order.paid` envelope stored once in `edge_deferred_events`; resend of the same batch/event → still one row, nothing else changes.
- (c) No cloud outbox row and no stock ledger row is created by the order event (no double deduction).
- (d) Event of another outlet/tenant → refused as conflict (`applier_refused`), link not stalled, later events apply.
- (e) Cross-tenant RLS isolation for `edge_deferred_events`.
- Run `LEGEND_TEST_FILES="src/test/edge-order-deferred.test.ts src/test/edge-stock-moved-applier.test.ts src/test/edge-link.test.ts" pnpm test` from worktree root after the engineer has generated the migration.

## Round 2 (review K): generic edge→cloud fallback (architect option B)

Reviewer + architect: the edge sends many non-WS-04 aggregates on `cloud-sync` (`table_session.*` table-session.service.ts:812,954; `pos_override.recorded` staff-override.service.ts:215; `staff_pin.*` device-pin.service.ts:251,353; `payment.refund_requested` pos-order-late-payment.ts:125; ...). Any one still stalls the link. A list always lags; filtering in transport loses events.

Implementer:

1. `apps/api/src/edge/applier-registry.ts`: add a per-direction default aggregate kind (`setEdgeDefaultAggregateKind(direction?, kind)` or equivalent) used by `registeredEdgeEventClassifier` only when no explicit kind exists AND the event arrives edge_to_cloud. If the classifier cannot see the direction, check how `classifyEdgeEvent` is called in `db-link-store.ts` (~~:252) and pass the direction minimally. Add a per-direction "unhandled" handler in the dispatcher (~~:59-64): explicit handler first, then unhandled handler, then the old `fallback`. Clear both in the test reset helper (~:126-132). cloud_to_edge behaviour must be unchanged.
2. `apps/api/src/edge/deferred-event-applier.ts`: `applyEdgeDeferredEvent` takes a `parkedReason` ("deferred" for explicit WS-04, "unclassified" for the fallback). Add `registerEdgeDeferredFallback()`, which installs the fallback kind `transaction_event` + an unhandled handler for edge_to_cloud that parks with `parked_reason='unclassified'` and logs `logger.warn` (event name, aggregate type, tenant, no payload). Keep the explicit WS-04 registration. Same tenant/outlet checks. An event without an outletId → CoreError refusal (conflict, not a stall).
3. `apps/api/src/db/schema/edge-deferred-event.ts`: add `parked_reason varchar(20) NOT NULL` + a CHECK IN ('deferred','unclassified'). Do NOT touch drizzle files; the engineer regenerates 0103.
4. `apps/api/src/edge/runtime.ts` registerEdgeLink: call `registerEdgeDeferredFallback()` after the explicit registrations.

Test-writer (`apps/api/src/test/edge-order-deferred.test.ts`): `table_session.opened` and `pos_override.recorded` through the link, each followed by `stock.moved` → both parked with `parked_reason='unclassified'`, cursor advanced, stock.moved applied; WS-04 rows have `parked_reason='deferred'`; an explicit handler (stock.moved) still wins over the fallback; the cloud_to_edge classifier for an unknown aggregate still returns null (unchanged).
