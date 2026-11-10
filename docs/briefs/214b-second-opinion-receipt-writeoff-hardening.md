# 214b Second opinion: receipt write-off hardening (legend-l56xd, legend-xlvvl)

Read-only review. Do not edit or commit. Do not read `.env*` or `~/.ssh`.

Worktree `.worktrees/receipt-writeoff-hardening`, branch `ws/receipt-writeoff-hardening` on top of `ws/receipt-number-writeoff` 13ce6220. Review `git diff 13ce6220..ws/receipt-writeoff-hardening` (commits bf232507, e6cb3e1b, c4c347ef). Architect already found legend-7vsby (owner template grantable without an owner, grants.ts:116-125); confirm or extend it, no need to re-report. Spec: `docs/briefs/214-receipt-writeoff-hardening.md` (main folder); your earlier findings 201b.

## What changed

- `apps/api/src/routes/pos-receipt-writeoff.routes.ts`:
  - POST and GET require `getAccessSnapshot(req).allowsVia("owner", "pos.receipt.writeoff", outlet)`. Custom roles always have `template_key NULL` (DB check in `apps/api/src/db/schema/platform-access.ts:63`), so they never pass. The owner template is excluded from top-authority grants (`grants.ts:47`), and templates cannot be edited.
  - POST requires `session.mfa_verified_at` within `ROLE_GRANT_REAUTH_MAX_AGE_MS` (5 min). Otherwise it answers 401 `REAUTH_REQUIRED`, or 403 `MFA_REQUIRED` when the session never verified.
- `apps/api/src/services/pos-receipt-writeoff.service.ts`: GET refuses on an edge process (409).
- `apps/api/src/services/pos-receipt.service.ts`:
  - `receiptGapsForOutlet` reads receipts and write-offs in one `UNION ALL` statement.
  - `mergeDeviceReceiptRun` gets a comment only: write-offs are never consulted.
- Tests: `apps/api/src/test/pos-receipt-writeoff.test.ts`, plus a merge case in `pos-receipt.test.ts`.
- `docs/runbooks/receipt-number-writeoff.md`: who may write off, preflight, compatibility window, rollback removing the code from every role.

## Questions

1. Is the owner-only check now complete? Consider an owner template assigned at outlet scope, an expired or revoked assignment, a platform super admin, and impersonation. Is a stale snapshot possible within a request?
2. Re-auth: is `mfa_verified_at` the right "recent re-authentication" signal, and is clock skew between the DB and the API handled like the role-grant path?
3. Does the race test in `pos-receipt-writeoff.test.ts` (wrapped tx with an interleaved late receipt) really exercise the old bug, and is the fix correct under READ COMMITTED?
4. Is the runbook's rollback and preflight SQL correct under FORCE RLS? Is the migration/API compatibility window stated correctly?
5. Anything left from 201b that is still open.

Answer per question: verdict (OK / risk / bug), evidence (file:line), suggested fix.
