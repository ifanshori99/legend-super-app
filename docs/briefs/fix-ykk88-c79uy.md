# Brief: fix SO Codex legend-ykk88 + legend-c79uy (+ test backfill 0283)

Worktree: .worktrees/fix-ykk88-c79uy, branch ws/fix-ykk88-c79uy, base milestone/m1 (ede015c9). Migration range if needed: 0368-0370. Do not merge/push.
Rules: tests fail-first via targeted vitest; NO heavy command run by subagents (parent runs heavy). Money change must be proven: no party paid more, outlet not at loss; when in doubt choose rule that caps payment.

## A. legend-ykk88 (money)
Refund: fact time must be monotonic per bill (tagihan) AFTER taking the lock (POS / admin / void paths), so a legitimate refund is not wrongly quarantined, and an illegitimate refund is still rejected.
Locations: payment-refund-approval-limits.ts:282, pos-order-corrections.ts:967 (SO Codex 535 P2).
Proof tests: legit refund not quarantined when clock/fact time from before lock is stale vs a concurrent earlier refund; refund over limit / not allowed still rejected; sum of refunds never exceeds paid amount.

## B. legend-c79uy (access)
P1: hris-employee-manager.service.ts:183 re-authorize AFTER lock (load latest access; serialize with role revocation).
P2: backfill-employee-managers.ts:591 use latest time after lock, then reclassify.
Proof tests: P1 revoked role concurrently/before lock => manager assignment rejected; P2 stale time not used.

## C. Extra
Test migration backfill 0283 with tenant that has template roles (owner/tenant_admin) on real rows (never run on real rows before).

Test paths: apps/api/src/test/... (check existing neighbours). IDs ULID if API needs.

## A+ (second opinion Codex on m1, mandatory regression for ykk88)
Scenario, two real transactions: owner refund Rp100rb starts at T0, then waits on lock pos_orders; supervisor approves overpayment refund Rp150rb at T1; POS commits with refunded_at=T0 -> supervisor payout legitimately quarantined (Rp250rb > limit Rp200rb). Decision time of refund/void must be set AFTER the lock, monotonic vs bill facts, used for persistence AND events (pos-order-corrections.ts:967 and :371, payment-refund-approval-limits.ts:357). Also keep: illegitimate refund still rejected; total never exceeds cap.
