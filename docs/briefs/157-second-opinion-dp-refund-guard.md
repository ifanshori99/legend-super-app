# Brief 157: second opinion, DP refund guard (legend-e7zj)

Role: second-opinion (Codex). Tier K (money). Effort xhigh. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/dp-refund-guard`, branch `ws/dp-refund-guard` (base `integ/m1-batch5`, 21edd29b).
- Diff range: `21edd29b..72e4f973` (code + tests; the next commit is PROGRESS only).
- Background: bead legend-e7zj (`bd show legend-e7zj`). A reservation DP is paid through a WS-05 payment intent, allocated to the table session on seating (`reservation_deposit_allocations`) and applied to the bill as `orders.deposit_applied_idr`. Before this change an admin could refund that DP in full after a sale used it (guest paid twice), and the session credit ignored refunds filed after seating.

## Run (one pass, about 275 non-test lines)
Files: `apps/api/src/services/reservation-deposit-credit.ts` (new; read its header first), `apps/api/src/services/payment-admin.service.ts` (`refundableBalance`, `createRefund`, `listRefundablePayments`), `apps/api/src/services/reservation-lifecycle.ts` (`depositCreditForSession`). Tests in `apps/api/src/test/reservation-deposit-refund-guard.test.ts` may be read for intent; they do not count.
Read for context, not in the diff: `apps/api/src/services/qr-order-ports.ts` (`lockSessionDeposit` and its lock-order doc, legend-94qt), `pos-order-support.ts` `depositFor`, `qr-order.service.ts` pay-first checkout, `open-bill-control.service.ts` `unusedDepositOfSession`, `reservation-core.ts` `loadHeldDeposit`, `payment-refund.service.ts` approval cap check, `reservation-refunds.ts` system refund.

## Invariants to try to break
1. Refunds of a DP intent plus the DP in use on its sessions (the larger of what non-voided orders applied and the live bill not covered by link payments or captured POS tenders, open-bill tables included, after the session's other DPs) never exceed what the intent received (`refundableBalance` cap), whatever the order of refund request, approval, failure, seating and sale.
2. The session credit equals, per allocation, min(allocated, what the intent still holds after non-failed refunds); a pending refund already lowers it, a failed one gives it back.
3. Race: a refund and a sale or QR checkout on the same DP never both take the same money (advisory lock per DP intent: shared in the credit lookup, exclusive in the refund cap under the intent row lock). No deadlock against the legend-94qt order (order row, promo locks, session deposit lock) or against payment webhooks and settlement that lock the intent row.
4. Every other caller of `refundableBalance` (approval, reservation system refund, POS and QR late payment) keeps its behaviour for intents with no allocation.
5. Tenant isolation: the raw SQL filters every table by tenant; RLS lets the POS and QR guest contexts read what the credit lookup reads.
6. Contract: `refundablePaymentSchema` refine (paid = refunded + refundable) still holds in the listing.

## Report
Findings with file:line, severity (High/Medium/Low), a concrete failing scenario and a suggested fix, or "no findings". Plain text, at most 600 words. Write it to `docs/briefs/157-second-opinion-dp-refund-guard.result.md` in the main checkout.
