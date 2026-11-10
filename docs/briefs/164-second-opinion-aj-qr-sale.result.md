# Brief 164 — second opinion: QR sale, revenue split, total-0 order.paid

Reviewed range: `7822d66e..02b37bf3`, originally `ws/aj-qr-sale`. The original worktree was removed before this review resumed; all reviewed source, line numbers and tests below come from immutable Git objects at `02b37bf3`, not the current checkout. Read design sections 1, 6, 8 row 3 and 10 before reviewing.

## Run A — emit + split

- **P1 / High — `apps/api/src/services/qr-order-consumers.ts:467`: The first delivered paid event can pin a wholly unallocated double-payment intent as the sale's payer.** Scenario: an order owes Rp100,000; superseded code A settles and allocates Rp100,000 to its link, then code B settles before either event is consumed. B is also `paid`, but its durable `payment.paid` has `allocatedIdr = 0` and Rp100,000 of `double_payment` funds. Deliver B's event first: the handler fires the order pinned to B and emits its sale, then requests the refund of B's double-payment fund. The sale consumes B's receipt. When B's refund completes after the fire, its payout guard counts sale Rp100,000 + payout Rp100,000 against B's Rp100,000 receipt and permanently parks the legitimate payout as `POSTING_AMOUNTS_MISMATCH`; A's receipt remains unapplied. Delivering A first produces the correct attribution, so accounting depends on payment-event delivery order. **Suggested fix:** Pin an intent proven by durable allocation facts to have covered `total - deposit_applied` on this payment link. A zero-allocated B must still get its double-payment refund but must not become the sale payer; defer firing to A's event or resolve the actual allocated payer under the existing order lock. Add an integration regression that settles both codes before consuming either event, exercises both delivery orders, completes B's automatic refund, and verifies one sale, no parked payout and no residual customer-deposit credit.

Supporting trace at the reviewed commit:

- `payment.service.ts:1626-1703` allocates only the outstanding link balance and emits B's `payment.paid` with zero allocation plus its unallocated amount. This first confirmation creates a fund row without a separate `payment.funds_unallocated` receipt event, so B's fund payout is backed by B's intent receipt.
- `qr-order-consumers.ts:451-477` checks link coverage and B's paid status, pins B at line 467, then requests B's double-payment refund.
- `accounting-auto-journal-guards.ts:536-552` charges the QR sale to the pinned intent; `:568-590` adds its completed payout; `:644-647` rejects the combined Rp200,000 demand on B's Rp100,000 receipt. This holds whichever accounting event is delivered first once the sale and later completed refund rows exist.
- `qr-order-paid-event.test.ts:470-501` covers a superseded code paying, but only one code settles; it does not cover two settled codes with reversed event delivery.

Other checks: the shared split preserves the previous inclusive/exclusive POS gross arithmetic and fails closed on inconsistent rows; the QR sale event is appended in the fire transaction; caller order locks/status gates make replay emission once-only; total-0 accepts empty tenders; recipe deduction uses the per-order idempotency key; changed reads are tenant-scoped.

## Run B — journal guards

**No additional findings.** Independently confirmed Run A's wrong-intent consequence through the backing and payout guards. Verified the tenant-scoped SQL `saleAt` CASE, POS-row precedence, QR pay-first detection, exclusion of unfired/open-bill orders, SQL-only microsecond bounds, sale/refund/forfeit tie predicates, QR payout sums, sale-side receipt budget, DP application bounds, pending/posted/pre-cutover routing, all-zero no-journal/no-park behavior, full-comp discount/sales posting, and invalid final QR void rejection. No migration, RLS or posting-rule changes occur in this range.

Design section 10 already identifies the writer timestamp/commit-order race (U4) and the missing POS intent sale-side check. Those acknowledged limitations are not counted as new findings in this review.

## Validation and limits

- Read both requested file diffs and the relevant AJ-QR, QR-PAID, revenue and recipe test intent at `02b37bf3`; traced the P1 through the existing payment writer and refund requester only to establish its concrete failure path.
- Ran the exact target commit's pure `orderRevenueSplit` through Node: six valid cases balanced (exclusive, inclusive, negative rounding in both modes, full comp and all-zero), and three invalid cases threw `OrderRevenueMismatch`. Result: **9 checks passed**. These were direct function checks, not the Vitest suite.
- Did not run database integration tests, Vitest, build, lint or typecheck; the P1 is established by the source trace, not a runtime database reproduction.
- Two review subagents, peak two concurrently; both initial attempts hit the usage limit, then both completed after resumption. The primary agent independently checked the finding.
- Only this requested result document was written. No code edits, commits or pushes.
