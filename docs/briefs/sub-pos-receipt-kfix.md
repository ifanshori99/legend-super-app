# Sub-brief: fix review K ws/pos-receipt

Worktree: `.worktrees/pos-receipt` (branch `ws/pos-receipt`). Never read `.env*`. Never pkill/killall. Edit only files named in your section. Run only the tests of your file: `cd apps/api && pnpm exec vitest run src/test/<file>` (if it needs Postgres and fails to connect, report and stop; do not start services).

## S4 — "CETAK ULANG" mark on reprints (low)

Files: `apps/api/src/services/pos-receipt-document.ts`, `apps/api/src/services/pos-receipt-pdf.ts` (~line 156), plus a new test `apps/api/src/test/pos-receipt-reprint-mark.test.ts` (or extend an existing pure document/PDF test if one exists — do NOT edit `pos-receipt.test.ts`).
Do: when the receipt's `reprintCount > 0`, the receipt document model carries a reprint flag and the PDF (and any text/email rendering built from the document) shows a clear "CETAK ULANG" line near the header. First print (`reprintCount === 0`) shows no mark. Test both cases at the document level (and PDF text if the existing tests already extract PDF text).

### S4 decision (lead)

Option (a): add `reprint: z.boolean()` to `receiptDocumentBaseShape` in `packages/shared/src/pos/schemas.ts` and update fixtures that build documents (any test file EXCEPT the new `pos-receipt-kfix.test.ts`; `pos-receipt.test.ts` fixtures allowed). Builder sets `reprint: receipt.reprintCount > 0`; PDF + email show "CETAK ULANG".

## Shared decisions for S1–S3 (lead)

New PosError codes (add to `packages/shared/src/pos/errors.ts`, mirror wherever `RECEIPT_PREFIX_MISMATCH` is listed: `packages/shared/src/pos/receipts.ts`, `tests/pos-contract.test.mjs`, HTTP status in `apps/api/src/middleware/error-handler.ts` if receipt codes are mapped there — owner: S1-R):

- `RECEIPT_DEVICE_REQUIRED` (409/422 like other receipt refusals) — edge sale without a verified device.
- `RECEIPT_SEQUENCE_NOT_PROVISIONED` — edge has no cloud-provisioned sequence for the device.
- `RECEIPT_VOID_UNMATCHED` — merged receipt says voided but cloud has no matching `pos_order_voids` row.
  Prefix namespaces: cloud-owned sequence (key `deviceId = outletId`, sale without device) uses the fixed prefix `CLOUD_RECEIPT_PREFIX = "C"` (export from `packages/shared/src/pos/receipts.ts` next to `receiptPrefixSchema`; owner S1-R adds it). Device sequences use `P1, P2, ...` and may never be `"C"`.
  Edge detection in the service: `getEdgeRuntimeState().edgeMode` from `apps/api/src/edge/runtime.ts` (tests flip it with `setEdgeRuntimeStateForTests`, restore after).

## S1-S — service part of finding 1 + findings 2, 3 (one implementer; file `apps/api/src/services/pos-receipt.service.ts` only)

1. `ensureSequence`: key === outletId → create/get with prefix `CLOUD_RECEIPT_PREFIX`. Device key + edge mode → never create: existing row or throw `RECEIPT_SEQUENCE_NOT_PROVISIONED`. Device key + cloud → `nextFreePrefix` (P-namespace) as today.
2. `allocateReceipt`: edge mode and `deviceId === null` → throw `RECEIPT_DEVICE_REQUIRED` (fail closed, before any write).
3. `provisionReceiptSequence` (cloud authority): refuse `deviceId === outletId` and prefix `CLOUD_RECEIPT_PREFIX` with `RECEIPT_PREFIX_MISMATCH`.
4. `mergeDeviceReceiptRun`: also refuse prefix `CLOUD_RECEIPT_PREFIX`. Finding 3: referenced orders must be same tenant+outlet AND `posOrders.status IN ('completed','voided')` AND `posOrders.deviceId = deviceId`; else `RECEIPT_PREFIX_MISMATCH` (keep current code).
5. Finding 2 (void from merge), for every batch receipt with `status === "voided"` (insert path and existing-issued path): validate device fields first (`voidReason` with `voidReasonSchema` from `@starter/shared/pos`, `voidedBy` with `userIdSchema`, `voidedAt` ISO date) → `VALIDATION_ERROR` if bad. Then require a `pos_order_voids` row (tenant, orderId) — the cloud void that went through the approval path — else `RECEIPT_VOID_UNMATCHED`; also require the order status `voided`-equivalent per that path (check how `voidPosOrderCorrection` in `services/pos-order-corrections.ts` leaves the order and mirror it). Written `voidedAt/voidReason/voidedBy` come from the `pos_order_voids` row (same mapping `voidReceiptForOrder` uses for online voids), never from the device. Validate the whole batch before any write (existing pattern). Update the header comment of the function.
   Run only typecheck for your file (`cd apps/api && pnpm exec tsc --noEmit -p .`); S1-R adds the error codes in parallel — if they are not there yet, wait/re-run rather than adding them yourself.

