# 528 Verification and money decisions

Worktree: `.worktrees/edge-promo-streams`; branch: `ws/edge-promo-streams`; base: `e38a3fdc`.

## Decisions

- Edge voucher/promo codes require authoritative cloud checkout online. Merely reaching cloud does not prove a local redemption exclusive. Every edge code path, including CRM validation preview, rejects codes. Cloud row-lock/idempotency logic stays authoritative.
- Voucher catalog documents land in tenant-RLS-protected `edge_voucher_catalog`, not canonical redeemable `vouchers`. Full holder and redeemed-order identifiers remain in JSON metadata without requiring local customer/order replicas. No fake holder profiles or unbound vouchers are created.
- Edge applies only uncapped automatic promotions; total/per-customer quotas, budget limits and facility entitlements require cloud checkout. This prevents spending shared capacity on independent databases.
- Both streams must complete before freshness can open. Partial/failed pulls persist epoch age, retain the cursor, and synchronously close the cached gate. Unproven elapsed time remains closed under Q62; normal sales remain available.
- Local promotion consumption counters never reset during metadata import and never advance the cloud rule version. A cloud cap reduced below already consumed local counters causes import to fail closed; all discounts stay off until rules can be imported. This favors no excess discount over availability.
- Rule, outlet switch and stacking policy are reread after candidate lock waits. Freshness and trusted time are rechecked before financial writes.

## Red proof

All commands ran at worktree root through `heavy`; no full suite was run.

- `LEGEND_TEST_FILES="src/test/edge-promo-stream-money.test.ts src/test/edge-promo-stream-sync.test.ts" heavy pnpm test`: initial registry and money regressions failed; `/tmp/528-red-final.log`, 13 failed / 6 passed. One protected-fixture cleanup exception was repaired separately.
- `LEGEND_TEST_FILES="src/test/edge-promo-stream-money.test.ts" heavy pnpm test`: facility entitlement case failed / 11 passed (`/tmp/528-facility-red.log`); direct resolver/stale-engine cases 4 failed / 12 passed (`/tmp/528-direct-red.log`).
- Two new files after concurrency/holder regressions: 8 failed / 27 passed (`/tmp/528-lock-holder-red.log`): five valid lock-wait money failures, one valid missing-holder FK import failure, and two raw PostgreSQL bigint fixture type mismatches subsequently corrected.

## Focused regression command

```sh
LEGEND_TEST_FILES="src/test/edge-promo-stream-sync.test.ts src/test/edge-promo-stream-money.test.ts src/test/edge-catalog-sync.test.ts src/test/edge-catalog-txid.test.ts src/test/edge-catalog-rewind.test.ts src/test/edge-catalog-loop.test.ts src/edge/catalog-puller.test.ts src/test/edge-promo-gate.test.ts src/test/edge-promo-unproven-clock.test.ts src/test/order-promo-db.test.ts src/test/crm-promo-engine.test.ts src/test/crm-promo-db.test.ts src/test/crm-promo-locks.test.ts src/test/crm-promo-freeitems.test.ts src/test/crm-promo-e5it-db.test.ts src/test/crm-promo-training.test.ts src/test/pos-refund-promo-db.test.ts src/test/edge-catalog-sales-gate-pos.test.ts src/test/edge-catalog-last-success.test.ts src/test/edge-catalog-followups.test.ts" heavy pnpm test
```

Result: 20 files, 378 tests passed, exit 0 (`/tmp/528-targeted-final.log`). Ordinary POS sales and refund regressions passed. New tests prove two edge code refusals followed by exactly one cloud voucher redemption, bounded nonnegative discounts, no stale/unproven financial writes, real cloud→second-edge imports/revocations, and five deterministic lock-wait races.

Actual local discount consumption of Rp12,000 survives cloud metadata/counter resync: local counters remain 1/Rp12,000 while cloud remains 7/Rp140,000. Release restores Rp12,000 exactly once; retry restores Rp0. Metadata stamps remain unchanged by redeem/release.

## Other gates

- `NODE_OPTIONS="--max-old-space-size=6144" heavy pnpm --filter @starter/api typecheck`: final fixed run exit 0 (`/tmp/528-tsc-api-fixed.log`). Initial runs found branded fixture/database seam typing; corrected. The heavy retry guard required reading its full failure log before retry; all reported errors were fixed.
- `heavy pnpm --filter @starter/shared typecheck`: exit 0 (`/tmp/528-tsc-shared-final.log`).
- Final lint/format, empty `db:generate`, and final two-file rerun results are recorded in `docs/PROGRESS.md` after execution.

## Verification limits

- Claude architect review remains scheduled by CTO after 00:45 per brief 526. One native Codex static review found the concurrency P1, which was fixed and covered by five failed-first tests; the reviewer rechecked the fix.
- Build, browser/e2e, production migration/rollout, and the full suite were not run. The brief prohibits the full suite. Generated additive migrations 0333–0334 were applied to disposable test databases.
- Q62 unknown boot age remains conservatively closed even after live pulls; no new live-clock proof protocol was introduced.

Final post-change run: the two new test files passed 35/35, exit 0 (`/tmp/528-new-tests-final.log`). API/shared tsc passed; changed-file ESLint and Prettier passed; final `heavy pnpm db:generate` reported no schema changes. Migration0334 tenant FK was moved inline per FORCE-RLS checklist before that last test run. No production TypeScript changed after the 378-test combined run.
