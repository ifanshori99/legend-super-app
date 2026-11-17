# Design: Auto-journals F19 (legend-9pz9, incl. legend-o9q9, legend-kej3, legend-fbms)

Status: design, 9 Nov 2026. Branch `ws/dp-late-journal` (base milestone/m1 3143577d).
Tier K (money, migration, journal contract): architect review + Codex second opinion before the release gate.
Points marked **TBD-verify** were not confirmed in code; the implementer checks them first.

## 1. Decision

One cloud-only outbox consumer, `accounting-auto-journal-consumer.ts`, posts every automatic
money journal through the existing engine (`postJournalFromRuleInTransaction`). It copies the
proven `inventory-gl-consumer.ts` pattern: savepoint per posting, park on expected accounting
errors, sweep retries, never block cloud-sync delivery.

Gateway money uses a **receipt-first** model with one liability role, `customer_deposit`
("Uang Muka Pelanggan"):

| Fact                                                        | Event                                                                    | Journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway money received (any intent: sale, DP, late, double) | `payment.paid`                                                           | Dr gateway_clearing / Cr customer_deposit (receivedIdr)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sale paid                                                   | `order.paid`                                                             | Dr cash / customer_deposit (intent-backed gateway + DP applied) / gateway_clearing (gateway without intent) / edc_clearing / loyalty_liability / sales_discount; Cr sales_revenue, service_charge, tax_payable_pbjt, rounding                                                                                                                                                                                                                                                   |
| Sale refunded                                               | `order.refunded`                                                         | mirror; gateway part Cr customer_deposit (owed to guest until payout)                                                                                                                                                                                                                                                                                                                                                                                                           |
| Gateway money paid back                                     | `payment.refunded`                                                       | Dr customer_deposit / Cr gateway_clearing. Backed by a posted receipt (fund or intent) and bounded by time, section 10                                                                                                                                                                                                                                                                                                                                                          |
| Gateway money the provider returned on its own              | `payment.provider_refunded`                                              | Dr customer_deposit / Cr gateway_clearing (legend-tlm3h). Backed by the posted intent receipt (pending waits, missing parks); capped only against the receipt at its own (created_at, id) bound: our earlier payouts + provider refunds up to it <= receipt. Sales are not counted: money already left, so a refund after the sale still books and customer_deposit may stand in debit (finance signal). Our next payout stays capped (provider refunds count as payouts there) |
| Completed sale voided                                       | `order.voided` (voidedFinalOrder true)                                   | reverses the `aj:sale:<orderId>` journal (cash-only sales; section 10). Open-order void: ignored                                                                                                                                                                                                                                                                                                                                                                                |
| DP forfeited                                                | `reservation.cancelled`, `reservation.no_show` (depositForfeitedIdr > 0) | Dr customer_deposit (gateway_clearing if the DP predates the cutover) / Cr deposit_forfeit_income                                                                                                                                                                                                                                                                                                                                                                               |
| Cash over/short                                             | `cashier_shift.closed`                                                   | existing rule (differenceIdr)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Gateway settlement + MDR                                    | `settlement.reconciled`                                                  | existing rule (Dr bank net, Dr gateway_fee_expense fee, Cr gateway_clearing gross). Journal date = `settledOn`. No backing guard: over-settlement is a reconciliation case, not a park                                                                                                                                                                                                                                                                                          |
| EDC settlement + MDR                                        | `edc_transaction.settled`                                                | existing rule (Dr bank net, Dr gateway_fee_expense fee, Cr edc_clearing gross). Journal date = `settledOn`. No backing guard, same as gateway settlement                                                                                                                                                                                                                                                                                                                        |
| Cash deposit to bank                                        | `cash_deposit.recorded` / document `cash_deposit`                        | existing rule (Dr bank / Cr cash_on_hand)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| End of day                                                  | `day.closed`                                                             | **no journal** (recap only; posting it would double count sales)                                                                                                                                                                                                                                                                                                                                                                                                                |

Why receipt-first: `gateway_clearing` then equals exactly what the gateway received per intent,
so settlement reconciles (the o9q9 bug). DP receipts, late payments, double payments and
payments on voided orders all get a journal on the day the money arrived, with no lookup of
"will this become a sale". `customer_deposit` holds every customer advance: DP held, late or
double payments awaiting refund, and gateway refunds awaiting payout. It should net to the open
DP balance plus pending refunds; that is a usable control.

Cutover/ordering guard (`order.paid`, per intent-backed gateway tender): the receipt under
`aj:receipt:<intentId>` is **posted** (journal exists: Dr customer_deposit), **pending**
(`payment.paid` not yet delivered in the `cloud-sync` outbox, or its receipt parked retryable:
the sale parks retryable `AUTO_JOURNAL_RECEIPT_PENDING` and the sweep posts it later) or **none**
(never emitted, consumed before wiring or with accounting off, or parked non-retryable: Dr
gateway_clearing, so the money is booked once). The outbox is read before the journal, so a
receipt committing between the reads is seen as pending, never as none.

