# Edge -> cloud failover for POS terminals

Status: design, tier K (legal document numbers, offline sync). Owner: architect.
Date: 2026-11-09. Founder decision 2026-11-09: when an outlet's edge (mini PC)
is down, terminals enrolled at that outlet MAY sell through the cloud. Document
numbers must never collide. Data made during the outage must sync back to the
edge when it returns.

Read against: `integ/m1-batch3` (receipt provisioning, `RECEIPT_DEVICE_ON_EDGE`,
`mergeDeviceReceiptRun`, legend-3yqy). `milestone/m1` does not have these yet.
Related: legend-k0i8 (edge -> cloud POS order sync, not built), PRD v1.7 §3 F5
"Pembagian Sumber Kebenaran", R10, EDG-04.

## 1. Decision summary

1. **Failover is a manager action, gated by heartbeat.** The cloud opens an
   `outlet_failover_windows` row only when a user with the new permission
   `pos.failover.manage` asks for it. The cloud accepts the request when the
   outlet's active primary edge has no heartbeat for >= 120 s
   (`edge_nodes.last_heartbeat_at`). A fresh heartbeat refuses the request
   (`FAILOVER_EDGE_HEALTHY`) unless the manager sets `override` with a reason
   (example: LAN switch dead, edge alive). An override notifies the owner.
   Not automatic: a terminal that cannot reach the edge cannot tell "edge dead"
   from "my Wi-Fi is bad". An automatic switch would split one drawer and one
   shift across two servers without a cash count.
2. **The cloud numbers failover sales in its own series per device: `F<n>`.**
   `receipt_sequences` gets a `series` column: `device` (P-prefix, numbered by
   the edge), `cloud` (prefix `C`, existing), `failover` (prefix `F<n>`,
   numbered only by the cloud). The F-series of a device lives forever and
   continues across outages, so it stays gapless. The edge never allocates on
   it. Each series has exactly one allocator. So numbers cannot collide, even
   when a manager opens a window while the edge is in fact still selling
   (split brain).
3. **Cash is bridged, not merged.** At switchover each cashier counts the
   drawer and opens a _failover shift_ in the cloud with that count as float.
   At return the cashier closes the failover shift with a blind count. Sync-back
   writes two system cash movements into the edge shift that was open at the
   outage: `failover_out` (start count) and `failover_in` (end count). The edge
   shift's expected cash and variance stay correct (worked example in §4.3).
4. **Sync-back is one ordered, idempotent batch per window, sent at return.**
   When the manager starts "return to edge", the cloud freezes the window and
   enqueues `cloud_to_edge` `transaction_event`s on the existing link
   (`edge_outbound_queue`), aggregate `pos_failover_window` / window id,
   sequence 1..N, deterministic event ids. The last event closes the window.
   The edge applies in order through the existing conflict rules
   (`edge/conflict.ts`): duplicate = skip, gap or collision = recorded in
   `edge_sync_conflicts`, never overwritten.
5. **The edge refuses device sales while a window is open.** Window state is
   master data (cloud wins) and travels cloud -> edge as a full-state event.
   A returning edge refuses device sales (`FAILOVER_ACTIVE`) and Tutup Hari
   (`FAILOVER_SYNC_PENDING`) until it has applied the closing event. The
   terminal also pins its API target to the cloud until the window closes.
6. **No echo.** Rows created in a window carry `failover_window_id`. The
   edge -> cloud order sync (legend-k0i8) must skip them.

Out of scope v1: QR guest orders during a window (cloud keeps answering
`EDGE_LINK_DOWN`; the waiter takes the order on a cloud terminal), terminal
selling with neither edge nor cloud, standby promotion itself (EDG-04).

## 2. States

```
            activate (manager, heartbeat stale or override)
  (none) ----------------------------------------------> active
                                                          |  \
                     cancel (zero failover sales)         |   \ start return (edge heartbeat
  cancelled <---------------------------------------------+    \ fresh, no open failover order
                                                                \ or shift)
                                                                 v
                                                             returning
                                                                 | edge acks closing event
                                                                 v
                                                               closed
```

