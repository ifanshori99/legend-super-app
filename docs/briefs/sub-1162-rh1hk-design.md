# legend-rh1hk — design question for architect (K tier, receipt numbering)

Worktree: this repo, branch ws/1162-pos-struk-edge (HEAD f9586c0db). Read-only task: write the design to `docs/briefs/sub-1162-rh1hk-design-answer.md`, change no code.

## Bug
Edge pull sends `receiptRuns` (prefix -> last number) built on the edge (`apps/api/src/edge/runtime.ts:1192`, `cloud-http.ts:256-283`, codec `packages/shared/src/edge/schemas.ts:209-244`). Cloud: `edge-device-sync.ts:303-312` sets `reportedAt = now` (cloud arrival), `claimDeviceReceiptSequencesForEdge` in `pos-receipt.service.ts:925-1170` compares: stale if `tau <= edgeReportedAt`; `reported < max(edgeReportedNumber,lastNumber)` => `retireSequence(...,"edge_regressed")` + new prefix (alert, throttle `RECEIPT_REGRESSION_ROTATIONS_MAX`).
Race: edge reads report (N), issues receipt L=N+1, pushes, cloud merges L (merge stamps edge_reported_at = merge time, legend-ol6v), THEN the pull request arrives with the old report N. tau > stamp, N < lastNumber => false rotation (prefix wasted, alert, throttle slot). Numbers stay unique, so it is noise/ops cost, not double numbering. Real restore/clone detection MUST keep working.

## Proposal (CTO): the pull report carries the outbox link cursor
Link cursor = `sync_cursors` (`next_out_seq`, `acked_out_seq`, `received_in_seq`, `peer_instance_id`, `peer_seq_offset`; `apps/api/src/db/schema/edge-node.ts:161`, `edge/db-link-store.ts:263-300`). Migration number reserved: 0704 (backup 0705). Latest in tree is 0492; use 0704 anyway (reserved work range).

## Questions
1. Exact rule: with the edge cursor C sent in the report (taken in the SAME read as the report), when may the cloud treat the report as stale/behind-merge (skip the regression check) versus a real restore? Restore case: edge DB restored from backup has lower numbers AND a lower outbox cursor than cloud's `received_in_seq`. Read `edge-link-restore-proof*.test.ts`, `edge-link-instance-resume.test.ts`, `db-link-store.ts` (peer instance / seq offset) to see how restore changes the cursor space (new instance id? offset?), and say whether C is comparable across a restore.
2. Does it need a stored column (migration 0704), e.g. on `receipt_sequences` (link seq of the merged run event that last raised lastNumber) — or can the rule use only existing `sync_cursors` data (no migration)? Prefer no migration if sound; CTO allows 0704 if needed.
3. Wire format: backward compatible optional query param (old edges send none => old behaviour). Name and encoding. Validate strictly (bounded int).
4. Failure modes: clock skew, cursor reset, replayed/stale report, attacker-chosen cursor value (an edge can lie: it can only make cloud SKIP a regression check — is that acceptable, can it hide a clone? bound it).
5. Test plan (fail-first): race test (report read, L issued+pushed+merged, then pull => NO rotation), restore test (restored DB => still rotates once), clone test (alarm path `cloneSeen` still fires).

Answer concisely: chosen rule, exact files/functions to change, migration yes/no and its SQL, risks. Do not write code.