Revenue split (`orderRevenueSplit`, `apps/api/src/services/order-revenue.ts`): POS and QR `order.paid`
take their amounts from the order row. `pricesIncludeTax` picks the identity. Exclusive:
subtotal - discount + service charge + tax + rounding = total, gross = subtotal. Inclusive:
subtotal - discount + rounding = total, gross = subtotal - service charge - tax. If the identity
fails the split throws `OrderRevenueMismatch` (fail closed). Output: gross sales, discount,
service charge, PBJT, rounding, total.

QR sale: a QR order paid first has no `pos_orders` row. It is a sale when `orders.channel = 'qr'`,
`payment_mode = 'pay_first'` and `fired_at` is set. `fireQrOrder` appends `order.paid` (channel `qr`)
in the same transaction that sets `fired_at`, only for reasons `verified_payment` and `deposit`.
Tender is `total - DP` on the intent that paid (pinned in `orders.payment_intent_id`); nothing left
to pay means no tenders and `paidGatewayIdr` 0. Sale time = `fired_at`.

Total-0 orders (fbms, design A): `order.paid` is emitted for total 0 too (tenders may be empty, `totalIdr`
is non-negative), so recipe deduction runs once per order. The auto-journal consumer ignores an
`order.paid` whose every amount is 0: no journal, no park. A full comp (gross 100, discount 100)
still posts the discount/sales pair.

Why one role, not a separate "unapplied receipts" role: the CTO decision authorised exactly one
liability role. A split can come later by mapping, without rule churn in consumers.

## 2. Rule changes (`packages/shared/src/accounting/`)

`coa.ts`

- `POSTING_ACCOUNT_ROLES`: add `customer_deposit: "liability"`, `deposit_forfeit_income: "revenue"`.
- `standardFnbChartTemplate` rows: `["2107", "Uang Muka Pelanggan", "current_liability", "2100", ["customer_deposit"]]`
  and an "other income" row for `deposit_forfeit_income` under the revenue header
  (code and account type **TBD-verify**: pick the next free 4xxx code and the type the template
  uses for other income). Check that 2107 is free (**TBD-verify**, 2101..2106 are taken).

`journal.ts` + DB check: add source type `customer_deposit` (receipts, forfeits). Refunds keep `refund`.

`posting-rules.ts`

- Header comment: replace "payment.paid and payment.refunded post nothing" with the receipt-first text above.
- `order.paid` lines become:
  `cash_on_hand Dr paidCashIdr`, `customer_deposit Dr paidGatewayIntentIdr`,
  `customer_deposit Dr paidDepositIdr`, `gateway_clearing Dr paidGatewayIdr` (gateway tender without
  an intent; expected 0, **TBD-verify** such tenders exist), `edc_clearing Dr paidEdcIdr`,
  `loyalty_liability Dr paidPointsIdr`, `sales_discount Dr discountIdr`,
  `sales_revenue Cr grossSalesIdr`, `service_charge Cr serviceChargeIdr`,
  `tax_payable_pbjt Cr pbjtIdr`, `rounding Cr roundingIdr` (negative flips side, already supported).
- `order.refunded`: `gateway_clearing Cr refundGatewayIdr` becomes `customer_deposit Cr refundGatewayIdr`.
- New `payment.paid` (sourceType `customer_deposit`): `gateway_clearing Dr receivedIdr`, `customer_deposit Cr receivedIdr`.
- New `payment.refunded` (sourceType `refund`): `customer_deposit Dr amountIdr`, `gateway_clearing Cr amountIdr`.
- New `payment.provider_refunded` (legend-tlm3h, sourceType `refund`): `customer_deposit Dr amountIdr`, `gateway_clearing Cr amountIdr`. One event per newly recorded `payment_provider_refunds` row (same transaction as the insert); receipts stay gross, so gateway_clearing ends at what the gateway kept.
- New `reservation.cancelled` and `reservation.no_show` (sourceType `customer_deposit`):
  `customer_deposit Dr forfeitedIdr`, `gateway_clearing Dr forfeitedGatewayIdr` (slice 2: DP paid
  before the cutover), `deposit_forfeit_income Cr forfeitedIdr`, `deposit_forfeit_income Cr forfeitedGatewayIdr`.
- Settlement, EDC settlement, cashier shift, cash deposit rules: unchanged.

Event catalog (`events/catalog.ts`): no new names needed; every trigger above is already
catalogued. Payload schemas are added where missing (section 3).

## 3. Event payloads