- One non-terminal window (`active` or `returning`) per outlet: partial unique
  index. Transitions only move forward (trigger). No delete.
- `active`: cloud accepts device sales of the outlet on the F-series.
- `returning`: cloud refuses new device sales again (`RECEIPT_DEVICE_ON_EDGE`).
  The edge still refuses them until it applied the closing event.
- `closed`: normal edge mode.

## 3. Flows

### 3.1 Switchover (edge down)

1. Terminal: `/api/edge/status` probe fails >= 60 s. Banner offers "Pindah ke
   mode cloud" to a manager (PIN). The back office shows the same action from
   the edge-node list.
2. Cloud `POST /api/edge-failover/windows` `{ outletId, reason, override?,
idempotencyKey }`. Checks: permission, outlet has an active edge, no open
   window, heartbeat stale >= 120 s or `override` with reason.
3. Same transaction: insert window (`active`), provision an F-series for every
   active receipt-taking device of the outlet (`RECEIPT_DEVICE_TYPES`), enqueue
   the window-state master event for the edge, write audit
   `edge.failover.activated`, notify owner and outlet managers.
4. Terminal pins API target to the cloud (stored per device, survives reload).
   Each cashier counts the drawer and opens a failover shift in the cloud
   (`pos_shifts.failover_window_id` set, `opening_float_idr` = count). An
   in-flight unpaid edge order is re-rung in the cloud.

### 3.2 Selling during the window

