# Edge order and void ingest into cloud orders (legend-771dl)

Status: design v2 (architect review applied). Base branch `ws/edge-sync-appliers`.
Migration range reserved: 0522-0525 (last file on the base branch is 0510).

## Problem

An order paid on an offline edge cashier never becomes a cloud `orders` row. Edge
parks `order.paid` / `order.voided` in `edge_deferred_events`
(`edge/deferred-event-applier.ts`) and only computes `cost_snapshot_idr`
(`edge/order-edge-applier.ts`). Cloud sales metrics (`metric-sources/sales.ts`:
`orders.status='completed'`, `business_date`, `order_items`, `pos_order_tenders`,
not `is_training`) miss every offline sale, and `mergeDeviceReceiptRun` refuses
receipts of orders without a completed cloud row.

## Hard rules (from the architect review)

R1. **Parking is never undone by ingest.** A refusal thrown by the parked hook rolls
back the parking of that event (`db-link-store.ts:141`). The parked
`order.voided` is the guard that stops cash being paid twice
(`payment-refund-edge-history.ts`). So after parking, ingest NEVER throws: it runs
in its own savepoint, catches every error (CoreError and SQL 23xxx), and records
`state='refused'` plus a reason code in `edge_order_ingests`, and logs a warning
(no payload, no ids beyond event id). A non-CoreError escaping the hook would roll
the batch back and stall the whole link, so this is also the stall guard.
R2. **Every amount comes from the payload.** The cloud computes nothing: no tax, no
rounding, no price lookup.
R3. **No side effects of a cloud sale:** no `appendOutbox`, no recipe deduction, no
journal, no loyalty, no receipt number, no `pos_receipts` row (trigger
`pos_receipts_match_sequence_trg`).
R4. **One lock key** for order paid, void and cost recompute: the existing
`stock-source:<tenant>:order:<dbId>` advisory lock (`order-edge-applier.ts`), with
the id normalised by `sourceIdToDb`.

## Contract change (additive, `order.paid.v1`, all new keys optional)

Producer = `completePosOrder` (`pos-order.service.ts`, `items` already loaded). New
optional keys on `order.paid`: `orderNumber`, `subtotalIdr`, `pricesIncludeTax`,
`paymentMode`, `isTraining`, `lines[]` (`menuItemId`, `name`, `quantity`,
`unitPriceIdr`, `modifiersTotalIdr`, `lineTotalIdr`, `fireStatus`,
`reservedBusinessDate`, `status` as in `order_items`), and per tender optional
`receivedIdr` (cash) and `pointsUsed` (points). `order.voided` gains optional
`requestedBy`. The existing refinements (`total = gross - discount + service + pbjt +
rounding`, buckets) stay. New refinement: when `lines` is present, non-void
`sum(lineTotalIdr) == subtotalIdr` (NOT gross: with tax-inclusive prices gross =
subtotal - service - tax). Cloud schema is strict, so cloud deploys first; the edge
producer fills the keys only when the cloud accepted them (version check at link
hello, M6; if that gate is not available the producer change ships behind the same
deploy order and this is reported).

## Table `edge_order_ingests` (migration 0522)

PK `(tenant_id, order_id uuid)`. Columns: `outlet_id`, `paid_event_id`, `state`
(`ingested` | `cancelled` | `voided` | `refused`), `reason` (text code, nullable),
`void_event_id`, `created_at`, `updated_at`. RLS and tenant scoping like the other
edge tables. Replay: row exists with `paid_event_id` equal -> no-op.

## `order.paid` ingest (hook composed into `costAfterOrderPaidParked`)

1. `aggregateId` normalised must equal `payload.orderId` normalised, else record
   `refused: aggregate_mismatch` (and stop).
2. Advisory lock (R4); `INSERT edge_order_ingests ... ON CONFLICT DO NOTHING`; no row
   inserted -> replay, return.
