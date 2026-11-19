# Sub-brief 1184: payout GL holds (shared context for subagents)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-f6ccc29f`, branch `ws/1184-payout-gl-holds`. Money + access (tier K). API + tests only, no web.
Run tests ONLY as `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` from worktree root. No tsc, no full suite. One subagent at a time runs tests (token heavy); edit-only otherwise.

DO NOT TOUCH: `payroll-payout-recon.service.ts`, `payroll-payout-recon-clearance.service.ts`, tests `payroll-payout-*lock*`, `payment-*`, `reservation-*`, `hris-offboarding.service.ts`, `platform-tenant-owner.service.ts`, anything in `apps/web`.

## Facts (already mapped)
- Table `payroll_payout_gl_postings` = `payrollPayoutGlPostings` in `apps/api/src/db/schema/payroll-payout.ts:354`. No status column; `kind` in settle|settle_pending|settle_skipped|return|overpaid. `fee_posted` bool, `payable_account_hold` bool (set by 0390 backfill only), `salaries_payable_account_id`.
- `accounting_was_off` is NOT stored: derived by `payoutRecoveryReason` (`payroll-payout-gl.service.ts:1745`, line ~1790): a `settle_skipped` posting with fee > 0, fee journal (`payoutGlKeys.fee(itemSetHash)`) missing, run with no lock journal, accounting on. Listed by `listPayoutRecovery*` (~2002/2211), route `GET /payout-fee-reposts` in `routes/payroll-payout.routes.ts` (~397).
- `payable_account_hold = true` -> reason `payable_account_unknown`; returns refused 409.
- Fee journaling paths: `repostSkippedFees` (manual), `repostFeesSoft` (recovery job), via `unpostedFeePostings` (fee_posted=false, FOR UPDATE); plus the fee journal posted when `resolvePendingSettles` flips settle_pending/settle_skipped -> settle. Find every caller of `postFeeOfPosting` / `payoutGlKeys.fee`.
- Lock order: run row, batch row (`loadBatchRunFirst`), `entityLock`, `lockBatchPayoutGl`.
- Step-up pattern: batch approve route `routes/payroll-payout.routes.ts:219-240`: `requireAuth, requireTrustedOrigin, requireTenantContext, requireTenantPermission(...), stepUp (requireTenantStepUpMfa maxAge PAYOUT_STEP_UP_MAX_AGE_MINUTES), jsonBody, passwordStepUp (requireTenantStepUpPassword)`; body carries `password`. Stale MFA -> 401 REAUTH_REQUIRED.
- Audit: `recordPayoutAudit` (`services/payroll-payout.service.ts:329`), action form `payroll.<object>.<past_tense>`, before/after + reason.
- Batch creator: `payroll_disbursement_batches.requested_by`.
- Test helpers: step-up setup `test/payroll-payout-1038-concurrent.test.ts:105-123`; two-connection barrier `test/payroll-payout-900-backfill-lock.test.ts:269` (`barrier()`), `test/payroll-payout-920-sibling-lock.test.ts:332-378`. accounting_was_off fixtures: `test/payroll-payout-877-gl-fee-skipped.test.ts`. Payable hold fixtures: grep tests for `payableAccountHold`/`payable_account_hold`.

## Design (fixed; ask the engineer before deviating)

### Permission
New `payroll.payout.gl_resolve` in `packages/shared/src/access/permissions.ts` (near 252). Default grants: `owner` (catalog-wide) and `finance` (Finance / Akuntan) only. Must NOT reach hr, general_manager, tenant_admin, outlet roles: pick tags so `catalogWhere` of other roles does not catch it; add label in `apps/web/src/features/ws01-access/lib.ts` ONLY if a root contract test (`tests/access-contract.test.mjs`, `tests/access-i18n.test.mjs`) requires it (that is the single allowed web file). MFA required roles already.

### Migration 0715 (single file `apps/api/drizzle/0715_payout_gl_holds.sql`, journal tag `0715_payout_gl_holds`; range 0715-0717 only)
Add to `payroll_payout_gl_postings`:
- `fee_opening_balance_at timestamptz`, `fee_opening_balance_by` (same actor column type as `requested_by`), `fee_opening_balance_note text`.
- `payable_hold_released_at timestamptz`, `payable_hold_released_by`, `payable_hold_release_note text`.
- CHECKs: each trio all-null or all-set; note trimmed length 1..1000; `payable_hold_released_at IS NULL OR payable_account_hold = false`.
- If a trigger/guard makes postings immutable or column grants limit UPDATE: allow exactly these transitions (null -> set once; hold true -> false once together with released_*), nothing else. Check `db/role` grant tests.
- No data backfill. `pnpm db:generate` must be empty afterwards.

