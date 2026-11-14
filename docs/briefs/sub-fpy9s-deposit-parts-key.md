# legend-fpy9s: deposit part shares gateway key with POS lines

Branch fix/refund-deposit-parts-key (base dba3f40b3). No migration. Money area: never pay more than owed, outlet must not lose.

## Facts (read by engineer)
- `apps/api/src/services/pos-refund-gateway.ts:68-83`: lines and `depositParts` of one intent merge into one `byIntent` amount, one refund, one idempotency key `pos-refund-gateway:<posRefundId>:<intentId>`.
- Keys are read by: payment-refund.service.ts:329-347, payment-refund-approval-limits.ts:400/439/480, reservation-deposit-credit.ts:57, pos-deposit-refund.ts:199. Do NOT rename/split the key (ripple).
- Callers today: corrections (lines only), pos-deposit-refund.ts:188 (`lines: []`, one deposit part). pos-deposit-refund.ts guard (`input.lines.some(...)`) refuses deposit + line on the same intent, so the mix is only reachable at function level / by rows inserted directly.
- Pin bound: `accounting-auto-journal-amounts.ts` refundGatewaySplitOf, `earlierIntentWant` (line want per key, built from earlier POS refund `lines`) vs `linked` refund amount at that key. `linked` includes the deposit part, `want` does not, so deposit part covers a shortfall of the line part (earlierUnfiledIdr = 0 although less than lines+deposit was filed).
- Planned fix: `want` per key = lines + deposit parts of that posRefundId+intent (table pos_deposit_refunds: posRefundId, paymentIntentId, amountIdr), so any filed-short amount stays counted against the pinned intent.

## Test (red first)
Extend `apps/api/src/test/auto-journal-refund-residual.test.ts` (see the legend-0dgi1 cases, style/helpers). Scenario: pinned intent, earlier POS refund with gateway line X and pos_deposit_refunds row D on the SAME intent (insert row directly), linked non-failed payment refund at the shared key of amount R < X+D but R >= X, then a later refund on the pinned intent: the shortfall X+D-R must count against the intent limit (not pinned / parks when over). Pick amounts so old code pins and new code does not. Plus: control case fully filed stays pinned (no double count). ARR-* and accounting-auto-journal-refund-split tests stay green.
Run: `LEGEND_TEST_FILES="src/test/auto-journal-refund-residual.test.ts" heavy pnpm test` (one heavy job at a time).
