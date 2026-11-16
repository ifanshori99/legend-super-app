# 911 wave 2: legend-r86qa (exported -> failed/not_sent/succeeded) and legend-izza4 (settle GUC)

Status: architect decision, 16 Nov 2026. Builds on `design-p1-1.md` (grant, 0653/0654). Do not edit 0652-0654. Money rule: when in doubt, refuse (item stays `exported`, run stays `locked`).

## 1. Decisions

R1. Every move out of `exported` happens only as `legend_payout`, inside a trusted SECURITY DEFINER function that consumes a one-time grant (0653). The item guard requires `current_user = 'legend_payout'` for `exported -> succeeded|failed|not_sent`.
R2. New grant kinds (no table change, `detail` column used):

- `resolve`: steps `propose`, `approve`; `detail` = outcome `failed|not_sent`. A grant for `failed` cannot be spent on `not_sent`.
- `bank_confirm`: step `record`; `detail` = `'succeeded'`.
  No `retry` kind: a retry batch already needs two people (PAYOUT-15). Retry safety comes from R1 plus the SQL holds of R4.
  R3. The resolution record (`resolved_by`, `resolved_by_2`, `resolution_*`) and the bank payment record (`confirmed_by`, `confirmation_ref`, `confirmation_evidence_key`, `settled_at`) are written only by `legend_payout`. Two exceptions stay with `legend_app`, enforced by the guard: the withdraw clear (legend-5rh26: all four step-one columns go to NULL, no step two, nothing else changes; this only lowers payout) and cash handover (`approved -> succeeded`, channel `cash`, ref and key NULL).
  R4. Retry holds in SQL. The insert guard refuses a new attempt for a payslip that has an `overpaid` attempt (today TS only, `payroll-payout.service.ts:961-963`) or a recon exception (already PAYOUT-62). `payout_resolve_approve` also refuses (PAYOUT-62) when the payslip has a recon exception or an overpaid attempt.
  R5. A step-one resolve proposal made before the cutover (no grant) cannot be approved: PAYOUT-71. It must be withdrawn and proposed again.
  R6 (izza4). The run guard no longer reads `app.payout_settle`. On a run with a batch that is not cancelled, `paid` needs `current_user = 'legend_payout'`, which only happens inside `app.payout_run_settle`. That function re-checks R10 in SQL as far as sealed data allows. `paid_by` comes from the batch row, never from an argument.
  R7. Other `legend_app` writers stay as they are. They do not move money out of `exported`: export (`approved -> exported`), submit/approve/cancel (`prepared/blocked/approved -> approved/cancelled/not_sent`, `payroll-payout.service.ts:1218,1399,1469,1479`), cash handover (`manual.service:1466`), GL link `gl_posting_id` (`payroll-payout-gl.service.ts:852`), batch close, and the withdraw clear (`payroll-payout-withdraw.service.ts:120`).

## 2. Migrations (temporary numbers; the merge train renumbers)

Each file follows the 0654 ownership dance:

1. As the migrator: CHECK changes, guards, grants.
2. `GRANT legend_payout TO CURRENT_USER WITH INHERIT FALSE, SET TRUE; GRANT CREATE ON SCHEMA app TO legend_payout; SET ROLE legend_payout;`
3. Create the functions. `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO legend_app` on the public functions only.
4. `RESET ROLE`, then revoke the two grants of step 2.

FKs of new tables go inside `CREATE TABLE` (no new tables are planned). Do not touch `drizzle/meta`.

### 0655_payout_grant_kinds_resolve.sql

1. `payroll_payout_grants`: drop and re-add `payroll_payout_grants_kind_check` with `'resolve', 'bank_confirm'` added. Add `payroll_payout_grants_detail_check`:
   `CHECK ((kind = 'resolve' AND detail IN ('failed','not_sent')) OR (kind = 'bank_confirm' AND detail = 'succeeded') OR (kind NOT IN ('resolve','bank_confirm') AND detail IS NULL))`
   Existing rows have NULL detail. The step CHECK is unchanged.
