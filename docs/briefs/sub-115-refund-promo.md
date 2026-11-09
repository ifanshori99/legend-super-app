# Sub-brief 115: refund parsial pesanan berpromo (shared context)

Parent: `docs/briefs/115-refund-promo-partial.md` (beads legend-q1e0, legend-9be7). Worktree: `.worktrees/refund-promo`, branch `ws/refund-promo`. Tier K (money). Do not commit; the engineer merges and commits. Do not touch files owned by another part.

## Founder rules (final, 9 Nov 2026)
1. Promo still earned after refund: refund of an item = item price minus its pro-rata (by price) share of the discount. Example: subtotal 100k (2 items x 50k), discount 20k, paid 80k; refund one 50k item -> 40k.
2. Promo condition no longer met: promo withdrawn, kept items at normal price, refund = paid - normal price of kept items (min 0). Same example with min-spend 100k promo -> 30k.
3. Refund does not reverse stock (only void does).

## Formula (goods level, crm-promo-refund.ts `recomputeAfterPartialRefund`)
Replace the current clamp/gross payout with a cumulative one:
- `standing = subtotalIdr - refundedSubtotalIdr`; `keptSubtotal = sum(keptLines.lineTotalIdr)` (422 if > standing, as now).
- `D_after = max(0, application.totalDiscountIdr - withdrawnDiscount)`.
- `keptDiscount = keptSubtotal === 0 ? 0 : min(keptSubtotal, share)` where `share` = the kept part of `D_after` split pro rata over `[keptSubtotal, standing - keptSubtotal]` with `allocateIdr` (largest remainder; check its behaviour for a 0 weight).
- New `totalDiscountIdr = keptDiscount`. `keptPayableIdr = keptSubtotal - keptDiscount`.
- `paid = application.paidIdr ?? max(0, subtotal - totalDiscount)` (as now); `remainingPaid = max(0, paid - refundedPaidIdr)`.
- `refundDueIdr = max(0, min(remainingPaid, remainingPaid - keptPayableIdr))`; `uncoveredIdr = max(0, keptPayableIdr - remainingPaid)`.
- `refundedPaidIdr += deferPayout ? 0 : refundDueIdr`.
- Empty `keptLines` is now allowed (guest returns everything left): every applied line is withdrawn (reason `no_matching_items`), skip `stillEarned`.
- The order wrapper (`order-promo-refund.ts` clamp correction) then lowers redemption lines + `promotions.spent_idr` by `before.totalDiscount - withdrawn - keptDiscount`, i.e. the refunded items' discount share goes back to the budget. Keep that; update its doc comment.

## Interface contract (Part A owns; Parts C/D code against it)
In `apps/api/src/services/crm-promo-refund.ts`:
- `PartialRefundInput` gains `deferPayout?: boolean` (default false = old behaviour of recording the due).
- Adjusted `PartialRefundResult` gains `keptPayableIdr: number` and `remainingPaidIdr: number` (before this refund).
- `PromoPartialRefundPort` gains `recordPartialRefundPayout(tx, context, { orderId: string; payoutIdr: number; at: Date }): Promise<{ recordedIdr: number }>`: per-order advisory lock + application row FOR UPDATE; no application -> `{recordedIdr: 0}`; released -> 409 `PROMO_APPLICATION_RELEASED`; `payoutIdr` must be a safe int >= 0; records `min(payoutIdr, remainingPaid)` into `refunded_paid_idr` and returns it.
In `apps/api/src/services/order-promo-refund.ts`:
- `orderPromoPartialRefundPort` exposes both methods (record passes through).
- `export async function livePromoApplicationOf(tx, context, orderId): Promise<{ status: string } | null>`: the order's application row unless missing or `released`.

