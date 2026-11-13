# Sub-brief: money-journal-refund (legend-48ft7, legend-bxdhv)

Repo: this worktree, branch fix/money-journal-refund (from milestone/m1 5cbe2a1e). Tier K (uang).

## 48ft7
Refund fact builder (`apps/api/src/services/accounting-auto-journal-amounts.ts` ~1395-1500, case "order.refunded")
reads account_mappings (payout roles cash_on_hand/customer_deposit/edc_clearing/loyalty_liability) and refuses if
one maps to a sale service_charge/tax account. Actual posting reads the mapping AGAIN in
`accounting-journal.service.ts` ~570-615 (postRuleInTransaction -> accountMap, buildJournalLinesFromRule).
Gap: mapping can change between check and posting (different tx/time), so a refund payout may credit
service-charge/tax account. Goal: fail-closed check in the SAME transaction/snapshot as the posting
(compare final accountMap payout roles vs the sale's protected accounts at posting time), never post.
Required tests (fail-first): (1) payout map collides with tax/SC account -> refused; (2) mapping changed
between fact build and posting -> refused, no journal row; (3) earlier refund already reversed -> correct;
(4) no party paid more, outlet not at loss (sum of payout credits <= refunded cap, SC/tax lines unchanged).

## bxdhv
3 tests fail on branch rat9r: order-recovery-refund T3/T4, order-recovery-rereport RR-2. Check first if they fail on
m1 tip (this worktree). Pass on m1 -> NO code change; note finding on card (fail follows rat9r /
ws/pti5r-promo-refund held, legend-fwe4l). Fail -> reproduce, root cause, fix (order-recovery-refund.ts).

## Scope
Edit only: apps/api/src/services/accounting-*.ts, order-recovery-refund.ts (only if fails on m1), apps/api/src/test/.
Not: DOIT/Duitku payment flow, QRIS DP, edge emergency. No migration.
Run tests only via: heavy env LEGEND_TEST_FILES="..." pnpm test (ONE subagent at a time = test-runner).
