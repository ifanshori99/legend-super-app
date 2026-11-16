# Sub-brief: QRIS hold C2/C3 gap closure (legend-yhia9.3, legend-yhia9.4)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-ae08d25b` (branch `ghostex/qris-hold-dp-c2-c3`, base = C1 tip `1275f0123`, NOT in m1 yet).
Design: `docs/design/qris-dp-intent.md` (D-01..D-09, §4 state machine, §6 contract, §7 money table, §8 tests).
Founder rule: jangan sampai rugi — customer never pays more than remaining R, outlet never receives less than T. When unsure, refuse (409) instead of moving money.

## State

C1 branch already contains most of C2 and C3 (see `docs/PROGRESS.md` lines 5478-5510):

- C2: `apps/api/src/services/pos-qris-hold.ts`, `payment.service.ts` (handlePosPaymentPaid/Closed), `payment-provider-proof.ts`, `worker/pos-qris-hold-check.job.ts`, `pos-order-payment.ts`, `payment-late-settlement.ts`.
- C3: `apps/api/src/services/customer-display.service.ts`, `routes/customer-display.routes.ts`, `db/schema/customer-display.ts`, migration `drizzle/0370_pos_customer_display.sql`, shared `packages/shared/src/pos/{schemas,endpoints,errors}.ts`.
- Tests: `apps/api/src/test/pos-qris-hold*.test.ts`, `pos-customer-display.test.ts`, `pos-qris-deposit-money.test.ts`, helpers `pos-qris-hold-test-helpers.ts`.

Known open gaps (from PROGRESS):

1. `/pair` replay (same code used twice) has no test.
2. `applyReservationCustomerCredit` (`reservation-deposit-remainder.ts` ~:374) does not check the QRIS hold (credit can change remaining while QR is collectible).
3. `QRIS_NEEDS_CLOUD` on edge unverified.
4. Cashier message when QR paid but not yet booked.

## Rules

- New migrations only in range 0615-0619 (prefer none). FKs of new tables inline in CREATE TABLE. No `NOT VALID` FK on FORCE RLS tables.
- Tests: `LEGEND_TEST_FILES="src/test/a.test.ts ..." heavy pnpm test` from worktree root. One heavy holder at a time (the test-runner).
- Brand types via project constructors, no `as`.
- Scope: API services/routes, shared contract, migrations, API tests. No web UI, no payout/HRIS.

## Round 2 (architect xhigh findings, 15 Nov)

- R1 BLOCKER (`reservation-deposit-remainder.ts`): the hold guard (orders FOR UPDATE, pos_orders FOR UPDATE, assertNoActiveQrisHold with uuidToUlid) must move to right after `table_sessions FOR UPDATE` (~~:433), BEFORE the `reservation-credit` advisory lock (~~:438). Reason: POS DP return (pos-order-corrections.ts:192 -> pos-refund-gateway.ts:119 -> reservation-deposit-credit.ts:195) and refund approval (payment-refund-approval-limits.ts:214 -> payment-refund.service.ts:505) lock orders/pos_orders first, then deposit-intent; the credit path did the reverse -> deadlock 40P01.
- R2 (`pos-order-payment.ts` ~:600-620 voidTendersAndRefundPaidQris + 3 other refund branches): select the hold by `tenderId`, not `activeHoldOf` (any active hold of the order).
- R3 (`table-session-operations.service.ts` :646/:661/:685/:1075): these change `orders.table_session_id` (not covered by 0369 trigger). Refuse with PosError QRIS_HOLD_ACTIVE when the moved order has an active hold (same guard as :1153), after the orders row lock.
- R4 (`data-import-registry.test.ts`): add `0368_pos_qris_holds.sql` and `0370_pos_customer_display.sql` to MIGRATION_DATA_STATEMENTS with an honest one-line reason (read the SQL: backfills only).
- T (tests, test-writer): deadlock test (credit apply vs DP return same session, 20 rounds, no 40P01, money invariant holds); multi-order session (hold on B, credit refused even if A is free); table-session move of a held order refused; narrow `.catch(() => undefined)` in CREDIT-HOLD-03 to expect QRIS_HOLD_ACTIVE or success only.
