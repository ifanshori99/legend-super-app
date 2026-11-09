# Sub-brief: receipt sequence bound to one edge database (legend-zsdd)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-seq-edge` (branch `ws/receipt-seq-edge`, base `milestone/m1` 9a2c1e86). Tier K (document numbers + migration). Related: legend-3yqy (interim fix, closed, keep it as a backstop), legend-ol6v (edge->cloud receipt merge, NOT done, do not build it).

## Rules for every subagent

- Never read `.env*`. Never kill processes you did not start. Do not commit (lead commits).
- Edit ONLY the files of your section. Need another file: stop and report.
- Keep existing comments. New code: short header comment with `legend-zsdd`.
- Do not run tsc, eslint or the full test suite; the lead runs them. Tests only if your section says so.
- Report: files changed, exported signatures, anything you could not do.

## Problem

A device sequence (`receipt_sequences`, prefix `P<n>`) is numbered on the edge. The edge's numbers do not reach the cloud yet (legend-ol6v), so the cloud `lastNumber` stays 0. A rebuilt edge (same node id and credential, fresh database) or a standby that takes over pulls the sequence again, inserts it at 0 and reissues numbers the old edge already printed. The 3yqy interim (edge refuses a pulled sequence with cloud `lastNumber > 0`) does not catch this, because the cloud number is 0.

## Design (lead decision)

Invariant: a sequence's counter lives in exactly ONE database. The row says which:

- `edge_node_id` + `edge_instance_id` both NULL: the cloud holds the counter.
- Both set: the edge database `edge_instance_id` of node `edge_node_id` holds it.
- `retired_at` set: the run is closed; it never numbers again. The device continues under a NEW prefix (prefixes are never reused in an outlet, so numbers never repeat).

Edge database identity: new column `edge_nodes.instance_id uuid NULL`, set only on the edge's own local row by `ensureLocalEdgeNode` (random UUID). A rebuilt edge (fresh database) gets a new instance id even with the same node id and credential. Cloud rows keep NULL.

Claim on the cloud, during the device pull of node N with instance I, only when N's cloud `edge_nodes` row is `role = 'primary'` and `status = 'active'` and the edge sent its instance (`edgeInstance` query param). For each current (not retired) sequence of an active, not revoked, order-taking device (`RECEIPT_DEVICE_TYPES`) of the outlet:

1. Bound to (N, I): nothing.
2. Unbound and `lastNumber = 0`: bind to (N, I).
3. Otherwise (unbound with `lastNumber > 0` = the cloud already issued numbers; or bound to another node or another instance = another database may have issued numbers the cloud never saw): retire it and insert a new row for the device with the next free `P<n>` (computed over ALL rows of the outlet, retired ones included), bound to (N, I), `lastNumber 0`.

Then the page lists only current sequences bound to (N, I). A standby, a non-active node, or an edge that sent no instance gets `receiptSequences: []` and claims nothing.

Cloud selling: unchanged refusal `RECEIPT_DEVICE_ON_EDGE` while the outlet has an active edge. If no edge is active and the device's current sequence is bound to an edge, the cloud retires it and continues under a new unbound prefix (never continues an edge's counter).

Edge apply (`applyCloudDeviceReceiptSequence`), with the edge's own binding (node id, instance id):

- Binding of the pulled sequence differs from own: `refused`.
- Outlet key / prefix `C`: `refused` (unchanged).
- Local current row of the device with the same id and prefix: `kept` (if its local binding is NULL, set it to own).
- Local current row of the device with another id or prefix: retire the local row, then insert the pulled one at 0 bound to own: `replaced` (refused if the prefix or id already exists locally on another row).
- No local current row: keep the 3yqy backstop (`lastNumber > 0` -> `refused`); prefix or id already used locally -> `refused`; else insert at 0 bound to own: `inserted`.

Status: refused sequences become visible: the puller state and `GET /api/edge/status` (`deviceRegistry`) carry `receiptSequencesRefused` (count from the last successful pull) and `receiptSequencesRefusedAt` (ISO time of the last pull that refused at least one, else null).

Release order: cloud first. A new edge sends `edgeInstance`; an old cloud's strict query schema would refuse it with 400 and stop the device pull (revocations).

## Contract (shared by all sections)

DB (`receipt_sequences`): `edgeNodeId: uuid("edge_node_id")`, `edgeInstanceId: uuid("edge_instance_id")`, `retiredAt: timestamp("retired_at", {withTimezone: true})`, all nullable. Check `receipt_sequences_edge_binding_check`: both NULL or both NOT NULL. Drop unique `receipt_sequences_device_key`; add unique index `receipt_sequences_device_current_key` on (tenant_id, outlet_id, device_id) WHERE retired_at IS NULL. `receipt_sequences_prefix_key` stays (prefix unique over all rows). DB (`edge_nodes`): `instanceId: uuid("instance_id")` nullable.

