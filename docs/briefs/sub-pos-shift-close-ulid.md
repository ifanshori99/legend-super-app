# Sub-brief: shift close accepts the PIN override ULID (legend-6c0)

Worktree `legend/.worktrees/pos-shift`. No `.env*` reads, no pkill/killall, no commit, no service/schema edits (done already).
Change already made: `closePosShiftInputSchema` / `forceClosePosShiftInputSchema` `approvalRequestId` = `closeApprovalIdSchema` (packages/shared/src/pos/schemas.ts): ULID override id OR any uuid-shaped id (RFC or `ulidToUuid` form). `verifyCloseApproval` (apps/api/src/services/pos-shift.service.ts ~:878) maps a ULID straight to the override id.

Tests to write/adjust:
1. `apps/api/src/test/pos-shift.test.ts`: new describe "POS-03 close names the PIN override by its own ULID (legend-6c0)":
   a. Real PIN approval via `createPosOverride` (see existing tests that use it), close with `approvalRequestId: override.id` (ULID, as returned) -> 200, closed; stored `pos_shifts.approval_request_id` = `ulidToUuid(override.id)`, `approval_override_id` matches. No retry loops.
   b. Same with `approvalRequestId: ulidToUuid(override.id)` (non-RFC uuid form) -> 200.
   c. Force close with the witness override's ULID -> 200.
   d. ULID of a different override (other count or other action) -> refused (403/approval refused), shift stays open.
   e. Garbage id ("abc") -> 422 VALIDATION_ERROR.
2. `apps/api/src/test/pos-day.test.ts`: remove any retry loop that re-creates the PIN override until its `ulidToUuid` form is an RFC uuid; send `override.id` directly.
3. `tests/pos-contract.test.mjs`: close and force-close input accept a ULID and a non-RFC uuid shape, reject "abc".

Run: `LEGEND_TEST_FILES="src/test/pos-shift.test.ts src/test/pos-day.test.ts" heavy pnpm test` from worktree root; `node --test tests/pos-contract.test.mjs`; `pnpm --filter @starter/api exec tsc --noEmit -p .`; eslint on edited files. Report changes + pass/fail counts.