2. `payroll_payout_attestations_kind_check` and `payroll_payout_recon_exceptions_kind_check`: add `'resolve', 'bank_confirm'`. Reason: the grant recon (design-p1-1 4.11) must be able to flag these attestations without a CHECK error.
3. As `legend_payout`: `CREATE OR REPLACE app.payout_grant_issue(...)`. The signature is unchanged, so the grantor ACL stays. Add to the matrix `resolve {propose, approve}` and `bank_confirm {record}`. Validate the detail per kind as in the CHECK, otherwise PAYOUT-72.
4. As `legend_payout`: `CREATE OR REPLACE app.payout_recon_flag(uuid, text, uuid, uuid, text)`. Copy the 0648 body and add the two kinds to the IN list at line 1032.

### 0656_payout_resolve_trusted.sql (r86qa)

1. Guard: `CREATE OR REPLACE app.payroll_disbursement_items_guard()` as the migrator. Copy the full 0648 body (no later file changes it) with only these edits:
   a. INSERT branch, after PAYOUT-62 (line ~1148): `IF EXISTS (item o of the same tenant and payslip with o.status = 'overpaid') THEN RAISE 'PAYOUT-62: payslip % has an overpaid attempt and is settled by hand, never by a new attempt' (23514)`.
   b. Transition list, line 1255: `OR (OLD.status = 'exported' AND NEW.status IN ('succeeded','failed','not_sent') AND current_user = 'legend_payout')`.
   c. Before the H2 block (line ~1353): when any of `resolved_by`, `resolved_by_2`, `resolution_outcome`, `resolution_evidence_key`, `resolution_note` changes, and `current_user IS DISTINCT FROM 'legend_payout'`, and the change is not the withdraw shape (the predicate at lines 1376-1386, reused verbatim): `RAISE 'PAYOUT-74: the resolution record of item % is written only by the payout role'` (23514).
   d. When any of `confirmed_by`, `confirmation_ref`, `confirmation_evidence_key`, `settled_at` changes, and `current_user IS DISTINCT FROM 'legend_payout'`, and the change is not `(OLD.status='approved' AND NEW.status='succeeded' AND NEW.channel='cash' AND NEW.confirmation_ref IS NULL AND NEW.confirmation_evidence_key IS NULL)`: `RAISE 'PAYOUT-74: the payment record of item % is written only by the payout role'`.
   All other checks are unchanged (PAYOUT-16 and PAYOUT-18 still apply to the payout role).
2. Privileges:
   - `GRANT UPDATE (resolved_by, resolved_by_2, resolution_outcome, resolution_evidence_key, resolution_note, failure_class) ON payroll_disbursement_items TO legend_payout;`
   - `REVOKE UPDATE (resolved_by_2, failure_class, confirmation_ref, confirmation_evidence_key) ON payroll_disbursement_items FROM legend_app;`
   - `legend_app` keeps `status`, `confirmed_by`, `settled_at` (cash), the four step-one columns (withdraw clear, shape enforced by c) and `gl_posting_id`.
