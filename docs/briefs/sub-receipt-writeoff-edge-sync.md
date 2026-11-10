# Sub-brief: receipt write-offs pulled to the edge (legend-jcby0)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-writeoff-edge-sync`. Edit only your section's files. No commit, no tsc, no full suite. Do not touch: write-off route/service (`pos-receipt-writeoff.*`), `pos-receipt.service.ts` (gap helpers are being changed on another branch), claim/rotation logic, edge PIN, `worker-main.ts`, UI, migrations.

## Problem

`receipt_number_writeoffs` (legend-0hzqw, migration 0156) exists on cloud and edge (same migrations), but only the cloud gets rows: the device-registry pull (`apps/api/src/services/edge-device-sync.ts`) ships `receipt_sequences` only. Tutup Hari on an edge (same `closePosDay` + gap ports as cloud, `app.ts:87/92`) stays refused with `RECEIPT_SEQUENCE_GAP` after the owner writes a number off on the cloud.
The edge gap check already counts local write-off rows and already applies "a late receipt cancels the write-off" (`writeoffOrdinalsBySequence`, `pos-receipt.service.ts` ~2090, `notExists` pos_receipts). So the fix is only: copy the cloud's write-off rows into the edge's own `receipt_number_writeoffs` via the existing pull. No migration. Write-offs are still created only on the cloud (service refuses on edge).

## Design

- Opt-in like `receiptSequences` (old edges parse pages strictly; `splitPage` must remove the new field before `deviceSyncPageSchema.parse`): query `receiptWriteoffs=1` → page field `receiptWriteoffs: DeviceReceiptWriteoffSync[]`, the outlet's FULL list on every page (append-only, rare; no cursor), ordered `created_at, id`, at most `RECEIPT_WRITEOFF_SYNC_MAX` (1000). More than that: send the oldest 1000 and log warn (counts only); the edge then fails closed (still refused), never wrong.
- Row: `{ id, outletId, sequenceId, prefix, sequenceNumber, reason, writtenOffBy, createdAt }` (no tenant: the edge takes it from its context).
- Edge apply (primary with binding only, same condition as sequences, AFTER the page's sequences so a new run is there first), in one `withTenant` tx: context must be exactly one outlet; any row of another outlet → whole list refused. Per row: edge `receipt_sequences` row with `id = sequenceId` of this tenant must exist with same outlet and prefix and `last_number >= sequenceNumber`, else skip (not ours / not yet / restored DB: fail closed). A local `pos_receipts` row for (sequence, number) → skip (late receipt; the gap check counts the receipt). Else insert with the cloud id, `onConflictDoNothing()` (repeat pulls idempotent), each insert in a savepoint; a trigger refusal (SQLSTATE 23514) → skip; any other error → the whole list is counted refused (caught, never throws out of the pull). Counts: inserted / skipped / refused, logged with counts only (never reason text).
- Fetcher: inside the `withSequences` block send `receiptWriteoffs=1`. On HTTP_400 from an older cloud: first retry the same page with everything except `receiptWriteoffs`; a second 400 continues into the existing staged chain (receiptRefused → receiptRuns → no sequences); none of the later stages sends `receiptWriteoffs`.

## Section S — `packages/shared/src/edge/schemas.ts` + `apps/api/src/services/edge-device-sync.ts` (implementer S)

1. Shared: `RECEIPT_WRITEOFF_SYNC_MAX = 1000`, `deviceReceiptWriteoffSyncSchema` (strict; `prefix: receiptPrefixSchema`, `sequenceNumber` int 1..999_999_999, `reason` 10..500, `writtenOffBy` uuid, `createdAt` ISO datetime string, uuids), type, and optional `receiptWriteoffs: z.array(...).max(MAX)` on `deviceSyncPageSchema`. JSDoc in the house style (legend-jcby0).
2. Cloud `deviceSyncQuerySchema.receiptWriteoffs: z.literal("1").optional()`; `listDeviceRecordsSince` reads the outlet's write-offs in the same tx as the sequences (query `receiptNumberWriteoffs` directly here, filtered by tenant AND outlet, not via the write-off service) and adds the field only when requested.
3. Edge `applyPageReceiptWriteoffs(context, raw)` as above; `splitPage` also splits `receiptWriteoffs`; `pullDeviceRegistry` calls it after the sequences; result gains `receiptWriteoffsInserted`, `receiptWriteoffsSkipped`, `receiptWriteoffsRefused`. Update `PullDeviceRegistryResult` and any caller that spreads/logs it (`apps/api/src/edge/runtime.ts` only if it must compile; keep edits minimal).

## Section H — `apps/api/src/edge/cloud-http.ts` + `apps/api/src/edge/cloud-http.test.ts` (implementer H)

Fetcher change above, plus unit tests in `cloud-http.test.ts` (mocked fetch): first request has `receiptWriteoffs=1` with `receiptSequences=1`; on 400 the retry drops only `receiptWriteoffs` (keeps receiptRuns/receiptRefused); two 400s continue into the old chain and no later request has `receiptWriteoffs`; no `receiptWriteoffs` when the fetcher has no `edgeInstanceId`/sequences path off (follow how `receiptRefused` tests are written). Do not change the existing behaviour otherwise.

## Section T — new DB test file `apps/api/src/test/edge-pull-writeoffs.test.ts` (test-writer T)

Real Postgres harness like `apps/api/src/test/pos-receipt-seq-edge.test.ts` (`cloudPull`, `scenario`, `ship`, `keepIds`, id remap: the simulated edge is another outlet in the same DB, so ship must remap run ids AND write-off ids and `sequenceId`, and set `outletId` to the edge outlet). For day close / gaps reuse helpers from `apps/api/src/test/pos-receipt-writeoff.test.ts`, `pos-day-receipt-gaps.test.ts`, `pos-day-close-all-gaps.test.ts`. Cloud write-off: through the real service if practical, else a direct insert in a tenant tx (the 0156 trigger still checks it). Cases:

- Repro: edge run with receipts 1 and 3 (hole 2), cloud has the run with last_number >= 3 and a write-off of 2; after the edge pull, Tutup Hari on the edge passes (or the edge outlet gap port returns no missing numbers; prefer the real `closePosDay` if the helpers allow). Without the fix it stays `RECEIPT_SEQUENCE_GAP`.
- Offline after pull: once pulled, a later Tutup Hari on the edge with no further pull passes.
- Late receipt: receipt 2 arrives on the edge after the write-off was copied → gap check passes, number counted once, not listed as written off; and a pull when the edge already has receipt 2 skips the row.
- Idempotent: two pulls → exactly one edge row per write-off.
- Isolation: a write-off of another tenant and of another outlet of the same tenant never reaches this edge.
- Skip/fail closed: a write-off for a run the edge does not hold, or whose number is above the edge run's last_number, is skipped (counted), other rows still inserted.
- Old edge: a request without `receiptWriteoffs` gets no `receiptWriteoffs` field (strict page parse still passes).
- Standby (role not primary) applies nothing.
  Write only; the engineer runs tests.
