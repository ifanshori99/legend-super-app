# Sub-brief: detect a restored / cloned edge database (legend-yd0h8)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-restore-detect` (branch `ws/edge-restore-detect`, base `ws/receipt-seq-edge` 64638306 = legend-zsdd). Tier K (document numbers + migration). Read `docs/briefs/sub-receipt-seq-edge.md` (zsdd design) first: binding, claim, rotate, edge apply. legend-ol6v (edge->cloud receipt merge) is NOT done; do not build it.

## Rules for every subagent

- Never read `.env*`. Never kill processes you did not start. Do not commit (lead commits).
- Edit ONLY the files of your section. Need another file: stop and report.
- Keep existing comments. New code: short comment with `legend-yd0h8`.
- Do not run tsc, eslint or the full test suite; the lead runs them. Tests only if your section says so.
- Do not touch: `staff_pin*`, `access-applier.ts`, refund, pos-day, pos-shift, auto-journal, payroll, `app.ts`, `routes/index.ts`, `worker-main.ts`.
- Report: files changed, exported signatures, anything you could not do.

## Problem

`edge_nodes.instance_id` lives in the edge database. A backup / VM snapshot restore or a clone keeps it, so the cloud sees the same (node, instance) and the restored edge reprints numbers it issued after the backup (cloud `lastNumber` stays 0 for edge runs until legend-ol6v).

## Design (lead decision)

1. Each device-records pull of a primary edge with a binding REPORTS its local counter of every current local device run: `prefix -> lastNumber` (all local rows with `retired_at IS NULL` and `device_id <> outlet_id`, any binding). Encoded in the query param `receiptRuns`: `""` (empty report: the edge holds no run) or `P1:150,P3:7` (comma-separated `<prefix>:<lastNumber>`). Absent param = old edge = no check at all.
2. Cloud keeps a high-water per run: new column `receipt_sequences.edge_reported_number` (int, default 0, never decreases). During the claim (`claimDeviceReceiptSequencesForEdge`), for every current row bound to exactly (N, I) of this pull, when a report was sent:
   - `reported = report.get(row.prefix) ?? 0` (a run bound to this database that the edge no longer holds counts as 0: a restore from before the run).
   - `high = max(row.edgeReportedNumber, row.lastNumber)`.
   - `reported >= high`: normal. If `reported > row.edgeReportedNumber`, raise the high-water (guarded UPDATE). No rotation.
   - `reported < high`: REGRESSION (restored or cloned database). Rotate like zsdd: retire the row with reason `edge_regressed`, insert the next free prefix bound to (N, I) at 0. The edge's existing `replaced` apply path then retires its local row and numbers under the new prefix.
   - Report entries for unknown, retired or foreign-bound prefixes are ignored.