### Card 1 `legend-3xzop`: mark fee as already in opening balance (no journal)
`POST /payout-gl-postings/:postingId/fee-opening-balance` (same router/prefix as `/payout-fee-reposts`), body strict `{ password, note }` (note trimmed 1..1000, shared validator).
Service in NEW file `apps/api/src/services/payroll-payout-gl-holds.service.ts`, one tx:
1. Load posting by (tenantId, id) else 404 `PAYOUT_GL_POSTING_NOT_FOUND`. Load batch with lock order above.
2. Actor == batch.requested_by -> 403 `PAYOUT_GL_SELF_APPROVAL`.
3. Posting `FOR UPDATE`; already marked -> 409 `PAYOUT_GL_ALREADY_RESOLVED`; live `payoutRecoveryReason` must be `accounting_was_off` else 409 `PAYOUT_GL_NOT_ACCOUNTING_WAS_OFF`.
4. Conditional UPDATE `... SET fee_opening_balance_at = now() (DB clock), _by, _note WHERE id AND tenant AND fee_opening_balance_at IS NULL RETURNING`; 0 rows -> 409 `PAYOUT_GL_ALREADY_RESOLVED`.
5. `recordPayoutAudit` action `payroll.payout_gl_fee.opening_balance_marked`, reason = note. No journal written.
Then in `payroll-payout-gl.service.ts`: a marked posting is never fee-journaled by ANY path (`unpostedFeePostings`, `repostFeesSoft`, resolver fee step) and `openRecoveryReason` returns null for it (drops off the list). Net/settle journaling of the same posting is unchanged (the mark is about the fee only).

### Card 2 `legend-6qp12`: release `payable_account_hold`
`POST /payout-gl-postings/:postingId/payable-hold-release`, body `{ password, note }`. Same steps 1-2. Posting FOR UPDATE; `payable_account_hold = false` -> 409 `PAYOUT_GL_ALREADY_RESOLVED`. Conditional UPDATE `SET payable_account_hold = false, payable_hold_released_at = now(), _by, _note WHERE payable_account_hold = true RETURNING`. Audit `payroll.payout_gl_payable_hold.released`. No journal written by the release itself.
Invariant: after release the posting re-enters normal flow exactly once and never uses today's mapping: a return must use the frozen `salaries_payable_account_id` (or lock-journal proof). If the code would fall back to today's mapping when the frozen account is null, release must refuse 409 `PAYOUT_PAYABLE_ACCOUNT_UNKNOWN` for such a row instead.

### Route
Both: `requireAuth, requireTrustedOrigin, requireTenantContext, requireTenantPermission("payroll.payout.gl_resolve"), stepUp, jsonBody, passwordStepUp`. Response 200 `{ postingId, resolvedAt }` (ISO). DTO type in `packages/shared/src/types/api.ts` or payroll types next to existing payout DTOs.

## Required tests (fail-first; "jangan sampai rugi")
Files: `apps/api/src/test/payroll-payout-1184-fee-opening-balance.test.ts` (card 1), `apps/api/src/test/payroll-payout-1184-payable-hold-release.test.ts` (card 2). Use ULIDs/uuids as the API expects.
- Two concurrent calls (two connections, barrier) -> exactly one 200, other 409; exactly one audit success row; zero/one journal as appropriate.
- Card 1: after mark, enable accounting + bank charges mapping, run `repostSkippedFees`, `recoverPayoutGlOfBatch` -> no fee journal for `payroll-payout-fee:<hash>`; row gone from recovery list.
- Card 2: after release, row leaves `payable_account_unknown`; the next normal action (return) journals exactly once with frozen account; second release 409; no extra journal.
- Rejected without effect AND without success audit: batch creator (self-approval), role without permission (e.g. hr), stale step-up (401), missing MFA, blank/whitespace note (422 or 400 per repo convention), wrong password.
- Tenant isolation: posting of another tenant -> 404, untouched.
- Card 1 on a posting whose reason is not accounting_was_off -> 409, untouched.