3. Functions (as `legend_payout`). All start with `v_tenant := app.require_tenant_id()`, validate the arguments, consume the grant first (`app.payout_grant_consume`), then call `app.payout_assert_actor(v_tenant, v_actor, v_session, 'payroll.disburse.approve')`. Locks are the batch `FOR UPDATE`, then the items `ORDER BY id FOR UPDATE`. The attestation goes through `app.payout_attest(..., v_grant, v_assertion)` with `operation_id = gen_random_uuid()` per call; UNIQUE `(tenant_id, grant_id)` allows one attestation per grant.

   | Signature                                                                                                                                           | Grant binding (kind, step, batch, items, key, ref, target, detail)       | Checks (refusal = item unchanged)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
   | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `app.payout_resolve_propose(p_batch uuid, p_item_ids uuid[], p_outcome text, p_key varchar, p_note text, p_grant text) RETURNS uuid` (operation id) | resolve, propose, p_batch, p_item_ids, p_key, NULL, NULL, p_outcome      | batch `manual_bank`, `exported`, requester is not the actor (PAYOUT-18); ids non-empty and distinct, every item of the batch is `exported` with `resolved_by IS NULL` (PAYOUT-76); note 1-500, key 1-500; an `evidence_files` row (tenant, key) with `batch_id = p_batch` exists and `NOT app.payout_proof_key_closed` (PAYOUT-65). Writes `resolved_by = v_actor`, outcome, key, note. Attestation `('resolve', op, 'propose', p_batch, items, p_key, NULL binding)`.                                                                                                                                                                                                                                                                                                                               |
   | `app.payout_resolve_approve(p_batch uuid, p_item_ids uuid[], p_outcome text, p_key varchar, p_grant text) RETURNS integer` (moved)                  | resolve, approve, p_batch, p_item_ids, p_key, NULL, NULL, p_outcome      | as above, plus for every item: `resolved_by IS NOT NULL`, `resolved_by_2 IS NULL`, `resolution_outcome = p_outcome` (PAYOUT-76), `resolution_evidence_key = p_key` (PAYOUT-65), `resolved_by <> v_actor` (PAYOUT-64, 42501), requester is neither (PAYOUT-18). PAYOUT-71 unless there is a `resolve/propose` attestation with `grant_id IS NOT NULL`, `actor = i.resolved_by`, `evidence_key = i.resolution_evidence_key`, `i.id = ANY(a.item_ids)`, `a.batch_id = p_batch`, and the joined grant has `detail = i.resolution_outcome`. PAYOUT-62 when the payslip has a recon exception or an `overpaid` attempt. Writes `resolved_by_2 = v_actor`, `status = p_outcome`, `failure_class = CASE WHEN 'failed' THEN 'definitive' END`; the count must equal the cardinality. Attestation `'approve'`. |
   | `app.payout_bank_confirm(p_batch uuid, p_item_ids uuid[], p_refs text[], p_keys varchar[], p_grant text) RETURNS integer`                           | bank_confirm, record, p_batch, p_item_ids, NULL, NULL, NULL, 'succeeded' | arrays have the same length, ids are distinct, each ref trimmed is 1-100 characters, each key is NULL or at most 500 characters; batch `manual_bank`, `exported`, requester is not the actor (PAYOUT-16); every item is `exported`; each non-null key has an `evidence_files` row of `p_batch` (PAYOUT-65). Not held by recon (money already left). One `UPDATE ... FROM unnest(p_item_ids, p_refs, p_keys)` sets `status='succeeded'`, `settled_at=statement_timestamp()`, `confirmed_by=v_actor`, ref, key. Attestation `('bank_confirm', op, 'record', items, key = the single distinct key or NULL)`.                                                                                                                                                                                            |

   Refs and keys are not part of the grant binding. The secret never leaves the API process, so the binding (actor, batch, items, outcome) is the boundary. Mixed resolve calls (some items step one, some step two) stay supported: the service splits them and issues up to two grants.

### 0657_payout_run_settle_trusted.sql (izza4)

