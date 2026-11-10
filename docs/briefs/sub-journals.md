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

## Fix E — approver permission re-check (security, money)

When an approval chain for a manual journal or recurring template settles as `approved`, the effect must re-check that the final approver (last level `decidedBy`) holds `accounting.journal.post` over the journal's scope (outlet, or tenant when `outletId` is null), not only that they are not the requester. Use `approverMayPostJournal(tx, context, userId, outletId, now)` from `services/accounting-journal-approver.ts` (already written). If it returns false: nothing posts. Manual journal: status `rejected`, `rejectionReason` `"approval approver lacks permission"`, `decidedAt` now, `decidedBy` null. Recurring template: status `rejected` with the same reason, never `active`. Applies to the chain path only; the direct approve path already goes through the route permission.

- E1 (implementer): wire it in `services/accounting-journal-manual.service.ts` (`settleRow`, approved branch) and `services/accounting-journal-recurring.service.ts` (chain settle, approved branch). Do not change pause or closed-month behaviour.
- E2 (test-writer): add tests to `test/accounting-journal.test.ts`. A chain approved in the inbox by a user whose matrix role can decide but who lacks `accounting.journal.post` (or whose scope does not cover the journal's outlet): settle and the approve endpoint post nothing and the journal/template ends `rejected`. Positive case already covered.

## Fix F — founder decision legend-j4ko (Q5 resume skips paused months, Q6 operator "skip this month")

Do NOT change migrations 0063/0064 or `_journal.json` by hand; add a NEW migration via `pnpm --filter @starter/api exec drizzle-kit generate --name recurring_journal_skips` (inspect SQL).

- Q5 resume: on `resume` (paused → active), months that passed during the pause are skipped; generation starts from the current month (Asia/Jakarta, `periodOf(entityToday(now))`). Implement: `lastGeneratedPeriod = max(lastGeneratedPeriod, previousPeriod(currentPeriod))`, but never below `previousPeriod(startPeriod)` semantics (if `startPeriod` ≥ current period, leave unchanged). The current month still posts when its day arrives. Document in code that `lastGeneratedPeriod` means "last month handled (posted or skipped)".
- Q6 skip: new endpoint `POST ${BASE}/recurring-journals/:recurringJournalId/skip-period`, body `{ period: periodKey, reason: string 1..500 }`, response `dataResponseSchema(recurringJournalSchema)`. Add it in `packages/shared/src/accounting/endpoints.ts` next to `transitionRecurringJournalEndpoint`.
  - Permission `accounting.journal.post`; tenant + outlet scope like other recurring endpoints (out of scope → NOT_FOUND).
  - Allowed only when the template is `active` or `paused`, `period` is exactly the next due month (`lastGeneratedPeriod + 1`, or `startPeriod` when null) and not after `endPeriod`, and that month's `fiscal_periods` row for the template's legal entity has status `closed`. Otherwise 409 (AccountingError, e.g. `INVALID_TRANSITION` / a new specific code if the codebase pattern allows).
  - Record the skip as a `recurring_journal_runs` row for (template, period) with `journal_entry_id` NULL, `skipped_by` = actor, `skip_reason` = reason. Schema: make `journal_entry_id` nullable, add `skipped_by text`, `skip_reason varchar(500)`, check exactly one of (journal_entry_id, skipped_by) is set. Keep the UNIQUE (tenant, template, period).
  - Set `lastGeneratedPeriod = period`. Audit via `auditAccountingChange` (action `accounting.recurring_journal.period_skipped`, reason), same transaction, template locked FOR UPDATE.
  - Idempotent: if a skip row already exists for (template, period), return the template unchanged (no second audit row). If a POSTED run exists for that period → 409.
  - The job (`runDueRecurringJournals`) must treat an existing run row (posted or skipped) as done.
- F1 (implementer): schema `db/schema/accounting-journal-requests.ts`, new migration, shared endpoint, `services/accounting-journal-recurring.service.ts` (resume + `skipRecurringJournalPeriod(context, actorId, id, {period, reason}, now?)`), route in `routes/accounting-journal.routes.ts`.
- F2 (test-writer): tests in `test/accounting-journal.test.ts`: resume after a 2-month pause posts no paused months and posts the current month on its day; a template stuck on a closed month: skip by a user with permission advances it and the next run posts the following month; skip is idempotent (one run row, one audit row); skip refused for an open month, a non-next month, a user without `accounting.journal.post`, and another tenant (NOT_FOUND).
