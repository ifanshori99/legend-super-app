# Brief 169b second opinion: POS intent sale, settlement providers, QR fire

Reviewed `6cc87daba8bf36947c92b1d36a5f205e39154ee2..da059c2884748c3814ec6bff8990fed5ec12abc3`, intended branch `ws/aj-pos-intent`. The named worktree and branch are no longer present; review used `git diff` and `git show da059c28:<path>` from the main repository checkout. Read design sections 1, 4 and 10 first. Only this requested report was written; no source edits, commits or pushes.

## Run A: POS sale-side check

**No new findings in the reviewed diff.**

- `apps/api/src/services/accounting-auto-journal-amounts.ts:758`: Pending intent receipts still raise retryable `AUTO_JOURNAL_RECEIPT_PENDING` before the new amount checks. Posted intents are deduplicated and each is checked independently at the order's sale bound (`:770–780`), so multiple intents cannot subsidize one another and multiple tenders on one intent are summed by the guard.
- `apps/api/src/services/accounting-auto-journal-guards.ts:325`: Bound times stay in SQL, preserving microseconds. Sales win equal-time ties against refunds/forfeits; equal-time sales use `orders.id` (`:334–367`). The bounded total includes this sale, earlier POS/QR sales, forfeits and intent-backed payouts, excluding payouts with their own fund receipt (`:506–590`). Receipt credit excludes reversed receipts (`:228–248`). Examined reads and joins are tenant-scoped.
- Distinct DP plus gateway tender compose through the existing DP/session check (`accounting-auto-journal-amounts.ts:485–523`). Reusing one intent as both DP and tender is not a supported writer path: reservation DP opens a separate payment link (`reservation-deposit-payment.ts:61`); POS creates its own link/intent and captures an intent on that link (`pos-order-payment.ts:335,647,707`).
- Reviewed AJ-POSI-01 through AJ-POSI-05 for full/partial refund, sale/refund time ties, two sales on one receipt, both delivery permutations, normal sale and pending receipt intent. These fixtures commit the business rows before delivery; they do not prove concurrent writer safety.

### Existing limitation: U4, high impact, outside this diff

`apps/api/src/services/pos-order.service.ts:1115,1182` still takes completion time before the transaction finishes, without a shared payment-intent lock. Concrete scenario: receipt 100k is posted; a 100k POS sale stamped T1 remains uncommitted; a 100k refund stamped T2 > T1 commits and its journal posts while the sale is invisible; the sale then commits and its new check excludes the later-stamped refund, so its journal also posts. Total customer_deposit debit becomes 200k against 100k credit. This is already documented at `docs/design/auto-journals.md:382–389`, not introduced by this patch.

No change to `pos-order.service.ts` is needed to add the accounting check for already-committed facts. To satisfy the stronger invariant across concurrent commits, writer changes are still necessary: serialize competing sale/refund/forfeit finalization on shared intent locks, take the ordering timestamp after locking, and add a regression with the earlier-stamped sale transaction held open. This report does not certify U4 as resolved.

## Run B: settlement allow-list and QR fire guard

**No findings.**

- `packages/shared/src/payment/settlement-events.ts:45,70`: The allow-list is exactly `doit` and `duitku`, matching the gateway provider catalog. Both incoming events and stored parked payloads parse the schema (`accounting-auto-journal-amounts.ts:303,1059`); other providers produce `AUTO_JOURNAL_PAYLOAD_INVALID` through the consumer's Zod error handling (`accounting-auto-journal-consumer.ts:141`). No production `settlement.reconciled` emitter was found at the reviewed commit. Unknown historical payloads intentionally require manual handling; existing journals remain subject to their idempotency check.
- `apps/api/src/services/qr-order.service.ts:1422–1429`: The update requires the same tenant, order and `awaiting_payment` status; failure throws before item, kitchen or event side effects. A direct second fire rejects and the transaction rolls back. The payment consumer locks the order (`qr-order-consumers.ts:280–295`) and returns for non-awaiting orders before calling fire (`:373–388,464`), so a legitimate redelivery does not reach the throw. The deposit/zero-total checkout caller owns its newly inserted awaiting-payment row (`qr-order.service.ts:1735–1774,1934–1941`); it does not need a separate read lock.
- Reviewed AJ-SET schema assertions, `settlement-events.unit.test.ts`, and QR-PAID-05 plus existing redelivery coverage for intent. No migration, RLS or posting-rule change exists in the range.

## Verification

- Static source/diff review with two independent read-only subagents; peak concurrency two. Conclusions reconciled against the target commit.
- `git diff --check 6cc87dab..da059c28 -- apps/api/src/services/accounting-auto-journal-amounts.ts apps/api/src/services/qr-order.service.ts packages/shared/src/payment/settlement-events.ts` passed.
- No tests, builds or database/concurrency experiments were executed. The named tests were read, not run; live stored settlement payloads were not inspected.
