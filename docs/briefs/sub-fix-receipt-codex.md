# Sub-brief: fix receipt Codex 68 findings (ws/fix-receipt-codex)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/fix-receipt` (branch `ws/fix-receipt-codex`, base `milestone/m1` dab1d592). Tier K (offline sync, document numbers).

Rules for every subagent:

- Never read `.env*`. Never `pkill`/`killall`/kill PIDs you did not start. Do not commit (lead commits).
- Edit ONLY the files listed in your section. Need another file: stop and report.
- Reproduce first: write the test, run it, see it FAIL for the right reason, then fix, then run it green. Report both runs (fail line, then pass summary).
- Run tests: from the worktree root `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` (heavy queues itself; do not wait on other processes). Postgres missing: report and stop, do not start services.
- Typecheck: `cd apps/api && heavy pnpm exec tsc --noEmit -p .` once at the end (ignore errors in files outside your section, report them).
- Comments: keep existing ones; new code gets a short header comment with the bead id.
- Copy test setup helpers from `apps/api/src/test/pos-receipt.test.ts` / `pos-receipt-kfix.test.ts` (read, do not edit).

## S-9WBC: receipt token redaction, absolute-form (legend-9wbc)

`apps/api/src/app.ts` safeUrl already strips the absolute-form authority (cherry-picked PO fix 7c98db8f, legend-qni9). Files: `apps/api/src/test/access-log-redaction.test.ts` only (app.ts only if a test proves a remaining leak).
Add cases in the existing style: `GET http://host/api/public/receipts/<TOKEN>` and `.../<TOKEN>/pdf` (absolute-form), plus origin-form for both; with query string; uppercase scheme `HTTP://`. Assert the log line has `/api/public/receipts/[redacted]` and never the token. Also prove the case FAILS on the pre-fix regex (temporarily revert locally is NOT allowed; instead state which assertion the old code broke, by reasoning from `git show 7c98db8f^:apps/api/src/app.ts`).

## S-V3VO: register e-receipt email job (legend-v3vo)

Files: `apps/api/src/worker-main.ts`, `apps/api/src/worker/pos-receipt-email.job.ts`, new test `apps/api/src/test/pos-receipt-email-worker.test.ts`.

- `runPosReceiptEmailJob(contexts, deps)` (job.ts:174) is never called. Register it in the per-tenant sweep of worker-main.ts right after the `runPurchasingPoEmailJob` block (~line 293), same try/catch + `console.error("POS receipt email sweep failed")`, `email: handlers.notificationDelivery?.email ?? null`.
- Deps type is `{ email: EmailProvider }` (non-null). Make it `EmailProvider | null` and mirror exactly what `purchasing-po-email.job.ts` does when the provider is null (read it). Never log the address or token unmasked.
- Test end-to-end: create a completed sale + receipt, request an e-receipt through the real service/route path that queues it (status `queued`), run the job with `FakeEmailProvider` → status `sent`, provider got one message to that address; run again → no second send. Null provider → same outcome as the PO job with null. Also assert worker-main.ts registers the job: export nothing new; a source-level check (`readFileSync` of worker-main.ts contains `runPosReceiptEmailJob(`) is acceptable as the last case.

## S-3YQY: provision device receipt sequence and pull it to the edge (legend-3yqy, part of legend-ain0 note 2)

