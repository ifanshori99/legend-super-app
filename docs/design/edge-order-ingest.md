# Edge order and void ingest into cloud orders (legend-771dl)

Status: design v2 (architect review applied). Base branch `ws/edge-sync-appliers`.
Migration number: 0347 (renumbered from 0522 in merge train batch60; last file on the base was 0346).

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

### Follow-ups (legend-cqehx, legend-yu8z0)

- `customerAttachedBy` (optional, nullable user id): the staff user who attached the
  customer. With a customer the producer always sends it: the user id, or `null` when
  nobody attached (the customer attached themselves); without a customer it is left
  out. Ingest reads three cases: id = staff attached; `null` = nobody; missing key =
  older producer, attacher unknown. All are stored in `orders.customer_attached_by`
  (only together with a known customer; missing and `null` both store NULL), so the
  LOY-02 guard (`loyalty-earn-consumer`) sees cashier and attacher. Staff who attached
  themselves book no points (`blocked_self_serve`); the sale and its journal are
  unaffected. A malformed id fails the strict schema: the event stays parked and
  nothing is ingested, never "null with points". Open decision: a missing key with a
  customer still earns unless the cashier is the member; blocking points whenever the
  attacher is unknown needs a marker the earn guard can read.
- tender `provider` (optional string, max 20): the `pos_order_tenders.provider` of the
  tender. Ingest maps cash/points to `manual` and `edc_card`/`edc_qris` to `edc`
  (a stated provider must agree, else `tender_unsupported`). A gateway method (`card`,
  `va`, `ewallet`, `qris`) is ingested only when `provider` is a gateway adapter code
  (`PAYMENT_GATEWAY_PROVIDERS`: `doit`, `duitku`; the DB check allows these plus `edc`
  and `manual`, which are not gateways). No provider, an unknown, empty, wrong-case or
  non-gateway one: refused `tender_unsupported` (recorded, parked, no money row, no
  journal). The producer fills `provider` on every captured tender.
- Legacy refusal stays: events without `lines`/`subtotalIdr` (or a gateway tender
  without `provider`) are refused and recorded, never guessed. No backfill: parked
  events are not redelivered, and a provider cannot be derived from the method alone.
- `order_exists` / QR design note: a QR order is already a cloud `orders` row when the
  edge pays it, so the ingest must not insert a second order. Today it refuses and
  records `order_exists`, so the payment is not applied in cloud. A real fix needs a
  business decision (open): an "adopt" path that attaches the edge tenders, lines and
  journal to the existing order, only when the existing row is `awaiting_payment`,
  its totals equal the payload, and it has no tender yet (idempotent on
  `edge_order_ingests`). Until then refusing is the safe rule: no double order, no
  double revenue.

## Table `edge_order_ingests` (migration 0347)

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

## Receipt-run wiring (legend-zy43)

Done. The edge reports its numbered receipts as `receipt_run.reported`; the cloud
merges them with `mergeDeviceReceiptRun` (`edge/receipt-run-applier.ts`, wired in
`registerEdgeLink`). `receipt_run` is no longer in `posDeferredAggregates()`, so the
event has one handler and the cloud boots without a duplicate handler.

Producer: `services/edge-receipt-run-reporter.ts`, a periodic reporter in the edge
runtime (primary only, every 60 s and once after boot). It is not an event in the
sale transaction: the sale allocates the receipt before it appends `order.paid`, so
such an event would overtake the order in the outbox and the merge (which needs the
order ingested first) would refuse it for good.

- Scope: only runs bound to this edge node and database instance; never the
  cloud-owned run (device id = outlet id); never an empty run.
- Bounded events: receipts go out in ascending chunks of 100 (about 55 KB per
  event; the link frame cap is 4 MB). A chunk starts right after the high-water of
  what this edge already reported FOR THAT PREFIX (largest `sequence.lastNumber` of
  its earlier chunk events with the same prefix) and carries its own last ordinal as
  `sequence.lastNumber`, so the cloud merge sees 1..lastNumber as the cloud's earlier
  chunks plus this one and advances without a gap refusal. At most 5 chunks per run
  per pass, so an offline backlog drains over several ticks, never as one burst.
  A retired run and a new run of the same device (new prefix) each have their own
  high-water and keys.
- Order of delivery: the outbox order is not the link order (the relay assigns
  `link_seq` per aggregate on delivery), and the cloud refuses for good a chunk
  whose order it has not ingested or a void it has no void row for. So a receipt is
  reported only after the cloud acknowledged the event it depends on: `order.paid`
  of its order, and `order.voided` when the receipt is voided. Acknowledged means
  the outbox row is `delivered` (relayed into `edge_outbound_queue`) and its queue
  row is `acked`; a queue row pruned after the ack counts as acknowledged. A chunk
  ends before the first receipt not acknowledged yet, and the high-water moves only
  with a chunk actually appended. An order with no `order.paid` event at all is
  never reported (fail closed).
- Exactly once: chunk key `<device>:<prefix>:c:<last ordinal>`; the high-water moves
  in the same transaction as the append (the sequence row is locked). A receipt
  voided after it was reported goes out as its own one-receipt event, key
  `<device>:<prefix>:v:<ordinal>`, once `order.voided` is acknowledged (at most 20
  per pass; found with one anti-join query, not by loading every voided receipt).
  The cloud merge inserts nothing for a receipt it already holds, so a redelivery,
  an overlap or a void already inside a chunk is safe. Aggregate sequence = max + 1
  (like `appendPosEvent`). The outbox grows by one event per 100 receipts and one
  per void; it is never rewritten.
- One failing run does not stop the other runs of the pass; its error is reported
  through the runtime log and the run is retried on the next tick.
- Link batches are also capped by bytes (`LINK_BATCH_MAX_BYTES`, 3 MiB of encoded
  events, at least one event per batch), so a backlog of large events cannot make
  a frame the peer refuses. One single event above that bound is never sent and
  never skipped: the link stays up, reports `Outbound event exceeds the link frame
limit` through `onError`, and the queue behind it waits for an operator. No
  producer should create such an event (the receipt reporter cannot).

Known limitations (open decision for the CTO):

1. No timed re-report. If the cloud still refuses a chunk (a sequence gap, an order
   it refused for good), the refusal is recorded as an `applier_refused` conflict and
   that chunk is NOT resent by itself. The order-not-ingested-yet case is avoided by
   the acknowledgement gate above.
2. A permanently refused order (`order_exists`, `legacy_payload`, an unsupported
   tender) is never ingested, so the merge keeps refusing any chunk that contains
   its receipt, and every later chunk of that device then hits the same hole
   (`RECEIPT_SEQUENCE_GAP`). A new sale does NOT repair this: the reporter never
   resends a chunk it already appended. The device's receipts stay unmerged after
   that point and `receiptGapsForOutlet` keeps reporting the hole. Fixing it needs
   a decision (for example a cloud-side receipt for a refused order, a manual
   reconcile action, or write-off of the number); it is not implemented here.

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
