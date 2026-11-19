# legend-vet9d — design question for architect (K tier, money: day close recap)

Worktree: this repo, branch ws/1162-pos-struk-edge (merged with milestone/m1 d99aae067). Read-only task: write the answer to `docs/briefs/sub-1162-vet9d-design-answer.md`, change no code. `bd show legend-vet9d` has the card.

## Problem
`apps/api/src/services/pos-day.service.ts` `computeRecap` (~307-760):
- :320-355 rejects (CONFLICT "Rekap refund DP belum tersedia") when any `pos_deposit_refunds` row joined to `pos_order_refunds`/`pos_orders` has `refundedAt` in the day range.
- :477-481 rejects (CONFLICT "Rekap hari ini tidak seimbang") when `capturedTotal !== salesTotal`; a deposit-funded sale (`orders.deposit_applied_idr > 0`, no tender row for the DP) always trips it.
- :484-560 voids are paid back through captured tenders; :562-620 refunds sum lines vs refund amount; :~690-705 tender rows net = captured - refunded; :~735 returns `endOfDayRecapSchema.parse` (packages/shared/src/pos/schemas.ts:1416 `endOfDayTenderRowSchema`, :1438 `endOfDayRecapSchema`; per-device total identity ~:1491). Blind recap :208-262 (`endOfDayBlindRecapSchema` nulls refundedIdr). Web consumer apps/web/src/features/ws04-pos-kasir/api.ts:341 `dayRecapFrom` (+ mock.ts, CONTRACT-GAPS.md).
Result today: any day with a DP-funded sale or a DP refund cannot be closed (fail closed). Goal: close it correctly, DP never treated as cash.

## Facts
- DP applied: `orders.deposit_applied_idr` (qr-order.ts:223, check 0<=dp<=total at :320); sale dated by `COALESCE(po.completed_at, o.placed_at)` (metric-sources/sales.ts:150).
- DP refund: `pos_deposit_refunds` (pos-deposit-refund.ts:23: order_id, pos_refund_id, payment_intent_id, amount_idr, released_at, immutable); created by `requestPosRefundDepositPart` (services/pos-deposit-refund.ts:72) paired with a WS-05 refund request on the original intent; `depositRefundFactTime` (:48). Customer-credit reuse: `reservationCustomerCreditUses`. sales.ts `REFUNDS_JOIN` :88-97 unions pos_order_refunds, pos_deposit_refunds and system:recovery payment_refunds per order (attributed to the ORDER, not the refund date); recovery arm only `requested_by='system:recovery'` and `order_issue_id IS NOT NULL` (the WS05 "mirror" guard).
- Journals: role `customer_deposit` (accounting-auto-journal-amounts.ts:2789 sale DP debit, :2170/:2835 refund credit back). Do NOT edit accounting-journal*.
- Existing tests: pos-day.test.ts:1629 (Q81-ECON-DAY-01, expects the fail-closed today; will change), recap identity :707, helpers cashSale/day/parseRecap/seedDay, `dp-economic-refund-fixture.ts` `seedEconomicDepositRefund`.

## Questions (answer concisely, no code)
1. Contract: exact new fields on the shared day recap (and per-device / shift if the schema has them) for DP paid into the day's sales and DP refunded in the day, optional/default-0 for old payloads; refinements/identities (e.g. captured + DP = sales; refunds identity incl. DP part). Where does DP sit in tender rows (never as a cash tender)?
2. Refund semantics: is a DP refund (`pos_deposit_refunds.amount_idr`) part of `pos_order_refunds.amount` (cash part + deposit part) or additive? Which date buckets it (refund date vs sale date) for TODAY refund of an EARLIER sale, and for TODAY refund of today's sale. How the net-sales / total-refunds / voids figures and the existing `captured - refunded` per-method identity stay balanced with no double count (WS05 mirror: payment_refunds that mirror a DP refund must not be counted again).
3. Voids of DP-funded paid sales (:484-560): how is the DP part treated (DP not returned through tenders)?
4. Customer-credit reuse (`reservationCustomerCreditUses`): in scope or not for the recap?
5. Shift close / blind recap / cash-guard: which of them share computeRecap or need the same identity relaxed; what to leave untouched.
6. Fail-closed: which residual cases must STILL reject (e.g. DP refund without paired row, sum mismatches), and what to do with the old reject at :320-355.
7. Test plan (fail-first): today + prior-date DP refund, no mirror double count, balanced day identity and shift identity, void of DP-funded sale, DP-only sale (no tender), blind recap unchanged, old payload parse.
8. Exact files/functions to change (api service, shared schema/types/endpoints, web mapper/mock, docs CONTRACT-GAPS), migration yes/no (expect no), risks.

Answer in a short file: chosen rule, files/functions, tests, risks. "Jangan sampai rugi": the chosen rule must never let a payout/refund exceed what was paid and must make the outlet's cash expectation unchanged by DP.
