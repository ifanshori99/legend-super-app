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
  double revenue. Design: section "Adopt order QR (legend-dy7pc)" below.

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

## Adopt order QR (legend-dy7pc)

Status: design, not implemented. Migrations 0540-0541 (0538/0539 are taken by
other threads). Money rule: never two sales, never two payments kept, nothing
paid out automatically.

### Findings that shape the design

1. **No producer exists today.** The edge copy of a QR order comes from
   `edge/qr-order-applier.ts` (`orders` + `order_items` only, no `pos_orders`).
   `completePosOrder` runs through `readPosOrder`
   (`services/pos-order-support.ts`), which inner-joins `pos_orders`, so the edge
   cashier cannot settle a QR order and no `order.paid` with channel `qr` is
   ever produced. In `applyPaid` the `channel_unsupported` check also runs before
   `order_exists`, so a QR payload never reaches `order_exists`; today that
   refusal only fires for a non-QR id collision.
2. **The edge never learns the cloud status after `qr_order.placed`.** A QR
   order paid by QRIS in the cloud (fired, `sent`) or voided by
   `sweepUnpaidQrOrders` (15 min without an open code) still looks
   `awaiting_payment` on the edge. A double payment (QRIS + edge cash) is a
   likely case, not a rare one.
3. **A cash tender cannot be booked on an order without `pos_orders`.** The sale
   journal treats an order without `pos_orders` as a QR gateway sale
   (`qrSaleGatewayOf`, `accounting-auto-journal-amounts.ts`) and requires
   `paidCashIdr = paidEdcIdr = paidPointsIdr = 0`. `pos_order_tenders` has an FK
   to `pos_orders`, and `pos_orders_channel_check` rejects `qr`. So adopt
   needs a `pos_orders` row with channel `qr` (migration 0540).
4. **POS-04 triggers** (`pos-order.custom.sql`): once `orders.status` is
   `completed`, the order, its items and its POS rows are frozen. Every child
   write therefore happens before the status flip, and the flip is the last write.
5. Sale journal key is `aj:sale:<orderId>` and the loyalty earn is unique per
   order, so a second sale journal or a second earn for the same order cannot
   be posted even under a race. The rules below still refuse the double case,
   because the money of the second payment must not be hidden.

Delivery split: the cloud adopt (this section) can ship first and is tested
with synthetic events. It stays dormant until the edge producer exists (see
"Edge producer", separate bead).

### Adopt rules (cloud, in `applyPaid`)

Flow: lock R4 → ledger replay guard → claim ledger row → checks → writes. All
of it runs in the existing ingest savepoint. Every refusal is recorded (R1).

- Branching: after `legacy_payload`, read `orders` for `payload.orderId`
  `FOR UPDATE`. If the row exists and both `payload.channel` and the row channel
  are `qr`, take the adopt path. If the row exists and either channel is not
  `qr`: `order_exists` (unchanged). If no row exists and the channel is `qr`:
  `channel_unsupported` (unchanged; the edge never creates a QR order).
- A1 Status: the row must be `channel='qr'`, `payment_mode='pay_first'`,
  `status='awaiting_payment'`. Otherwise refuse `adopt_status:<status>`
  (`sent` = already paid in the cloud, `voided` = swept, any other value), or
  `adopt_mode_unsupported` for `open_bill`.
- A2 Identity: same `outlet_id` and `business_date`, else `adopt_mismatch`.
- A3 Money equal exactly, no rounding: `subtotal`, `discount`,
  `service_charge`, `tax_idr = pbjtIdr`, `rounding`, `total`,
  `prices_include_tax`, and `paidDepositIdr = deposit_applied_idr`. Else
  `adopt_amount_mismatch`.
- A4 Lines: the live payload lines (`status <> 'voided'`) equal the live cloud
  `order_items` as a multiset of (`menuItemId`, `quantity`, `unitPriceIdr`,
  `modifiersTotalIdr`, `lineTotalIdr`). Else `adopt_lines_mismatch`. The
  existing line checks and the money invariant (`tenders + deposit = total`)
  stay. Payload lines are compared only; they are never inserted.
- A5 No money on the cloud bill: `orders.payment_intent_id IS NULL`; when
  `payment_link_id` is set, `payment_links.paid_idr = 0`, no intent of the link
  in `paid`/`partially_refunded`/`refunded`, no `payment_evidence` or
  `payment_unallocated_funds` row of its intents. Else `adopt_gateway_money`. No
  `bill_splits` row for the order (any status), else `adopt_split_bill`.
