# Design: one collectible QRIS per bill, DP-safe (legend-yhia9)

Status: design, 13 Nov 2026. Owner: architect (xhigh, money). Branch
`design/qris-dp-edge-emergency` (base `milestone/m1` 5cbe2a1e). Unblocks the
HOLD on `legend-y5d2r` (QRIS for bills with a DP).
Tier K (money + migration): every card gets one architect review; Codex second
opinion once for the whole payment area before the release gate.

Inputs: brief from CTO (13 Nov), bead notes on `legend-y5d2r` (architect
12 Nov: "old paid -> one system:pos refund PENDING, customer not refunded"),
money tests on `origin/ws/qris-dp-due` 54682a08
(`apps/api/src/test/pos-qris-deposit-money.test.ts`, QRIS-DP-MONEY-01..04),
contract e191e0cf (`customerDisplayStateSchema` with `depositAppliedIdr`,
`remainingIdr`), founder rule "Jangan sampai rugi" (11 Nov), founder Q68 (UI
holds QRIS for DP bills), Duitku API docs (no cancel/void for QRIS; status
`00` paid, `01` process, `02` failed/expired; callback retried up to 5 times).

Points marked **TBD-verify** were not confirmed in code; the implementer checks
them first and reports a mismatch before coding around it.

## 1. The problem in business words

A QRIS code stays payable at the provider until it expires. Neither DOIT nor
Duitku lets us cancel it (`services/payment-duitku.ts:11`, no `cancel` in DOIT;
port `cancel?` is optional, `services/payment-gateway.ts:144`). Today the POS
"cancels" a QR only in our own database: it voids the tender, cancels the link
and marks the intent expired, without asking the provider
(`voidPendingQrisTenders`, `services/pos-order-payment.ts:109`). Then the bill
can change: a DP is attached, a line is edited, or the cashier takes cash. If
the customer still pays the old QR, the money arrives for a bill that no longer
wants it, and the system only files a `pending` refund (`system:pos`,
`services/pos-order-late-payment.ts:72`). The customer has paid twice until a
manager approves the refund. That is the reason for the HOLD.

The fix: **while a QR may still be paid, the bill's money is frozen.** Nothing
that changes the amount due (DP, lines, discounts, other tenders, void,
completion) is allowed. The cashier can hide the QR at once ("cancel"), but the
bill unlocks only when the provider itself confirms that the QR can no longer
be paid. If the customer pays during that wait, the payment is still exactly
right for the unchanged bill, so we **apply** it instead of refunding.

## 2. What exists (milestone/m1)

| Fact                                                                                  | Where                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bill = `orders` row, money columns materialized                                       | `db/schema/qr-order.ts:210-215` (subtotal, discount, service_charge, tax, rounding, total)                                                                                                                              |
| DP on the bill `orders.deposit_applied_idr`, check `0 <= dp <= total`                 | `qr-order.ts:223`, `:320`                                                                                                                                                                                               |
| DP writers                                                                            | `pos-order.service.ts:1099-1115` (submit), `pos-order-support.ts:943` (reprice), `qr-order.service.ts:2114`; resets `pos-order.service.ts:798`, `:1617`                                                                 |
| QRIS tender: amount = total − DP − captured, server-side                              | `addPosTender` case `qris`, `services/pos-order-payment.ts:341-405`                                                                                                                                                     |
| One QR per bill today: order `FOR UPDATE` + app check, no DB unique                   | `pos-order-payment.ts:189`, `:341-351`                                                                                                                                                                                  |
| Local QR cancel, no provider call                                                     | `voidPendingQrisTenders` (`pos-order-payment.ts:109`), callers `:257` (non-QR tender replaces waiting QR), `:545`, `pos-order.service.ts:1306` (complete), `:1563` (void), local link cancel `pos-order-payment.ts:978` |
| Intent lifetime QRIS 10 min, caller may shorten                                       | `services/payment.service.ts:120`, `:764`                                                                                                                                                                               |
| Poll asks provider first; local-clock expiry after poll window                        | `pollPendingGatewayIntents` `payment.service.ts:2485`, `:1560-1588`; job `worker/payment-gateway-poll.job.ts:90`, runs in EDGE_MODE too (`worker-main.ts:512`)                                                          |
| Duitku status: `00` paid, `01` pending, `02` failed (explicit); other codes throw     | `services/payment-duitku-wire.ts:291`, `:302`; getStatus `payment-duitku.ts:473-479`                                                                                                                                    |
| DOIT status: pending, paid, expired, failed (refunded → pending)                      | `services/payment-doit-wire.ts:283`, `:313`                                                                                                                                                                             |
| Paid handler: late/stale → pending refund; `bill_below_tender` → void + refund        | `handlePosPaymentPaid` `pos-order-payment.ts:613`, branches `:663`, `:758`, `:777`, `:~805`                                                                                                                             |
| Webhook dedupe, evidence unique                                                       | `gateway_webhook_events` (`db/schema/payment-gateway-webhook.ts:24`), `payment_evidence` unique `provider_ref` (`payment.ts:460`)                                                                                       |
| Customer display contract (pair, state), no API, web polls every 5 s                  | `packages/shared/src/pos/schemas.ts:2074-2117`, `endpoints.ts:666,675`; `apps/web/src/features/ws04-display/queries.ts`, `lib.ts:12`                                                                                    |
| Device auth `dv1` token, registry check per request                                   | `lib/device-token.ts`, `routes/device-id.ts` (`registeredDeviceIdOf`, `currentDeviceIdOf`)                                                                                                                              |
| POS runs on the edge; QRIS on edge calls the provider itself; webhooks are cloud-only | `edge/mode.ts:5-10`, `:77`; no edge branch in `pos-order-payment.ts:341-405`                                                                                                                                            |

