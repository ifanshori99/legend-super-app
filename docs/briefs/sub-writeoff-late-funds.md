# Sub-brief: late funds after write-off (legend-oan3p)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/writeoff-late-funds` (branch `ws/writeoff-late-funds`, base `origin/int/batch63`). Tier K (money + migration). Do NOT commit; the engineer commits.

## Problem

A "missing" reconciliation case (`payment_reconciliation_cases`, `settlement_line_id IS NULL`, `source_transaction_id` = the sale) closed as `resolved` through the approval chain = write-off (hapus-buku). If a LATER settlement import matches that sale (funds did arrive), today nothing happens: `closeMissingCasesOfSale` in `apps/api/src/services/payment-settlement-import.service.ts` (~line 70-161, call site ~499) only selects `open|pending_approval`.

## Rule

- Never reverse/undo anything automatically. The case stays `resolved`. No journal, no outbox money event, no change to the settlement line or its normal import effects.
- Instead: flag + correction queue row for finance. One row per case for life (idempotent on re-import / replay).
- Finance closes the correction through the approval matrix: Owner or Finance Manager, one level, either is enough, approver != requester. Reuse action type `reconciliation_case` (its default policy, migration 0357, is exactly this) with object type `payment_reconciliation_correction`. Fail closed like `resolveReconciliationCase` (no policy / not required → 409).
- Tenant + outlet isolation everywhere (filter by tenant in SQL, RLS on the new table).

## Part A — migration, schema, shared contract (implementer A)

Migration `apps/api/drizzle/0368_reconciliation_late_funds.sql` (+ `meta/0606_snapshot.json`, `_journal.json` entry, idx after 360). Generate with `pnpm db:generate` (`--name reconciliation_late_funds`), then rename file/tag to `0606_...` if drizzle numbers it 0361 (check how 0578→0359 renumbering was done in git log; journal `tag` must equal filename). Move FKs of the new table INLINE into `CREATE TABLE` (no separate `ADD CONSTRAINT` for the new table). Append `SELECT app.enforce_tenant_rls('public.payment_reconciliation_corrections'::regclass);` and `SELECT app.enforce_outlet_rls(...)` (pattern: 0031/0032). After that `pnpm db:generate` must produce nothing.

Table `payment_reconciliation_corrections` in `apps/api/src/db/schema/payment-admin.ts`, exported as `paymentReconciliationCorrections`:

- `id uuid pk default random`, `tenant_id` (tenantIdColumn → tenants), `outlet_id` (outletIdColumn), FK (tenant_id,outlet_id)→outlets like cases.
- `case_id uuid not null`, FK (tenant_id, case_id) → payment_reconciliation_cases(tenant_id, id).
- `settlement_id uuid not null` (report in which funds arrived), `settlement_line_id uuid not null` (the matched line), `source varchar(20)`, `reference varchar(100)` (line reference).
- `written_off_idr` idrColumn not null (= abs(case.variance_idr)), `received_idr` idrColumn not null (line received amount).
- `status varchar(20) not null default 'open'` CHECK IN ('open','pending_approval','resolved').
- `decision varchar(30)` nullable CHECK NULL or IN ('reverse_write_off','keep_write_off').
- `approval_chain_id uuid`, `requested_by text`, `approved_by text`, `resolved_by text`, `resolved_at timestamptz`, `note text`, `created_at timestamptz default now not null`.
- unique (tenant_id, id); UNIQUE (tenant_id, case_id) named `payment_reconciliation_corrections_case_key`; index (tenant_id, outlet_id, status); check amounts >= 0.

Register: `apps/api/src/test/data-import-registry.test.ts` (migration annotation map ~line 162), `apps/api/src/test/payment-admin-rls.test.ts` names list, and any schema/table coverage test that lists payment-admin tables (grep tests for `paymentReconciliationCases` / `payment_reconciliation_cases`).

Shared contract `packages/shared/src/payment/admin.ts`:

- `reconciliationCaseViewSchema` gains required `lateFunds: reconciliationLateFundsSchema.nullable()` where `reconciliationLateFundsSchema = z.strictObject({ correctionId: uuidSchema, settlementId: uuidSchema, settlementLineId: uuidSchema, receivedIdr: nonnegativeIdr, detectedAt: isoDateTimeSchema, correctionStatus: z.enum(["open","pending_approval","resolved"]) })`. Doc comment: funds of a written-off case arrived later; finance must review (no automatic reversal).
- `reconciliationCorrectionViewSchema` (strictObject): id, tenantId, outletId, caseId, settlementId, settlementLineId, source, reference, writtenOffIdr, receivedIdr, status, decision (nullable enum), requestedBy/requestedByName, approvalRequestId, approvedBy/approvedByName, resolvedByName, resolvedAt, note, createdAt (mirror case view types).
- `resolveReconciliationCorrectionInputSchema = z.strictObject({ decision: z.enum(["reverse_write_off","keep_write_off"]), note: <same as case resolve note schema> })`.
- Endpoints: `listReconciliationCorrections` GET `${ADMIN}/reconciliation/corrections` (cursor page + outletFilter + optional status), `resolveReconciliationCorrection` POST `${ADMIN}/reconciliation/corrections/:correctionId/resolve` (params `correctionId: uuidSchema`).
- Update every case fixture in admin.ts (`lateFunds: null`), add one correction fixture; update `apps/web/src/features/ws05-payment-admin/mock.ts` case objects with `lateFunds: null` so web typechecks.

## Part B — services, routes, worker (implementer B)

New file `apps/api/src/services/payment-reconciliation-correction.service.ts`:

- `export const CORRECTION_OBJECT_TYPE = "payment_reconciliation_correction"`.
- `openLateFundsCorrection(tx, context, { caseRow, line: {id, settlementId, reference, receivedIdr}, now })`: `INSERT ... ON CONFLICT (tenant_id, case_id) DO NOTHING RETURNING`; only when inserted, `recordAudit` action `payment.reconciliation_correction_opened` (actorType system, objectType CORRECTION_OBJECT_TYPE, retention audit_2y) — same shape as the matched-close audit. No outbox, no journal.
- `listReconciliationCorrections(context, actorId, query)`: like `listReconciliationCases` (permission `payment.reconcile`, tenant filter, cursor).
- `resolveReconciliationCorrection(context, actorId, params, body, key)`: like `resolveReconciliationCase`: lock row FOR UPDATE, permission on its outlet, `idempotentPaymentAdminWrite(... "reconciliation.correction_resolve" ...)`, 409 unless `open`, `openApprovalRequest` with sourceModule `payment`, actionType `reconciliation_case`, objectType CORRECTION_OBJECT_TYPE, amountIdr = writtenOffIdr, fail closed if `!opened.required`; set `pending_approval`, chain, requested_by, decision, note; audit `payment.reconciliation_correction_resolution_requested`.
- `settleReconciliationCorrectionForApproval(tx, context, {chainId}, now)`: mirror `settleReconciliationCaseForApproval` (re-read chain outcome + final approver from DB via `resolveApprovalChainOutcome`, row lock, replay no-op when not pending): approved → `resolved`, resolved_by=requested_by, approved_by, resolved_at; rejected/expired → `open`, chain null, decision null. Audit `payment.reconciliation_correction_resolved` / `_resolution_rejected` / `_resolution_expired`. No outbox, no journal.
- `apps/api/src/services/payment-reconciliation-approval-consumer.ts`: accept objectType CORRECTION_OBJECT_TYPE too and dispatch to the correction settler.

Detection in `closeMissingCasesOfSale` (payment-settlement-import.service.ts): select the sale's missing cases with `status IN ('open','pending_approval','resolved')` FOR UPDATE in one query; existing branch for open/pending unchanged; for `resolved` call `openLateFundsCorrection` with the line just inserted (the call site must pass line id + received amount + settlement id). `matched` cases: untouched.

Case view (`payment-admin-reconciliation.service.ts`): `view()`/`viewOf()` and the list must fill `lateFunds` from the correction row of the case (left join or one batched lookup for the page; tenant-filtered). `null` when none.

Routes `apps/api/src/routes/payment-admin.routes.ts`: GET list with `reconcileQuery`, POST resolve with `jsonBody, reconcileRecord` (same as case resolve).

Catalogs: new audit actions / text must pass root contract tests (`tests/*-contract.test.mjs`, `tests/text-contract.test.mjs`); grep for `payment.reconciliation_case_matched_closed` to see where audit actions are registered and add the new ones next to it.

## Part C — fail-first tests (test-writer)

New file `apps/api/src/test/payment-reconciliation-late-funds.test.ts`, reusing helpers/patterns from `payment-settlement-import.test.ts` (`gatewayMissingSetup` ~516, `requestClose` ~469, `approveRequest`, `laterGatewayReport` ~539, `countOutboxEvents` ~457, `moneySnapshot` ~559) and `payment-reconciliation-approval.test.ts`. Copy helpers locally if not exported. Cases:

