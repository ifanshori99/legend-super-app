# 528 Edge promo/voucher streams implementation

Spec: 528-edge-promo-voucher-streams.md; engineer override 526.

1. Tests first: real cloud export -> edge pull/apply, version replay, tenant/outlet rejection, expired/disabled/outlet-switch changes, complete-stream freshness. Separate money tests prove stale/unproven no writes, two-edge voucher refusal, cloud single use, discount bounds and capped auto promo refusal.
2. Shared/cloud/schema owner: add typed promotions/vouchers documents, cloud scanners, sync txid columns/indexes and migration 0333 only; outlet switches and stacking settings travel atomically with promotion documents, change triggers bump parent version. Export inactive rows and never replicate plaintext codes.
3. Apply/pull owner: ordered tenant/outlet-safe imports with no rollback of local financial counters; vouchers depend on promotions. Mark promo checkpoints fresh only when complete, and invalidate freshness before partial/failed/backlogged pull can expose older active rules.
4. Root safety owner: reject all voucher/code redemption on edge pending authoritative online cloud reservation. Cloud checkout is the supported online path. Skip globally capped promotions and customer accumulated/reward state on edge; allow only stateless uncapped promotions while both streams and trusted clock are fresh. Keep Q62 unproven time closed. No change to ordinary sales.
5. Run only focused LEGEND_TEST_FILES via heavy; package tsc via heavy, changed-file eslint/prettier and db:generate. Update PROGRESS, commit and push ws/edge-promo-streams without force. Architect review remains CTO's after 00:45; deadline 00:40 WIP checkpoint if unfinished.

Money decision: network reachability alone cannot prove voucher/global budget exclusivity. Edge never consumes voucher or capped promotion counters without shared atomic authority. Ordinary cloud redemption retains existing row locks and idempotency.
