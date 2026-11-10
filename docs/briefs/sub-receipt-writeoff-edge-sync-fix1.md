# Sub-brief fix round 1: receipt write-offs to the edge (legend-jcby0)

Read `docs/briefs/sub-receipt-writeoff-edge-sync.md` first (design, scope, rules). Same rules: only your section's files, no commit, no tsc, no tests. Current: `edge-pull-writeoffs.test.ts` + `cloud-http.test.ts` 47/47 pass. Change since the first brief: the cloud sends write-offs on request regardless of binding (the edge applies only as primary with binding) — keep.

## Section S2 — `apps/api/src/services/edge-device-sync.ts` (+ JSDoc only in `packages/shared/src/edge/schemas.ts`) (implementer)

1. Cap keeps the NEWEST (review F1): the cloud read orders `created_at DESC, id DESC` with `limit(MAX + 1)`, keeps the first MAX, then reverses so the page still lists them oldest first (`created_at, id`). Older rows are already on the edge and never removed; past the cap the newest still arrive. Update the warn text and the JSDoc of `RECEIPT_WRITEOFF_SYNC_MAX` / page field.
2. Cloud read isolated (F3): run the write-off SELECT in a savepoint (`tx.transaction(async (sp) => ...)`); on error log (counts only, edgeNodeId) and leave the field OUT of the page (edge applies nothing = fail closed); the device records and sequences of the page are unaffected.
3. Edge work and noise (F4), in `applyDeviceReceiptWriteoffs`:
   - one query first: ids of this outlet's local write-offs among the parsed ids → those are skipped silently (counted in `skipped`, no further queries);
   - a write-off whose run this database does not hold → `skipped`, not a "missed" (debug log at most);
   - a local receipt already holding the number (late receipt) → `skipped`, not "missed";
   - "missed" (worth a warn log, counts only) = run held but prefix differs or `last_number < n`, or a 23514 trigger refusal;
   - log info only when `inserted > 0`; warn when missed > 0.
   - `pullDeviceRegistry`: apply the write-off list once per pull (first page that carries it); later pages of the same pull skip it.
4. JSDoc (F6) on `deviceReceiptWriteoffSyncSchema`: strict per row; one bad row refuses the whole list; a new row field needs a new opt-in query parameter (older edges would refuse every list).

## Section H2 — `apps/api/src/edge/cloud-http.ts` + `apps/api/src/edge/cloud-http.test.ts` (implementer)

F2: send `receiptWriteoffs=1` only when `options.edgeInstanceId !== undefined` (as the first brief said). Flip the test that locks in the current behaviour (no `receiptWriteoffs` without `edgeInstanceId`), and fix the `legend-2lp.7` URL test expectation if its fetcher has no instance id. Nothing else.

## Section T2 — `apps/api/src/test/edge-pull-writeoffs.test.ts` (test-writer)

Add: prefix mismatch (edge run same id, other prefix) → skipped, not inserted; 23514 trigger skip inside the savepoint (e.g. call `applyDeviceReceiptWriteoffs` directly with a row the pre-checks pass but the trigger refuses, if constructible; else document why not); a non-23514 error refuses the whole list and the pull still succeeds (e.g. a `writtenOffBy`/reason that passes zod but violates a DB check, or another constructible failure; skip with a comment if not constructible); cloud cap: more than `RECEIPT_WRITEOFF_SYNC_MAX` rows (insert 1001 cheaply in SQL) → page has exactly MAX rows, the newest included, the oldest one left out, list ordered oldest first; second pull with everything already copied → `inserted 0`, `skipped` = list size; a multi-page pull (device records over more than one page, small `limit`) applies the write-offs once. Exported names: `applyDeviceReceiptWriteoffs`, `RECEIPT_WRITEOFF_SYNC_MAX`. Write only; the engineer runs tests.
