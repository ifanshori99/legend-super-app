# Sub-brief legend-wkl3: Rp0 goods return is recorded

CTO decision (9 Nov 2026): returning a free item (founder Q19) records a refund row with payout Rp0 as the record of the goods returned. The row has `items` filled, reason and an audit entry. No gateway call, no stock reversal. Idempotent. The response is a success (201 like any refund), not 422.

## Implemented (worktree `.worktrees/refund-promo`, uncommitted)
- `apps/api/src/services/pos-order-corrections.ts` `refundPosOrder`: promo order with payout <= 0 sets `goodsReturnOnly`: row `amount_idr = 0`, `lines = []`, `items` = requested; no `recordPartialRefundPayout`; no `order.refunded` events (POS + order stream); audit `pos_order.refunded` with `after.goodsReturnOnly = true` and `after.goodsReturnNote`. The CRM port still runs (promo rows lowered, `spent_idr` lowered: the free croissant is no longer given).
- DB checks (`0106_slim_human_cannonball.sql`): amount > 0, or amount = 0 with non-empty items; lines empty exactly when amount = 0.
- `packages/shared/src/pos/schemas.ts` `posRefundSchema`: amount >= 0; lines empty iff Rp0; Rp0 needs items.
- `pos-day.service.ts` recap and `pos-receipt-document.ts` invoice status ignore Rp0 rows.

## Tests to write (in `apps/api/src/test/pos-refund-promo-db.test.ts`, Q19 describe)
Replace the test "BOGO: ... returning 1 free croissant pays Rp0 and is refused with nothing written" (line ~1032) and the Q19 assumption comment (~902-907) with:
1. BOGO 4 coffee + 2 croissant (170k, 50k off, paid 120k), return 1 croissant asking 25k: status 201, body `data.amountIdr` 0, `data.lines` [], `data.items` = the croissant x1. DB: one row amount 0 with items; application `paid 120000, refundedPaid 0, totalDiscount 25000, refundedSubtotal 25000`; `spentOf` 25000; stock unchanged; audit row `pos_order.refunded` with `goodsReturnOnly` true; no `order.refunded` event row for the order (check the outbox/event tables used by other tests, e.g. grep `order.refunded` in apps/api/src/test).
2. Resend same idempotencyKey: same response, still one row, spent/application unchanged.
3. Revenue report unchanged: end-of-day recap before vs after the Rp0 return has the same `totalRefundsIdr`, refund count and sales totals. Recap via `getEndOfDayRecap(tenantContext(tenantId), { userId }, outletId, businessDate)` from `pos-day.service.ts` (see `pos-day.test.ts:811`) or the HTTP route `GET /api/outlets/:id/pos/day?businessDate=` (see `pos-day.test.ts:365`, `parseRecap` :420).
4. Path independence after the Rp0 return: then returning 1 coffee pays Rp30.000 (kept 3 coffee + 1 croissant = 115k, 25k off, 90k payable; paid 120k). Same as returning 1 coffee + 1 croissant at once (30k).

Run: `LEGEND_TEST_FILES="src/test/pos-refund-promo-db.test.ts" pnpm test` from the worktree root. Never kill global test processes (no pkill vitest/killall node); stop only your own PIDs. Do not commit.

## Review fix (Opus, K): Rp0 only when nothing is owed
`goodsReturnOnly = dueBill === 0` (bill level). Owed money (`dueBill > 0`) but the tenders are used up (payout 0, e.g. a deposit paid part of the bill) stays 422 `REFUND_NOTHING_DUE` and the whole transaction rolls back.

Test to add (same file, after the Q19 tests): founder promo sale (`promoSale()`, 2 x 50k, 20k off, paid 80k cash). `UPDATE orders SET deposit_applied_idr = 50000` for that order (artificial deposit, as in `pos-order-qris-lifecycle.test.ts:887`). Refund item A asking 80k -> 201, payout 80k (dueBill 90k, tenders cap 80k). Refund item B asking 1k -> 422 `REFUND_NOTHING_DUE`, still one refund row, application unchanged by the refused call, `spentOf` unchanged by the refused call.
