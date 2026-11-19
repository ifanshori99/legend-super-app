# legend-vet9d answer: DP buckets in the day recap (architect, high)

## Chosen rule
DP (deposit) is a liability. It never shows up as a tender. A DP-funded sale counts its DP in a separate bucket on the day of the sale. A DP refund counts in its own bucket on the day of the refund. The cash and tender rows stay exactly as they are, so the drawer's expected cash is unchanged. The recap reads only POS-native rows (`pos_order_refunds`, `pos_deposit_refunds`) and never reads `payment_refunds`, so a WS-05 mirror refund cannot be counted twice.

## 1. Contract (`packages/shared/src/pos/schemas.ts`)
- Device recap: add `depositAppliedIdr` and `depositRefundedIdr`, both `nonnegativeIdr.default(idr(0))`. Refine `depositAppliedIdr <= totalIdr`.
- Recap: add `totalDepositAppliedIdr` and `totalDepositRefundedIdr`, both default 0. Each must equal the sum over devices.
- Changed identity: sum of tender net = sales - depositApplied - refunds - voids.
- Unchanged: `totalRefundsIdr` and `refundAmountIdr` stay the tender part only.
- Blind recap: add the same four fields to `endOfDayBlindDeviceRecapSchema` and `endOfDayBlindRecapSchema` (not drawer figures, stay visible). Both schemas are strict, so missing fields there make the blind parse throw.
- The `day.closed` event and the per-device total identity are untouched.

## 2. Refund semantics
- Additive, not inside: `pos_order_refunds.amount_idr` is the tender payout only. `pos_deposit_refunds` (same `pos_refund_id`) holds the DP part on top of it (`pos-order-corrections.ts:1328-1374`).
- Date bucket: both parts go by `pos_order_refunds.refundedAt` (refund date), for today's sale and for an earlier sale. DP applied stays on the sale's own day; nothing is netted between the two buckets.
- A refund that is all DP (tender part Rp0) now counts in `refundCount`: the query becomes "amount > 0 OR has a deposit row".

## 3. Voids
`voidPosOrder` already refuses to void a DP sale (`:313`). In the recap, a void on an order with `deposit_applied_idr > 0` gets an explicit CONFLICT before allocation.

## 4. Customer credit
Out of scope (already inside `deposit_applied_idr`).

## 5. Shift, blind recap, cash guard
None call `computeRecap`. Shift expected cash is cash tenders and cash lines only (`pos-shift-support.ts`); `pos-cash-guard.ts` untouched. Blind recap only needs the schema fields.

## 6. Still refused
- Remove the blanket reject at `pos-day.service.ts:320-355`; replace with the DP refund bucket query (same joins).
- Change the `:477` check to: captured + depositApplied != sales -> CONFLICT.
- Keep the refund lines != amount check.
- Add CONFLICT for: a deposit refund on an order with DP = 0; total deposit refunds of an order (up to `range.end`) above `deposit_applied_idr`; `releasedAt` outside the business day of its refund; deposit-row outlet differing from its refund's outlet.

## 7. Tests (`apps/api/src/test/pos-day.test.ts`, failing first)
Rewrite Q81-ECON-DAY-01 so it closes with the refund bucketed today. Add: DP refund today for today's sale; DP-only sale with no tender; mixed DP and cash sale (cash net = cash captured); `payment_refunds` mirror row in the fixture counted once; void of DP order -> 409; over-refunded DP -> 409; blind recap parses with DP fields; old frozen recap without the new fields parses as 0; shift close difference 0 on a DP day.

## 8. Files, risks
Files: `apps/api/src/services/pos-day.service.ts` (`computeRecap`), `packages/shared/src/pos/schemas.ts`, `packages/shared/src/pos/fixtures.ts`, `apps/web/src/features/ws04-pos-kasir/api.ts` (`dayRecapFrom`) + type, `mock.ts`, `mock-wire.ts`, `CONTRACT-GAPS.md`. Migration: none (recap stored as JSON). Risks: strict blind schema needs the fields; a DP release is counted when it happens even if payout fails later (payout status stays in WS-05); showing DP figures on screen is a separate UI card.
