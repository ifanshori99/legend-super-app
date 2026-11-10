# Second opinion (Codex): edge small fixes

Repo worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-small-fixes`, branch `ws/edge-small-fixes`, diff `d8ea5e0b..HEAD` (2 commits). Read-only: do not run builds or the full suite, do not edit.

## Cards
- legend-6xcy (S): `startEdgeMasterSyncLoop` is now started by `apps/api/src/edge/runtime.ts` (5 min, `masterSync.stop()` in the runtime `stop()`). Test in `apps/api/src/test/edge-registry-pull.test.ts` (hanging masters fetch, stop resolves, signal aborted).
- legend-jm5c (K): the refund payout and escalation sweep in `apps/api/src/worker-main.ts` only starts when `sweepsRefunds = edgeRuntime.ok && !edgeRuntime.config.edgeMode` (fail-closed). Source-regex test `apps/api/src/test/edge-worker-refund-gate.test.ts`.
- legend-oark: NOT changed. Pull loop already exists. Open gaps, out of scope here: `applyStaffPinRecords` (`services/staff-pin-sync.ts`) has no EDGE_MODE guard; the spec "refuse setStaffPin on the edge" contradicts `edge/mode.ts` (allowlists `/api/staff-pins`) and `edge/staff-pin-resend.ts`.

## Questions
1. Can any other path start a refund payout/escalation on an edge worker (other scheduler, relay tick, job)?
2. Can the master sync loop start leak (timer/abort) if runtime startup throws after it starts, or race a bootstrap sync?
3. Is a source-regex test enough to guard jm5c, or is there a cheap behavioural alternative?
4. Anything on the legend-oark gaps above you would treat as release-blocking?

Answer with findings only: file:line, severity, fix. Under 25 lines.

## Pembaruan CTO
legend-oark sudah diubah di b6f0035f (guard EDGE_MODE di applyStaffPinRecords); permintaan tolak setStaffPin di edge dibatalkan. Rentang: d8ea5e0b..b6f0035f.
