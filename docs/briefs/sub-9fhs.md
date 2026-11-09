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