Shared (`packages/shared/src/edge/schemas.ts`): `deviceReceiptSequenceSyncSchema` gains `edgeNodeId: uuidSchema` and `edgeInstanceId: uuidSchema` (required). Type `DeviceReceiptSequenceBinding = { edgeNodeId: string; edgeInstanceId: string }` exported from the same file.

Service (`apps/api/src/services/pos-receipt.service.ts`):

- `claimDeviceReceiptSequencesForEdge(tx, context, input: { outletId: string } & DeviceReceiptSequenceBinding): Promise<{ claimed: number; rotated: number }>` (cloud only; throws if edge process).
- `listDeviceReceiptSequences(tx, context, outletId, binding: DeviceReceiptSequenceBinding): Promise<DeviceReceiptSequenceSync[]>`.
- `applyCloudDeviceReceiptSequence(tx, context, sequence, own: DeviceReceiptSequenceBinding): Promise<"inserted" | "kept" | "replaced" | "refused">`.

Edge sync (`apps/api/src/services/edge-device-sync.ts`):

- `deviceSyncQuerySchema` gains `edgeInstance: uuidSchema.optional()`.
- `PullDeviceRegistryOptions.binding?: DeviceReceiptSequenceBinding` (sequences applied only when `role === "primary"` AND `binding` is set).
- `PullDeviceRegistryResult` gains `receiptSequencesReplaced: number` (keeps `receiptSequencesRefused`).
- `applyDeviceReceiptSequences(context, raw, own)`.

Fetcher (`apps/api/src/edge/cloud-http.ts`): `createDeviceRecordsFetcher({ cloudUrl, credential, edgeInstanceId? })` adds `edgeInstance=<id>` next to `receiptSequences=1` when set.

Node (`apps/api/src/services/edge-node.service.ts`): `ensureLocalEdgeNode` returns `instanceId: string` too.

Puller (`apps/api/src/edge/device-registry-puller.ts`): `pull` may return `receiptSequencesRefused?: number`; state gains `receiptSequencesRefused: number` and `receiptSequencesRefusedAt: string | null`.

Migration: `apps/api/drizzle/0148_receipt_sequence_edge_binding.sql`, journal `when` = 1794223000000 (must be above 1794222890808).

## S1: schema + migration (implementer)

Files: `apps/api/src/db/schema/pos-receipt.ts`, `apps/api/src/db/schema/edge-node.ts`, `apps/api/src/db/schema/pos-receipt.custom.sql`, new migration + `apps/api/drizzle/meta/*`.

- Columns, check, index per Contract. Grep the repo for any `onConflict` target or code naming `receipt_sequences_device_key` and report it (do not edit other files).
- Trigger `app.receipt_sequences_forward_only` (custom.sql; read the whole function): add (a) `retired_at` may only go NULL -> value, never change after; (b) the binding pair may only go from both NULL to both set, and never once set; (c) a binding change on a retired row is refused. Keep every existing rule. Update the function in custom.sql AND append the same `CREATE OR REPLACE FUNCTION` to the new migration.
- `cd apps/api && pnpm db:generate` (no DB needed), rename the generated file/tag to `0148_receipt_sequence_edge_binding`, set its journal `when` to 1794223000000, append the trigger SQL with `--> statement-breakpoint` separators, check the SQL drops the old unique and creates the partial index. Run `pnpm db:generate` again: it must produce nothing.

## S2: cloud + edge sequence service (implementer)

File: `apps/api/src/services/pos-receipt.service.ts` only.

- `findSequenceRow`: current rows only (`retired_at IS NULL`). `prefixesOfOutlet`: all rows (retired included).
- New `claimDeviceReceiptSequencesForEdge` per Design (one `lockOutletSequences`; guarded UPDATE for the bind: `WHERE retired_at IS NULL AND edge_node_id IS NULL AND last_number = 0`; retire then insert for rotation).
- `listDeviceReceiptSequences(…, binding)`: current rows bound to exactly that binding; output gains `edgeNodeId`, `edgeInstanceId`.
- `ensureSequence` (cloud, device key): current row bound to an edge -> retire and insert a new unbound row with the next free prefix. Edge process: unchanged.
- `applyCloudDeviceReceiptSequence(…, own)` per Design; update its doc comment.
- `mergeDeviceReceiptRun`: find the sequence by (device, prefix) including retired rows, so a late run of a replaced sequence still merges (legend-ol6v). Keep all other rules.
- `receiptGapsForOutlet*` / `receiptGapsForDevice`: check how they pick sequences; retired runs must still report their gaps; nothing must assume one row per device. Report what you changed.
- `insertSequence` gains optional binding. Update the header comment block for the new invariant.

## S3: edge sync, shared schema, route, fetcher (implementer)

