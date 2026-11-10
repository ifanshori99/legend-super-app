# Second opinion (Codex): impersonate only with grant, 60-min cap, audit as impersonator — legend-rzirp, legend-6yfhc (tier K: auth)

Branch `ws/impersonate-grant` (worktree `.worktrees/impersonate-grant`), based on
`ws/support-readonly` da19ac16 (legend-cg071). Review
`git diff da19ac16..ws/impersonate-grant`. Read-only review; report findings with
file:line, severity, and a concrete failure scenario. Do not edit.

## What the change claims

- `POST /api/auth/admin/impersonate-user` (Better Auth 1.7.7 admin plugin) is
  gated in `apps/api/src/lib/auth.ts` `hooks.before`: caller must be an active
  platform admin (`platform_admins`), caller session not already impersonated,
  target ≠ caller and not a platform admin, and caller must hold an active
  support grant (not ended, not expired, holder still platform admin) in a
  tenant where the target has an active `role_assignments` row. Refusal: 403.
- Same check repeated in `databaseHooks.session.create.before` (server-side
  `auth.api.impersonateUser` skips `hooks.before`), which also caps the
  session `expiresAt` at now + 60 min. `impersonationSessionDuration` = 3600 s.
- `services/identity-session.service.ts`: activity / management upgrade never
  moves an impersonated session's `expiresAt` later than it was.
- Audit: `support_access.impersonation_started` (create.after, fail closed:
  session deleted on audit failure) and `support_access.impersonation_ended`
  (delete.after, cause stopped / signed_out / expired / revoked; logged, never
  blocks an exit), one row per matched tenant, actor = admin,
  sensitiveAccess true, reason = grant reason.
- legend-6yfhc: `enforceSupportSession` puts the grant in the request context
  (`lib/request-context.ts`); `services/core-audit.ts` `recordAudit` (the only
  writer of `audit_logs`) rewrites `actorId` from the impersonated tenant user
  to the impersonator, sets sensitiveAccess true + grant reason, and tags the
  event with optional `support { grantId, impersonatorUserId,
  impersonatedUserId, accessMode }` (new optional field in
  `packages/shared/src/audit/schemas.ts`, jsonb, no migration).
- MFA: no grant-based MFA bypass (CTO decision, option a).

## Please check

1. Gate bypasses: any path creating an impersonated session without the hooks;
   `ctx.path` / body shape assumptions; race between grant end and session
   creation; grant ended or expired while a session is live (cg071 per-request
   guard should still refuse).
2. Tenant binding: grant tenant vs target role tenant; target with roles in
   several tenants; RLS loops across tenants; audit rows never in a tenant
   without a matching grant.
3. Duration: any other writer of `session.expires_at` that can extend an
   impersonated session past 60 min (explicit extend endpoint, Better Auth
   updateAge refresh, identity gate).
4. Attribution: AsyncLocalStorage leakage between requests; rows of another
   tenant; system/device rows inside a support request; readers that rely on
   `event.actorId` being the tenant user (approvals distinct-actor, audit
   filters, edge `access-applier`); old rows still parse.
5. Fail-closed vs availability: audit failure on start/end; import cycles
   between `lib/auth.ts` and services.