3. Refuse (recorded, R1) with reasons: `legacy_payload` (no `lines`/`subtotalIdr`:
   events parked before the contract change are not guessed; none exist before
   go-live), `order_exists` (a cloud `orders` row with that id exists, e.g. the QR
   order applier created it: follow-up), `lines_mismatch`, `training` is NOT a refusal
   (stored with `is_training`), `channel_unsupported` (`pos_orders` check rejects
   `qr`), any caught SQL error `db_error:<sqlstate>`.
4. Writes (savepoint): `orders` (status `completed`, all money columns from the
   payload, `payment_mode`, `prices_include_tax`, `deposit_applied`, `number` =
   `orderNumber`, `business_date`, `placed_at=paidAt`), `pos_orders` (shift_id kept
   as plain value: no FK; `device_id`, `cashier_id`, `completed_at`, `is_training`),
   `order_items` + `pos_order_items` from `lines`, `pos_order_tenders` one per tender
   (status `captured`, `resolved_at=paidAt`, `received_idr`/`points_used` as the
   table requires, **`shift_id` always NULL** because of FK
   `pos_order_tenders_shift_fk` and so edge cash never enters a cloud drawer).
5. Money invariant checked before write: `sum(tenders) + paidDeposit == total`.

## `order.voided` ingest (new parked hook)

- Same aggregate check, lock, and savepoint/refusal rules (R1).
- `voidedFinalOrder=false`: order never paid. Record `cancelled`; create nothing.
- `voidedFinalOrder=true`: only when the order is `ingested`, no void or refund exists,
  `amountIdr == orders.total_idr > 0`, and `requestedBy` (or, for older events, a
  cashier id different from the approver) and `approvedBy` exist. Then insert exactly
  one `pos_order_voids` (`id = voidId`, `receipt_number`, `requested_by`,
  `approved_by`, override/approval ids, `voided_at`) and set state `voided`. Do NOT
  update `pos_orders.void_*` (trigger blocks it) and do NOT change `orders.status`
  (cloud-native void does not either; sales metric uses its own void metric). Anything
  else: `refused` with a reason (`order_not_ingested`, `void_amount_mismatch`,
  `void_actor_missing`, `already_voided`). Void arriving before paid is a
  `sequence_gap` conflict in the link (`edge/conflict.ts`), so no pending-void path.
  Note: edge itself cannot create final voids any more (EDGE_MODE guard in
  `pos-order-corrections.ts`), so `voidedFinalOrder=true` only occurs for old events.

## Receipt-run wiring (legend-zy43): not done here

No edge producer of `receipt_run.reported` exists on the base branch, so wiring
cannot be proven. Reported as blocked on the producer; `receipt_run` stays in
`posDeferredAggregates`. Ingest writes `pos_orders.device_id` and no receipt so the
future merge works.

## Out of scope (reported as follow-ups or business decisions)

- B1 GL journal for edge sales: `net_sales`, `avg_ticket`, target attainment read the
  GL, so they exclude edge sales until a journal path exists; ingest fixes gross sales
  and transaction counts only.
- B2 PBJT tax snapshot / tax reporting for edge sales (legal).
- B4 points tender: loyalty balance is not debited in cloud for edge points payments.
- B5 old voids without actor ids stay refused until manually reconciled.
- `order.refunded` stays parked only; QR orders paid on edge (`order_exists`);
  backfill of already parked events (parked events are not redelivered); PBJT
  snapshot; training flag on legacy events.

## Test plan (`apps/api/src/test/edge-order-ingest.test.ts`, fail first)

- Paid order with lines: one `orders` row, same total, items, tenders; ULID and UUID id
  forms are the same order.
- Replay of the same event (same and separate batches): no extra rows.
- Sum of cloud completed sales over a mixed set equals the edge totals (no money
  computed by cloud).
- Refusals (legacy payload, aggregate mismatch, lines mismatch, order exists) leave the
  parked row in place, create no cloud order, and do not throw; an induced SQL error
  does not stall the batch.
- Void: exactly one `pos_order_voids`, replay no-op, amount mismatch / double void /
  missing actor refused, non-final void creates nothing, void of unknown order refused.
- Other tenant or outlet untouched.
- No outbox row, stock movement, journal, receipt or cloud shift is written.
- Tender `shift_id` is NULL even when a cloud shift with that id exists.
