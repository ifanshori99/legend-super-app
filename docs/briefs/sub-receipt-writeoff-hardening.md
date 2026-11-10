# Sub-brief 214: receipt write-off hardening (legend-l56xd, legend-xlvvl)

Worktree (only place to work): `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-writeoff-hardening`, branch `ws/receipt-writeoff-hardening`. Do not commit, push, run tsc, `pnpm check` or full suites. No new migration. Do NOT touch receipt claim/rotation/allocation logic, edge sync, refund, payroll, `worker-main.ts`, UI. Each part edits only its own files.

## Decided design

### H1 owner-only + recent re-auth (legend-l56xd). File `apps/api/src/routes/pos-receipt-writeoff.routes.ts`

- Today: `requireOutletPermission("pos.receipt.writeoff")` + `verifiedSecondFactor`. A tenant admin can put the code in a custom role (top-authority path, `packages/shared/src/access/grants.ts:115`), and its holder passes.
- POST and GET: after the permission middleware, require `getAccessSnapshot(req).allowsVia("owner", "pos.receipt.writeoff", { type: "outlet", id: outletId })`. Else throw `AccessError("PERMISSION_DENIED")` (403). A custom role (templateKey null) never satisfies it. The owner template cannot be granted through top authority (`TOP_AUTHORITY_EXCLUDED_TARGETS`, grants.ts:47) and templates cannot be edited (`updateCustomRole`, access.service.ts ~481).
- POST: replace the `mfaVerified` check with recent re-auth, reusing the role-grant rule. Load `loadSessionRow(getAuth(req).session.id)` (`apps/api/src/services/identity-session.service.ts:122`, as `access.routes.ts:100-101` does). Take `mfaVerifiedAt`. If it is null → `AccessError("MFA_REQUIRED")` (403). If its age is not within `0..ROLE_GRANT_REAUTH_MAX_AGE_MS` (`@starter/shared/access`, 5 min) → `AccessError("REAUTH_REQUIRED")` (401). Same age expression as grants.ts:88-92. Comment why (irreversible).

### H2 GET refuses on edge (legend-xlvvl b). File `apps/api/src/services/pos-receipt-writeoff.service.ts`

`listReceiptNumberWriteoffs`: same `isEdgeProcess()` refusal as POST (CoreError CONFLICT, Indonesian message: the history lives in the cloud only). Reuse one message constant.

### H3 slow helper single snapshot + merge doc (legend-xlvvl c, d). File `apps/api/src/services/pos-receipt.service.ts`

- `receiptGapsForOutlet` (~1505): read the present ordinals of all the outlet's runs in ONE statement: receipts `UNION ALL` all write-offs (no NOT EXISTS needed here; the set dedups) for the outlet's sequence ids, scoped by tenant. One statement = one READ COMMITTED snapshot, so a late receipt cannot fall between two reads. Keep the result shape and order. Do not touch the fast paths.
- `mergeDeviceReceiptRun` completeness check (~1413-1429): comment only, no logic change: an advancing merge requires every number 1..newLast to have a real receipt (cloud or batch); write-offs are deliberately not consulted, so a written-off number never lets a device run advance (legend-0hzqw/legend-xlvvl).

### H4 tests (test-writer). File `apps/api/src/test/pos-receipt-writeoff.test.ts` (and `pos-receipt.test.ts` only if the merge test fits better there; prefer the write-off file)

- The test "owner" must now be the owner TEMPLATE: change the owner role rows to `is_template true, template_key 'owner'` (permissions can stay `["pos.receipt.writeoff"]`; the isolated tenant has no templates, so no clash; check the roles unique keys). Keep `verifySessionMfa` (stamps now, so re-auth passes).
- New cases:
  1. Delegation (repro l56xd): a custom role (`is_template false`) holding `pos.receipt.writeoff`, assigned at tenant scope, session MFA-verified → POST 403 and GET 403, no row written. Owner still 201.
  2. Stale re-auth: owner whose `session.mfa_verified_at` is 10 minutes old (owner SQL UPDATE) → POST 401 `REAUTH_REQUIRED`, no row. GET still 200.
  3. GET on edge (repro xlvvl b): `inEdgeMode` (exists in the file) → GET 409.
  4. Slow helper race (repro xlvvl c): run lastNumber 3, receipts 1 and 3, write off 2; then a late receipt 2 commits between the helper's receipt read and its write-off read. Make it deterministic: call `receiptGapsForOutlet` with a wrapped tx (or a pg-level hook) that inserts the late receipt (separate owner connection, committed) right after the first statement touching `pos_receipts` resolves. Expect `[]` (no false gap). Must fail on the current code. If a deterministic interleave is not feasible, say so and write the closest honest test.
  5. Merge (xlvvl d): a run with a written-off number 2: an advancing `mergeDeviceReceiptRun` whose batch lacks receipt 2 (and cloud has none) still throws `RECEIPT_SEQUENCE_GAP`. See `pos-receipt.test.ts:544-553` for `mergeRun`/`provision`.
- Write, don't run. Report the case names and anything assumed.

### H5 runbook (doc-writer). File `docs/runbooks/receipt-number-writeoff.md`, Indonesian, short

- Who: only an active tenant Owner (template role), not a custom role, even if it holds the code. POST needs a 2FA verification in the last 5 minutes (401 `REAUTH_REQUIRED` otherwise: verify 2FA again). GET is also cloud only (409 on edge) and owner only.
- ~line 58-60: the GET history always keeps the write-off. Only the shift report's `writtenOff` list drops a number that later got a real receipt.
- Rollback (a): remove `pos.receipt.writeoff` from EVERY role (templates and custom), per tenant with `set_config('app.tenant_id', ...)`: `permissions - 'pos.receipt.writeoff'`, because the old API parses roles strictly (`packages/shared/src/access/schemas.ts:39`) and an unknown code breaks role listing. Add a preflight report before migrating/rolling back: tenants without an owner template row (the 0156 backfill skips them), and custom roles holding the code (count per tenant). Document the compatibility window: if migration 0156 runs before the new API is live, the old API sees the new code in owner rows → strict parsing fails for those roles until the new API is deployed; so deploy the API together with (immediately after) the migration, or apply migration and API in one release step.