## S1-R — route + contract part of finding 1 (one implementer)

Files: `apps/api/src/routes/pos-order.routes.ts`, `packages/shared/src/pos/errors.ts`, `packages/shared/src/pos/receipts.ts`, `tests/pos-contract.test.mjs`, `apps/api/src/middleware/error-handler.ts` (only if receipt codes mapped there).

1. Add the 3 error codes + `CLOUD_RECEIPT_PREFIX` (above).
2. `caller(req)`: `deviceId` = verified device id, mirroring `deviceIdOf` in `routes/device-pin.routes.ts:53` (DEVICE_TOKEN_HEADER, `verifyDeviceToken`, tenant source `device`, tenant id match) but return `null` instead of throwing when absent/unverified. Never trust a body/header device id without signature. Update the header comment (lines 19-20).
3. Check that `deviceId` from `caller` reaches `allocateReceipt` (order completion → receipt port) and is stored on `posOrders.deviceId` at order creation; report if not.

## S-T — regression tests (test-writer; new file `apps/api/src/test/pos-receipt-kfix.test.ts` only)

Copy setup helpers/patterns from `apps/api/src/test/pos-receipt.test.ts` (read it, do not edit it). Cover, against the decisions above:

- F1: cloud sale without device → number `C-000001`; device provisioned `P1` via `provisionReceiptSequence`; device run with `P1` merges OK; numbers distinct; no `RECEIPT_PREFIX_MISMATCH`. Edge mode (`setEdgeRuntimeStateForTests`): sale with `deviceId: null` → `RECEIPT_DEVICE_REQUIRED`, nothing written; unprovisioned device → `RECEIPT_SEQUENCE_NOT_PROVISIONED`; provisioned device → uses provisioned prefix. `provisionReceiptSequence` with prefix `C` or deviceId=outletId refused; merge with prefix `C` refused.
- F2: merge receipt voided without `pos_order_voids` row → `RECEIPT_VOID_UNMATCHED`, nothing written; invalid `voidReason` → `VALIDATION_ERROR`; with a matching void row → receipt voided with reason/by from the void row, not the device.
- F3: merge with an order of another device, or an order still open → `RECEIPT_PREFIX_MISMATCH`.
  Route-level (if a supertest pattern exists in nearby tests): POS order completion with a valid device token stores `deviceId` on the receipt; without token deviceId is null.
  Run your file; failures because the implementation is not done yet are expected — report which.

## S5 — update tests to the new rules (after run 1: 19 fail old file, 8 fail kfix)

Rules now in the service (do NOT change the service; if a test seems to need a service change, report it):

- Sale without a device → cloud-owned sequence, prefix `C` → numbers `C-000001`...
- `mergeDeviceReceiptRun` requires a cloud sequence row for the device first (`provisionReceiptSequence(tx, ctx, {outletId, deviceId, prefix: "P1"})` or a cloud sale of that device), else `RECEIPT_SEQUENCE_NOT_PROVISIONED`; prefix must equal that row's prefix else `RECEIPT_PREFIX_MISMATCH`.
- Merged receipts must reference `completed` orders with `pos_orders.device_id = deviceId`; voided receipts need a `pos_order_voids` row.
- A merged receipt whose number does not match the sequence prefix now fails earlier with the assertion message "Nomor struk tidak cocok dengan prefiks perangkat" — check what code that error carries (`assertReceiptMatchesSequence` in `packages/shared/src/pos/receipts.ts`) and expect that code.
  Fix the fixtures/expectations, keep each test's intent (what it proves). Don't weaken assertions to pass. Run with `LEGEND_TEST_FILES="src/test/<file>" heavy pnpm test` from the worktree root (heavy queues itself; do not pgrep/wait on other processes, never pkill).
- S5-A: `apps/api/src/test/pos-receipt.test.ts` failures at lines 555, 658, 802, 927, 1056, 1085, 1119, 1140, 1202, 1231, 1253, 1306, 1350, 1369, 1458, 1518, 1662, 2625 (1798 is fixed in the service already).
- S5-B: `apps/api/src/test/pos-receipt-kfix.test.ts` failures at 672, 682, 753, 783, 815, 842, 861, 879 (merge fixtures lack a provisioned sequence).