## POS refund flow (Part C, `pos-order-corrections.ts` `refundPosOrder`)
Body gains optional `items: [{ itemId, quantity }]` (order_items ids of this order). Inside the existing `correct()` transaction (idempotent via `posIdempotent`, so a resend replays the stored response and never double-pays):
1. Load the order's non-voided `order_items` (tenant + order filtered). Earlier refunded qty per item = sum of `pos_order_refunds.items` of this order. Validate each requested item: belongs to the order, not voided, unique, `quantity <= qty - refundedBefore` (else 422 `VALIDATION_ERROR`).
2. `const app = await livePromoApplicationOf(...)`. If `app` and no `items` -> 422 ("Pesanan berpromo: pilih item yang direfund."). 
3. If `app`: kept lines = for each non-voided item, `keptQty = qty - refundedBefore - refundedNow`; when > 0 push `{ menuItemId, quantity: keptQty, unitPriceIdr: unitPrice + modifiersTotal, lineTotalIdr: (unitPrice + modifiersTotal) * keptQty }` (same pricing as `pos-order-discounts.ts` promo lines). Call `posPromoRefundPort().recomputeAfterPartialRefund(tx, context, { orderId, keptLines, reason: input.reasonNote, actorUserId: caller.userId, at: now, deferPayout: true })`. Any throw aborts the refund (refuse when the port cannot run).
   - Bill level: `net = order.subtotalIdr - order.discountIdr`, `extras = order.serviceChargeIdr + order.taxIdr`, `keptPayableBill = keptPayableIdr + (net > 0 ? floor(extras * keptPayableIdr / net) : 0)` (BigInt for the product). `dueBill = max(0, (paid - refunded) - keptPayableBill)`. `payout = min(input.amountIdr, dueBill)`. `payout <= 0` -> 422 `REFUND_NOTHING_DUE` ("Tidak ada dana yang perlu dikembalikan.").
   - After the ledger row is inserted: `recordPartialRefundPayout(tx, ctx, { orderId, payoutIdr: goodsPart, at: now })` where `goodsPart = grossSalesIdr - discountIdr` of `refundSplit(order, payout)`.
4. No `app`: `payout = input.amountIdr` (old behaviour); items, if sent, are validated and recorded.
5. Use `payout` everywhere the old code used `input.amountIdr` (assertRefundWithinPaid, approval `minValueIdr`, allocation, row, event payload, split). Audit `after` adds `requestedAmountIdr` and `items`. Row stores `items` (`[]` when none). No stock change.
- `pos-order-ports.ts`: add `setPosPromoRefundPort(next | null)` / `posPromoRefundPort()`; default = `orderPromoPartialRefundPort` (real), setter exists so tests can inject a failing port.

## Schema / contract (Part B)
- `apps/api/src/db/schema/pos-order.ts` `posOrderRefunds`: `items jsonb NOT NULL DEFAULT '[]'` typed `{ itemId: string; quantity: number }[]`. `pnpm db:generate` from the worktree root, inspect SQL, keep it to that one ADD COLUMN.
- `packages/shared/src/pos/endpoints.ts` `refundPosOrder` body: `items: z.array(z.strictObject({ itemId: <order item id schema used elsewhere in shared/pos>, quantity: z.number().int().positive().max(999) })).min(1).max(100).optional()` with a refine refusing duplicate itemId. Export a named schema `posRefundItemSchema` from `packages/shared/src/pos/schemas.ts`; `posRefundSchema` (response) gains `items: z.array(posRefundItemSchema)`. Update the endpoint doc comment (promo orders need items; API may pay less than asked).

## Tests
- Targeted run: `LEGEND_TEST_FILES="src/test/a.test.ts src/test/b.test.ts" pnpm test` from the worktree root. Never kill other sessions' processes; stop only your own PIDs.
- Part A updates expectations in `apps/api/src/test/order-promo-db.test.ts` and `crm-promo-e5it-db.test.ts` to the founder formula (only the partial-refund cases).
- Part D (test-writer) writes `apps/api/src/test/pos-refund-promo-db.test.ts` (see parent brief "Contoh uji wajib").

