# Brief 167: second-opinion — shift close fixes (legend-q7jj, legend-ccpn)

Tier K (cash drawer, approval, migration). Codex second opinion before the release gate. This brief deliberately leaves out the Claude review findings.

## Range

- Repo `/Users/ifanshori99/Projects/legend super app/legend`, branch `ws/shift-close-fix` (local only, not pushed), worktree `.worktrees/shift-close-fix`.
- Base `milestone/m1` at `a8c90378` (already holds pos-drawer-guess).
- Diff: `git diff a8c90378..1c051167`. Skip `apps/api/drizzle/meta/*_snapshot.json` (generated).
- About 340 non-test lines, under the 800-line limit. One run.

## What changed

1. legend-ccpn (commit `2a7a8c73`, widened in the q7jj commit): a default `cash_shift_close` approval matrix of one tier and one level from Rp0, founder decision Q28 (every close needs one approval, a PIN at the cashier is enough). The level-1 approvers are the templates that hold `shift.cash.approve_close`: `supervisor`, `outlet_manager`, `general_manager`, because the approver must hold the exact role the matrix names.
   - `packages/shared/src/access/approval.ts`: `DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES`.
   - `apps/api/src/services/access.service.ts` (`seedTenantRoleTemplates`) and `apps/api/src/db/seed-dev-tenant.ts`: insert only when the tenant has no `cash_shift_close` row.
   - `apps/api/drizzle/0141_cash_shift_close_approval_policies_data.sql`: backfill for existing tenants, RLS FORCE lifted for the duration, `INSERT … WHERE NOT EXISTS`.
2. legend-q7jj: fixes for the Codex 146 findings on pos-drawer-guess (`docs/briefs/146-second-opinion-pos-drawer-guess.result.md`).
   - F1 (balance oracle at close): a count now stores `cash_watermark`, the number of the shift's cash rows (cash movements, refunds, voids; held or not). `closePosShift` and `forceClosePosShift` refuse the count as `SHIFT_COUNT_STALE` when the number moved, before any approval is judged. A count with a null watermark (made before this column) is stale. Migration `0142_pos_shift_count_cash_watermark.sql` adds the nullable column.
   - F3 (outflow bound ignored refunds and voids): `assertShiftOutflowBound` (in `pos-shift-support.ts`) sums cash outs and drops, refund cash lines and captured cash of voids, held or not, plus the new amount. `recordCashMovement`, `voidPosOrderCorrection` and `refundPosOrder` call it before the insert. `heldCashOutIdrOf` answers CONFLICT instead of a 500 on legacy oversize data.
   - F4 (empty matrix skipped the phone chain check): in `assertApprovalTier` the shape of a phone chain (amountless, payload names this variance, all levels approved) is checked before the matrix is read. Only the level count depends on the matrix.
   - F2 (held cash_out produces a fictitious cash debit at close) is NOT changed in code. See "Open decision" below.

## Files at risk

1. `apps/api/src/services/pos-shift.service.ts`: `submitPosShiftCount`, `closePosShift`, `forceClosePosShift`, `recordCashMovement`, `assertApprovalTier`.
2. `apps/api/src/services/pos-shift-support.ts`: `cashWatermarkOf`, `assertShiftOutflowBound`, `heldCashOutIdrOf`.
3. `apps/api/src/services/pos-order-corrections.ts`: `voidPosOrderCorrection`, `refundPosOrder`.
4. `apps/api/drizzle/0141_*.sql`, `apps/api/drizzle/0142_*.sql`, `apps/api/src/db/schema/pos-shift.ts`.

## Invariants to attack

- J1: The answer to a close (stale, refused, closed) never depends on whether any cash row of the shift is held. A cashier can never learn the expected drawer cash or the held status from repeated counts, closes, cash movements, refunds or voids.
- J2: A close never succeeds on a count that does not describe the drawer as it is at close time, on both the cashier and the force path.
- J3: Every cash outflow of a shift (cash out, drop, refund cash, void cash; held or not) stays a safe integer, and the refusal never depends on the held flag. No path returns a 500 on a large amount.
- J4: A phone approval chain that is old (opened with an amount), names another variance, or has a level not approved is refused, whatever the tenant's `cash_shift_close` matrix is, including an empty one.
- J5: With the default matrix, a close with a variance needs one supervisor who is not the cashier; the PIN path and a valid phone chain still work.
- J6: The seed, `0141` and their re-runs never change a tenant that already has any `cash_shift_close` row, and never read or write another tenant's rows.
- J7: `cash_watermark` is never in a DTO, event payload or log.
- J8: Concurrency: the watermark, the outflow bound and the count are read under the shift row lock, so a concurrent writer cannot slip a row in between the check and the insert or close.

## Open decision (do not report as a finding, but say if the current state is unsafe)

F2: the close event's `differenceIdr` is `counted − expected + held` ("as if nothing were held", legend-utqr), and the shared contract (`packages/shared/src/pos/events.ts` `cashierShiftClosedPayloadSchema`) and `pos-day.service.ts` rely on it. The ledger consumer (`accounting-auto-journal-amounts.ts` ~:905-935) compares it with the shift variance and parks a close with held cash as `POSTING_AMOUNTS_MISMATCH`, so no journal posts today. How held cash movements are booked is pending a CTO accounting decision. Check that no path posts a journal for the held amount.

## Rollout notes (judge, not bugs in themselves)

- Run migrations before the new code is live: the count insert writes `cash_watermark`.
- Counts submitted before the deploy have no watermark and are stale. A cashier who already used 3 counts on a shift that was open at deploy can only be closed by a supervisor force close.

## Output

Findings only, each with file:line, a concrete scenario and a severity. State it plainly when an invariant holds.