- A6 No `tax_snapshots` row for source `order`/this order (an unfired pay-first
  order has none), else `adopt_tax_exists`.
- A7 Tenders: same `providerOf` / points / cash-received rules as create. A
  gateway tender on an adopted QR order is refused `tender_unsupported` (the
  edge cannot see the cloud payment link; only cash and EDC).
- Customer: keep the cloud `customer_profile_id` when set and ignore the
  payload customer. When it is null, apply the create rules (customer known to
  the tenant, `customerAttachedBy`). Points are never a reason to refuse.

**Idempotency key:** `edge_order_ingests` PK `(tenant_id, order_id)`, the same
row and replay rules as create. The new column `kind='adopt'` is recorded on
both `ingested` and `refused` rows. Replay of the same event is a no-op.
Another event for the same order is final. A transient refusal is retried as
today. Cloud consumers and the sweep never write this table.

**Lock order:** R4 advisory lock → `orders` row `FOR UPDATE` → `payment_links`
`FOR UPDATE` → `payment_intents` (inside `cancelPaymentLinkInTx`). This matches
the repo order orders → links → intents (`facility-breakfast-money.ts`,
`payment.service.ts`). The QR consumer locks `orders` first and never takes the
advisory lock, so no cycle exists.

**Writes, in this order:**

1. Link exists: `cancelPaymentLinkInTx(link, reason 'edge_paid')`. The link
   expires and every pending code becomes `expired` with `payment.expired`.
   `handleQrOrderPaymentClosed` then answers `unchanged`. There is no gateway
   cancel, so a code already shown can still be paid; the consumer guard below
   handles that payment.
2. `pos_orders` (channel `qr`, `shift_id`/`device_id`/`cashier_id`/
   `is_training` from the payload, `completed_at = paidAt`).
   `pos_orders_same_outlet_trg` passes (same outlet and channel).
3. `pos_order_items` for each live existing `order_items` row
   (`held_by_cashier=false`). Set `order_items.fire_status='fired'` on the live
   items (the kitchen worked on the edge). Do NOT call `routeFiredItemsToKitchen`.
4. `pos_order_tenders` exactly as create (`status captured`, `shift_id NULL`).
5. `orders` update `WHERE status='awaiting_payment'`: `status='completed'`,
   `fired_at=paidAt`, customer fields, `updated_at`. If zero rows change, refuse
   `adopt_status:changed`.
6. PBJT snapshots from the payload `taxes`, then `deliverSaleEffects` (journal
   `aj:sale:<orderId>` takes the POS tender path, then the loyalty earn), as
   create.

Why `completed`, not `sent` like a cloud QR sale: the order now has
`pos_orders` + tenders. With `completed`, the journal books cash/EDC, `saleAt` is
`pos_orders.completed_at`, the void ingest (`applyVoided` requires
`completed`) and the receipt-run merge accept it, and `assertNotEdgeIngested`
blocks cloud void/refund (state `ingested`). Known effect: adopted QR orders
count in `paidOrdersWhere` (status `completed`); cloud QR sales (`sent`) do not.

**R3 for adopt (not done):** no `fireQrOrder`, no cloud KDS routing, no
`appendQrOrderPaid` / outbox `order.paid`, no QR `order.placed` event, no guest
claim token (`issueWholeBillClaimTx`), no receipt number or `pos_receipts` row,
no stock deduction, no change to daily-limit reservations or promotion use
(the order is sold, so they stay consumed). Journal, PBJT and points run as in
create (legend-uctlr).

### Webhook after adopt (consumer guard)

Today `handleQrOrderPaymentPaid` sends a `completed` order to the
`status !== 'awaiting_payment'` branch. That branch refunds only `double_payment`
unallocated funds. A code paid after adopt lands on a link with `paid_idr = 0`,
so WS-05 books it as allocated money and nothing is refunded: the guest pays
twice in silence. New branch in `services/qr-order-consumers.ts`, before that
one:

- Condition: the order has an `edge_order_ingests` row with `kind='adopt'` and
  state `ingested` or `voided`, and the event intent is in
  `HOLDS_REFUNDABLE_MONEY`.
- Action: `requestQrLatePaymentRefund` for that intent, then
  `requestQrDoublePaymentRefund`. Both file a refund **request** only, once per
  intent; approval stays with a person (WS-05). Log ids only. Return the new
  outcome `late_payment_on_edge_paid_order`. Never fire, never touch the order.
- The refund reason text is new UI text: "Refund pembayaran online: pesanan
  sudah dibayar di kasir". Pass it as a parameter and register it in the text
  catalog.
