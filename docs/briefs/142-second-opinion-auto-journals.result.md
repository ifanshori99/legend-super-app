Brief 142: second opinion, auto-journals F19

Reviewed the specified files in 5fc862cb..a9c8ca14 (Runs A-C) and a9c8ca14..226f1155 (Run D), after reading the design and wiring patch. Line numbers refer to each run's end commit. Code, migrations and Git history were not changed; this requested report is the only repository file written.

Run A: contract, schema, migrations, posting path

No findings.

Verification: inspected the named diff and relevant posting/parent checks. Accounting and payment contract tests passed, 83/83, in the current worktree (b714f7b6; its code matches 226f1155). Database migrations were not executed.

Run B: amounts and keys

apps/api/src/services/accounting-auto-journal-amounts.ts:529 — High — Payouts debit customer_deposit without establishing that their receipt posted. Scenario: a Rp200,000 DP was received before wiring, or payment.paid was consumed with accounting disabled; no receipt journal exists. A subsequent refund posts Dr customer_deposit / Cr gateway_clearing Rp200,000, permanently debiting a liability never credited. Pre-cutover unallocated funds have the same problem. Fix: resolve the exact payout source using payment_refunds.unallocated_fund_id, check the corresponding intent/fund receipt or existing liability credit, park pending receipts, and explicitly handle absent cutover receipts without an unsupported customer_deposit debit. This remains at 226f1155.

apps/api/src/services/accounting-auto-journal-amounts.ts:45 — High — Completed-sale voids never reverse the sale journal. Scenario: a Rp100,000 cash sale posts Dr cash / Cr revenue; an approved linked void then returns the captured cash through the drawer calculation. pos-order-corrections.ts:291 emits only order.voided with voidedFinalOrder:true, which AUTO_JOURNAL_EVENTS excludes; no refund event or journal reversal is produced. Cash and revenue remain overstated by Rp100,000. Fix: consume completed-sale voids with a business-keyed reversal of the original sale journal, while ignoring unpaid-order voids. Slice 2 blocks DP voids but leaves this ordinary cash-sale path available.

Verification: inspected payout and void emitters and receipt handling. Executed the exact a9c8ca14 amounts source in memory with mocked read-only transactions: payout construction never read receipt journals; order.voided was unhandled. No database-backed tests ran.

Run C: consumer, parking, sweep, late adjustment

No findings.

Verification: inspected the exact consumer, wiring, outbox transaction boundary, fiscal-period lock, savepoints, idempotency and audit paths. Static review only; no database-backed execution.

Run D: DP applied, DP forfeit, shift close

apps/api/src/services/accounting-auto-journal-amounts.ts:548 — High — The new payout guard protects applied DP but ignores forfeited DP. Scenario: receipt Cr customer_deposit Rp100,000; an unseated no-show forfeits all Rp100,000 and debits that liability; staff then create and approve an ordinary refund of the same intent. This is reachable because payment-admin.service.ts:40 excludes reservationId from source documents and its refund cap ignores forfeiture. No session allocation exists, so the guard permits another Dr customer_deposit Rp100,000, leaving a permanent debit balance. Fix: enforce applied + forfeited + ordinary completed refunds <= received against the exact intent, including reservations.deposit_payment_id and forfeiture effective time. Keep fund payouts exempt; reject the payout upstream or explicitly reverse forfeiture if policy allows it.

apps/api/src/services/accounting-auto-journal-amounts.ts:535 (also :603) — High — DP guards depend on future state, making first delivery order change which historical facts post. Scenario: refund Rp100,000 completes at T1 while no sale is completed; a stale DP order completes at T2 before the refund event is delivered. The asOf refund query still counts that later completed order and permanently parks the valid T1 refund. Conversely, a valid DP sale at T1 first delivered after an offending refund at T2 is parked against current refunds; both facts can park instead of only the offending payout. Fix: bound completed sales by refund completion time (pos_orders.completed_at), and evaluate sale DP availability as of order.paid.paidAt or a durable completion snapshot. Add backlog/reversed-delivery cases in both directions.

Verification: both findings were independently cross-checked. Executed exact 226f1155 amounts source in memory with mocked read-only transactions: full forfeit and full payout both produced debit facts, and delayed historical sale/refund facts threw POSTING_AMOUNTS_MISMATCH. POS contract tests passed, 16/16. Mocks do not verify PostgreSQL/RLS/concurrency; no database-backed tests or migrations ran.

Review execution: three read-only Codex subagents, peak concurrency three; primary agent reviewed Run D and consolidated the report. No commits or pushes.