Files: `apps/api/src/services/edge-device-sync.ts`, `packages/shared/src/edge/schemas.ts`, `apps/api/src/routes/edge-device-sync.routes.ts` (doc comment only), `apps/api/src/edge/cloud-http.ts`.

- Shared schema + type per Contract; fix the comment near the sequence schema (rebuilt edge / standby now get a new prefix; legend-zsdd).
- `listDeviceRecordsSince`: when `receiptSequences=1`: in the same tx read the node's `edge_nodes` row (by verified id, tenant, outlet). Claim path only if role primary, status active and `edgeInstance` given: `backfillDeviceReceiptSequences`, then `claimDeviceReceiptSequencesForEdge`, then `listDeviceReceiptSequences(binding)`. Otherwise `receiptSequences: []`.
- Apply/pull per Contract; count `replaced`; logs carry counts only; keep "never stops device records or later pages".
- Fetcher per Contract.

## S4: edge node instance, runtime wiring, puller state, status (implementer)

Files: `apps/api/src/services/edge-node.service.ts` (`ensureLocalEdgeNode` only), `apps/api/src/edge/runtime.ts` (wiring only, minimal lines), `apps/api/src/edge/device-registry-puller.ts`, `packages/shared/src/edge/endpoints.ts` (`edgeStatusSchema.deviceRegistry` only), `apps/api/src/services/edge-status.service.ts`.

- `ensureLocalEdgeNode`: insert with `instanceId: randomUUID()`; if the existing row has NULL `instance_id` set it once (`WHERE instance_id IS NULL`), then read it back; return `instanceId`.
- runtime: `createDeviceRecordsFetcher({ …, edgeInstanceId: local.instanceId })`; `pullDeviceRegistry({ …, binding: { edgeNodeId: local.scope.edgeNodeId, edgeInstanceId: local.instanceId } })`; return `receiptSequencesRefused` from the pull to the puller.
- Puller state per Contract (count from the last successful pull; `…RefusedAt` = time of the last successful pull with count > 0; failures do not change them).
- `edgeStatusSchema.deviceRegistry`: add both fields (optional in the schema for compat), fill them in edge-status.service.ts.
- Update `apps/api/src/edge/device-registry-puller.test.ts` with cases for the new state (allowed test file for this section) and run it: `bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/edge/device-registry-puller.test.ts" heavy pnpm test'`.

## T1: reproduction tests (test-writer, isolated worktree)

New file `apps/api/src/test/pos-receipt-seq-edge.test.ts`. Copy setup helpers from `apps/api/src/test/pos-receipt-provisioning.test.ts` (read, do not edit; `inEdgeMode`, `edgeNodeAt`, `enroll`, `edgePull`, `cloudPage`). Write against the Contract above. Cases:

1. Rebuilt edge: node N primary, instance I1 pulls (cloud `listDeviceRecordsSince` with `receiptSequences=1`, `edgeInstance=I1`) -> device sequence P1 bound to (N, I1); edge allocates 3 numbers (cloud `lastNumber` stays 0). Same N, new instance I2 pulls -> the device's sequence has a prefix other than P1, the P1 row is retired; applied on a fresh edge outlet/database and allocating gives `<newPrefix>-000001`, never `P1-000001`.
2. Standby takeover: P1 bound to primary N1; N1 revoked; node N2 (now the active primary) with instance I3 pulls -> new prefix bound to (N2, I3). An active standby pulling with an instance gets `[]` and P1 stays bound to N1.
3. Two edges never hold one sequence: list for (N2, I2) never contains the (N1, I1) row; the DB trigger refuses rebinding a bound row (owner SQL UPDATE) and un-retiring; the partial unique refuses a second current row for one device; edge apply refuses a sequence whose binding is not its own.
4. Cloud after the edge is gone: sequence bound to an edge, no active edge, a cloud device sale gets a new prefix, not P1-000001.
5. Unbound sequence with cloud `lastNumber > 0` claimed by an edge: rotated (new prefix), not handed over.
6. Edge apply `replaced`: local current row P1, pulled P2 bound to own -> P1 retired locally, P2 inserted; next allocation `P2-000001`.

Reproduce first: in your isolated worktree (at the base, before any fix) run the file once: `bash -c 'cd "<your worktree>" && pwd && pnpm worktree:setup >/dev/null && LEGEND_TEST_FILES="src/test/pos-receipt-seq-edge.test.ts" heavy pnpm test'`. Case 1 must fail on a number/prefix assertion (show the line), not only on a missing export; others may fail on missing API. Report fail lines. Then report the absolute path of your test file; the lead copies it.

## T2: update existing tests to the new contract (test-writer)

