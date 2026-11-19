# legend-rzt8s — architect review fixes (apply exactly, same two files)

Files: apps/api/src/worker/edge-order-redrive.job.ts, apps/api/src/test/pos-1162-edge-run-ack-before-ingest.test.ts.

1. Ordering (~lines 409, 415, 418): sort and keyset on the column `c.aggregate_sequence` (bigint NOT NULL, same as assertReplayAllowed), not `(c.event ->> 'sequence')::bigint`. Add `c.id` as third tie-break in both ORDER BY and the keyset (two nodes can store the same (sequence, event_id)).
2. (~line 400) In `reapplyRefusedReceiptRuns` (order-recovery path) call `blocked.delete(aggregateId)` before each `reapplyDevice`, so a device that failed in the paid phase is retried in the void phase of the same tick.
3. (~line 446) Add `FOR SHARE` to the `edge_nodes.status` read inside the per-run tx, so a revoke committing between read and apply is not missed (keep read inside the tx, after the conflict lock).
4. Tests (fail-first where it changes behaviour, say which are RED): (a) two devices in one sweep, device A keeps failing, device B heals in the same sweep; (b) cross-tenant: an open conflict of tenant 2 is never applied or resolved by a sweep for tenant 1; (c) the 101-run test: assert how many runs are applied right after the FIRST sweep (and the rest after the following sweeps, or fix the setup so more than one sweep is truly needed; do not leave sweeps that check nothing); (d) same-sequence tie-break across two nodes if cheap, otherwise skip and say so.
5. NOT in scope: partial index (separate card), failed-replay conflicts.

Rules: tests via `LEGEND_TEST_FILES="src/test/pos-1162-edge-run-ack-before-ingest.test.ts src/test/edge-order-redrive.test.ts" heavy pnpm test` (one command per Bash call, background, wait for notification). Prettier + eslint on both files. No tsc, no commit, no push. Report: changes, RED/GREEN per test, counts, not verified.
