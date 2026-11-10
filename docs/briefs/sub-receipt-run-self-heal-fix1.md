# Sub-brief fix round 1: receipt run self-heal (legend-hfq3z)

Read `docs/briefs/sub-receipt-run-self-heal.md` first (design + scope rules). Same worktree, same rules: edit only your section's files, no commit, no tsc / full suite.
Current state: all sections implemented; `apps/api/src/test/pos-receipt-seq-edge.test.ts` 43/43 pass. `applyCloudDeviceReceiptSequence` now wraps retire+insert in a savepoint and maps a unique violation (pkey / prefix key) to `refused_id_used` / `refused_prefix_used` (done, keep).

Review K findings to fix (no migration; keep reason `claim_rotated`):

## Section A — `apps/api/src/services/pos-receipt.service.ts` (implementer A)

A1. Heal only when `input.report !== undefined` (an edge that sends refusals always sends `receiptRuns`; without a report the cloud cannot tell an unreported numbered run). Also skip the throttle query when report undefined.
A2. Throttle query: add `eq(receiptSequences.edgeInstanceId, binding.edgeInstanceId)`. With it, a `claim_rotated` row bound to exactly this (node, instance) can only come from the heal path (a normal claim rotation retires rows with another binding or unbound) — state that in a comment. Raise `RECEIPT_REFUSAL_ROTATIONS_MAX` to 10.
A3. Heal retire stamps `tau` (`retireSequence(tx, tenantId, sequence.id, "claim_rotated", tau)`), like `edge_regressed`.
A4. Clone alarm: the existing `cloneSeen` query (rows of this exact binding retired as `edge_regressed` in the window) must also include rows retired as `claim_rotated` of this exact binding (heal retirements): use `inArray(receiptSequences.retiredReason, ["edge_regressed", "claim_rotated"])`. Same condition (reported > frozen high-water and tau newer) → `alert`. Scenario it fixes: clones A and B share (node, instance); B numbers P2 unreported, A refuses P2 and heals it away; B's later report `P2:3` must raise the alert.
A5. Heal prefix floor: in the heal branch pick the next free prefix `P<n>` with n greater than every `P<n>` in `input.report` (regex `^P(\d{1,11})$`), greater than the refused run's own number when its reason is `prefix_used`, and not in `used`. If that n would make the prefix longer than 12 chars, fall back to `nextFreePrefix(used)`. Implement as `nextFreePrefixAbove(used, floor)` next to `nextFreePrefix`; do not change the other callers. Reason: a clash means the edge holds prefixes the cloud lacks (e.g. cloud restore), stepping P4, P5... one at a time would burn the throttle.
A6. `alert` also true when `refusedThrottled > 0` (a device left without a run; the edge shows `receiptRunAlert`). Update the JSDoc paragraph (legend-hfq3z) for A1-A6.

## Section B — `packages/shared/src/edge/schemas.ts` + `apps/api/src/services/edge-device-sync.ts` (implementer B)

B1. `encodeReceiptRunRefusals`: at most `RECEIPT_RUN_REFUSAL_MAX_ENTRIES` (50, export it) entries, the lowest ids after sorting; doc: the rest go on a later pull once these healed (the cloud refuses > 50 with 400).
B2. `listDeviceRecordsSince`: when `claim.refusedThrottled > 0` log at error level (counts only: edgeNodeId, refusedThrottled), message "refused receipt runs throttled: device left without a receipt run (legend-hfq3z)"; keep the warn for `refusedRotated > 0`. The page's `receiptRunAlert` already follows `alert` (A6) — check it is sent when the request had `receiptRuns`.

## Section T — tests (test-writer T)

Files: `apps/api/src/test/pos-receipt-seq-edge.test.ts` (hfq3z block, helpers `cloudPull`/`hfqClaim` ~line 1353), `apps/api/src/edge/receipt-run-refusals.test.ts`, `apps/api/src/test/edge-pull-refusals.test.ts` if needed.
T1. A1 makes heal need a report: `cloudPull`/`hfqClaim` callers that send refusals must also send a report (`new Map()` = edge holds no run, or the real local one). Update helpers (e.g. default `report: new Map()` when refusals given) and add a test: refusals WITHOUT report → no rotation.
T2. Heal with a report holding other prefixes (e.g. edge reports `P7:3` for another device; refused run P2) → new prefix is P8 (floor), not P3; also prefix_used floor from the refused prefix itself.
T3. Clone alarm after heal (A4): heal P2 away for binding X, then a request for X with report `P2:3` (newer tau) → page `receiptRunAlert: true`.
T4. Throttle: counts only this instance's `claim_rotated` (a normal claim rotation of another instance's row of the same node does not count); max now 10 (`RECEIPT_REFUSAL_ROTATIONS_MAX`); throttled → `receiptRunAlert: true`.
T5. Codec: encoding 60 refusals yields 50 entries (lowest ids), decodes OK.
Run nothing; the engineer runs tests.
