# Brief 142b: second opinion of brief 142 fixes

Reviewed `b714f7b6..84218ab4` on `ws/aj-fix142`, after reading `docs/design/auto-journals.md`, including section 10, and the earlier report in the primary checkout. All source references are pinned to `84218ab4`; the worktree was already at `d309b186`, whose five reviewed production files and design match the pinned commit.

Outcome: **No new findings in Runs A–C.** This is a review of the specified fixes, with the execution limits and known upstream risk below.

## Run A: guards

**No findings.** Reviewed `apps/api/src/services/accounting-auto-journal-guards.ts` (672 lines).

Verified tenant predicates, including raw SQL subqueries; intent/fund/sale backing keys; outbox → parked → journal read order; pending versus missing backing; and zero available credit for a reversed receipt. Checked SQL-native completion-time bounds, inclusion of the current refund, refund-ID and sale-ID ties, sale-before-forfeit/refund ties, forfeit-before-refund ties, and historical DP, payout and forfeit caps. Surrounding writers confirm that session allocations are fixed at seating and a seated reservation cannot subsequently forfeit.

Executed the exact target guards source in memory against read-only mocked transactions: **8 scenarios passed**, covering backing-state precedence/read order, non-retryable missing backing, fund payout at/above its cap, absent receipt credit, combined forfeit/payout overdraw, and forfeit at/above the remaining intent amount. These mocks do not execute SQL predicates.

## Run B: facts, consumer and void

**No findings.** Reviewed the specified diff in `apps/api/src/services/accounting-auto-journal-{amounts,consumer,void}.ts`.

Verified completed refund row/payload agreement, exact backing selection, pending/missing receipt parking, completion-time money date without fallback, and integration of the historical DP/forfeit guards. Checked completed-sale void validation, cash-only support, business-key replay, pending/missing sale handling, reversal of the actual sale entry, late-adjustment date/audit wiring, and tenant-scoped reads. Open-order voids remain ignored; noncash completed-sale voids park for finance.

The Run B reviewer executed the exact target `voidFactOf` source in memory: **10 mocked cases passed**, covering open/cash/noncash voids, missing/pending sale backing, missing void row, DP and amount mismatch. Consumer transaction, parking and date integration were reviewed statically.

## Run C: reversal extraction

**No findings.** Reviewed `apps/api/src/services/accounting-journal.service.ts:871` onward, covering `reverseJournal` and `reverseJournalInTransaction`.

Verified manual input parsing, trusted context, tenant/outlet scope, target row locking, mirrored lines and balance, period checks, same-key replay before reversal/period rejection, double-reversal and reversal-of-reversal protection, and atomic journal/outbox/audit writes. Manual calls retain the same fingerprint inputs, with explicit `lateAdjustmentFrom: null`.

The Run C reviewer executed the exact base and target `journalRequestFingerprint` implementations from `apps/api/src/services/accounting-shared.ts:54`: **6 assertions passed**. Omitted/null/undefined late-adjustment values preserve the manual fingerprint; changing reason, entry date, target entry or late-adjustment date changes it. The reversal functions themselves were not runtime-tested.

## Verification limits and known upstream risk

- PostgreSQL-backed tests, SQL boundary execution, concurrency, RLS and migrations were not run. Existing tests were read for intent; the in-memory checks do not substitute for database-backed verification.
- Section 10's existing **U4 writer commit-order race remains unresolved by this diff**: an earlier-stamped sale can commit after a later refund has been checked, allowing both debits. The design proposes a shared intent-row lock and timestamps taken after that lock. “No new findings” does not certify the stated invariant under that concurrent writer interleaving; U4 still needs disposition before claiming that guarantee.
- The diff changes no RLS definitions, migrations or shared posting rules.

Execution: three read-only Codex subagents, peak concurrency three; primary agent cross-checked the scoped diffs and ran the guard scenarios. Application code, Git history and other documentation were not changed. This requested report is the only file written; no commit or push.