3. Rate limit (two live databases on one node id keep regressing each other): per (node N, device), count rows retired with reason `edge_regressed`, bound to node N, `retired_at > now() - 24 hours`. If the count is already `RECEIPT_REGRESSION_ROTATIONS_MAX = 2`, do NOT rotate (throttled): keep the row, keep the high-water (never lowered). Alert = some device of node N has `>= 2` such retirements in the window (after counting this pull's rotations). So a single restore rotates once with no alert; a clone rotates at most 2 times per device per 24 h, then raises the alert and stops.
4. Alert to the edge: the page carries `receiptRunAlert: true` ONLY when the request sent `receiptRuns` (old edges parse pages strictly) and the alert holds; otherwise the field is absent. The edge splits it off the page like `receiptSequences` (never refuses the page). Puller state + `GET /api/edge/status` `deviceRegistry` show it.
5. Retire reason (audit + rate limit): new nullable column `receipt_sequences.retired_reason`. Every retire path sets one: `claim_rotated` (zsdd claim rotation), `cloud_takeover` (cloud sale on an edge-bound run, `ensureSequence`), `edge_replaced` (edge apply `replaced`), `edge_regressed` (new).
6. Known limits (do not try to fix; architect A1): sales between a restore and the first successful pull still reuse numbers; a clone (two live databases, same node + instance) gets an ALARM, not prevention (both receive the new prefix). Also: a restored edge that sells past the old high-water before its first pull, or a backup newer than the last pull, is not detected (legend-ol6v receipt events will). Manual zsdd procedure (reset `edge_nodes.instance_id`) stays valid.

Release order: cloud before edge (old cloud's strict query 400s on `receiptRuns`; the fetcher falls back, see S3).

## Contract (shared by all sections)

DB `receipt_sequences` (drizzle `apps/api/src/db/schema/pos-receipt.ts`):

- `edgeReportedNumber: integer("edge_reported_number").notNull().default(0)`, check `receipt_sequences_edge_reported_number_check`: `edge_reported_number BETWEEN 0 AND 999999999`.
- `retiredReason: varchar("retired_reason", { length: 30 }).$type<ReceiptSequenceRetiredReason>()` nullable; check `receipt_sequences_retired_reason_check`: `retired_reason IS NULL OR (retired_at IS NOT NULL AND retired_reason IN ('claim_rotated','cloud_takeover','edge_replaced','edge_regressed'))`. Export `type ReceiptSequenceRetiredReason = "claim_rotated" | "cloud_takeover" | "edge_replaced" | "edge_regressed"` from the schema file.
- Trigger `app.receipt_sequences_forward_only` (add, keep every existing rule): `edge_reported_number` never decreases; on a retired row (OLD.retired_at NOT NULL) `edge_reported_number` and `retired_reason` never change; `retired_reason` may only be set in the update that sets `retired_at` (NULL -> value), never on a current row (check covers it).

Shared (`packages/shared/src/edge/schemas.ts`):

- `export type ReceiptRunReport = ReadonlyMap<string, number>` (prefix -> lastNumber).
- `export function encodeReceiptRunReport(report: ReceiptRunReport): string` (sorted by prefix, `P1:150,P3:7`; empty map -> `""`).
- `export const receiptRunReportQuerySchema` = zod string, max 12000 chars, `""` or entries matching `<receiptPrefix>:<0..999999999>` joined by `,`, max 500 entries, no duplicate prefix; `.transform` to `Map<string, number>`.
- `deviceSyncPageSchema` gains `receiptRunAlert: z.literal(true).optional()` with a doc comment (sent only to an edge that sent `receiptRuns`).

Service (`apps/api/src/services/pos-receipt.service.ts`):

- `export const RECEIPT_REGRESSION_ROTATIONS_MAX = 2;` `export const RECEIPT_REGRESSION_WINDOW_HOURS = 24;`
- `claimDeviceReceiptSequencesForEdge(tx, context, input: { outletId: string; report?: ReceiptRunReport } & DeviceReceiptSequenceBinding): Promise<{ claimed: number; rotated: number; regressed: number; throttled: number; alert: boolean }>`. `rotated` keeps its zsdd meaning (claim rotation); `regressed` = rotations for a regression; `throttled` = regressions not rotated. `alert` false when `report` is undefined.
- `export async function localReceiptRunReport(tx, context, outletId: string): Promise<Map<string, number>>` (edge only; throws on the cloud): current local device runs `prefix -> lastNumber`.
- `retireSequence(tx, tenantId, sequenceId, reason: ReceiptSequenceRetiredReason)`; all callers pass the reason above.

Edge sync (`apps/api/src/services/edge-device-sync.ts`):

- `deviceSyncQuerySchema` gains `receiptRuns: receiptRunReportQuerySchema.optional()` (doc: legend-yd0h8).
- `listDeviceRecordsSince`: pass `report: receiptRuns` to the claim; log a warn (counts only) when `regressed > 0 || throttled > 0`; the page includes `receiptRunAlert: true` only when `receiptRuns !== undefined && claim.alert`.
- `PullDeviceRegistryOptions.fetchPage: (since: string | null, receiptRuns?: ReceiptRunReport) => Promise<unknown>`. `pullDeviceRegistry`: when `role === "primary"` and `binding` set, before EACH page compute `localReceiptRunReport` (own short `withTenant` tx on the edge, outlet = `context` outlet) and pass it; else pass `undefined`.
- `splitPage` also splits `receiptRunAlert`; `PullDeviceRegistryResult` gains `receiptRunAlert: boolean` (true if any page had `receiptRunAlert === true`; any other value ignored).

Fetcher (`apps/api/src/edge/cloud-http.ts`): returned function `(since, signal, receiptRuns?: ReceiptRunReport)`. With sequences and `receiptRuns` given: `query.set("receiptRuns", encodeReceiptRunReport(receiptRuns))`. 400 fallback, staged: if the failed request carried `receiptRuns`, retry once WITH sequences + `edgeInstance` but WITHOUT `receiptRuns` (zsdd cloud); if that also 400s (or no report was sent), the existing retry without sequences and without `edgeInstance`. Final failure thrown as is.

Runtime (`apps/api/src/edge/runtime.ts`, wiring lines only): `fetchPage: async (cursor, receiptRuns) => fetchDeviceRecords(cursor, signal, receiptRuns)`; return `receiptRunAlert` from the pull to the puller.

Puller (`apps/api/src/edge/device-registry-puller.ts`): `pull` may return `receiptRunAlert?: boolean`; state gains `receiptRunAlert: boolean` (from the last successful pull) and `receiptRunAlertAt: string | null` (time of the last successful pull with alert true; failures change neither). Same pattern as `receiptSequencesRefused` / `…RefusedAt`.

Status: `packages/shared/src/edge/endpoints.ts` `edgeStatusSchema.deviceRegistry` gains `receiptRunAlert: z.boolean().optional()` and `receiptRunAlertAt: isoDateTimeSchema.nullable().optional()`; `apps/api/src/services/edge-status.service.ts` fills them.

Migration: `apps/api/drizzle/0153_receipt_sequence_restore_detect.sql`, journal `when` = 1794232000000 (above 1794231000000). CTO may renumber at merge.

## S1: schema + migration (implementer)

Files: `apps/api/src/db/schema/pos-receipt.ts`, `apps/api/src/db/schema/pos-receipt.custom.sql`, new migration + `apps/api/drizzle/meta/*`.

- Columns, checks, type per Contract. Trigger: read the whole function; add the rules; update custom.sql AND append the same `CREATE OR REPLACE FUNCTION` to the migration.
- `cd apps/api && pnpm db:generate` (no DB needed), rename generated file/tag to `0153_receipt_sequence_restore_detect`, journal `when` 1794232000000, append trigger SQL with `--> statement-breakpoint`. Run `pnpm db:generate` again: must produce nothing. Report the generated SQL.

## S2: service (implementer)

File: `apps/api/src/services/pos-receipt.service.ts` only. Per Design 2, 3, 5 and Contract. Rate-limit count: one query at the start of the claim (after `lockOutletSequences`) grouped by device for node N; increment locally per rotation. High-water UPDATE guarded `WHERE retired_at IS NULL AND edge_reported_number < reported`. Update the header comment and the claim's doc comment. Import `ReceiptRunReport` from `@starter/shared/edge` and the reason type from the schema.

## S3: shared schema, edge sync, fetcher, runtime (implementer)

Files: `packages/shared/src/edge/schemas.ts`, `apps/api/src/services/edge-device-sync.ts`, `apps/api/src/edge/cloud-http.ts`, `apps/api/src/edge/runtime.ts` (wiring only). Per Contract. Also extend `apps/api/src/edge/cloud-http.test.ts` with: param sent; staged fallback (400 with receiptRuns -> retry keeps edgeInstance, drops receiptRuns; second 400 -> retry without sequences). Run only that test file: `bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-restore-detect" && pwd && LEGEND_TEST_FILES="src/edge/cloud-http.test.ts" heavy pnpm test'` (only after S2 reported, else skip and say so).

## S4: puller state + status (implementer)

Files: `apps/api/src/edge/device-registry-puller.ts`, `apps/api/src/edge/device-registry-puller.test.ts`, `packages/shared/src/edge/endpoints.ts` (`edgeStatusSchema.deviceRegistry` only), `apps/api/src/services/edge-status.service.ts`. Per Contract. Add puller test cases (alert set, At kept after an alert-free pull, failure keeps both). Run: `bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-restore-detect" && pwd && LEGEND_TEST_FILES="src/edge/device-registry-puller.test.ts" heavy pnpm test'`.

## T1: reproduction tests (test-writer, isolated worktree at the base)

New file `apps/api/src/test/pos-receipt-restore-detect.test.ts`. Copy setup helpers from `apps/api/src/test/pos-receipt-seq-edge.test.ts` (read, do not edit: `inEdgeMode`, `enroll`, `insertNode`, `queryWith`, `pullAs`, `shipTo`, `localEdgeNode`, `edgeApply`, `edgeSell`, `sequenceRows`). Cloud and edge share one test DB; an "edge database" is an edge outlet. Drive the edge through `pullDeviceRegistry` whose `fetchPage(since, receiptRuns)` calls the cloud `listDeviceRecordsSince` with `deviceSyncQuerySchema.parse({ limit, receiptSequences: "1", edgeInstance, ...(receiptRuns ? { receiptRuns: encodeReceiptRunReport(receiptRuns) } : {}) })` and ships the page to the edge outlet. Cases:

1. Restore: edge A (node N, instance I) pulls, sells 3 on P1, pulls again (cloud high-water 3). A "restored" edge B (new edge outlet, SAME N and I) holding P1 at 1 (ship P1, sell 1) pulls: cloud retires P1 (`retired_reason = 'edge_regressed'`), B's next sale is `<new prefix>-000001`, never `P1-000002`. On the base this must fail on the receipt number assertion.
2. Restore from before the run: same as 1 but B holds no P1 at all (empty report) -> rotated, B never issues `P1-000001`.
3. Normal reports (equal or forward, repeated pulls, multi-page) never rotate; high-water rises; a report never lowers it.
4. Old edge (no `receiptRuns`): no check, no rotation, no `receiptRunAlert` key on the page; zsdd behaviour unchanged.
5. Clone: two edges with the same (N, I) alternate pulls with diverging counters: at most 2 regression rotations per device in 24 h, then throttled (no further rotation, prefix stable), page has `receiptRunAlert: true`; a single restore (case 1) has no alert. Pulls with `receiptRuns` see the alert even when their own report did not regress.
6. Trigger (owner SQL): `edge_reported_number` cannot decrease; `retired_reason` cannot be set on a current row nor changed on a retired one.
7. Report parsing: bad `receiptRuns` (bad prefix, negative, duplicate prefix, >500 entries) -> `deviceSyncQuerySchema` refuses.
   Reproduce first in your isolated worktree at the base: `bash -c 'cd "<your worktree>" && pwd && pnpm worktree:setup >/dev/null && LEGEND_TEST_FILES="src/test/pos-receipt-restore-detect.test.ts" heavy pnpm test'`. Case 1 must fail on a number/prefix assertion (show the line); others may fail on missing API. Report fail lines and the absolute path of your test file; the lead copies it.

## Round 2: review K fixes (on top of 226421c3)

Findings: (R1, reviewer) a report read before a request that timed out (15 s) can reach the cloud AFTER a newer report raised the high-water: false `edge_regressed` rotation, burns the 2-per-24h budget, so a real restore later is throttled. (R2, reviewer) trigger allows retiring with `retired_reason` NULL. (A1, architect) docs overstate: sales between a restore and the first successful pull still reuse numbers; a clone gets an ALARM, not prevention (both databases receive the new prefix). (A2, architect) the cloud warn log has no node id. (A3, architect) alert earlier: a report for a RETIRED `edge_regressed` prefix of this binding above its frozen high-water = a second live database: alert at the first rotation.

Fix contract:

- DB `receipt_sequences.edge_reported_at` (`edgeReportedAt: timestamp("edge_reported_at", { withTimezone: true })`, nullable): edge time of the report that last raised the high-water. Trigger: never goes backwards, never back to NULL once set, frozen on retired rows; and (R2) the update that retires a row (OLD.retired_at NULL, NEW.retired_at NOT NULL) must set `retired_reason`. Same migration 0153 (not merged yet): regenerate it, keep name, journal `when` 1794232000000, snapshot chained from 0152; `pnpm db:generate` again must be empty.
- Query `receiptRunsAt: isoDateTimeSchema.optional()` (edge time the report was read; use the shared ISO datetime schema already used in `packages/shared/src/edge`). Fetcher: whenever it sets `receiptRuns` it also sets `receiptRunsAt` = `(options.now ?? (() => new Date()))().toISOString()` (new optional `now` option); fallback stage 1 drops both.
- Claim input gains `reportedAt?: Date` (service passes `new Date(receiptRunsAt)` or undefined). Token `τ = min(reportedAt ?? cloudNow, cloudNow + 5 min)` (`cloudNow = new Date()`; clamp so a forward-skewed edge clock cannot freeze the check). Per row bound to (N, I), with a report:
  - `row.edgeReportedAt !== null && τ <= row.edgeReportedAt`: STALE, skip the row entirely (count `stale`).
  - else as before; when the high-water rises set `edgeReportedNumber = reported, edgeReportedAt = τ` (guard `edge_reported_number < reported`).
- A3: also read retired rows bound to exactly (N, I) with reason `edge_regressed`, `retired_at` in the window: if `report.get(prefix) > row.edgeReportedNumber` and (`row.edgeReportedAt === null || τ > row.edgeReportedAt`), a second live database exists: alert. `alert = cloneSeen || some device count >= MAX`.
- Return gains `stale: number`. Warn log (counts + `edgeNodeId`) when `regressed || throttled || stale || alert`.
- Docs (A1): header + claim comment state the two limits plainly.

Sections: F1 schema/trigger/migration (S1 files). F2 service (`pos-receipt.service.ts`). F3 shared schema + `edge-device-sync.ts` + `cloud-http.ts` + `cloud-http.test.ts` (run that test file only). F4 test-writer: add to `apps/api/src/test/pos-receipt-restore-detect.test.ts`: (a) R1 stale report: report P1:3 at t1 arrives after P1:5 at t2>t1 -> no rotation, `stale` 1; (b) same lower count with a NEWER token -> rotation; (c) A3 clone: after one regression rotation, a report of the retired prefix above its frozen high-water with a newer token -> alert at once; (d) trigger: retire without reason refused, `edge_reported_at` cannot go backwards or to NULL; (e) forward-skewed token is clamped (a report at now+1 day, then a lower count at real now+6 min still... choose a case that proves the clamp: report at now+1day raises hw with τ=now+5min; a later regression at now+6min (inject reportedAt) is detected). Use the claim directly or `listDeviceRecordsSince` with `receiptRunsAt`. Run only that file after F1-F3 land: `bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-restore-detect" && pwd && LEGEND_TEST_FILES="src/test/pos-receipt-restore-detect.test.ts" heavy pnpm test'`.