## 3. Decisions

### D-01 The bill is frozen while a QR is collectible ("QR hold")

New table `pos_qris_holds`. Issuing a QRIS tender creates one hold row in the
same POS transaction as the tender. (The link and the intent commit in their
own transactions first, `payment.service.ts:243`, `:696`; the QR string reaches
the cashier and the display only after the POS transaction commits, so a
rolled-back POS transaction leaves an intent nobody can see or pay.) While the
hold is `open` or `cancelling`, these are refused with 409 `QRIS_HOLD_ACTIVE`:

- attach or change DP (`deposit_applied_idr`),
- add, edit or remove lines, discounts, vouchers, promos, service charge,
  rounding (anything that moves `orders` money columns),
- add any other tender, void any tender (including the QR's own tender),
- split or merge the bill,
- complete or void the bill,
- close the business day or hand over the shift for that outlet (today
  `handlePosPaymentPaid` refunds a payment that lands after the day closed,
  `pos-order-payment.ts:758`; the close must wait for active holds instead).

Two layers: a service guard right after the order `FOR UPDATE` lock (clear
error for the cashier) and a database trigger (backstop for any path we
forget, including raw SQL and background jobs). Cashier message:
"QR masih bisa dibayar. Batalkan QR dan tunggu konfirmasi penyedia dulu."

Why (business): the amount on a QR never becomes wrong while the customer can
still pay it, so a customer can never pay more than the bill.
Risk: the cashier must wait after cancelling (D-04, Q1).
Fallback: manager release (Q2).

### D-02 One active hold per bill, enforced by the database

Partial unique index `(tenant_id, order_id) WHERE state IN ('open','cancelling')`.
The hold is per order, not per split: a split bill pays its QR splits one at a
time. Concurrent QR requests: the order lock serializes them; the unique index
makes the second insert fail even if a path skips the lock (QRIS-DP-MONEY-03
stays 201 + 409).

### D-03 A QR is closed only by provider proof

A hold leaves `open`/`cancelling` for `closed` only when one of these is true:

| Provider | Evidence that closes the hold                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Duitku   | `transactionStatus` answers `02` for this `merchantOrderId` and `reference`, and `now >= expires_at + 60 s`                     |
| DOIT     | Status `expired` or `failed` for this provider ref, and `now >= expires_at + 60 s`                                              |
| Any      | Provider `cancel` succeeded and a later status read says expired/failed/cancelled (only if a provider ever implements `cancel`) |

Never closes the hold: local clock alone, the poll window timeout
(`payment.service.ts:1564`), HTTP errors, timeouts, unknown codes, a `02`
before `expires_at` (a failed attempt may be retried on the same QR), an answer
about another reference (`payment-duitku.ts` `continue`).

A failed create throws before the POS transaction writes the tender
(`payment.service.ts:774`), so no tender and no hold exist and the QR string
never reached anyone. A retry with the same idempotency key re-binds the
intent (`intentIdFor`).

The provider port drops the raw status code today
(`payment-duitku.ts:483-490` maps `02` to `expired`). `GatewayPaymentStatus`
gains `rawStatus` (provider's own code, e.g. `"02"`), and closure evidence
uses it, not the mapped value. Provider name comes from `intent.provider`,
not from the tender (the tender hard-codes `"doit"`,
`pos-order-payment.ts:393`).

The 60 s margin covers clock skew between us and the provider.
Evidence (provider, raw status code, reference, checked_at) is stored in
`close_evidence`. No personal data.

The intent row may still be marked `expired` locally by the existing poll, and
`payment.expired` may fire, but that no longer unlocks anything: only the hold
gates the bill (D-04 makes `handlePosPaymentClosed` hold-aware).

**Gate S1 (`legend-1yig6`).** This decision assumes Duitku answers `02` once a
QRIS has expired. If the sandbox shows it stays `01` or answers "not found",
every cancelled QR would lock the bill until a manager release. S1 must pass
before C2 merges; if it fails, the architect revisits D-03 and the CTO brings
the fallback (treat `01` at `expires_at` + 5 min as closed, risk accepted by
the founder) to the founder.

### D-04 Cashier "cancel" hides the QR and waits; it never voids locally

`POST .../orders/:orderId/qris/cancel` moves the hold `open → cancelling`,
records who and when, and triggers one immediate status read after commit.
The display stops showing the QR on its next poll (≤ 5 s). The tender stays
`authorized` and the intent stays `pending` until D-03 evidence arrives; then,
in one transaction: hold `closed`, intent `expired`/`failed`, tender `voided`,
link cancelled, bill unlocked.

The cancel route is new (there is no tender void route today; the only tender
route is `pos-order.routes.ts:372`). The local link cancel at
`pos-order-payment.ts:978` ("the cashier opens a fresh QRIS") must not run
while a hold is active. Every caller of `voidPendingQrisTenders` that acts on
an active hold now gets 409 instead: `:257` (cash/EDC replaces a waiting QR),
`pos-order.service.ts:1306` (complete), `:1563` (void). The
`handlePosPaymentPaid` refund branches at `:545` (`bill_below_tender`,
`business_day_closed`, `refund_reserved`) stay as the safety net for
anomalies (D-07).

`handlePosPaymentClosed` (`pos-order-payment.ts:876`, consumer
`order-payment-consumers.ts:169`) reacts to `payment.expired` /
`payment.failed`, which the existing poll can fire on the local clock or on a
`02` at `expires_at` + ε. It becomes hold-aware: lock the hold (lock order in
D-06); while the hold is active it changes nothing and returns handled; only
when the hold is `closed` (or there is none) does it run today's
fail-tender/cancel-link logic. Without this, the new tender trigger would make
that consumer fail and retry forever.

Closure is driven by a separate hold check job (`next_check_at`), not by the
payment poll, because the poll re-reads an intent only inside its grace
window (`payment.service.ts:2525-2535`). The job runs on cloud and edge, reads
the provider once right after cancel, then at `expires_at` + 60 s, then every
2 minutes for 30 minutes, then every 10 minutes (Duitku asks not to hammer the
status API). On D-03 evidence it closes in one transaction: hold `closed`,
intent `expired`/`failed`, tender `voided`, link cancelled.

Wait time after cancel: at most the QR lifetime left plus one status read.
With today's 10-minute lifetime that is up to about 11 minutes (Q1).

### D-05 A payment that arrives while the hold is active is applied

Because D-01 kept the bill unchanged, a paid notice for the hold's intent is
still exactly the amount due. Apply it whether the hold is `open` or
`cancelling`: hold `paid`, then tender `captured`, as today. The bill is not
auto-completed by the consumer; the cashier completes it as today
(`pos-order.service.ts:~1268`), so completion side effects stay in one place.
The customer pays once; no refund.

Defence in depth at apply time, in the same transaction: the hold's `basis`
(total, DP, captured at issue) must equal the bill now, and the paid amount
must equal `hold.amount_idr`. A mismatch is an anomaly (D-07), never a capture.

### D-06 Exactly-once apply, one lock order

No new entry point. Webhook and poll keep going through `confirmPayment`
(evidence, link `paidIdr`, strict amount check, parking of unmatched money),
which emits `payment.paid`; the hold logic lives inside `handlePosPaymentPaid`.

Lock order extends the repo's single payment lock order (legend-s0u8c,
comment in `services/payment-late-settlement.ts:20-35`): `orders` (ORDER BY
id) → `pos_orders` → **`pos_qris_holds`** → `pos_order_tenders` →
`payment_links` → `payment_intents` → funds/refunds. Every new writer (cancel
route, hold check job, `handlePosPaymentClosed`, guards) follows it; C1
updates that comment.

Idempotency layers, all kept: webhook event dedupe
(`gateway_webhook_events` unique `(tenant, provider, event_id)`),
`payment_evidence` unique `provider_ref`, conditional updates in
`confirmPayment`, tender update `... WHERE status = 'authorized'`, hold update
`... WHERE state IN ('open','cancelling')`. A second notice finds the tender
captured and returns with no write (existing branch).

An intent marked `expired` locally while its hold is still active can still
turn `paid` through the late settlement path: `billClosedForLateSettlement`
(`payment-late-settlement.ts:106`) lets it through because the link is not
cancelled and the bill is not closed, and the tender is still `authorized`
because `handlePosPaymentClosed` did nothing (D-04). Test QH-11 proves it.

### D-07 Anomalies become parked money or one pending refund, never a second capture

- Hold `closed` (provider said expired, then the payment still arrives; or a
  manager release): the closure cancelled the link and voided the tender, so
  `billClosedForLateSettlement` (`payment-late-settlement.ts:106`) refuses the
  late settlement and the money is parked in `payment_unallocated_funds`
  (`payment.ts:356`). Add an alert to the outlet manager. The manager returns it
  to the payer from the unallocated-funds queue. No capture, no `system:pos` refund.
- Paid amount differs from the intent amount: `confirmPayment` already parks it
  as unallocated; alert; no capture.
- Hold active but the basis check fails (should be impossible with the
  triggers), or a legacy tender without a hold: today's branches stay
  (`handlePosPaymentPaid` `:663` gives one pending refund `system:pos`, key
  `pos-late-payment-refund:<intentId>`; `:777` `bill_below_tender`).

In every branch the outlet holds the money until a manager returns it, so the
outlet never loses; the customer is made whole by that return.

### D-08 Customer display backend

- **Pairing.** The display device (registered device of type `display`, `dv1`
  token checked against the registry on every request) asks for a code:
  `POST .../customer-display/pairing-codes` → `{ code, expiresAt }` (6 digits,
  5-minute TTL, single use, one live code per display; stored only as
  HMAC-SHA256 with a server key, bound to tenant and outlet). The cashier types
  the code on the terminal: `POST .../customer-display/pair` (existing contract
  `{ code, idempotencyKey }`, staff session + terminal device token). Wrong
  codes: 5 per terminal device per 5 minutes and 20 per outlet per 5 minutes,
  then 429. One active pairing per display and per terminal (DB unique);
  re-pairing revokes the old one. Revoke: `DELETE .../customer-display/pairings/:id`.
- **Selected bill.** Explicit, never guessed: `PUT .../customer-display/selection
{ orderId | null, idempotencyKey }` by the cashier on the terminal. Issuing a
  QR from a terminal selects that bill on its display in the same transaction.
- **State.** `GET .../customer-display` (display token, or cashier session +
  `terminalDeviceId` for preview) returns `customerDisplayStateSchema`, built
  only on the server from the selected order, its tenders and its hold.
  `remainingIdr = total − DP − captured`. `qris` is non-null only when the hold
  is `open` **and** `hold.amount_idr = remainingIdr`; otherwise `qris = null`
  and the display shows "Silakan bayar di kasir" (existing UI kind). `version`
  is a per-terminal counter bumped by selection changes, order money changes
  and hold changes (triggers), so the display drops older answers.
- After this ships, the UI HOLD for DP bills (founder Q68, `displayPayMode`)
  is lifted: the display shows the QR for the remainder. Card U1 (UI) and
  closing `legend-y5d2r` follow the backend.

### D-09 Edge outlets follow the same rules locally

POS bills on an edge live in the edge database, and the edge calls the
provider itself; webhooks never reach it. Hold, freeze and triggers are the
same code in the edge database. Paid and closure evidence on the edge come
only from the poll (`worker-main.ts:512` runs it in EDGE_MODE;
**TBD-verify** that gateway credentials are present on the edge, otherwise
QRIS cannot be issued there at all and the tender must answer 409
`QRIS_NEEDS_CLOUD`). While the edge is offline, a hold cannot be closed: the
bill stays frozen until the link returns, or a manager release (Q2).

## 4. Hold state machine

```
            issue (tender + intent + hold, one tx)
                         |
                         v
   paid notice  +----- open -----+  cashier cancel
   (D-05)       |                |  (D-04)
                v                v
              paid <------- cancelling
                ^   paid notice  |
                |   (D-05)       | provider evidence (D-03)
                |                v
                |             closed  ----> late paid notice: parked as unallocated (D-07)
   open --------+-- provider evidence (D-03) --> closed
   open/cancelling -- manager release (Q2, if approved) --> closed (force_released)
```

Allowed transitions only: `open→cancelling`, `open→paid`, `open→closed`,
`cancelling→paid`, `cancelling→closed`. `paid` and `closed` are final. Rows
are never deleted (audit).

## 5. Migrations 0419-0421

Numbers are provisional; the merge train renumbers. RLS through
`app.enforce_tenant_rls` / `app.enforce_outlet_rls`; every unique key
includes `tenant_id`. Money is `bigint` IDR.

**0419 `pos_qris_holds`**

| Column                                                       | Shape                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `id`                                            | PK `(tenant_id, id)`, id ULID-in-uuid                                                                                                                                                                         |
| `outlet_id`                                                  | NOT NULL, FK outlets                                                                                                                                                                                          |
| `order_id`, `tender_id`, `payment_intent_id`                 | NOT NULL, composite FKs `(tenant_id, x)`; unique `(tenant_id, payment_intent_id)`; **TBD-verify** the target tables have `(tenant_id, id)` uniques                                                            |
| `bill_split_id`                                              | nullable                                                                                                                                                                                                      |
| `amount_idr`                                                 | bigint, CHECK `> 0`                                                                                                                                                                                           |
| `basis_total_idr`, `basis_deposit_idr`, `basis_captured_idr` | bigint, NULL only when `backfilled`; CHECK `backfilled OR amount_idr = basis_total_idr - basis_deposit_idr - basis_captured_idr`                                                                              |
| `backfilled`                                                 | boolean NOT NULL default false                                                                                                                                                                                |
| `state`                                                      | CHECK IN (`open`,`cancelling`,`paid`,`closed`)                                                                                                                                                                |
| `opened_at`, `opened_by`                                     | NOT NULL                                                                                                                                                                                                      |
| `cancel_requested_at`, `cancel_requested_by`                 | nullable, both or neither                                                                                                                                                                                     |
| `last_checked_at`, `check_attempts`, `next_check_at`         | poll bookkeeping                                                                                                                                                                                              |
| `closed_at`, `close_reason`, `close_evidence` jsonb          | CHECK `(state IN ('open','cancelling')) = (closed_at IS NULL)`; `close_reason` IN (`provider_paid`,`provider_expired`,`provider_failed`,`provider_cancelled`,`force_released`), required when `closed`/`paid` |

Indexes: unique `(tenant_id, order_id) WHERE state IN ('open','cancelling')`;
`(state, next_check_at) WHERE state IN ('open','cancelling')`.
Backfill: one `open` hold (`backfilled = true`, basis NULL, amount from the tender) for each `authorized` QRIS tender whose intent is not `paid` (including intents already `expired` locally and still polled), with `next_check_at = now()` so the hold check job resolves it from the provider. At apply time a backfilled hold is captured only when the paid amount equals the tender amount and the bill's current remaining; otherwise D-07. If a bill has more than one such tender, the migration raises and lists the rows (product is not live; the operator resolves before deploy).

**0420 freeze triggers**

- `pos_qris_holds` BEFORE UPDATE: only the transitions in §4; `amount_idr`,
  `basis_*`, `order_id`, `tender_id`, `payment_intent_id` immutable; BEFORE
  DELETE: refuse.
- `orders` BEFORE UPDATE: when an active hold exists for the row and any of
  `subtotal_idr`, `discount_idr`, `service_charge_idr`, `tax_idr`,
  `rounding_idr`, `total_idr`, `deposit_applied_idr` changes, or `status`
  changes to `completed`/`voided`: raise `QRIS_HOLD_ACTIVE`.
  **TBD-verify** exact column names and that line edits always rewrite these
  totals in the same transaction (otherwise add the trigger to the line table).
- `pos_order_tenders` BEFORE INSERT OR UPDATE: when an active hold exists for
  `NEW.order_id`, refuse any insert and any change of `status` or `amount_idr`
  (including the hold's own tender). The apply path sets the hold `paid`
  first, then captures the tender; the closure path sets the hold `closed`
  first, then voids the tender.
- Error mapping: **TBD-verify** the repo's convention for trigger errors
  (SQLSTATE + message) and map to `CoreError("CONFLICT", …)` with code
  `QRIS_HOLD_ACTIVE`.

**0421 customer display**

| Table                            | Shape                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer_display_pairing_codes` | PK `(tenant_id, id)`; `outlet_id`, `display_device_id` FK devices; `code_hash` bytea (32); `expires_at`, `consumed_at`, `created_at`. Unique `(tenant_id, outlet_id, code_hash) WHERE consumed_at IS NULL`; unique `(tenant_id, display_device_id) WHERE consumed_at IS NULL`                           |
| `customer_display_pairings`      | PK `(tenant_id, id)`; `outlet_id`, `terminal_device_id`, `display_device_id` FK devices; `status` IN (`active`,`revoked`); `paired_at`, `paired_by`, `revoked_at`, `revoked_by`. Unique `(tenant_id, display_device_id) WHERE status='active'`, `(tenant_id, terminal_device_id) WHERE status='active'` |
| `customer_display_sessions`      | PK `(tenant_id, terminal_device_id)`; `outlet_id`; `selected_order_id` nullable FK orders; `version` bigint NOT NULL default 0; `updated_at`. AFTER UPDATE trigger on `orders` and AFTER INSERT/UPDATE on `pos_qris_holds` bump `version` of sessions that select that order                            |

Pair attempt counters reuse the existing throttle pattern of the staff PIN
proof (`staff-pin-proof.service.ts:62-63`); **TBD-verify** whether that is a
table or memory and follow it.

## 6. API contract (additions; shared Zod in `packages/shared/src/pos/`)

| Route                                                                      | Auth                                                            | Result                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /api/outlets/:outletId/pos/orders/:orderId/tenders` (qris, existing) | unchanged                                                       | 201 tender + hold; 409 `QRIS_HOLD_ACTIVE` when a hold is active                     |
| `GET  /api/outlets/:outletId/pos/orders/:orderId/qris`                     | cashier (POS permission)                                        | hold: state, amountIdr, expiresAt, cancelRequestedAt, lastCheckedAt                 |
| `POST /api/outlets/:outletId/pos/orders/:orderId/qris/cancel` (new)        | cashier, `requireTrustedOrigin`, `{ idempotencyKey }`           | 202 hold `cancelling`; repeat returns current state; `paid`/`closed` returned as is |
| `POST /api/outlets/:outletId/pos/orders/:orderId/qris/release`             | only if Q2 = yes: manager approval via the `pos-overrides` flow | hold `closed` `force_released`, only when `now >= expires_at + 30 min`              |
| `POST /api/outlets/:outletId/pos/customer-display/pairing-codes`           | display device token                                            | `{ code, expiresAt }`                                                               |
| `POST /api/outlets/:outletId/pos/customer-display/pair` (existing)         | cashier session + terminal device token                         | pairing                                                                             |
| `DELETE /api/outlets/:outletId/pos/customer-display/pairings/:id`          | cashier or manager                                              | revoked                                                                             |
| `PUT  /api/outlets/:outletId/pos/customer-display/selection`               | cashier session + terminal device token                         | session with new `version`                                                          |
| `GET  /api/outlets/:outletId/pos/customer-display` (existing)              | display device token, or cashier + `terminalDeviceId`           | `customerDisplayStateSchema`                                                        |

Display routes never accept an amount from the client. A display token from
another tenant or outlet, a revoked display, or a display not paired gets 401
or 404 (no hint which).

## 7. Money proof: case table

T = bill total, D = DP applied, C = captured tenders, R = T − D − C.
"Overpaid" means a party received more than it is owed after the flow ends.

| #   | Situation                                                                                      | Rule          | Customer pays                       | Outlet keeps                                               | Overpaid?                                            | Test                            |
| --- | ---------------------------------------------------------------------------------------------- | ------------- | ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| 1   | No DP, QR for T, paid                                                                          | D-05          | T                                   | T                                                          | No                                                   | QH-01                           |
| 2   | DP D, QR for T − D, paid                                                                       | D-05          | T − D (+ D earlier)                 | T                                                          | No                                                   | QRIS-DP-MONEY-01                |
| 3   | Client sends an amount ≠ R                                                                     | server amount | nothing                             | nothing                                                    | No (refused before gateway)                          | QRIS-DP-MONEY-02                |
| 4   | Two QR requests at once                                                                        | D-02          | R once                              | R                                                          | No (one intent, one gateway call)                    | QRIS-DP-MONEY-03                |
| 5   | DP attached or changed while QR open/cancelling (API or raw SQL)                               | D-01          | R (unchanged)                       | T                                                          | No (409 / trigger)                                   | QH-03 (replaces MONEY-04 setup) |
| 6   | Line, discount, voucher, service or rounding edit while QR active                              | D-01          | R                                   | T                                                          | No                                                   | QH-04                           |
| 7   | Cash/EDC offered while QR active                                                               | D-01          | R by QR only                        | T                                                          | No (409; cash only after closure)                    | QH-05                           |
| 8   | Complete or void the bill while QR active                                                      | D-01          | —                                   | —                                                          | No (409)                                             | QH-06                           |
| 9   | Cashier cancels, customer had already paid (notice during `cancelling`)                        | D-05          | R once                              | T                                                          | No (captured, no refund)                             | QH-07                           |
| 10  | Cashier cancels, provider later says expired after `expires_at`, DP then attached, new QR paid | D-03, D-05    | new R′ = T − D′ − C                 | T                                                          | No                                                   | QH-08                           |
| 11  | Provider `02` before `expires_at`                                                              | D-03          | —                                   | —                                                          | No (hold stays; no reissue)                          | QH-09                           |
| 12  | Provider timeout / 5xx / unknown code / other reference                                        | D-03          | —                                   | —                                                          | No (hold stays; alert after expiry + 30 min)         | QH-10                           |
| 13  | Intent marked expired locally (poll window), then provider says paid                           | D-05, D-06    | R once                              | T                                                          | No (applied because the hold is active)              | QH-11                           |
| 14  | Duplicate webhook; webhook and poll race                                                       | D-06          | R once                              | T                                                          | No (one capture)                                     | QH-12                           |
| 15  | Paid amount ≠ hold amount                                                                      | D-07          | X                                   | X held as unallocated                                      | No capture; X returned manually                      | QH-13                           |
| 16  | Provider says expired (hold closed), then the old QR is paid (provider anomaly)                | D-07          | R′ + X                              | T, plus X parked as unallocated until a manager returns it | Temporarily; one unallocated record, never a capture | QH-14                           |
| 17  | Manager release (Q2), then old QR paid                                                         | D-07          | as 16                               | as 16                                                      | as 16                                                | QH-15                           |
| 18  | Gateway create fails                                                                           | D-03          | —                                   | —                                                          | No (no tender, no hold, QR never shown)              | QH-16                           |
| 19  | POS transaction rolls back after the provider made the intent                                  | D-01          | —                                   | —                                                          | No (QR never shown; expires at provider)             | QH-17                           |
| 20  | Edge offline while QR active                                                                   | D-09          | R once (applied after link returns) | T                                                          | No (frozen until proof)                              | QH-18                           |
| 21  | Split bill: second split's QR while first is active                                            | D-02          | one split at a time                 | sum of splits = T − D                                      | No (409)                                             | QH-19                           |
| 22  | Display shows QR only when hold `open` and amount = R                                          | D-08          | —                                   | —                                                          | No (stale amount never shown)                        | QD-02                           |
| 23  | Cashier cancels; display still shows old QR up to 5 s; customer pays                           | D-04, D-05    | R once                              | T                                                          | No (case 9)                                          | QD-03                           |
| 24  | Display of another tenant/outlet or revoked display reads state                                | D-08          | —                                   | —                                                          | No data leak                                         | QD-01                           |

Invariants the tests assert after every case:

- **I1** `C + D <= T` for every bill at every commit; `C + D = T` when completed.
- **I2** At most one hold `open`/`cancelling` per bill (DB unique).
- **I3** While a hold is active, the bill's money columns and its other tenders do not change (trigger).
- **I4** A hold closes only with provider evidence or an audited manager release.
- **I5** A paid notice is captured only when the hold is active and amount and basis match; otherwise it is parked as unallocated (closed hold, amount mismatch) or yields one pending refund (legacy branch), never a capture.
- **I6** Each provider payment is captured at most once.

Only cases 16 and 17 leave the customer temporarily paid twice. Both need the
provider to accept a payment after it reported the QR closed, or a manager
release; both end parked as unallocated money that the outlet holds until a manager returns it.

## 8. Acceptance tests (write first, see them fail)

Files: `apps/api/src/test/pos-qris-hold.test.ts` (new),
`apps/api/src/test/pos-customer-display.test.ts` (new), and
`apps/api/src/test/pos-qris-deposit-money.test.ts` from `origin/ws/qris-dp-due`
(cherry-pick 54682a08; MONEY-04 changes: the raw `UPDATE orders SET
deposit_applied_idr` while the QR is authorized must now fail with
`QRIS_HOLD_ACTIVE`, and the old-QR expectation moves to QH-14 (one unallocated record + alert)).
Use the fake gateway of the existing tests (`fixture.gateway`), extended with a
scripted status answer per intent (`00`/`01`/`02`, error, other reference) and
a controllable clock for `expires_at`.

- QH-01..QH-19 and QD-01..QD-03: one test per row of §7, named with the case.
- QH-23 `handlePosPaymentClosed` does nothing while a hold is active (`payment.expired` at `expires_at` + 1 s): tender stays `authorized`, the outbox consumer does not fail.
- QH-24 the hold check job closes only with raw `02` (or DOIT expired/failed) at or after `expires_at` + 60 s; a mapped `expired` without raw code does not close.
- QH-20 trigger backstop: raw SQL on `orders` money columns, on tenders
  insert/status, and hold DELETE/backward transition, each refused.
- QH-21 cancel is idempotent: two cancels, one state change, one immediate status read.
- QH-22 lock order: webhook apply and cashier cancel at the same time end in
  `paid` with no deadlock (run 20 times).
- QD-04 pairing: wrong code 5 times → 429; expired code refused; code reused
  refused; second pairing revokes the first; cross-tenant code refused.
- QD-05 `version` strictly increases on selection, money and hold changes.
- Cross-tenant isolation for the three new display tables and `pos_qris_holds`
  in `db/rls.test.ts` / `db/outlet-rls.test.ts` allowlists.

Red proof: QH-03, QH-05, QH-07, QH-11, QH-20, QH-23 must fail on m1 before the fix.

## 9. Cards (children of `legend-yhia9`)

All tier K. Order: T first (red), then C1; C2 and C3 in parallel after C1;
U1 after C2, C3 and S1; Codex second opinion for the payment area before the release gate.

| Card | Who         | Scope                                                                                                                                                                                                                                                                             | Main files                                                                                                                                                                                                                     | Depends on                              |
| ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| T    | test-writer | §8 tests, red on m1, cherry-pick MONEY tests                                                                                                                                                                                                                                      | `test/pos-qris-hold.test.ts`, `test/pos-customer-display.test.ts`, `test/pos-qris-deposit-money.test.ts`, fake gateway helper                                                                                                  | —                                       |
| C1   | engineer    | 0419 + 0420, Drizzle schema, hold service (issue, cancel, guard), service guards in every money mutator, `voidPendingQrisTenders` callers → 409/cancel, hold row in the POS tx, update lock-order comment in `payment-late-settlement.ts`                                         | `drizzle/0419_*.sql`, `drizzle/0420_*.sql`, `db/schema/pos-qris-hold.ts` (new), `services/pos-qris-hold.ts` (new), `pos-order-payment.ts`, `pos-order.service.ts`, `pos-order-support.ts`                                      | T                                       |
| C2   | engineer    | `handlePosPaymentPaid` hold logic (D-05, D-07), `handlePosPaymentClosed` hold-aware (D-04), hold check job `worker/pos-qris-hold-check.job.ts` on cloud and edge (D-04), `rawStatus` on `GatewayPaymentStatus`, provider from `intent.provider` (D-03), alerts, edge check (D-09) | `pos-order-payment.ts` (`handlePosPaymentPaid`), `payment.service.ts` (poll outcomes), `payment-duitku.ts`, `payment-doit-wire.ts`, `pos-order-late-payment.ts`, `order-payment-consumers.ts`, `payment-gateway.ts`, `worker/` | C1; merge gated on S1                   |
| C3   | engineer    | 0421, pairing codes, pairing, selection, state endpoint, display device auth, `version` triggers                                                                                                                                                                                  | `drizzle/0421_*.sql`, `db/schema/customer-display.ts` (new), `services/customer-display.service.ts` (new), `routes/customer-display.routes.ts` (new), `routes/index.ts`, `packages/shared/src/pos/`                            | C1                                      |
| U1   | ui-engineer | Lift DP HOLD on display (`displayPayMode`), cashier cancel + "menunggu konfirmasi" state, pairing screen                                                                                                                                                                          | `apps/web/src/features/ws04-display/*`, `ws04-pos-kasir/*`                                                                                                                                                                     | C2, C3, S1, founder review              |
| F1   | engineer    | Follow-up: other local link cancels that ignore the provider (reservation DP link `reservation-lifecycle.ts:532`, `facility-breakfast-money.ts:405`, `order-recovery-charge*`)                                                                                                    | per file                                                                                                                                                                                                                       | C2                                      |
| S1   | engineer    | Sandbox proof with real DOIT/Duitku keys: `02` only after expiry, paid after expiry possible or not, shortest accepted `expiryPeriod`. Gate before C2 merges (D-03).                                                                                                              | test notes in `docs/`                                                                                                                                                                                                          | payment keys (founder sends at the end) |

`legend-y5d2r` closes after U1.

## 10. Questions for CTO (founder decisions, with recommendation)

- **Q1 Lama QR berlaku di kasir.** Setelah kasir membatalkan QR, tagihan
  terkunci sampai QR itu benar-benar kedaluwarsa di penyedia, karena DOIT dan
  Duitku tidak bisa membatalkan QR. Sekarang QR berlaku 10 menit, jadi kasir
  bisa menunggu sampai sekitar 11 menit sebelum menerima tunai atau memasang
  DP. **Rekomendasi:** turunkan masa berlaku QR di kasir menjadi 5 menit
  (tunggu maksimal sekitar 6 menit), setelah dicek di sandbox (kartu S1).
  Dampak: pelanggan punya 5 menit untuk membayar; bila lewat, kasir menerbitkan
  QR baru dengan satu ketukan. Alternatif: tetap 10 menit. (Teknis: masa berlaku dikirim dari `addPosTender` lewat `expiresAt`, bukan mengubah `INTENT_LIFETIME_MINUTES.qris`, karena pesanan QR meja ikut memakainya.)
- **Q2 Penyedia tidak bisa dihubungi.** Bila server penyedia atau internet
  outlet mati, sistem tidak bisa membuktikan QR lama sudah mati, jadi tagihan
  tetap terkunci. **Rekomendasi:** manajer boleh membuka kunci lewat persetujuan
  manajer (PIN), hanya 30 menit setelah QR kedaluwarsa, tercatat di audit. Bila
  ternyata QR lama tetap terbayar, uangnya masuk daftar dana tak teralokasi;
  outlet memegang uangnya dan manajer mengembalikannya ke pembayar (outlet tidak
  rugi). Alternatif: tidak ada buka kunci; tagihan menunggu sampai penyedia
  menjawab (pelanggan mungkin pergi tanpa membayar).

Technical choices taken by the architect (no founder input needed): freeze
the whole bill rather than only the DP (D-01); hold per order, not per split
(D-02); apply a payment that lands during cancel instead of refunding it (D-05).

## 11. Outside this design (noted, not solved)

- A cloud webhook for an intent created on an edge finds no row in the cloud;
  the provider retries 5 times then emails. Money is not lost (the edge poll
  finds the payment), but the noise needs a card for WS-02 owners.
- Other flows that cancel a payment link only locally (F1).
- Refund approval speed for case 16/17 stays with WS-05 (existing pending queue).