S1-S4 are implemented in this worktree (read the diff: `git diff`). Files: `apps/api/src/test/pos-receipt-provisioning.test.ts` and, only if a run shows they break, `apps/api/src/test/pos-day-receipt-gaps.test.ts`, `apps/api/src/test/edge-registry-pull.test.ts`, `apps/api/src/test/device-edge.test.ts`, `apps/api/src/edge/cloud-http.test.ts`, `apps/api/src/test/edge-bootstrap.test.ts`, `apps/api/src/test/edge-status*.test.ts`. Never touch production code; a test that shows a real production bug: stop and report it with the failing line.

- Pulled sequences now carry `edgeNodeId` + `edgeInstanceId`; the cloud only lists sequences for an active primary that sent `edgeInstance`; edge apply takes `own` and a prefix change becomes `replaced` (old local row retired), not `refused`. Keep every old intent (standby never applies, lastNumber>0 backstop, cross-tenant, flag, RECEIPT_DEVICE_ON_EDGE) and rewrite assertions only where the Design changed the outcome; say which ones in your report.
- Run: `bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-seq-edge" && pwd && shopt -s nullglob && files=(apps/api/src/test/pos-receipt-provisioning.test.ts apps/api/src/test/pos-day-receipt-gaps.test.ts apps/api/src/test/pos-receipt.test.ts apps/api/src/test/pos-receipt-kfix.test.ts apps/api/src/test/device-edge.test.ts apps/api/src/test/edge-registry-pull.test.ts apps/api/src/test/edge-bootstrap.test.ts apps/api/src/edge/cloud-http.test.ts apps/api/src/test/data-import-registry.test.ts apps/api/src/test/edge-status*.test.ts) && echo "files=${#files[@]}" && LEGEND_TEST_FILES="${files[*]#apps/api/}" heavy pnpm test'`. Report file count, pass/fail per file, and failures (shortest decisive line).

## R1: review K fixes (commit 2283ae9c)

Reproduce each with a failing test first where feasible.

### R1-A (implementer): `apps/api/src/services/pos-receipt.service.ts` only

1. Edge allocation honours the binding: in `ensureSequence` on an edge process, a current row with a binding is usable only if this database's own `edge_nodes` row matches it (`edge_nodes.id = row.edge_node_id AND edge_nodes.instance_id = row.edge_instance_id`, one query, same tx). Otherwise throw `RECEIPT_SEQUENCE_NOT_PROVISIONED`. Rows with NULL binding stay usable (3yqy-era rows; the next pull binds them). Comment: this is what makes the restore procedure work (reset `edge_nodes.instance_id` on a restored/cloned edge database: its old runs stop numbering until a pull rotates them).
2. Allocation UPDATE guard: the `last_number + 1` UPDATE in `allocateReceipt` adds `retired_at IS NULL`, and on the cloud process also `edge_node_id IS NULL` (a claim may bind the row between the read and the UPDATE). No row updated: throw `CoreError("CONFLICT", "Nomor struk perangkat sedang dipindahkan; ulangi transaksi.")`.
3. `applyCloudDeviceReceiptSequence` `replaced` path: refuse when the pulled `lastNumber > 0` too (same 3yqy backstop as the insert path).

### R1-B (implementer): `apps/api/src/edge/cloud-http.ts`, `apps/api/src/edge/cloud-http.test.ts`, `apps/api/src/services/edge-device-sync.ts`

1. Fetcher fallback (new edge on an older cloud whose strict query refuses `edgeInstance`): when a request that carried `edgeInstance` gets HTTP 400, retry the same page ONCE without `edgeInstance` and without `receiptSequences`. If that also fails, throw the second error (so the stored-cursor recovery in runtime.ts still sees HTTP_400). Log a warning (no ids). Unit test both paths in cloud-http.test.ts and run it: `bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-seq-edge" && pwd && LEGEND_TEST_FILES="src/edge/cloud-http.test.ts" heavy pnpm test'`.
2. `listDeviceRecordsSince`: when the claim rotated at least one run, `logger.warn({ rotated, claimed }, ...)` (counts only): a repeated rotation means two databases pull with one node id.

### R1-C (test-writer): `apps/api/src/test/pos-receipt-seq-edge.test.ts` only

Add cases (they must fail before R1-A lands; run once now, report the fail lines, then again after the lead says R1-A landed):

- Edge process, device row bound to (N, I_old) while this database's own `edge_nodes` row has instance I_new (owner SQL update of instance_id = the restore procedure): allocation refused `RECEIPT_SEQUENCE_NOT_PROVISIONED`; after a pull bound to (N, I_new) applies the rotated sequence, allocation gives `<newPrefix>-000001`.
- Edge apply `replaced` with pulled `lastNumber > 0` is `refused` and the local row stays current.
- Run: `bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-seq-edge" && pwd && LEGEND_TEST_FILES="src/test/pos-receipt-seq-edge.test.ts" heavy pnpm test'`.
