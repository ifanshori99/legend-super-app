# Second opinion (Codex): impersonated session cut at grant end, single grant scan per request — legend-npkpz (tier K: auth)

Branch `ws/impersonate-expiry-cap` (worktree `.worktrees/impersonate-expiry-cap`),
based on `integ/m1-batch24` 94d769c6 (contains ws/impersonate-grant, legend-rzirp).
Review `git diff 94d769c6..ws/impersonate-expiry-cap`. Read-only review; report
findings with file:line, severity, and a concrete failure scenario. Do not edit.

## What the change claims

- `apps/api/src/lib/auth.ts` `databaseHooks.session.create.before`: an
  impersonated session's `expiresAt` = min(Better Auth expiry, now + 60 min,
  the latest `expiresAt` among the grants matched by
  `assertImpersonationAllowed`). Helper `impersonationSessionEnd` in
  `apps/api/src/services/platform-support.service.ts`. Grant ended/expired
  later is still refused per request by `middleware/support-session.ts`.
- `platform-support.service.ts` `scanImpersonationGrants`: within one HTTP
  request, `assertImpersonationAllowed` runs 3 times (hooks.before,
  session.create.before, session.create.after). The first successful
  cross-tenant scan (`findImpersonationGrants`, one RLS tenant transaction per
  tenant) remembers the matched tenant ids in a `WeakMap` keyed on the
  request's AsyncLocalStorage store (`lib/request-context.ts`), key
  admin+target. The later checks of that request scan again, fresh (grant and
  role assignment), but only those tenants (`findImpersonationGrants({
  tenantIds })`). No store (server-side `auth.api.impersonateUser`) means no
  memo. Platform-admin checks still run every time. Empty results are not
  remembered.
- Audit labels: `packages/shared/src/i18n/messages/audit-settings.ts`
  `auditSettings.audit.actions.support_access_*` and objectType
  `support_access_grant`.
- No migration. Grants stay under forced tenant RLS; the scan still visits each
  tenant once per impersonate request (was 3x).

## Please check

1. Cap: any path where the session outlives every matched grant; target with
   roles in several granted tenants (max of grant ends vs the per-request
   guard); cookie maxAge vs `expiresAt`; `impersonationEndsAt` in the start audit.
2. Memo: leakage across requests, users or concurrent requests sharing an ALS
   store; keys that collide; anything a later check reads from the memo other
   than tenant ids.
3. Decision parity: any input where the narrowed later checks allow or deny
   differently from three full scans (only a grant newly opened mid-request in
   another tenant can differ, and only by adding a tenant).
4. End audit (`recordImpersonationEnded`) unchanged: still scans at session
   start time.

## Invariants (PRD v1.7 §3 F4 Support Access, TEN-04)

- Tenant data opens only through a time-boxed grant, read-only by default.
- Impersonated session ≤ 60 min and never valid after its grant ends.
- No MFA bypass through a grant (legend-cg071 option a).
