# Sub-brief: manual + recurring journals (bead legend-vmyg)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/journals` (branch `ws/journals`). Paths below relative to `apps/api/src` unless noted. Do NOT commit. Do NOT edit files outside your section. Do NOT read `.env*`. Do not run `pnpm check`/`pnpm build` (the lead runs them); `pnpm --filter api exec tsc --noEmit` is fine.

## Already done (read, don't change)

- Schema: `db/schema/accounting-journal-requests.ts` — `manualJournals`, `recurringJournals`, `recurringJournalRuns` (UNIQUE tenant+template+period). Migrations 0063/0064 (RLS FORCE).
- Period checkpoint: `services/accounting-journal-period-gate.ts` — `assertJournalPeriodPostable(tx, context, {legalEntityId, entryDate})` + constants `JOURNAL_APPROVAL_SOURCE_MODULE="accounting"`, `MANUAL_JOURNAL_OBJECT_TYPE`, `RECURRING_JOURNAL_OBJECT_TYPE`. Call it at submit, approve/settle, and each recurring generation (before posting).
- Contracts (packages/shared/src/accounting): `journal.ts` (manualJournalSchema, transitionManualJournal, createManualJournalInputSchema, updateManualJournalInputSchema, rejectInputSchema, recurringJournalSchema, transitionRecurringJournal, recurringOccurrenceDate, recurringPeriodsDue, checkJournalBalance), `endpoints.ts` lines ~210-300 (listManualJournals, createManualJournal, getManualJournal, updateManualJournal, submit/withdraw/approve/cancel/rejectManualJournal, listRecurringJournals, createRecurringJournal, transitionRecurringJournalEndpoint). Use them; don't redefine.
- Core posting: `services/accounting-journal.service.ts` `postJournalInTransaction(tx, context, input)` (idempotent per `idempotencyKey`, checks balance + period). Approval: `services/platform-approval.service.ts` `openApprovalRequest` (:491), `getApprovalChainOutcome` (:697), `cancelApprovalRequest` (:710). Precedent for chain settle: `services/staff-override.service.ts` `settlePending` (~:520) and consumer `services/staff-override-consumers.ts`. Job precedent: `worker/accounting-depreciation.job.ts`. Route precedent: `routes/accounting.routes.ts` (Express Router, requireAuth/requireTrustedOrigin/requireTenantContext, requireTenantPermission, jsonBody, getScopedTenantContext, actorId).

## Rules (money)

- Integer IDR only; lines validated by shared `balancedLines` (debit = credit). Unbalanced → 400/422 via zod or AccountingError.
- Ledger (`journal_entries`) written ONLY on approval (manual) or by the job for an ACTIVE (approved) template. Never at create/submit.
- Requester never approves/rejects own request (AUTH-06): use shared transition functions (throw APPROVER_IS_REQUESTER) and the DB check constraint backs it.
- Every write in `withTenant`; mutate rows locked `FOR UPDATE`; every query filters `tenantId`; outlet-scoped users only see/act on rows whose `outletId` is in their scope (null outlet = tenant-level, needs tenant scope).
- Idempotent: create uses (tenant, idempotencyKey) + sha256 fingerprint (replay same body → same row; different body → IDEMPOTENCY_KEY_REUSED 409, mirror accounting-journal.service). Posting key manual: `manual-journal:<id>`; recurring: `recurring-journal:<templateId>:<YYYY-MM>`. sourceType `manual` / `recurring`, sourceId = request/template id.

## Approval flow (both kinds)

- submit (requester only, draft→pending_approval): gate period (manual only: entryDate), then `openApprovalRequest(tx, context, {sourceModule:"accounting", actionType:"manual_journal", objectType, objectId:id, amountIdr: total debit, outletId, requestedBy, source:"user", requestReason: description})`. APPROVAL_POLICY_MISSING propagates (fail closed). `required:true` → store `approvalChainId`. `required:false` → chain null.
- approve (actor ≠ requester, permission `accounting.journal.post`):
  - chain null → decide directly: transition, then (manual) gate + post + status posted, decidedBy/decidedAt, postedEntryId; (recurring) status active, approvedBy/At.
  - chain set → settle from chain: `getApprovalChainOutcome`; pending (and deadline not passed) → throw 409 `APPROVAL_PENDING` (CoreError/HttpError per codebase convention); approved → effect with decider = last level's `decidedBy` from `approval_requests` (re-check ≠ requester); rejected/expired/cancelled → status rejected, rejectionReason `approval <outcome>`.
