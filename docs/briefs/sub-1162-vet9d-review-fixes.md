# legend-vet9d — architect review fixes (apply exactly)

Files: apps/api/src/services/pos-day.service.ts, apps/api/src/test/pos-day.test.ts only. Architect: no P1; money logic correct.

P2 tests (each must be RED where it changes behaviour; say which):
1. Void test (~pos-day.test.ts:1898): void is Rp25,000 but only Rp15,000 cash taken, so the older "void cannot be allocated" check fires first. Make the void Rp15,000 so only the DP guard can fire; assert the error message contains "void pada pesanan yang memakai DP".
2. Guard tests (~:1918, :1950, :1972) assert only CONFLICT. Assert the message too (e.g. "melebihi DP pesanan asal", "tidak cocok dengan DP pesanan asal"; see item P3-2 for separate messages).
3. Add a test for the outlet-mismatch guard: pos_order_refunds on tenant.outletId, pos_deposit_refunds on a second outlet of the same tenant; expect 409 + message.
P3 code/tests:
- P3-1 (~service :613-669): select `depositOrderId: posDepositRefunds.orderId` and `refundOrderId: posOrderRefunds.orderId`; add a guard (case-insensitive not-equal, the ids may differ in ULID/UUID form: compare like the rest of the file does) that rejects a DP row whose order differs from its refund's order. Add a test only if it is cheap to seed, else say so.
- P3-2 (~:661): the three guards share one message; give each its own text, tests pin them.
- P3-3: cross-day over-refund test: Rp10,000 DP refunded on day 1, another Rp10,000 on day 2, order DP Rp10,000. Day 2 -> 409, day 1 -> 200.
- P3-4 (~:555): remove the unused selected `id`.

Rules: `LEGEND_TEST_FILES="src/test/pos-day.test.ts src/test/pos-vet9d-recap-contract.test.ts" heavy pnpm test` (one command per Bash call, background, wait for notification). Prettier --write + eslint on both files. No tsc, no commit, no push. Report: changes, RED/GREEN per test, counts, not verified.