The consumer parses only the fields it needs, with a consumer-local zod schema (`z.object`,
not strict, so emitter additions do not break it). Amounts are whole rupiah.

| Event                                     | Fields used                                                                                                                                                       | Natural money time                                           | Extra reads                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `order.paid`                              | orderId, outletId, grossSalesIdr, discountIdr, serviceChargeIdr, pbjtIdr, roundingIdr, totalIdr, paidCash/Gateway/Edc/PointsIdr, paidDepositIdr (slice 2), paidAt | paidAt                                                       | `pos_order_tenders` gateway rows: with `payment_intent_id` -> paidGatewayIntentIdr, without -> paidGatewayIdr      |
| `order.refunded`                          | refundId, orderId, gross/discount/serviceCharge/pbjtIdr, refundCash/Gateway/Edc/PointsIdr, refundedAt                                                             | refundedAt                                                   | none                                                                                                               |
| `payment.paid`                            | intentId, method, provider, receivedIdr, paidAt, late; envelope outletId                                                                                          | paidAt                                                       | `payment_intents.edc_transaction_id`; skip EDC-linked intents (**TBD-verify** EDC intents emit payment.paid)       |
| `payment.refunded`                        | refundId, paymentIntentId, amountIdr                                                                                                                              | `payment_refunds.completed_at` (payload lacks it)            | read refund row; skip EDC-linked intents                                                                           |
| `payment.provider_refunded`               | providerRefundId, paymentIntentId, amountIdr, refundedAt                                                                                                          | `payment_provider_refunds.created_at` (row is the authority) | read the row; skip EDC-linked intents and echoes of our own refunds; park a refund of a fund held whole            |
| `reservation.cancelled/no_show`           | reservationId, depositForfeitedIdr; envelope outletId                                                                                                             | envelope occurredAt (closedAt)                               | `reservations` row (outlet, status, depositForfeitedIdr must match); DP intents (`payment_intents.reservation_id`) |
| `cashier_shift.closed`                    | shiftId, outletId, differenceIdr, closedAt                                                                                                                        | closedAt                                                     | `pos_shifts` row (closed, same outlet, varianceIdr must match)                                                     |
| `settlement.reconciled` v1 (new schema)   | settlementId, provider, outletId, settledOn, grossIdr, feeIdr, netSettledIdr; refine gross = net + fee                                                            | settledOn                                                    | none                                                                                                               |
| `edc_transaction.settled` v1 (new schema) | settlementBatchId, terminalId, outletId, settledOn, grossIdr, feeIdr, netSettledIdr                                                                               | settledOn                                                    | none                                                                                                               |
| `cash_deposit.recorded` v1 (new schema)   | cashDepositId, outletId, amountIdr, depositedOn                                                                                                                   | depositedOn                                                  | none                                                                                                               |

`order.paid` schema changes (`packages/shared/src/pos/events.ts`):

- Slice 2: add `paidDepositIdr: nonnegativeIdr` (default 0) to the bucket sum refine; tenders sum = total - paidDepositIdr.
- Slice 3 (fbms design A): `totalIdr` nonnegative, `tenders` may be empty, refine allows 0.

Slice 2, verified 9 Nov (resolves the TBD-verify notes above):

- `reservation.*` payload (`reservation-lifecycle.ts:498`, `reservation-public.ts:586`) is
  {reservationId, closedBy, reason, depositPaidIdr, depositRefundIdr, depositForfeitedIdr,
  policyVersion}; the system cancels (`reservation-booking.ts:416`, `reservation-core.ts:761`)
  always send 0 and post nothing. forfeited = held DP - refund, written to the row with the event.
- `cashier_shift.closed` (`pos-shift.service.ts:1384`): differenceIdr = countedIdr - expectedIdr
  (= `pos_shifts.variance_idr`), signed; 0 posts nothing.
- DP placement (`depositReceiptOf`): every DP intent's receipt posted -> customer_deposit; none ->
  gateway_clearing (`paidGatewayIdr` on order.paid, `forfeitedGatewayIdr` on the forfeit); any
  pending -> `AUTO_JOURNAL_RECEIPT_PENDING`; mixed -> `AUTO_JOURNAL_DEPOSIT_CUTOVER_MIXED`
  (not retryable). order.paid reaches the DP through `orders.table_session_id` ->
  `reservation_deposit_allocations` and requires paidDepositIdr = `orders.deposit_applied_idr`.
- `order.refunded` has no DP leg (`pos-order-corrections.ts:520`): no refund split needed.

Legal entity: `outlets.legal_entity_id` of the event outlet (same query as inventory-gl :414).
Null -> park `OUTLET_LEGAL_ENTITY_MISSING`. Tenants without the accounting module: `ignored`.

## 4. Idempotency key per event