1. Guard: `CREATE OR REPLACE app.payroll_runs_payout_guard()` as the migrator. Copy the 0344:500-542 body. Replace `current_setting('app.payout_settle', true) IS DISTINCT FROM 'on'` with `current_user IS DISTINCT FROM 'legend_payout'`. L3 (PAYOUT-23) is unchanged. The GUC is no longer read anywhere.
2. `GRANT UPDATE (status, paid_at, paid_by, updated_at) ON payroll_runs TO legend_payout;`. Also grant SELECT on whatever the other `payroll_runs` UPDATE triggers read, if a test shows 42501 (`payroll_runs_guard`, `payroll_runs_approvers_guard`, `payroll_rapel_source_reversal_guard`).
3. `app.payout_run_settle(p_batch uuid, p_zero_net uuid[]) RETURNS boolean` (as `legend_payout`, EXECUTE to `legend_app`, no grant: it is a consequence, not a human step):
   - the batch must belong to the tenant (otherwise PAYOUT-77, P0002);
   - lock the run `FOR UPDATE`; return false unless it is `locked`;
   - return false when `approved_by` is NULL;
   - return false when the run has no payslip;
   - return false when any payslip of the run has no `succeeded` item, unless it is in `p_zero_net` AND has no item at all AND no recon exception;
   - return false when the L3 conditions hold (an open batch or item);
   - otherwise `UPDATE payroll_runs SET status='paid', paid_at=statement_timestamp(), paid_by=v_batch.approved_by, updated_at=... WHERE status='locked'`, then `RETURN FOUND`.

## 3. TypeScript

1. `apps/api/src/services/payroll-payout-grant.service.ts`: add `"resolve" | "bank_confirm"` to the `kind` union.
2. `apps/api/src/db/schema/payroll-payout.ts`: add both kinds to `PAYOUT_ATTESTATION_KINDS` (attestation and recon CHECKs), to the grants kind list (~line 1405), and add the grants detail check.
3. `apps/api/src/services/payroll-payout-manual.service.ts`:
   - `confirmManualItems` (:798-826): replace the per-item UPDATE loop with one grant (`kind:'bank_confirm', step:'record', batchId, itemIds, evidenceKey:null, refId:null, targetId:null, detail:'succeeded'`) and one call `SELECT app.payout_bank_confirm(${batch.id}::uuid, ${uuidArray(ids)}, ${refs}::text[], ${keys}::varchar[], ${grant}) AS moved`. `moved` must equal the number of results, otherwise 409 `PAYOUT_ITEM_NOT_CONFIRMABLE`. Keep every TS pre-check.
   - `resolveManualItems` (:965-1012): keep the TS checks. Split the rows into `proposeIds` (`resolvedBy === null`) and `approveIds`. For each set that is not empty, issue a grant (`kind:'resolve'`, step, `evidenceKey: evidence`, `detail: input.outcome`) and call the function. Return the counts as today.
   - `settleRunWhenAllPaid(tx, actor, batch)` (:499-568): keep the decrypt loop. Collect `zeroNet` (unpaid payslips with a readable net <= 0) and return false as today on net > 0 or an unreadable net. Remove both `set_config` calls and the drizzle UPDATE. Call `SELECT app.payout_run_settle(${batch.id}::uuid, ${uuidArray(zeroNet)}) AS paid`. `settleAndMaybePay` passes `batch`.
   - `confirmCashHandover` (:1471): drop `confirmationEvidenceKey: null`, because that column is revoked.
   - Update the header comment (:17-26).
4. Deadlock risk (verify first): `loadBatchRunFirst` locks the batch `FOR UPDATE` (payroll-payout.service.ts:515). The grantor's INSERT into the grants table checks `payroll_payout_grants_batch_fk` with `FOR KEY SHARE` on that batch row, from another connection, so the API waits on itself. Check whether the 0654 call sites (return, correction) already hang in `911-grants` case 11. If they do, issue the grants before `loadBatchRunFirst` (bindings come from the input plus an unlocked read of `resolved_by`). The SQL re-checks under the lock and fails closed. The same rule applies to the 0654 call sites (report to I5).
5. Routes: no change. `payroll-payout.routes.ts` already mounts `stepUp` and `passwordStepUp` and `actorOf` passes `grants`.

## 4. Tests

