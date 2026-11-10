# Sub-brief: receipt run self-heal (legend-hfq3z)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-run-self-heal` (branch `ws/receipt-run-self-heal`). Edit ONLY the files of your section. Do not commit. Do not run `pnpm check`, tsc, or the full test suite (the engineer runs them). Do not touch `receiptGapsForDevice`, `closePosDay`, write-off, edge PIN, refund, payroll, auth, `worker-main.ts`. No migration (decision below).

## Problem

Cloud rotates a device run (e.g. legend-yd0h8 `edge_regressed`), edge refuses the replacement because its prefix or id already exists locally (`applyCloudDeviceReceiptSequence` in `apps/api/src/services/pos-receipt.service.ts` returns `"refused"`), sduiq retires the old local run, device has no run → sales fail `RECEIPT_SEQUENCE_NOT_PROVISIONED` forever (the replacement stays at 0, so no regression rotation either).

## Design (decided)

1. Edge collects clash refusals per pulled run: `prefix_used` (the `used.has(sequence.prefix)` branch) and `id_used` (the `sameId` branch). Other refusals (other binding, outlet key / `C`, `lastNumber > 0`, local row bound elsewhere) are NOT reported.
2. Next request to the cloud carries query param `receiptRefused=<id>:<reason>,...` (only when non-empty and only together with `receiptSequences=1`). Contract already in `packages/shared/src/edge/schemas.ts`: `RECEIPT_RUN_REFUSAL_REASONS`, `ReceiptRunRefusalReason`, `ReceiptRunRefusalReport` (ReadonlyMap id->reason), `encodeReceiptRunRefusals`, `decodeReceiptRunRefusals` (ids lowercased; null = malformed), `receiptRunRefusalQuerySchema`. Exported from `@starter/shared/edge` like `decodeReceiptRunReport`.
3. Cloud claim (`claimDeviceReceiptSequencesForEdge`): for a current row bound to exactly this binding whose id is in the refusals AND `lastNumber === 0` AND `edgeReportedNumber === 0` AND `(report?.get(prefix) ?? 0) === 0`: retire it with the EXISTING reason `claim_rotated` (no migration; the check constraint stays) and insert the next free prefix bound to the binding (same code as the rotate branch), `refusedRotated += 1`, `continue`. Throttle: count rows `tenant, edgeNodeId = this node, retiredReason = 'claim_rotated', retiredAt > now() - RECEIPT_REGRESSION_WINDOW_HOURS` grouped by device (query only when refusals non-empty); when a device already has `>= RECEIPT_REFUSAL_ROTATIONS_MAX` (new export, = 5) → `refusedThrottled += 1` and fall through to the normal handling of that row. Idempotent: a reported id that is retired / unknown / other tenant / other binding / has numbers is ignored (only current rows of this tenant+outlet bound to this binding are visited; outlet advisory lock already serialises concurrent pulls). The same request's `listDeviceReceiptSequences` then returns the new run, so the edge heals in that same response.
4. Compat: old edge sends no param → unchanged. New edge vs old cloud (strict query → HTTP 400): the fetcher retries without `receiptRefused` first (keeping `receiptRuns`), then the existing staged retries.

## Section P — `apps/api/src/services/pos-receipt.service.ts` (implementer P)

- `claimDeviceReceiptSequencesForEdge`: input gains `refusals?: ReceiptRunRefusalReport`; result gains `refusedRotated: number; refusedThrottled: number`. Logic per point 3, placed at the top of the `sameBinding(sequence, binding)` branch (before the `input.report === undefined` continue). Export `RECEIPT_REFUSAL_ROTATIONS_MAX = 5`. Update the JSDoc (legend-hfq3z paragraph).
- `applyCloudDeviceReceiptSequence`: return type becomes `"inserted" | "kept" | "replaced" | "refused" | "refused_prefix_used" | "refused_id_used"`; the prefix-used branch returns `"refused_prefix_used"`, the sameId branch `"refused_id_used"`. Update its JSDoc and the `retireUnlistedDeviceReceiptSequences` JSDoc sentence that says a clash "does NOT recover by itself" (now: reported on the next pull, legend-hfq3z).

## Section S — `apps/api/src/services/edge-device-sync.ts` (implementer S)