1. Write-off applied (case `resolved` via approved chain + worker consumer) then later import matches the sale → exactly one correction row `open`, `writtenOffIdr`/`receivedIdr` right; case still `resolved`; GET cases shows `lateFunds` non-null with that correctionId; GET corrections lists it.
2. No double journal / no auto reversal: money snapshot (journal entries/lines, outbox money events, `reconciliation_case.resolved` count stays 1) after the late import equals a control import of the same line for a sale with no case, i.e. only the normal line effects; no outbox event for the correction.
3. Idempotent: re-sending the same import (same idempotency key and a re-import attempt) and replaying the approval event → still one correction row, one `payment.reconciliation_correction_opened` audit.
4. Tenant isolation: tenant B with same-shaped data untouched; tenant B cannot list/resolve tenant A correction (404).
5. Correction approval: requester cannot approve own chain; Owner or Finance Manager approval (one level) → worker → `resolved` with decision kept; rejected → back to `open`; resolve on non-open → 409; no policy → 409 fail closed.
6. A `matched` or `open` case is not flagged (existing behaviour kept).
   Run: `cd <worktree> && LEGEND_TEST_FILES="src/test/payment-reconciliation-late-funds.test.ts" heavy pnpm test`. Must fail first for the right reason (missing table/endpoint/flag), not setup. Report the failing assertions.

## Part D — architect follow-ups (round 2)

D1 (implementer). Late line with a different amount: the import then also opens a `mismatch` case for that line (settlement_line_id set). Link it so finance never books the loss twice:

- Add nullable `mismatch_case_id uuid` to `payment_reconciliation_corrections` (FK (tenant_id, mismatch_case_id) → payment_reconciliation_cases(tenant_id, id), inline). Edit migration 0606 in place (not pushed/applied anywhere) and regenerate snapshot; `pnpm db:generate` must stay empty.
- Fill it in the import transaction for the same line (whichever order the mismatch case and `closeMissingCasesOfSale` run; if the correction is created first, update it after the mismatch case insert, tenant-filtered). Null when the line matched exactly.
- Contract: `mismatchCaseId: uuidSchema.nullable()` on `reconciliationCorrectionViewSchema` and on `reconciliationLateFundsSchema`; fixtures updated.
- Doc comment: finance must decide the correction and the linked mismatch case together.

D2 (test-writer), same test file:

- Race: two connections. Hold the case row lock in the approval settle (approved chain, worker path) while the import runs; commit settle; import completes → exactly one correction, case `resolved`.
- Late line with different amount (e.g. written off 50000, 48000 arrives): one correction with `receivedIdr` 48000 and `mismatchCaseId` = the new mismatch case id; case view `lateFunds.mismatchCaseId` same; exact-amount line → `mismatchCaseId` null.

## Part E — block linked mismatch case while correction undecided (legend-kbf9v, CTO approved)

E1 (implementer). In `resolveReconciliationCase` (`apps/api/src/services/payment-admin-reconciliation.service.ts`), inside the idempotent write, after the existing status checks and BEFORE `openApprovalRequest`: if any `payment_reconciliation_corrections` row of the same tenant has `mismatch_case_id = case.id` and status `open` or `pending_approval` → throw `HttpError(409, "LATE_FUNDS_CORRECTION_PENDING", "Decide the late-funds correction of this sale first: it is linked to this mismatch case.")` (check HttpError code typing; add the code where error codes are declared/registered, incl. shared error-code lists or text catalogs if any). Lock the correction row `FOR SHARE` (case row is already locked first; same lock order as import: case → correction). A resolved correction no longer blocks. Nothing else changes. Doc comment referencing legend-kbf9v.

E2 (test-writer), same test file `payment-reconciliation-late-funds.test.ts`: late line 48000 vs write-off 50000 → resolve mismatch case answers 409 `LATE_FUNDS_CORRECTION_PENDING` while correction `open`, still 409 while `pending_approval`, case stays `open` with no approval request created; after correction approved (resolved) the mismatch case resolve request succeeds (`pending_approval`); after correction rejected (back to open) → 409 again; an unlinked mismatch case of another sale is unaffected. Run the new tests fail-first BEFORE E1 lands if possible (check `git diff` for `LATE_FUNDS_CORRECTION_PENDING`), then again after.