Business-fact keys, prefix `aj:`, sha256 fallback above 100 chars (as `idempotencyKeyOf`).

| Event                                | Key                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| order.paid                           | `aj:sale:<orderId>`                                                                                   |
| order.refunded                       | `aj:order-refund:<refundId>`                                                                          |
| order.voided (voidedFinalOrder true) | `aj:sale-void:<orderId>`                                                                              |
| payment.paid                         | `aj:receipt:<event.id>` (one event per money arrival; a double payment is a new event) **TBD-verify** |
| payment.refunded                     | `aj:payout:<refundId>`                                                                                |
| payment.provider_refunded            | `aj:provider-refund:<providerRefundId>`                                                               |
| reservation.cancelled / no_show      | `aj:dp-forfeit:<reservationId>`                                                                       |
| cashier_shift.closed                 | `aj:shift:<shiftId>`                                                                                  |
| settlement.reconciled                | `aj:settlement:<settlementId>`                                                                        |
| edc_transaction.settled              | `aj:edc-settlement:<settlementBatchId>`                                                               |
| cash_deposit.recorded                | `aj:cash-deposit:<cashDepositId>`                                                                     |

Rule: before computing the date, look the key up in `journal_entries`. Found -> `already_posted`
(no-op). This avoids `IDEMPOTENCY_KEY_REUSED` when a retry would compute a different
(rolled-forward) date than the first post. A `pg_advisory_xact_lock(hashtext(key))` serializes
the consumer and the sweep.

Emitter contract for settlement events (beads legend-3a5m, legend-jlqi, legend-cs7):

- Each bank payout has exactly one emitter and one event. EDC payouts (stored as provider
  `edc_<bank>`) are emitted only as `edc_transaction.settled`. `settlement.reconciled.provider`
  is an allow-list of gateway providers (`GATEWAY_SETTLEMENT_PROVIDERS`, today `doit` and `duitku`); EDC bank
  codes (bca, mandiri, bni, bjb) and `edc_<bank>` are rejected. A new gateway provider is added
  to that list (a schema change).
- One event per outlet. `settlementId` / `settlementBatchId` is unique per tenant: the emitter
  dedupes by provider + bank statement line or provider reference, so a re-imported bank file
  never makes a new id.
- Emit once, when the settlement is final. A replay with other amounts is ignored
  (`already_posted`), so a correction is a manual journal.
- `netSettledIdr` must be >= 0. A day where refunds exceed the payout is booked manually by finance.
- Net goes to the entity's single `bank` mapping. A `bankAccountId` field is a v2 (breaking) change.

## 5. Late-adjustment date logic (CTO decision 1, applied to every event of this consumer)

1. `naturalDate = businessDateOf(moneyTime, outletBusinessDayClock(outlet))` (`outlet-clock.ts`).
2. `wouldPostingBeBlockedByClosedPeriod(tx, tenant, entity, periodOf(naturalDate))` (takes the
   entity FOR SHARE lock, so close/reopen cannot race the post in the same transaction).
3. Not blocked -> `entryDate = naturalDate`, `lateAdjustmentFrom = null`.
4. Blocked -> `latest = max(period) where status = 'closed'` for the entity;
   `entryDate = first day of nextPeriod(latest)` (`period-key.ts`), `lateAdjustmentFrom = naturalDate`.
   Periods are monthly and the gate rejects any date before a later closed month, so this is the
   first open day after. `lockFiscalPeriod` creates the target month if missing (**TBD-verify**).
5. Flag: new nullable column `journal_entries.late_adjustment_from` (business date), CHECK
   `late_adjustment_from IS NULL OR late_adjustment_from < entry_date`. Included in the request
   fingerprint. Description suffix ` (penyesuaian terlambat dari <date>)`.
6. Audit: `auditAccountingChange` action `accounting.journal.late_adjusted`
   {journalId, eventName, sourceId, originalDate, entryDate}, same transaction (**TBD-verify** signature, accounting-shared.ts:122).

Pure part goes to shared `late-adjustment.ts`: `resolveAutoJournalDate(naturalDate, latestClosedPeriod)`.

Why for every event, not only `late=true` payments: any money fact that reaches a closed month
(edge offline, outbox backlog) is the same situation. Consistent with the 8 Nov edge-offline
decision. Note: inventory GL still parks on PERIOD_CLOSED (follow-up bead, section 9).

## 6. Failure parking

Table `auto_journal_parked` (T, outlet-owned; RLS `app.enforce_tenant_rls` + `app.enforce_outlet_rls` as in 0087):
`tenant_id uuid NOT NULL, outlet_id uuid NOT NULL, idempotency_key varchar(100) NOT NULL,
event_id text NOT NULL, event_name varchar(80) NOT NULL, payload jsonb NOT NULL (ids + amounts only, no PII),
error_code varchar(60) NOT NULL, retryable boolean NOT NULL, attempts int NOT NULL default 1,
first_failed_at, last_failed_at timestamptz NOT NULL, next_retry_at timestamptz NULL`;
UNIQUE (tenant_id, idempotency_key); INDEX (tenant_id, next_retry_at).