- `deviceSyncQuerySchema`: add `receiptRefused: receiptRunRefusalQuerySchema.optional()` with doc comment.
- `listDeviceRecordsSince`: decode it (`decodeReceiptRunRefusals(...) ?? undefined`) and pass `refusals` to the claim; log a warn with counts only when `refusedRotated > 0 || refusedThrottled > 0` (message mentions refused runs rotated, legend-hfq3z). No page shape change.
- `ReceiptSequenceApplyResult`: add `readonly refusals: ReceiptRunRefusalReport` (id -> reason of this list's clash refusals). `applyDeviceReceiptSequences` fills it from the two new outcomes (they also count in `refused`); empty Map on the early return.
- `applyPageReceiptSequences`: also return `refusals` (empty Map in the catch).
- `PullDeviceRegistryOptions`: add `readonly refusals?: ReceiptRunRefusalReport` (from the previous pull); `fetchPage(since, receiptRuns?, refusals?)`. In `pullDeviceRegistry`: `let pending = options.refusals ?? new Map()`; pass `pending.size > 0 ? pending : undefined` as 3rd arg only when role primary + binding; after each page: if the page's sequences were applied (the existing if branch) `pending = counts.refusals`, else `pending = new Map()` (a cloud that sends no sequences cannot use the report). Result gains `readonly receiptRunRefusals: ReceiptRunRefusalReport` = final `pending`. Doc comments.

## Section H — `apps/api/src/edge/cloud-http.ts` + `apps/api/src/edge/runtime.ts` (implementer H)

- `createDeviceRecordsFetcher`: fetcher signature `(since, signal, receiptRuns?, refusals?)`; `pathFor` sets `receiptRefused` (via `encodeReceiptRunRefusals`) only with sequences and only when `refusals` non-empty. Retry: when a request that carried `receiptRefused` gets HTTP_400, log warn ("cloud refused the receipt run refusal report; retrying the page without it") and retry once with sequences + edgeInstance + receiptRuns but without refusals; if that also 400s, continue into the EXISTING staged chain (without receiptRuns, then without sequences). Keep existing behaviour identical when `refusals` is absent/empty. Keep the `options.edgeInstanceId === undefined` guard semantics.
- `runtime.ts` (device puller block ~line 663-700): closure `let receiptRunRefusals: ReceiptRunRefusalReport = new Map();` pass `refusals: receiptRunRefusals` to `pullDeviceRegistry`, forward 3rd arg in `fetchPage: async (cursor, receiptRuns, refusals) => fetchDeviceRecords(cursor, signal, receiptRuns, refusals)`, and after `pullDeviceRegistry` resolves set `receiptRunRefusals = result.receiptRunRefusals` (keep returning the result unchanged). Do not change anything else in runtime.ts.

## Section T1 — tests in `apps/api/src/test/pos-receipt-seq-edge.test.ts` (test-writer T1)

Add `describe("legend-hfq3z ...")` after the sduiq block (~line 1054; its case ~1060 builds a refused clash: reuse its setup helpers). Test via the real functions (`listDeviceRecordsSince` / `claimDeviceReceiptSequencesForEdge`, `applyDeviceReceiptSequences`/`pullDeviceRegistry` as the existing tests do). Cases:

1. Repro: replacement refused for prefix clash → device cannot sell (RECEIPT_SEQUENCE_NOT_PROVISIONED); next pull carries the refusal → cloud retires that run (`claim_rotated`) and lists a new run with a new prefix → edge accepts it → a sale on the edge numbers under the new prefix (1).
2. Same for id clash (`id_used`) if feasible with the helpers.
3. Repeated / duplicated report (send the same refusals twice, also after heal) → exactly one current cloud row per device, one extra retired row, no prefix reused.
4. Ignored: id of a run with numbers (lastNumber>0 or edge_reported_number>0), id bound to another node/instance, unknown id, id of another tenant's run (that run untouched: tenant isolation).
5. Old edge (no `receiptRefused`) → no rotation (behaviour unchanged).
6. Throttle: after `RECEIPT_REFUSAL_ROTATIONS_MAX` claim_rotated retirements of that device on the node in the window → `refusedThrottled`, no rotation.
7. Query schema: `deviceSyncQuerySchema` accepts a good `receiptRefused`, rejects malformed (bad uuid, bad reason, duplicate id, >50 entries).
   Tests must FAIL on the base code (behaviour asserts, not only types). Run: `bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/test/pos-receipt-seq-edge.test.ts" pnpm test'` only when the engineer tells you code is ready; otherwise just write.

## Section T2 — unit tests (test-writer T2)

- `apps/api/src/edge/cloud-http.test.ts`: fetcher sends `receiptRefused` only with non-empty refusals; on 400 retries without it but with `receiptRuns`; second 400 continues the old chain; no refusals → old behaviour (existing tests stay green).
- Shared codec tests: find where shared edge schemas are tested (grep `encodeReceiptRunReport` in `packages/shared` tests or `apps/api/src/test`); add round-trip / malformed cases for `encodeReceiptRunRefusals`/`decodeReceiptRunRefusals` there.
- `pullDeviceRegistry` unit level if an existing test file covers it with fake `fetchPage` (grep `pullDeviceRegistry(` in tests): refusals of page k sent on page k+1; `options.refusals` sent on page 1; page without sequences clears; result `receiptRunRefusals`.