- `payroll-payout-911-exported-settle.test.ts`. Mapping:
  - forged failed/not_sent/free text: PAYOUT-74.
  - forged succeeded: 42501 (`confirmation_ref` is revoked).
  - GUC cases: same as above. Run case: PAYOUT-22, with and without the GUC.
  - controls: go through the new functions (APP, APP2 and APP3 need live, fresh-MFA fixture sessions).
    Fill the `it.todo` cases, all as `legend_app` with a COMMIT:
  - no proof: `payout_resolve_approve(..., NULL)` gives PAYOUT-70.
  - fabricated 64-hex proof: PAYOUT-70.
  - stale proof: reuse the expiry fixture of 911-grants case 6. PAYOUT-70.
  - reused proof: PAYOUT-70.
  - same actor: PAYOUT-64 and the grant stays unconsumed.
  - valid proof: two grants move the item to `failed`/`not_sent`; a `bank_confirm` grant moves it to `succeeded`.
  - recon-flagged slip held: add the exception with `app.payout_recon_flag`. Approve gives PAYOUT-62.
    New cases:
  - `[911-resolve-outcome-bound]`: a `failed` grant spent on `not_sent` gives PAYOUT-70.
  - `[911-resolve-legacy-step-one]`: a pre-cutover proposal from a superuser fixture gives PAYOUT-71.
  - `[911-retry-overpaid-held-sql]`: the INSERT gives PAYOUT-62.
  - `[911-settle-fn]`: false with a failed slip; false when a `p_zero_net` slip has an item; true when all succeeded; `paid_by` = batch approver.
  - `[911-withdraw-clear-still-app]`.
  - `[911-old-guc-ignored-owner]`.
- `payroll-payout-core.test.ts`:
  - :1456 `markPaid(…, true)`: replace the GUC with `SET LOCAL ROLE legend_payout`, and assert that the GUC alone is refused.
  - :1704 `settlePaid`: same role switch (L3 still refuses). The control at :1740 calls `app.payout_run_settle` as `legend_app`.
  - The seeds at :1061, :1515 and :1749 that move `exported -> succeeded` by SQL run that statement as `legend_payout`. Add a fixture `asPayoutRole` in `payroll-payout-fixtures.ts`.
  - :1334 still gives 23514.
- `payroll-payout-manual.test.ts`:
  - The control after :1494 (`okFailed` and the other allowed shapes) runs as `legend_payout`.
  - The local `actor(by)` (:752, :762, :1289) must carry `grants: testGrantIssuer` and a live session (use the fixture `actorOf`).
  - Most of the 53 `exported` mentions are service flows and need no change.
- Same seed fix (`exported -> succeeded` by SQL) in `891-correction.test.ts:1199,1625` and `905-trusted-boundary.test.ts:374,405`. Confirm/resolve callers with ad hoc actors in `877-proof-lock-order.test.ts:187` and `gl.test.ts:652`.
- `withdraw-proposal` and `proposal` tests: the service paths should stay green. Check each fixture that writes `resolved_by` by SQL.

## 5. Residual risk (to CTO)

- `p_zero_net` comes from TS, because net pay is sealed. `legend_app` could list a net > 0 payslip that has no item, and the run turns `paid` early. No money moves: a paid run with batches stays payable. Closing this needs a plaintext net > 0 flag at lock time (follow-up bead).
- Cash `approved -> not_sent` (cancel) and `approved -> succeeded` (handover) remain one-person `legend_app` writes. This design keeps that (follow-up bead: cash handover grant).
- Recon does not yet check `resolve`/`bank_confirm` attestations. That needs a follow-up bead: two different actors with grants for every item that left `exported` after the cutover.
- Bank confirmation and resolve now need a fresh MFA session in SQL (through the grant). The production gate is the same as P1-1 (`PAYOUT_GRANTOR_DATABASE_URL`). Without it, every exported batch is stuck: no confirm and no resolve (503).
- Open pre-cutover step-one proposals must be withdrawn and proposed again (PAYOUT-71).