- Refund approval is not blocked by a sale: the adopted order has `pos_orders`,
  so it is outside `qrSaleScope`, and no intent is pinned.
- `handleQrOrderPaymentClosed` and `sweepUnpaidQrOrders` need no change: they
  act only on `awaiting_payment`.

Races (one sale either way, never two):

- Adopt commits first: the consumer finds a `completed` adopted order and takes
  the refund branch.
- The consumer fires first: adopt sees `sent` and refuses `adopt_status:sent`.
- The payment is confirmed but not consumed yet: A5 refuses
  `adopt_gateway_money`, and the consumer fires the order later.

### Double payment (QRIS paid in cloud + money taken on edge)

Safe choice: refuse the adopt, record the conflict, and move no money
automatically. The cloud keeps the QRIS sale. The edge cash/EDC is outside the
cloud books (drawer surplus on the edge). The record is the ledger row
(`refused`, `kind='adopt'`, reason `adopt_status:sent` or `adopt_gateway_money`)
plus the parked event. An order voided by the sweep and then paid on the edge is
refused `adopt_status:voided` the same way: a revenue gap in the cloud, no payout
risk. Nothing reverses or refunds by itself.

### Edge producer (dependency, separate bead)

- Edge settle of a QR pay-first order: create the edge `pos_orders` row
  (channel `qr`) for the forwarded order, then the normal tender/complete.
  `order.paid` carries channel `qr`, `lines`, `paidDepositIdr`. Only cash and EDC
  tenders.
- Forward cloud QR status changes (fired, voided) cloud → edge, so a connected
  edge refuses to settle an order already paid or voided in the cloud. Offline,
  the risk remains and the conflict path above applies.
- Migration 0540 also applies to the edge database (same schema).

### Migrations

- 0540: `pos_orders_channel_check` adds `qr` (drop, add `NOT VALID`, then
  `VALIDATE CONSTRAINT`), plus `db/schema/pos-order.ts`. `createPosOrder` still
  refuses channel `qr` in the service (`pos-order.service.ts` ~l.572).
- 0541: `edge_order_ingests.kind varchar(10) NOT NULL DEFAULT 'create'` with
  check `kind IN ('create','adopt')`, plus `db/schema/edge-order-ingest.ts`.
- Implementer: grep every `posOrders` join that reads "has pos_orders = POS
  channel" (`readPosOrder`, `saleAtOf`, `qrSaleScope`, POS lists, pos-day). An
  adopted QR order must not appear as an open POS order. It is `completed`, so
  the POS mutations stop at `assertMutable` and at the correction guard.

### Tests (fail first)

`test/edge-order-ingest.test.ts`:

- adopt happy path: one `orders` row (no second), status `completed`, `pos_orders`
  channel `qr`, tenders, journal once, no KDS ticket, no outbox `order.paid`;
- link cancelled and pending intents `expired`;
- replay (same and separate batches) is a no-op;
- each refusal A1-A7 leaves the cloud order unchanged and records
  `kind='adopt'`;
- void after adopt: exactly one `pos_order_voids`, plus the journal reversal;
- other tenant and outlet untouched.

QR consumer test: a `payment.paid` after adopt files exactly one refund request
and changes nothing on the order. Races: fired-then-adopt is refused; and
paid-not-consumed is refused `adopt_gateway_money`, then the consumer fires.
Money test: for each scenario, the sum of booked sales = one total, never two.

### Open business decisions (safe default in brackets)

- O1 Build the edge settle of QR orders at all? Without it, adopt stays
  dormant. [cloud part ships; producer waits for founder]
- O2 Double payment: which money goes back, QRIS refund or cash back at the
  outlet? [nothing automatic; adopt refused; finance decides by hand]
- O3 A finance list of adopt conflicts (UI). [ledger rows only, follow-up]
- O4 Swept (voided) order paid on the edge: revive or manual entry? [refuse]
- O5 Guest points: no claim token on adopt; points only for a cloud member or a
  customer attached at the edge. Adopted orders without a customer also stay in
  the loyalty "has_history" check (`loyalty-program.service.ts` ~l.333).
  [accept]
- O6 A QRIS payment after adopt: refund request filed by the system.
  [request only; a person approves]
- O7 `open_bill` QR orders paid at the edge cashier. [refused
  `adopt_mode_unsupported`]
- O8 Adopted QR orders count in the `completed` sales metrics, cloud QR sales
  (`sent`) do not. [accept, same as other edge sales]