- `allocateReceipt` (cloud, device sale, outlet has active edge):
  window `active` -> next number of the device's F-series; no window ->
  `RECEIPT_DEVICE_ON_EDGE` (today's behaviour).
- `pos_orders`, `pos_shifts`, `cash_movements` written in the cloud carry
  `failover_window_id`. Voids and refunds of failover orders run in the cloud
  while the window is `active`. After return they run on the edge (it now has
  the rows).
- Card and QRIS: EDC standalone with manual reference (PRD fallback), QRIS via
  the cloud gateway. The edge EDC agent and print agent are down.
- Kitchen: KDS tablets follow the same pinned-cloud rule as terminals.

### 3.3 Return to edge

1. Edge boots, link reconnects, pulls the window state (`active`), refuses
   device sales and shows "Outlet dalam mode cloud".
2. Manager: "Kembali ke edge". Cloud checks: edge heartbeat fresh (< 60 s), no
   open (unpaid) failover order, every failover shift closed with a count.
   Else `FAILOVER_OPEN_WORK` with the list.
3. Same transaction: window -> `returning`; build the sync-back batch from the
   DB by `failover_window_id` (frozen; nothing can change it now); enqueue
   events 1..N for the outlet's current active primary; audit
   `edge.failover.return_started`.
4. Edge applies events in order (§5). The closing event checks counts and
   totals, then marks its window copy `closed` and lifts the block.
5. Cloud receives the ack of the closing event -> window `closed`, audit
   `edge.failover.closed`, notify managers. Terminals see the edge status
   "window closed" and unpin back to the edge.

### 3.4 Cancel (activated by mistake)

Allowed only while the window has zero failover orders and zero failover cash
movements. Failover shifts opened with no sales are closed by the cancel.
Window -> `cancelled`, state event to the edge, audit.

### 3.5 Edge replaced by standby

The batch targets the active primary at return time. If that node is revoked
before the ack, a manager action re-enqueues the same batch (same event ids)
for the new primary. Duplicates on a node that already applied part of it are
skipped by event id.

## 4. Invariants

### 4.1 Numbering

- N1. Every receipt series has exactly one allocator: `device` = edge (plus
  device offline merge, existing), `cloud` (`C`) = cloud, `failover` (`F<n>`) =
  cloud only. Edge `allocateReceipt` never selects a non-`device` series.
- N2. Prefix namespaces are disjoint per outlet: `^F[0-9]{1,4}$` is reserved
  for `series = 'failover'` (DB check both ways), `C` for `cloud`.
  `receiptPrefixSchema` refuses a caller-chosen `F<n>` prefix. The migration
  aborts if an existing `device` prefix matches `^F[0-9]+$`.
- N3. One series per (tenant, outlet, device, series). Every lookup that
  today assumes one row per device filters by `series`
  (`findSequenceRow`, `listDeviceReceiptSequences`, `applyCloudDeviceReceiptSequence`,
  `mergeDeviceReceiptRun`, `provisionReceiptSequence`). `prefixesOfOutlet`
  keeps all series (uniqueness).
- N4. Gapless per series (POS-06 unchanged): cloud allocation runs in the sale
  transaction. The edge F-series copy only advances inside the sync-back
  applier, in the same transaction as the receipts it covers.
- N5. Order numbers come from the ULID order id (`orderNumberFor`), generated
  where the order is created. A collision on `orders_tenant_outlet_number_key`
  during sync-back is a recorded conflict, never an overwrite.
- N6. A receipt number, once issued, never changes and is never reused
  (existing triggers in `pos-receipt.custom.sql`).

### 4.2 Window and sync

- W1. At most one `active`/`returning` window per outlet.
- W2. Cloud accepts device sales of an edge outlet only while its window is
  `active`.
- W3. The edge accepts device sales only when its window copy is absent,
  `closed` or `cancelled`.
- W4. (Superseded, see "Delta rc2 (26 Nov)".) The sync-back batch is built after the window leaves `active`; failover
  rows are immutable in the cloud from then on (service check plus trigger on
  `failover_window_id` rows when the window is not `active`).
- W5. Apply is idempotent by event id and ordered by aggregate sequence; a gap
  or collision is recorded with the full envelope and alerts managers
  (`notifyEdgeSyncConflictRecorded`). The window then stays `returning`.
- W6. Tutup Hari is refused on edge and cloud for the outlet while a window is
  `active` or `returning` (`FAILOVER_SYNC_PENDING`).
- W7. (Superseded, see "Delta rc2 (26 Nov)".) Failover rows are never sent edge -> cloud (k0i8 echo guard).

### 4.3 Cash (worked example)

Edge shift expected at outage E1 = 1,000,000. Drawer count at switchover
C1 = 990,000. Failover shift: float C1, cash sales S = 300,000, close count
C2 = 1,290,000 (variance 0). Edge shift after sync-back: expected
E1 - C1 + C2 = 1,300,000, plus later sales. Its final variance includes the
pre-outage difference C1 - E1 = -10,000, which belongs to the edge shift.
New `cash_movements.type` values: `failover_out`, `failover_in` (system
written, `reason_note` = window id).

## 5. Sync-back batch (cloud -> edge)

> Superseded by "Delta rc2 (26 Nov)" (D1): failover orders are not synced back to the edge.

Aggregate `pos_failover_window`, aggregate id = window id, sequence 1..N,
event id = UUIDv5(window id, kind, record id). Order of events:

1. `pos.failover.series_checkpoint` per F-series: prefix, device, lastNumber.
2. `pos.failover.shift_opened` per failover shift.
3. `pos.failover.order_recorded` per order: full snapshot (orders, pos_orders,
   items, tenders, discounts, voids, refunds, approval uses, receipt,
   deliveries metadata). Inserted with the cloud ids.
4. `pos.failover.cash_movement` per movement, plus the two bridge movements
   per interrupted edge shift.
5. `pos.failover.shift_closed` per failover shift (count, variance).
6. `pos.failover.window_closed`: counts per kind, receipts per series, sum of
   order totals. The applier verifies them against what it holds; a mismatch
   is a conflict and the window stays `returning`.

Stock moves of failover sales use the existing cloud -> edge `stock-moved`
applier; verify in slice 4 that failover sales emit them.

## 6. Audit and notifications

Audit actions: `edge.failover.activated` (reason, override, heartbeat age),
`edge.failover.cancelled`, `edge.failover.return_started`,
`edge.failover.closed` (counts), `edge.failover.reenqueued`. Shift bridging
and receipt allocation use the existing audit paths. Notify owner on override
activation; notify outlet managers on activate, close and every sync conflict.

## 7. Rollback

- Operational: cancel (no sales) or return (with sales). No other exit.
- Feature: tenant setting `edgeFailoverEnabled` (default off). Off refuses
  new activations; it cannot be turned off while a window is open.
- Schema: additive (new table, nullable columns, new check values). Forward
  only; no down migration needed to disable the feature.

## 8. Tests

Contract (`tests/pos-contract.test.mjs`, shared):

- `F<n>` prefix refused for device provisioning; new error codes and HTTP
  statuses; window and state schemas strict.

DB (`apps/api/src/test/edge-failover-schema.test.ts`):

- one open window per outlet; forward-only status; no delete.
- `series`/prefix check both ways; unique (tenant, outlet, device, series).
- migration preflight aborts on an existing `F<n>` device prefix.
- failover rows immutable when the window is not `active`.

Cloud service (`apps/api/src/test/edge-failover.test.ts`):

- device sale on edge outlet without window -> `RECEIPT_DEVICE_ON_EDGE`.
- activation refused with fresh heartbeat; allowed with override + reason;
  idempotent per key; F-series provisioned for every receipt device.
- with window: F-series gapless under concurrency (2 terminals x 50 sales,
  no duplicate, no gap); P-series untouched.
- cancel refused after one sale; return refused with an open order or shift.
- after return starts: device sale refused, failover rows frozen.
- existing provisioning/pull tests still pass with two series per device
  (`pos-receipt-provisioning.test.ts`, `pos-receipt-kfix.test.ts`).

Edge (`apps/api/src/test/edge-failover-sync.test.ts`):

- window state `active` blocks device sales and Tutup Hari on the edge.
- full batch applies; replay of the same batch is a no-op.
- missing event -> `sequence_gap` conflict, nothing after it applied, alert.
- closing-event checksum mismatch -> conflict, window stays `returning`.
- edge never allocates on an F-series; Tutup Hari gap check passes after apply.
- bridge movements give the expected cash of §4.3.
- split brain: edge sells P-series while cloud sells F-series; after sync
  zero number collisions, all orders present.
- standby re-enqueue: new node receives the full batch; old partial apply skipped.

k0i8 (when built): edge -> cloud emitter skips `failover_window_id` rows.

E2E (`e2e/edge-failover.spec.ts`, via `heavy`): manager activates, cashier
counts, sells 3 sales `F1-000001..3`, closes failover shift, manager returns,
edge shows the 3 receipts and the terminal unpins.

## 9. Implementation slices

All schema slices need `integ/m1-batch3` merged into `milestone/m1` first:
batch 3 owns migrations up to 0128 and the receipt provisioning code
(legend-3yqy) that slice 1 changes.

### S1. Contract and schema (needs batch 3 merged)

- `packages/shared/src/edge/failover.ts` (new), `packages/shared/src/edge/index.ts`
- `packages/shared/src/pos/receipts.ts` (reserved `F` prefix, series type)
- `packages/shared/src/pos/errors.ts` (`FAILOVER_EDGE_HEALTHY`,
  `FAILOVER_ACTIVE`, `FAILOVER_OPEN_WORK`, `FAILOVER_SYNC_PENDING`,
  `FAILOVER_NOT_ACTIVE`)
- `packages/shared/src/access/permissions.ts`, `roles.ts` (`pos.failover.manage`)
- `apps/api/src/db/schema/edge-failover.ts` + `edge-failover.custom.sql` (new)
- `apps/api/src/db/schema/pos-receipt.ts` + `.custom.sql` (`series`, keys, checks)
- `apps/api/src/db/schema/pos-order.ts`, `pos-shift.ts` + `.custom.sql`
  (`failover_window_id`, cash movement types, freeze trigger)
- `apps/api/drizzle/0129_*` and next
- `tests/pos-contract.test.mjs`, `apps/api/src/test/edge-failover-schema.test.ts`
  Depends: batch 3 merged.

### S2. Cloud window service and failover selling (needs batch 3 merged)

- `apps/api/src/services/edge-failover.service.ts` (new: activate, cancel,
  start return, state event, audit, notify)
- `apps/api/src/routes/edge-failover.routes.ts` (new), `apps/api/src/routes/index.ts`
- `apps/api/src/services/pos-receipt.service.ts` (`allocateReceipt` branch,
  `ensureFailoverSequence`, series filters of N3)
- `apps/api/src/services/edge-device-sync.ts` (pull lists `device` series only)
- `apps/api/src/services/pos-shift.service.ts`, `pos-order.service.ts`
  (stamp window id, failover shift open/close)
- `apps/api/src/test/edge-failover.test.ts`
  Depends: S1.

### S3. Edge window state and blocks

- `apps/api/src/edge/failover-state-applier.ts` (new), `apps/api/src/edge/runtime.ts`
  (register in `applier-registry.ts`)
- `apps/api/src/services/pos-receipt.service.ts` (edge refuses with
  `FAILOVER_ACTIVE`), `apps/api/src/services/pos-day.service.ts` (W6)
- `apps/api/src/services/edge-status.service.ts`, `packages/shared/src/edge/schemas.ts`
  (`failover` field on edge status)
  Depends: S2 (emits the state event). Can run in parallel with S5.

### S4. Sync-back batch and edge applier (tier K: architect + second opinion)

(Superseded by "Delta rc2 (26 Nov)": replaced by cards F4 and F5 in `docs/briefs/1271-edge-failover-cards.md`.)

- `apps/api/src/services/edge-failover-sync.ts` (new: batch builder, enqueue,
  re-enqueue, close on ack)
- `apps/api/src/edge/failover-sync-applier.ts` (new)
- `apps/api/src/services/edge-queue.service.ts` (ack hook for the closing event)
- `apps/api/src/services/pos-receipt.service.ts` (`applyFailoverReceiptRun`, edge side)
- `apps/api/src/test/edge-failover-sync.test.ts`
  Depends: S2, S3.

### S5. Web: terminal failover mode (mockup first, founder review)

- `apps/web/src/features/ws02-edge/logic.ts`, `hooks.ts`, `api.ts`
- `apps/web/src/features/ws02-edge/components/connectivity-banner.tsx`
- `apps/web/src/features/ws02-edge/components/failover-panel.tsx` (new:
  activate, count, return checklist)
- API base selection for the POS client (pinned cloud target per device)
- `e2e/edge-failover.spec.ts`
  Depends: S2 contract; S4 for the full e2e.

### S6. Echo guard and duplicate review (with legend-k0i8)

(Superseded by "Delta rc2 (26 Nov)": D1 removes the echo, so no emitter guard is needed.)

- k0i8 emitter skips `failover_window_id` rows (W7)
- "possible duplicate" report: edge orders completed in the 15 min before
  the outage vs failover orders with the same items and total, for manager
  void through the normal approval path
  Depends: S4 and legend-k0i8.

## 10. Open questions (business, founder)

1. Who may switch an outlet to cloud mode: store manager only, or also shift
   supervisor? Owner notified on every switch or only on override?
2. Drawer count at switchover and at return: required (recommended; about 2
   minutes per cashier) or optional?
3. Receipts show a visible `F1-000001` style number during failover. Accepted?
4. Without the edge, outlet LAN printers are unreachable. Is an on-screen QR
   e-receipt acceptable when the terminal has no own printer?
5. Edge still down at end of day: keep the day open until it returns, or
   allow Tutup Hari from cloud data only with edge data posted later as a
   late adjustment (legend-k0i8 rule)?

### Founder decisions (2026-11-09, Ghostex page Q21-Q24)

1. Switch to cloud mode: store manager **and** shift supervisor may do it.
2. Drawer count at switchover and at return: **required**.
3. Without the edge, printers are unreachable: receipt is an **on-screen QR e-receipt**.
4. Edge still down at end of day: **Tutup Hari from cloud data is allowed**; edge data that arrives later posts as a late adjustment (legend-k0i8 rule).
   Question 3 (visible `F1-000001` number) was not asked; CTO default stands: accepted.

## Delta rc2 (26 Nov)

Source: `docs/briefs/1271-edge-failover-cards.md` and founder decision 29
(`docs/founder/keputusan-2026-11-21.md`). Topology on `int/rc2`: the POS is always
served by the edge, and E1/E3 ingest edge -> cloud. This section wins over the text
above. Superseded: §5, S4, S6, W4, W7.

- D1. No full sync-back of failover orders to the edge (drops S4 and S6, and §5).
  The cloud already holds every edge sale (E1) and shift/day (E3). Copying
  cloud-written sales onto the edge would make the edge re-emit them up = double
  sale/cash. Failover rows stay cloud-only, so the echo is impossible (W7 not needed).
  Cost: after return, void/refund of an `F` receipt is done from back office (cloud
  refund path), not at the edge cashier; the edge's day screen shows edge sales only
  (note on screen).
- D2. Cash = close-and-reopen, not bridge movements (replaces §4.3 and the
  `failover_out`/`failover_in` types). The switchover count C1 (per device) is the
  forced blind count of the interrupted edge shift; variance C1-E1 stays with the edge
  shift. The failover shift in the cloud opens with float C1 and closes with count C2.
  After return the cashier opens a new edge shift with float C2. Every rupiah sits in
  exactly one shift; no new `cash_movements.type`. The edge closes its own shift
  (single writer), applied from the window-closing event; E3 mirrors the close up as
  usual. If that edge shift has any sale/cash movement after the C1 count time (split
  brain), the applier refuses, records an `edge_sync_conflicts` row and alerts
  managers: never guesses.
- D3. Numbering unchanged (§4.1): `receipt_sequences.series` (`device` | `cloud` |
  `failover`), F-run per device held in the cloud only (never edge-bound), prefix
  `^F[0-9]{1,4}$` reserved both ways.
- D4. E3 gate: `assertPosWriteNotOnEdge` returns (allows) on the cloud while the
  outlet's window is `active`; on the edge it throws `FAILOVER_ACTIVE` while the local
  window copy is `active`/`returning`. `allocateReceipt` takes the F-run instead of
  `RECEIPT_DEVICE_ON_EDGE` while `active`.
- D5. Tutup Hari: the stale-edge cloud close (Q24, `assertDayClosesOnCloud`) stays.
  Edge Tutup Hari is refused while the window is `active`/`returning`. When the edge
  later closes a day that has failover rows, the E3 mirror compares edge figures with
  cloud figures without failover rows, then stores the cloud's full recap (edge +
  failover).
- D6. Freeze trigger (W4) dropped: no batch is built from frozen rows, and back-office
  refunds of failover orders must stay possible. Kill switch: env
  `EDGE_FAILOVER_ENABLED` (default false).

### Corrections from the F1 review (27 Nov, `docs/qa/1271-f1-review.md`)

- F2: the cloud run `C` has series `cloud`. Find or create the sequence with
  `series <> 'failover'` or an explicit series, never `series='device'`;
  `insertSequence` takes an explicit `series`. A cloud sale without a device must
  still work after migration 0529.
- F3: fill `failover_window_id` on every order/shift insert path, including split,
  merge and move bill. Use the event constants `pos_failover_window.state` and
  `.closed`.
- F4: the edge's window copy uses `idempotency_key` = window id; the window table joins
  `EDGE_REQUIRED_TABLES`.
- F5: write-off refuses an F run; gaps in F numbers are reported, not erased.