- Retryable (park, sweep retries every 10 min): `ACCOUNT_MAPPING_MISSING`, `ACCOUNT_INACTIVE`,
  `ACCOUNT_NOT_POSTABLE`, `ACCOUNT_ENTITY_MISMATCH`, `OUTLET_LEGAL_ENTITY_MISSING`, `PERIOD_CLOSED` (race only),
  `AUTO_JOURNAL_RECEIPT_PENDING` (backing receipt not yet posted), `AUTO_JOURNAL_SALE_PENDING` (void waits for its sale journal).
- Not retryable (park, `next_retry_at = null`, finance sees it): any other `AccountingError`
  (`POSTING_AMOUNTS_MISMATCH`, `JOURNAL_UNBALANCED`, `IDEMPOTENCY_KEY_REUSED`, `JOURNAL_ALREADY_REVERSED`),
  `AUTO_JOURNAL_PAYLOAD_INVALID`, `AUTO_JOURNAL_RECEIPT_MISSING` (payout whose receipt will never post),
  `AUTO_JOURNAL_SALE_MISSING` (void whose sale journal will never post), `AUTO_JOURNAL_VOID_UNSUPPORTED`
  (void of a sale with gateway, EDC, points or deposit money; finance corrects). Deterministic,
  so retrying the outbox would only block cloud-sync until dead letter.
- Ignored, not parked: `order.paid` with every amount 0 (consumer returns null, section 1).
- Non-`AccountingError` (DB, transient): propagate; outbox retry as today.
- Success after parking deletes the row. Sweep `retryParkedAutoJournals(context, now)`: batch 100,
  rebuilds from the stored payload (no outbox replay needed), recomputes the date (section 5).

## 7. Backfill migration

Two migration files (number = next free after rebasing on the latest m1; batch4 already
uses up to 0132, so **do not use 0113 blindly**):

A. DDL (drizzle-generated): `auto_journal_parked`; `journal_entries.late_adjustment_from` + CHECK;
replace `journal_entries_source_type_check` with the list plus `customer_deposit`.
B. Hand-written: RLS for `auto_journal_parked`, then per legal entity:

- insert account `2107 Uang Muka Pelanggan` (current_liability) under that entity's `2100`
  header; `ON CONFLICT DO NOTHING`; only entities that already have header `2100`;
