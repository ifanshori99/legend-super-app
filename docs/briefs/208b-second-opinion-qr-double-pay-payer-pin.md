# Second opinion (Codex): QR sale never pins an unallocated double-payment code as payer — legend-mks0q (tier K: money, accounting)

Branch `ws/qr-double-pay-payer-pin` (worktree `.worktrees/qr-double-pay-payer-pin`),
based on `milestone/m1` 94d769c6. Review `git diff 94d769c6..c955df7c` (tip of `ws/qr-double-pay-payer-pin`).
Read-only review; report findings with file:line, severity, and a concrete
failure scenario. Do not edit.

Origin: brief 164 Run A P1 (`docs/briefs/164-second-opinion-aj-qr-sale.result.md`).
Order owes Rp100.000; superseded code A settles (allocated 100k); code B settles
before any event is consumed (`payment.paid` B: allocatedIdr 0, a 100k
`double_payment` fund). B's event first used to fire the order pinned to B; B's
completed fund refund then parked `POSTING_AMOUNTS_MISMATCH` (sale 100k + payout
100k vs B's 100k receipt) and A's receipt stayed in customer_deposit.

## What the change claims

- `apps/api/src/services/qr-order-consumers.ts` `handleQrOrderPaymentPaid`, fire
  path: after the existing gates (order `awaiting_payment` under its row lock,
  link total = order total − deposit applied, link fully paid, event intent
  `paid`), the payer is resolved by `payerIntentOf`:
  1. the event's intent, when its allocation ≥ the link total;
  2. else the one `paid` intent of the link whose allocation ≥ the link total
     (at most one: `payment_links.paid_idr ≤ total_idr`);
  3. else (bill split over several codes) the event's intent when it allocated
     anything (unchanged legacy behaviour);
  4. else null: the order is not fired from this event; the event intent's
     `double_payment` funds still get their refund request (outcome
     `double_payment_refund_requested`, or `unchanged` on replay).
- Allocation per intent (`allocatedIdrByIntent`) = Σ `payment_evidence.amount_idr`
  − Σ `payment_unallocated_funds.amount_idr` (any reason, any resolution), over
  the link's `paid` intents, in ONE SQL statement (single READ COMMITTED
  snapshot; an earlier two-query version could see a mid-read second payment's
  evidence without its fund — architect finding, fixed). WS-05 keeps no per-intent allocation column; both
  tables are append-only and written in the settlement transaction
  (`payment.service.ts` first confirmation and double-payment branches).
- No change to `payment.service.ts` writes, journal guards, refund payout
  runner, schema or migrations.

## Please check

1. Derivation: any settlement path where evidence − funds differs from the
   `allocatedIdr` the `payment.paid` event carried (overpayment, repeated
   provider transaction on an already-paid intent, evidence-less legacy fund
   rows, fund resolved as `credit`, late payment on an expired code).
2. Payer choice: any input where the resolved payer differs between delivery
   orders, or where an intent with zero allocation is still pinned; replay of
   either event after the fire (must be `unchanged` / refund once).
3. Case 4 (null payer): can a fully paid order be stranded in
   `awaiting_payment` because no event ever fires it?
4. Locking: the payer read runs under the order row lock only (intent rows not
   locked); any concurrent settlement/refund that changes the answer between
   read and fire.
5. Accounting outcome for both delivery orders: one sale, payer A, B's payout
   backed by B's receipt, no parked journal, customer_deposit back to 0.

## Invariants (PRD v1.7 §3 F10 Mode Bayar, §3.13 Siklus Pembayaran, ORD-02, PAY-04)

- A pay-first QR order fires once, only on verified money covering the quote.
- Double-payment money is never revenue; it goes back by refund.
- Accounting result must not depend on payment-event delivery order.