- Export `settleManualJournalForApproval(tx, context, manualJournalId, now)` and `settleRecurringJournalForApproval(...)`: idempotent (non-pending row returned unchanged), used by approve endpoint AND the outbox consumer.
- reject (actor ≠ requester): if chain pending, `cancelApprovalRequest` (actorUserId = actor); status rejected with reason.
- withdraw (manual, requester): cancel chain, back to draft, chain null. cancel: draft|rejected → cancelled. edit (PATCH): draft|rejected → draft, recompute nothing else.

## Section A — manual service (implementer)

File: `services/accounting-journal-manual.service.ts` (new). Export: `createManualJournal(context, actorId, input)`, `listManualJournals(context, query)` (keyset on createdAt desc,id desc like listJournals), `getManualJournal(context, id)`, `updateManualJournal(context, actorId, id, input)`, `submitManualJournal`, `withdrawManualJournal`, `approveManualJournal`, `rejectManualJournal(context, actorId, id, reason)`, `cancelManualJournal`, `settleManualJournalForApproval(tx, context, id, now?)`. Return contract `ManualJournal` (parse with manualJournalSchema; `recurringJournalId` always null).

## Section B — recurring service + job (implementer)

File: `services/accounting-journal-recurring.service.ts` (new). Export: `createRecurringJournal(context, actorId, input)` (status draft), `listRecurringJournals(context, legalEntityId)`, `transitionRecurringJournal(context, actorId, id, body)` (submit/approve/reject/pause/resume/end; submit/approve/reject per Approval flow; pause/resume/end need `accounting.journal.post` + any actor), `settleRecurringJournalForApproval(tx, context, id, now?)`, and the job `runDueRecurringJournals(context, now = new Date())`:

- tenant-wide trusted context (assertTrustedScopedContext, like depreciation job). today = `entityToday(now)` (`services/accounting-ap-fa-shared.ts`); for each `active` template: periods = `recurringPeriodsDue(template, periodOf(today))` filtered to occurrence date (`recurringOccurrenceDate`) ≤ today.
- Each period in its OWN `withTenant` transaction: lock template FOR UPDATE, re-check active; if run row exists for (template, period) → skip; `assertJournalPeriodPostable`; `postJournalInTransaction` (key above, postedBy = template.approvedBy); insert `recurringJournalRuns` (onConflictDoNothing); set `lastGeneratedPeriod = period`. Error → stop THIS template (later periods wait), continue others. Returns `{posted, skipped, failed}`. Resumable: re-run picks up from lastGeneratedPeriod; crash between post and run row replays the posting key.

## Section C — routes + wiring (implementer)

- `routes/accounting-journal.routes.ts` (new): `accountingJournalRouter` implementing every endpoint in endpoints.ts §manual/recurring with the precedent pattern; view endpoints `accounting.journal.view`, writes `accounting.journal.post`. Create returns 201.
- Register: one line in `routes/index.ts` next to `apiRouter.use("/accounting", accountingRouter)`.
- `services/accounting-journal-consumers.ts` (new): `handleJournalApprovalResolved(context, event)` mirroring staff-override-consumers: only `approval.resolved` with sourceModule `accounting` and objectType manual_journal/recurring_journal; find row by (tenant, approvalChainId); call the settle function inside `withTenant`. Ignore others. Wire one line in `worker-main.ts` next to `handleApprovalResolved(context, event)`, and one try/catch block calling `runDueRecurringJournals(context, new Date())` next to `runDueDepreciation`.
- Import service functions by the names in sections A/B (they are being written in parallel; if missing when you typecheck, that's expected).

## Section D — tests (test-writer)

File: `test/accounting-journal.test.ts` (new). Setup like `test/accounting-core.test.ts` (helpers agent/signUp/originHeader, owner Pool, scopedContext) and approval policy setup like `test/platform-approval.test.ts`. Cover: unbalanced rejected (400/422); create+submit writes no journal_entries; approval by another user posts exactly one entry (sourceType manual); requester approve → 403/APPROVER_IS_REQUESTER; with an approval policy: approve endpoint returns 409 while chain pending, inbox decision by other user then settle posts; double approve / replayed settle → still one entry; create idempotency replay; recurring: approve template, `runDueRecurringJournals` twice (and concurrently via Promise.all) → one entry per period, run rows unique; resumable after a closed period blocks then reopens / lastGeneratedPeriod; tenant isolation (tenant B cannot get/list/approve tenant A rows; RLS hides rows). Fixed `now` dates.