## Q19 (founder 9 Nov 2026, bead legend-15by): returned free item pays Rp0
Rule: the kept discount is also capped by what the still-applied promotions give when re-evaluated on the kept lines.
- `stillEarned` returns `{ failure: PromoRejectionReason | null; recomputedIdr: number }` (recomputedIdr = evaluation.discountIdr when applied, else 0).
- In the withdraw loop, for each line NOT withdrawn: `cap += min(line.discountIdr, recomputedIdr)`; value-voucher lines (`promotionId === null`) and lines whose rule is missing add `line.discountIdr`.
- `keptDiscount = min(keptSubtotal, proRataShare, cap)` (cap only ever lowers it). Withdrawn lines add nothing. `returnsAll` unchanged.
- Founder examples stay 40k / 30k (20k-off whole-bill promo: recompute on kept 50k = 20k >= pro-rata 10k).
- Examples to test (prices: coffee 30k, croissant 25k; promo "buy 2 coffee get 1 croissant free"):
  - BOGO: 4 coffee + 2 croissant = 170k, discount 50k, paid 120k. Return 1 croissant -> Rp0 (REFUND_NOTHING_DUE at POS; refundDueIdr 0 at crm level), kept discount 25k.
  - Mixed A: same bill, return 1 coffee -> kept 3 coffee + 2 croissant = 140k, recompute 25k, pro-rata 41,176 -> kept discount 25k, payout 120k - 115k = 5k.
  - Mixed B: 2 coffee + 1 croissant + 1 juice 30k = 115k, discount 25k, paid 90k; return juice -> pro-rata binds (18,478 < 25k): kept discount 18,478, payout 90k - (85k - 18,478) = 23,478 (check allocateIdr rounding).

## Q19b: path-independent, stack-ordered, per-line kept discount (K review fix)
Problems in c140459c: (1) pro-rata splits the *current* (already capped) discount over `standing`, so two refunds pay less than one (BOGO 4 coffee + 2 croissant: return coffee, then coffee = 29,643; both at once = 35,000). (2) re-check evaluates each promo alone on the full kept subtotal, not in stack order (free items/bundle first, then bill-level on what is left), so stacked percent promos overstate. (3) the order wrapper lowers redemption rows pro rata by discount, not by which promo actually lost discount (wrong `spent_idr`, value voucher row shrinks).

New rule, per still-applied (not withdrawn) redemption line i, in `crm-promo-refund.ts`:
- `o_i` = ORIGINAL discount of that line = the applied evaluation in `application.result.evaluations` whose `promotionId` equals `line.promotionId` (value voucher: equals `line.voucherId`, since the voucher pseudo-promotion id is the voucher id). Evaluations are never re-priced by refunds, only flipped to rejected on withdraw. Fallback if not found: `line.discountIdr`.
- `share_i = allocateIdr(o_i, [keptSubtotal, application.subtotalIdr - keptSubtotal])[0]` (ORIGINAL basis, not `standing`).
- `r_i` = stack-ordered re-check on the kept lines: order the kept promos like `applyPromotions` (`packages/shared/src/crm/promo.ts` ~863: tier 0 = `free_items`/`bundle_price`, else tier 1; then priority desc; then id), `left = keptSubtotal`, each `evaluatePromotion(neutral, bill, ZERO, { discountableIdr: left })`; applied -> `r_i = discountIdr`, `left -= min(o_i, r_i)`. Value voucher line: `r_i = min(o_i, left)` at tier 1, priority 0, id = voucherId. Rule missing or `stillEarned` non-withdraw rejection -> `r_i = o_i`; a promo that passed `stillEarned` but is rejected in the stack loop (no room left) -> `r_i = 0` (K review fix).
- `k_i = min(share_i, o_i, r_i)`; `keptDiscount = min(keptSubtotal, sum k_i)` (if the outer min binds, reduce k_i from the last line in stack order so `sum k_i == keptDiscount`). Withdrawn lines: k_i = 0 (existing withdraw path).
- Result gains `keptLineDiscounts: readonly { redemptionId: string; keptDiscountIdr: number }[]` (still-applied lines only).
- Drop the `discountAfter`/`standing`-based share and `keptCap`. `returnsAll` unchanged.
In `order-promo-refund.ts`: replace the pro-rata `lowerAppliedDiscount(clamped)` with per-row lowering: for each `keptLineDiscounts` entry, `cut = row.discountIdr - keptDiscountIdr` (> 0 only), lower the row by `cut` and its promotion's `spent_idr` by `cut` (GREATEST(...,0); value voucher rows have no promotion). Keep lock order (rows by promotionId,id; promotions by id) and the `promo_application.clamped` audit (total lowered). Invariant: sum(applied rows) == application.total_discount_idr. Update header comments (Q19 + per-line).
Checks: founder 40k/30k, Q19 BOGO Rp0, Mixed A 5k unchanged; Mixed B: o=25k, share = 25k*85/115 = 18,478, r = 25k -> 18,478 unchanged. Two-step BOGO coffee+coffee = one-step 35,000.