## Follow-ups (implementer C)
State now: schema columns feeOpeningBalanceAt/By/Note, payableHoldReleasedAt/By/ReleaseNote exist; migration 0715 replaces `payroll_payout_gl_postings_guard` + column grants; service `apps/api/src/services/payroll-payout-gl-holds.service.ts` (markFeeInOpeningBalance, releasePayableHold) and routes exist; permission `payroll.payout.gl_resolve` (owner via catalog, finance explicit).
1. New migration `apps/api/drizzle/0716_payout_gl_resolve_grants.sql` + `_journal.json` entry idx 716 (copy 0715 entry shape, `when` larger than 0715's) + `meta/0716_snapshot.json` = copy of 0715 snapshot with new id/prevId. Body: copy pattern of `drizzle/0346_payroll_disbursement_grants.sql` granting `payroll.payout.gl_resolve` to template roles `owner` and `finance` only. Add registry entry in `apps/api/src/test/data-import-registry.test.ts` (same style as the 0346 entry ~line 243).
2. `apps/api/src/services/accounting-finance-exceptions.service.ts:~776`: add `AND fee_opening_balance_at IS NULL` to the `fee_posted = false` query (marked fee is not an exception). Only that line.
3. Holds service: before UPDATE, if batch frozen (reuse `batchIsFrozen` from payroll-payout-gl.service.ts, export it if needed; a 0428 trigger refuses UPDATE on frozen batch postings) -> 409 `PAYOUT_BATCH_FROZEN` (same code/message as elsewhere). Card 2: refuse 409 `PAYOUT_PAYABLE_ACCOUNT_UNKNOWN` when `salaries_payable_account_id` is null for ANY kind (DB guard requires it), before UPDATE.
4. Add both endpoints to the shared contract `packages/shared/src/hris/payroll/payout-endpoints.ts` with `defineEndpoint` (pattern of `approveDisbursementBatch`; body = `resolvePayoutGlPostingInputSchema`; response DTO). Make the routes use the contract paths if other routes do.
Report files changed.

## Fix round 1 (implementer D) — reviewer findings
F1 (money): release must also require proof. In BOTH `releasePayableHold` (service, before UPDATE) and the 0715 guard release branch: the settle journal (`journal_entries.idempotency_key = posting.journal_key`, same tenant) EXISTS, and every journal line on it that debits a salaries-payable account debits exactly `salaries_payable_account_id` (no debit line to another payable account; at least one debit on it). Otherwise 409 `PAYOUT_PAYABLE_ACCOUNT_UNKNOWN` (service) / RAISE (guard). Rows whose settle debited another account stay held (no re-pointing in this branch). Look at how 0390 (`drizzle/0390_payout_frozen_payable_account.sql:77-97`) decided the hold and mirror its "proven" test exactly; also `postPayoutReturn` (~1245) to confirm the return then credits the frozen account.
F2 (defence): fee-mark guard branch additionally requires the run of the batch has NO lock journal (same key the service uses: `payrollGlKeys.locked(runId)`; resolve prefix in SQL) and `fee_posted`/kind conditions mirror `accounting_was_off`. Edit 0715 in place (not applied anywhere yet).
Edit only 0715 SQL + `payroll-payout-gl-holds.service.ts`. No tests runs. Report.

## Fix round 2 (implementer E) — architect findings
A2: insert guard (latest body in `apps/api/drizzle/0415_payout_trusted_followups.sql`) does not refuse the six new columns on INSERT. In 0715, CREATE OR REPLACE that insert guard function with the 0415 body unchanged plus a RAISE when any of fee_opening_balance_at/_by/_note, payable_hold_released_at/_by, payable_hold_release_note is NOT NULL on INSERT. Use plain `diff` to prove the rest is byte-identical.
A3: in 0715 update-guard mark and release branches add `AND NEW.fee_opening_balance_at = pg_catalog.now()` / `AND NEW.payable_hold_released_at = pg_catalog.now()`; confirm the service writes `sql\`now()\`` (same tx => equal).
A4: remove the unneeded `export` of `payableAccountOf` in payroll-payout-gl.service.ts (~558) if nothing outside uses it (grep).
Edit only those files. No test runs. Report.