- insert mapping role `customer_deposit` to that account only when the row with code 2107 has
  that name and type (never map a tenant's own different 2107);
  `ON CONFLICT (tenant_id, legal_entity_id, role) DO NOTHING`;
- same two steps for `deposit_forfeit_income`.
  Entities without the headers get nothing; their postings park `ACCOUNT_MAPPING_MISSING` until
  finance maps the role. Trigger 0027:324 (parent/type) is satisfied by the header choice.
  Table and column names, and whether the migration role bypasses forced RLS: **TBD-verify**
  against earlier data migrations.
  No historical journal backfill: auto-journals start at deploy. Opening balances stay manual.

## 8. Slice order

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Gate                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1     | Roles, rules, source type, late-adjustment, parking, backfill, consumer for order.paid (POS), order.refunded, payment.paid, payment.refunded; wiring patch                                                                                                                                                                                                                                                                                                                                                                                                           | now                                                                                             |
| 2     | DP applied: `paidDepositIdr` in order.paid schema, remove fail-closed at `pos-order.service.ts:1141`, no DP leg on order.refunded (verified); forfeit handler; `cashier_shift.closed` handler                                                                                                                                                                                                                                                                                                                                                                        | after 1                                                                                         |
| 3     | Done in code (ws/aj-qr-sale). kej3: emit `order.paid` from QR fire path (`fireQrOrder`, `qr-order-paid.ts`), gateway intent tender, paidAt = `orders.fired_at` (same instant), paidDepositIdr = depositApplied; shared `order-revenue.ts` `orderRevenueSplit()` (exclusive if subtotal - discount + svc + tax + rounding = total, gross = subtotal; inclusive if subtotal - discount + rounding = total, gross = subtotal - svc - tax; else fail closed). fbms design A: schema nonnegative, drop `if (order.totalIdr > 0)` (:1220), consumer skips all-zero amounts | after batch3 + batch4 are in m1 (inclusive QR, recipe deduction, qr-order-consumers +167 lines) |
| 4     | Settlement + MDR: **done in code** (payload schemas for `settlement.reconciled` / `edc_transaction.settled`, consumer handlers, tests with synthetic events). Business date = `settledOn`. No backing guard: over-settlement is a reconciliation case, not a park. Emitters pending: legend-3a5m, legend-jlqi, legend-cs7 (settlement import ledger, `payment-admin-reconciliation.service.ts:144`)                                                                                                                                                                  | after 1                                                                                         |
| 5     | Cash deposit: `accounting-cash-deposit.service.ts` posting document `cash_deposit` + emitting `cash_deposit.recorded`; route registration through a second wiring patch                                                                                                                                                                                                                                                                                                                                                                                              | after 1                                                                                         |

Slice 4 emitters must follow the emitter contract in section 4: one emitter per payout, EDC only
via `edc_transaction.settled`, one event per outlet, id unique per tenant and bank line, emit once
when final (corrections are manual), net >= 0, `bankAccountId` is v2.

Slices 1 and 3 must both land before the release gate: until 3, QR receipts sit in
`customer_deposit` with no sale.

Slice 2 deploys API and web together: `posOrderBaseSchema` is strict and the web client
validates every response against it (`apps/web/src/lib/api/endpoint-core.ts:121`), so an
old web build answers a new API's POS order with `RESPONSE_SHAPE_INVALID` (and the reverse).
Slice 2 also decides the DP source on the exact intents only (the session's
`reservation_deposit_allocations.payment_intent_id` for a sale, `reservations.deposit_payment_id`
for a forfeit), parks a sale whose session applies more DP than those intents still hold
(`POSTING_AMOUNTS_MISMATCH`, not retryable), and refuses a linked void of a sale paid with DP
(409 CONFLICT, refund instead).

### Slice 1 files (no forbidden file; about 740 non-test lines)

| File                                                                         | Change                                                                                                                                                            | Est. lines |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| packages/shared/src/accounting/coa.ts                                        | 2 roles, 2 template rows                                                                                                                                          | 15         |
| packages/shared/src/accounting/posting-rules.ts                              | header, order.paid, order.refunded, payment.paid, payment.refunded, reservation forfeit rules                                                                     | 50         |
| packages/shared/src/accounting/journal.ts                                    | source type `customer_deposit`                                                                                                                                    | 2          |
| packages/shared/src/accounting/late-adjustment.ts (new)                      | `resolveAutoJournalDate`                                                                                                                                          | 40         |
| packages/shared/src/accounting/index.ts                                      | export                                                                                                                                                            | 1          |
| apps/api/src/db/schema/accounting.ts                                         | `late_adjustment_from`, source CHECK                                                                                                                              | 12         |
| apps/api/src/db/schema/accounting-auto-journal.ts (new) + db/schema/index.ts | parked table                                                                                                                                                      | 50         |
| apps/api/drizzle/<next>_auto_journals.sql + meta (generated)                 | DDL                                                                                                                                                               | 30         |
| apps/api/drizzle/<next+1>_auto_journals_backfill_rls.sql                     | RLS + backfill                                                                                                                                                    | 70         |
| apps/api/src/services/accounting-journal.service.ts                          | `lateAdjustmentFrom` in inputs, fingerprint, insert                                                                                                               | 20         |
| apps/api/src/services/accounting-auto-journal-amounts.ts (new)               | per-event parse, amounts, keys, money time                                                                                                                        | 130        |
| apps/api/src/services/accounting-auto-journal-consumer.ts (new)              | deliver, date, park, sweep, audit                                                                                                                                 | 320        |
| docs/briefs/141-auto-journals-wiring.patch (new)                             | worker-main.ts: import, `if (postsInventoryGl) await deliverAutoJournalEvent(context, event, tx)` after the inventory GL call, sweep in relay tick with try/catch | patch      |

Tests (not counted): `apps/api/src/test/accounting-auto-journal.test.ts` (each event balanced,
replay no-op, late payment into closed month rolls to first open day + flag + audit, mapping
missing parks then sweep posts, cross-tenant isolation of the parked table, accounting module off
ignored), `packages/shared/src/accounting/posting-rules.test.ts`, `late-adjustment.test.ts`.
Run with `LEGEND_TEST_FILES=...`.

Forbidden, untouched: `worker-main.ts`, `app.ts`, `routes/index.ts`, `edge/runtime.ts`,
DOIT adapter + webhook, refund module (`payment-refund.service.ts` read-only via events),
`crm-promo-refund.ts`.

## 9. Risks

1. Migration number collision: batch4 holds 0113..0132. Rebase on the latest m1 before `pnpm db:generate`.
2. Receipt-first assumes every intent-backed gateway tender has a `payment.paid`, and EDC-linked
   intents are excluded. Wrong -> `customer_deposit` drifts. Verify first; add a test per path.
3. Gateway refunds paid outside the refund module (no `payment.refunded`) would leave a credit in
   `customer_deposit` (**TBD-verify**).
4. Inventory GL parks PERIOD_CLOSED while sales roll forward: COGS and sales can sit in different
   months. File a follow-up bead to align.
5. An admin `replayOutbox` of old events would post historical journals into the current month
   (flagged). Acceptable; CTO may ask for a cutover guard.
6. Adding template rows can change shared fixtures and tests that count accounts.
7. Journal contract change (source type, column, fingerprint) is tier K: architect + Codex.

## 10. Codex 142 fixes (legend-9pz9 second opinion)

Codex second opinion (`docs/briefs/142-second-opinion-auto-journals.result.md`) found four High issues:

- F1: `payment.refunded` posted Dr customer_deposit without a customer_deposit credit for the payout.
- F2: completed-sale void (`order.voided`, voidedFinalOrder true) never reversed `aj:sale:<orderId>`. Cash returns via drawer; gateway and EDC voids are also allowed.
- F3: payout guard ignored forfeited DP. Receipt 100, forfeit 100, then a refund of the same intent 100 debited customer_deposit twice.
- F4: guards read current state (order status, refunds so far). A later change alters facts that already parked or posted. Order-dependent.

Rule for every fix: the same historical facts give the same result regardless of event delivery order. A posting parks rather than post an unsupported debit.

### Time bounds

- Refund bound B = (`payment_refunds.completed_at`, refundId).
- Sale bound S = (`pos_orders.completed_at`, orderId) of the sale.
- Forfeit bound = `reservations.closed_at`.
- Tie rule: on equal time the sale counts as earlier than a refund or forfeit; the forfeit counts as earlier than a refund.
- Read only rows final at that time: completed refunds, completed orders, closed reservations. Never read current status without a time bound.
- Bound times are read in SQL from the fact's own row, never through a JS `Date`: `Date` keeps milliseconds, `timestamptz` microseconds, so a round-tripped bound can drop the fact's own row.

### QR sale time (slice 3, closes U3)

- Sale time, read in SQL only (microsecond safe): `saleAt(o)` = `pos_orders.completed_at` when a `pos_orders` row exists, else `o.fired_at` when `o.channel = 'qr'` and `o.payment_mode = 'pay_first'`, else null.
- Sale bound S = (`saleAt`, `orders.id`). Orders with null `saleAt` (open bills, non `pay_first`) are not sales and are excluded. A null `saleAt` on the sale being checked -> `AUTO_JOURNAL_PAYLOAD_INVALID`.
- DP applied (sale with DP) reads orders through `saleAt`, so QR sales count.
- Payout, intent backing: besides POS tenders, add `sum(total - deposit_applied)` over QR sales with `payment_intent_id` = the refunded intent and `saleAt` bound <= B (tie: sale earlier).
- QR `order.paid` (no `pos_orders` row): `fired_at` must be set and the payload must equal the split of the order row. `paidGatewayIdr` = `total - DP`; when > 0 the pinned intent must be paid on the order's payment link. Receipt state of that intent: posted -> book `paidGatewayIntentIdr`; none -> `paidGatewayIdr` (pre-cutover); pending -> park retryable. DP follows the existing deposit receipt path.
- Void: no change. The correction void refuses a total-0 sale (`pos-order-corrections.ts`) and its row needs a `pos_orders` row, so neither a total-0 sale nor a QR pay-first sale reaches a final void; such an event parks `AUTO_JOURNAL_PAYLOAD_INVALID` on the void row check.
- Sale-side balance check (review K slice 3): a QR gateway sale of intent I runs `assertSaleWithinReceipt` at bound S: captured POS tenders, QR sales, forfeits and payouts backed by I up to S (tie: the sale is earlier) may not exceed I's posted receipt credit, else `POSTING_AMOUNTS_MISMATCH`. So a refund of I completed before the fire posts and the sale parks, in any delivery order. The pinned intent's amount must cover `total - DP`. Still open: POS intent tenders have no sale-side check (existing behaviour, follow-up), and a row that commits late with an earlier timestamp (U4).

### Backing receipt

- Intent backing: `aj:receipt:<intentId>` (outbox `payment.paid`).
- Fund backing: `aj:receipt-fund:<fundId>` (outbox `payment.funds_unallocated`), when the refund has `unallocatedFundId` and that fund has that event. Otherwise intent backing (fund counted inside `payment.paid`).
- Backing state `posted` / `pending` / `none`, same order as section 1: outbox, parked, journal.
- Sale backing: `aj:sale:<orderId>` (outbox `order.paid`, payload orderId).

### Payout (`payment.refunded`, section 4 key `aj:payout:<refundId>`)

- Refund row must be `completed`, `completed_at` set, amount and intent equal to payload; else `AUTO_JOURNAL_PAYLOAD_INVALID`.
- Money time = `completed_at` (no `occurredAt` fallback).
- Backing pending -> `AUTO_JOURNAL_RECEIPT_PENDING`; none -> `AUTO_JOURNAL_RECEIPT_MISSING`; posted -> amount check.
- Fund backing: completed payouts of the fund with bound <= B must not exceed the fund receipt credit; else `POSTING_AMOUNTS_MISMATCH`.
- Intent backing: receipt credit must cover captured POS tenders of orders completed with bound <= B (tie: sale earlier), plus forfeits closed <= B, plus completed payouts of the intent with bound <= B (this one included); else `POSTING_AMOUNTS_MISMATCH`.
- DP intents: DP applied by completed orders with bound <= B must not exceed the DP still held by session intents (amount, minus completed non-fund refunds <= B, minus forfeits closed <= B); else `POSTING_AMOUNTS_MISMATCH`.

### Sale with DP (`order.paid`, F4)

- Applied DP = DP of orders completed with bound <= S.
- Held DP = intents in `DP_INTENT_STATUSES`, minus completed non-fund refunds with `completed_at` < S, minus forfeits with `closed_at` < S.
- Sale order must be completed with `completed_at` set; else `AUTO_JOURNAL_PAYLOAD_INVALID`.
- Replaces the "live" status reads, so a later refund or forfeit no longer changes an earlier sale.

### Forfeit (`reservation.cancelled` / `no_show`, F3)

- Forfeit plus completed refunds of the DP intent with `completed_at` < `closed_at` must not exceed the intent amount; else `POSTING_AMOUNTS_MISMATCH`.

### Void (`order.voided`, key `aj:sale-void:<orderId>`)

- `voidedFinalOrder` false: ignored (open-order void posts nothing).
- Checks: `pos_order_voids` row (id = voidId, orderId) exists; order `deposit_applied_idr` = 0; amount = `orders.total_idr`; else `AUTO_JOURNAL_PAYLOAD_INVALID`.
- Cash goes back to the guest. Gateway tenders paid by an intent whose receipt (`aj:receipt:<intentId>`) is posted were booked out of `customer_deposit`, so the reversal credits them back there, owed to the guest until the intent's refund pays out (legend-x1i1h; like `refundGatewayIdr` of `order.refunded`). A payout of that intent stops counting the voided sale once the void journal posts, and waits retryable (`AUTO_JOURNAL_RECEIPT_PENDING`) while the void can still post.
- EDC or points money, gateway money without an intent or without a posted receipt (booked to `gateway_clearing`) -> `AUTO_JOURNAL_VOID_UNSUPPORTED`.
- Sale backing pending -> `AUTO_JOURNAL_SALE_PENDING`; none and no sale entry -> `AUTO_JOURNAL_SALE_MISSING`; entry exists -> reverse that entry (`reversal_of` = sale entry). Reason `Void penjualan <voidId>`.
- Backing state (legend-j0ag5): a sale or POS refund journal that finance reversed (ACC-01) counts as not posted (`none`): a POS refund of a reversed sale parks `AUTO_JOURNAL_SALE_MISSING`, a reversed POS refund backs no payout. Receipts keep their state; their credit is read net of a reversal.
- Date: section 5 (late-adjust into the first open day if the month is closed).
- Sale already reversed by finance -> `JOURNAL_ALREADY_REVERSED` (park, not retryable).

### Upstream proposals (not code; owners decide)

- U1: `refundableBalance` subtracts forfeited DP; refund of forfeited DP returns 409 `REFUND_DEPOSIT_FORFEITED`. Removes F3 at source.
- U2: correction void must refuse, or return gateway, EDC and points tenders. Today it returns only cash.
- U3 (closed in slice 3, see "QR sale time" above): QR orders have no `pos_orders` row, so no completion time. Their sale time is now `orders.fired_at`.
- U4: commit order vs time order. `payment_refunds.completed_at`, `pos_orders.completed_at` and
  `reservations.closed_at` are each the writer's `now` before commit, and refund completion, DP or
  gateway-tender sale completion and forfeit close share no lock. A sale stamped T1 that commits after a
  refund stamped T2 > T1 is consumed is invisible to the refund's check, and the sale's check does not count
  the later refund: both can post (Dr customer_deposit twice). The window is the open sale transaction
  versus outbox delivery of the refund (seconds). Fix in the writers: lock the DP or tender intent row
  (`payment_intents ... FOR UPDATE`) in all three and take the timestamp after the lock. The e7zj advisory
  lock covers refund creation, not completion.
- Known over-park: a sale parked for applying refunded DP still counts as applied in later checks of the
  same session, so later DP sales there park too (finance clears them together).
- A receipt that finance reversed (ACC-01) backs no payout.