Problem: `ensureSequence` (`services/pos-receipt.service.ts` ~182) in edge mode throws `RECEIPT_SEQUENCE_NOT_PROVISIONED` for any device, because nothing calls `provisionReceiptSequence` (line ~441) outside tests and the device-registry pull carries no sequence.
Files: `apps/api/src/services/device.service.ts`, `apps/api/src/services/edge-device-sync.ts`, `apps/api/src/routes/edge-device-sync.routes.ts` (only if the record shape is validated there), `apps/api/src/services/pos-receipt.service.ts` (new exported helpers only; do not change existing functions' behaviour), shared record schema file if the pull record is typed in `packages/shared/src/edge/*` (name it in the report), new test `apps/api/src/test/pos-receipt-provisioning.test.ts`.
Design (lead decision):

1. Cloud: `enrollDevice` provisions a receipt sequence for devices that can sell (check the device type enum; POS/cashier types only — list which you chose and why) in the SAME transaction as the device insert. Prefix = next free `P<n>` in that outlet (reuse the existing next-free-prefix logic, export a helper `provisionNextDeviceReceiptSequence(tx, ctx, {outletId, deviceId})` from pos-receipt.service.ts that is idempotent: existing row returned unchanged).
2. Backfill for devices enrolled before this change: when the cloud serves the device pull (`listDeviceRecordsSince`), selling devices of that outlet without a sequence get one provisioned (same helper) and appear in that response even if their device row is older than the cursor. Explain in a comment why a read path writes (idempotent, same tenant tx).
3. Pull record carries the device's sequence `{id, outletId, deviceId, prefix}` (never `lastNumber` from the cloud as authority over the edge counter).
4. Edge `applyDeviceRecords`: insert the sequence row if absent (same id, prefix, lastNumber 0); if a row exists for (outlet, device) keep it untouched (the edge counter is ahead of the cloud); if the existing prefix differs from the cloud's → fail closed (throw, no partial write) — it would mean two numbering namespaces.
5. Revoked/retired device: no new provisioning.
   Test: enroll POS device → sequence row exists with `P1`, second device `P2`; non-selling device type → none; pull lists sequence; edge apply (use `setEdgeRuntimeStateForTests` like pos-receipt-kfix.test.ts) inserts it; then `allocateReceipt` in edge mode for that device succeeds with prefix `P1` (before the fix: `RECEIPT_SEQUENCE_NOT_PROVISIONED`); re-pull does not reset `lastNumber`; prefix mismatch on edge → refused; pre-existing device without sequence gets backfilled by the pull. Cross-tenant: tenant B pull never sees tenant A sequences.

## S-AIN0-DAY: receipt gaps at Tutup Hari (legend-ain0, day-close part)

Files: `apps/api/src/services/pos-day.service.ts`, the recap/close schema in `packages/shared/src/pos/schemas.ts` (only the day recap/close types), new test `apps/api/src/test/pos-day-receipt-gaps.test.ts`.
Lead decision: REPORT, do not block. `getEndOfDayRecap` and `closePosDay` include `receiptGaps: {deviceId, prefix, lastNumber, missing: number[]}[]` for the outlet from `receiptGapsForOutlet(tx, ctx, outletId)` (pos-receipt.service.ts ~805); the close freezes it in `pos_daily_closes.recap` (jsonb, no migration) and the `day.closed` payload/audit carries only the count `receiptGapCount` (no numbers list in events). Check the recap hash/identity code in pos-day.service.ts: gaps must not change the money identity or the stored hash semantics of existing closes (old recaps without the field must still parse: optional / default []). If the recap schema is `.strict()`, add the field accordingly. Keep `missing` capped (first 100 numbers + `missingCount`) so one broken device cannot bloat the row.
Test: outlet with device run 1,2,4 (insert receipts via existing test helpers) → recap shows missing [3]; close stores it; no gaps → []; old recap JSON without the field parses.

## S-K1: review K fixes for S-3YQY (one implementer, Opus)

Committed base: 6894fced/1d9b6444. Files: `apps/api/src/services/pos-receipt.service.ts`, `apps/api/src/services/edge-device-sync.ts`, `apps/api/src/routes/edge-device-sync.routes.ts`, `apps/api/src/edge/runtime.ts` (only the pull call, if the flag/role must be passed there), `packages/shared/src/edge/schemas.ts`, new error code files as in sub-pos-receipt-kfix.md S1-R (`packages/shared/src/pos/errors.ts`, `packages/shared/src/pos/receipts.ts`, `tests/pos-contract.test.mjs`, `apps/api/src/middleware/error-handler.ts` if receipt codes mapped there), tests `apps/api/src/test/pos-receipt-provisioning.test.ts`, `apps/api/src/test/pos-day-receipt-gaps.test.ts`. Reproduce each with a failing test first.

1. Day close blocked forever (HIGH): `applyCloudDeviceReceiptSequence` — edge has no row and cloud `lastNumber > 0` → return `"refused"` (do NOT insert; the edge holds none of 1..L so the gap port would report 1..L forever). Fresh numbering comes from re-enrolling the terminal (new device → new prefix). Remove `lastNumber` as an insert value (insert at 0 only when cloud lastNumber is 0). Test: pull with lastNumber 40 → not inserted, refused counted; lastNumber 0 → inserted; then a day close on the edge after one sale has no gap.
2. Cloud + edge issue the same number (HIGH): `allocateReceipt` in cloud mode refuses a device-keyed sale (deviceId !== null) when the outlet has an active `edge_nodes` row → new PosError `RECEIPT_DEVICE_ON_EDGE` (409, message Indonesian: the device numbers on the outlet edge). Sales without device (C sequence) unchanged. Test both.
3. Standby edge: `pullDeviceRegistry` does not apply sequences when the node role is standby (find the role in runtime/edge config). Test.
4. Old edges + revocations (HIGH): the cloud adds `receiptSequences` to a page ONLY when the edge asks (`?receiptSequences=1` query param, validated strictly in the route); new edges send it. Parse sequences separately from the page schema (page schema keeps the field optional); any sequence error (shape, other outlet, apply failure) is caught inside the pull: logged with counts only, counted in `receiptSequencesRefused`, and never stops device records or later pages. Test: page without the flag has no field; malformed/other-outlet sequence → device records of that page and later pages still applied (a revocation lands).
5. Fix the comment in `packages/shared/src/edge/schemas.ts` (~103) claiming a rebuilt edge never reissues a number: say it is only safe once legend-ol6v merges edge runs, and point to the follow-up bead "sequence bound to one edge node".
   Run `LEGEND_TEST_FILES="src/test/pos-receipt-provisioning.test.ts src/test/pos-day-receipt-gaps.test.ts src/test/pos-receipt.test.ts src/test/pos-receipt-kfix.test.ts src/test/device-edge.test.ts" heavy pnpm test` and `cd apps/api && heavy pnpm exec tsc --noEmit -p .` at the end.
