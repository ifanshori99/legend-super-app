# legend-rh1hk — design answer (architect, K tier)

Read-only review at f9586c0db. No code changed.

## Decision

Send the edge's outbox link cursor `C` with the report. Use it with the cloud's existing link slots, so **no migration**. Release reserved migration 0704.

The cursor alone cannot tell a race from a restore. A restored database keeps its instance id, so its numbering does not change (`bindPeer`, a9iby; restore-proof-db test "control: restored database ... acked normally"). Its `C_b` is therefore comparable with the cloud's numbers. It is lower, and it is self-consistent: the cloud's state at `C_b` is exactly the backup. The difference between the two cases is time. In a race, the cloud passed `C` within the last few seconds. In a restore, it passed `C_b` before the restore.

## Rule (Q1)

The report is **behind merge** only when all of these hold:
1. The pull sent `receiptRunsSeq = C` together with `receiptRuns`.
2. `sync_cursors(edge_to_cloud).peer_instance_id` equals the pull's `edgeInstance`. A null or different instance means `C` is ignored.
3. The first `edge_link_slots(edge_to_cloud)` row with `link_seq > C + peer_seq_offset` exists.
4. That row has `created_at >= tau - W`, with `W = RECEIPT_REPORT_CURSOR_WINDOW_MS = 30_000`. This is twice the edge's 15 s `DEFAULT_TIMEOUT_MS`.

One PK range lookup, `LIMIT 1`, run inside the claim transaction after `lockOutletSequences`:
```sql
SELECT s.created_at >= $tau::timestamptz - make_interval(secs => 30) AS recent
FROM sync_cursors c JOIN edge_link_slots s
  ON s.tenant_id = c.tenant_id AND s.edge_node_id = c.edge_node_id AND s.direction = c.direction
WHERE c.tenant_id = $t AND c.edge_node_id = $node AND c.direction = 'edge_to_cloud'
  AND c.peer_instance_id = $instance::uuid AND s.link_seq > $C + c.peer_seq_offset
ORDER BY s.link_seq LIMIT 1
```

When the report is behind merge, only the ol6v `lastNumber` comparison is relaxed. For a row where `reported < max(edgeReportedNumber, lastNumber)`:
- If `reported >= edgeReportedNumber`: no rotation. Raise `edgeReportedNumber`/`edgeReportedAt = tau` if it is higher, and count `behind += 1`.
- If `reported < edgeReportedNumber`: real regression. Rotate as today.

The stale check, the refusal heal, `cloneSeen` and the throttle are unchanged. A `behind` report never resolves `receipt_run_alert`.

Why this is sound: every slot above `C` was handed out after the edge read its report, so it was received after the read. Any slot above `C` older than W therefore proves the state went back in time.

## Q2 Migration

None. The answer is a per-pull flag, not a per-row one. Per-row precision would need two columns: the link seq that raised `lastNumber`, and when. `edge_reported_at` cannot serve as the time, because pulls move it and the relaxation could then repeat forever. That cost buys nothing, because the relaxed path still keeps the report-vs-report check.

## Q3 Wire

- Name: `receiptRunsSeq`. Format: decimal string, `^(0|[1-9][0-9]{0,14})$`.
- Allowed only with `receiptRuns`. Without it the cloud answers 400 (strict schema refine).
- The edge reads `next_out_seq` of its own `sync_cursors(edge_to_cloud)` row FIRST, then the counters, in the same `withTenant` transaction. This order is required under READ COMMITTED: reversed, a sale between the two reads would cause a false rotation. A missing row gives `0`.
- Compatibility: the parameter goes only on the first attempt. If that attempt gets 400, the edge retries the same page with everything except `receiptRunsSeq`, including writeoffs and refusals. If that retry succeeds, the parameter is suppressed for 1 h (the `receiptRefusalsRetryAt` pattern). If it also gets 400, the existing chain runs. Old edges send nothing and get today's behaviour.

## Q4 Failure modes

- **Clock skew:** the edge clock is not used. `tau` is the app clock and `created_at` is the DB clock, both on the cloud; W covers drift.
- **Restore within W** (e.g. a VM snapshot revert): detection waits one pull, at most W + `EDGE_DEVICE_SYNC_INTERVAL_SECONDS` (default 60 s). It is not lost. This is the same class as documented limit (1).
- **Cursor reset:** a new instance is ignored until the link rebinds, then `+ offset` maps it.
- **Dead-letter renumber** (`next_out_seq - 1`): `C` overstates, so the cloud does a full check. That is today's false rotation, never a hidden one.
- **Pruned or missing slot:** full check.
- **Replayed or stale report:** the old `C` points at old slots, so a full check, or `stale`, as today.
- **Lying edge:** a lie can only pick `C` just below a slot from the last 30 s. That relaxes the `lastNumber` comparison only, for that pull. Report-vs-report, `cloneSeen` and the merge's ordinal conflicts still catch a clone: the honest twin's next full check rotates. The liar would need the node credential, which already allows arbitrary pushes.

## Files, in order

1. `packages/shared/src/edge/schemas.ts`: add `receiptRunSeqQuerySchema`.
2. `apps/api/src/services/edge-device-sync.ts`:
   - `deviceSyncQuerySchema`: add the param and the refine.
   - `listDeviceRecordsSince` (around lines 303-345): pass `reportCursor`; resolve the alert only when `stale === 0 && behind === 0`.
   - `reportLocalRuns` (line 1182): return `{report, cursor}`.
   - `pullDeviceRegistry` (line 1233): pass `cursor` to `fetchPage`.
3. `apps/api/src/services/pos-receipt.service.ts`:
   - `claimDeviceReceiptSequencesForEdge`: input `reportCursor?: number`; add the `reportBehindMerge` helper and the branch before the regression retire (around line 1150); return `behind`.
   - Update the header comment (lines 28-47) and the JSDoc.
4. `apps/api/src/edge/cloud-http.ts`: `pathFor`, the fetcher signature, and the new first retry stage.
5. `apps/api/src/edge/runtime.ts:1192`: thread `cursor` through `fetchPage`.

## Q5 Tests (fail-first)

Add a new `rh1hk` describe in `apps/api/src/test/pos-receipt-restore-detect.test.ts`. Seed `sync_cursors` and `edge_link_slots` in each case.
- **Race:** `edgeReportedNumber` 2 and slots 1..5 old. Merge raises `lastNumber` to 3 and creates slot 6 now. Report `P1:2` with `C=5` and tau after the stamp. Expect `regressed 0`, `behind 1`, prefix kept. This fails today.
- **Restore:** same, but slot 6 is 10 min old. Expect `regressed 1`. Also: within W the result is `behind`; a second claim with tau after W gives `regressed 1`.
- **Report below `edgeReportedNumber` with a recent slot:** expect `regressed 1`.
- **Instance mismatch or null:** expect `regressed 1`.
- **Clone:** the yd0h8-9 cases rerun with a recent-slot `C`; `alert` is still true.
- **Existing tests stay green unchanged:** yd0h8-10 line 1557 (no cursor = old path).
- **Alert:** in `edge-device-sync-receipt-alert.test.ts`, a `behind` pull does not resolve the alert.
- **Wire parse and staging:** yd0h8-7 style parse tests. In `apps/api/src/edge/cloud-http-538.test.ts`: the first attempt carries the param; a 400 leads to a retry without it that keeps `receiptRuns` and writeoffs; then a 1 h suppression.

## Risks

- Nomor dokumen, K tier: one architect review, effort high.
- Relaxation is per node for W: during it, the ol6v check is off for every run of the node.
