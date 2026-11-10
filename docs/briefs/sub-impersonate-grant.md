# Sub-brief: impersonate grant, durasi, audit (legend-rzirp, legend-6yfhc)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/impersonate-grant` (branch `ws/impersonate-grant`, base `ws/support-readonly` da19ac16). Tier K (auth). All paths below relative to `apps/api/src` unless noted. Better Auth 1.7.7 (`apps/api/node_modules/better-auth/dist`). Do not touch files outside your section. Do not commit. Do not run `pnpm check`, tsc, or full test suites; the engineer does.

## Context (already true on base)

- Support session = Better Auth admin impersonation (`session.impersonatedBy` = admin user id, `session.userId` = tenant user).
- `middleware/support-session.ts` (legend-cg071): `enforceSupportSession(req)` called by `requireAuth` checks an active `support_access_grants` row for (tenant, impersonatedBy) via `assertSupportAccess` (`services/platform-support.service.ts:667`). `guardImpersonatedAuthRoutes` blocks `/api/auth/*` for impersonated sessions except `IMPERSONATION_ALLOWED_PATHS`.
- Platform admin = active `platform_admins` row, `isPlatformAdmin(userId)` (`platform-support.service.ts:113`).
- Grants are tenant-owned under forced RLS, as are `role_assignments` (`db/schema/platform-access.ts:76`: tenantId, userId, roleId, validFrom, validUntil). Cross-tenant reads loop tenants and use `withTenant(db, platformTenantContext(tenantId), ...)` (see `findGrantTenant`, `allTenantIds` in platform-support.service.ts).
- Every audit row is inserted by `services/core-audit.ts` `recordAudit(tx, context, input, safeFields)`. `services/audit-writer.ts` `recordAudit(entry, scope)` → `core-audit-writer.ts` → core-audit. Event schema: `packages/shared/src/audit/schemas.ts` (`strictObject`, `sensitiveAccess: true` needs non-empty reason).
- MFA decision (legend-cg071, option a): no MFA bypass based on a grant. Do not add one.

## Section A — gate + start/end audit (implementer A)

Files: `lib/auth.ts`, `services/platform-support.service.ts` (new section only), `services/core-audit-writer.ts` (SAFE_FIELDS only).

1. In `platform-support.service.ts` add and export:
   - `IMPERSONATION_SESSION_MAX_SECONDS = 60 * 60`.
   - `findImpersonationGrants({ adminUserId, targetUserId, now, at? })`: loop `allTenantIds()`; per tenant in `withTenant(platformTenantContext)`: grants of admin in that tenant that are active at `at ?? now` (`startedAt <= at`, `expiresAt > at`, `endedAt IS NULL OR endedAt > at`), and only if any, whether target has an active `role_assignments` row in that tenant (`validFrom <= now`, `validUntil IS NULL OR validUntil > now`). Return `Array<{ tenantId, grant }>` (latest-expiring grant per tenant).
   - `assertImpersonationAllowed({ adminUserId, targetUserId, now })`: throw `PlatformError("SUPPORT_ACCESS_REQUIRED")`-equivalent reasons in this order: admin not platform admin → `SUPPORT_ACCESS_REQUIRED`; target === admin or target is platform admin → `IMPERSONATION_NOT_ALLOWED`; no match from `findImpersonationGrants` → `SUPPORT_ACCESS_REQUIRED`. Return the matches. Throw a plain typed error (e.g. `class ImpersonationRefused extends Error { code }`) so lib/auth.ts maps it to Better Auth `APIError("FORBIDDEN", { code, message })` (import `APIError` from `better-auth/api`).
   - `recordImpersonationStarted({ adminUserId, targetUserId, sessionId, sessionExpiresAt, matches, now })` and `recordImpersonationEnded({ adminUserId, targetUserId, sessionId, sessionCreatedAt, cause, now })` (end recomputes tenants with `findImpersonationGrants({ at: sessionCreatedAt })`). One audit row per matched tenant via the private `audit(tx, context, …)` helper: `actorType: "user"`, `actorId: adminUserId`, actions `support_access.impersonation_started` / `support_access.impersonation_ended`, `objectId: grant.id`, `reason: grant.reason`, `sensitiveAccess: true`, `after: { impersonatedUserId, accessMode, sessionExpiresAt | cause, grantExpiresAt }`. `cause` ∈ `stopped | signed_out | expired | revoked`.
2. `core-audit-writer.ts`: add SAFE_FIELDS for both actions (the keys of `after`).
3. `lib/auth.ts`:
   - `admin({ …, impersonationSessionDuration: IMPERSONATION_SESSION_MAX_SECONDS })`.
   - `hooks.before: createAuthMiddleware(...)` (from `better-auth/api`): when `ctx.path === "/admin/impersonate-user"`: `getSessionFromCtx(ctx)`; no session → return (endpoint 401s); session already impersonated → FORBIDDEN `IMPERSONATION_NOT_ALLOWED`; `targetUserId = ctx.body?.userId` (string, else return and let validation fail); `await assertImpersonationAllowed(...)` mapped to APIError 403.
   - `databaseHooks.session.create.before(session)`: if `session.impersonatedBy`: re-run `assertImpersonationAllowed` (defense in depth: server-side `auth.api.impersonateUser` skips `hooks.before`), and return `{ data: { ...session, expiresAt: min(session.expiresAt, now + 60 min) } }`.
   - `databaseHooks.session.create.after(session)`: if impersonated: `recordImpersonationStarted`; on failure delete that session row (drizzle on `session` table by id) and throw (fail closed).
   - `databaseHooks.session.delete.after(session, ctx)`: if impersonated: cause from `ctx?.path` (`/admin/stop-impersonating` → stopped, `/sign-out` → signed_out), else `expiresAt <= now` → expired, else revoked; `recordImpersonationEnded`; on failure log error (pino `authLog`), never throw (never block an exit).
   - Watch for import cycles (`lib/auth.ts` ← `middleware/support-session.ts` → `platform-support.service.ts`). If platform-support imports anything that imports `lib/auth`, use a dynamic `await import()` inside the hooks.
   - Comment block explaining the policy (TEN-04, legend-rzirp).

## Section B — write attribution to impersonator (implementer B)

Files: `lib/request-context.ts`, `middleware/support-session.ts`, `services/core-audit.ts`, `packages/shared/src/audit/schemas.ts` (repo root relative).

1. `request-context.ts`: extend context with optional `support?: { tenantId, grantId, impersonatorUserId, impersonatedUserId, accessMode, reason }`; add `setRequestSupport(value)` and a getter `getRequestSupport()`.
2. `support-session.ts` `enforceSupportSession`: after the grant passes (non-null), call `setRequestSupport({...})` with tenant id, grant id/accessMode/reason, impersonatedBy, `req.auth.user.id`. Check the `SupportAccessGrant` type for field names.
3. `packages/shared/src/audit/schemas.ts`: add optional `support: z.strictObject({ grantId: uuidSchema, impersonatorUserId: uuidSchema, impersonatedUserId: uuidSchema, accessMode: z.enum(["read_only","read_write"]) }).optional()` to `auditEventSchema` (jsonb column, no migration). Old rows stay valid.
4. `core-audit.ts` `recordAudit`: single attribution point. Before `auditEventSchema.parse`, read `getRequestSupport()`; if present and `input.tenantId === support.tenantId`: add `support` tag; if `actorType === "user"` and `actorId === support.impersonatedUserId`: set `actorId = support.impersonatorUserId`, `sensitiveAccess = true`, `reason = input.reason?.trim() ? input.reason : support.reason` (truncate to 1000). Other actors (system/device) keep actor, only get the tag. Never touch a row of another tenant. Comment why (legend-6yfhc).

## Section C — impersonated session never outlives 60 min (implementer C)

File: `services/identity-session.service.ts` only.

`touchSession` (and any other expiry writer there, e.g. explicit extend) may move `expiresAt` forward (management upgrade sets `newSessionExpiry`, activity slides idle deadline). For a row with `impersonatedBy` set, never write an `expiresAt` later than the row's current `expiresAt` (cap with `min`). Check `SessionRow` has `impersonatedBy`. Short comment (legend-rzirp: impersonation hard cap 60 min).

## Section T — tests (test-writer, own worktree)

New file `apps/api/src/test/impersonation-grant.test.ts`, modeled on `apps/api/src/test/support-session-readonly.test.ts` (reuse its helpers pattern: `newTenantOwner`, `newSuperAdmin`, `openGrant`, `impersonate`). Cases (IDs in names, `legend-rzirp` / `legend-6yfhc`, TEN-04):

1. Impersonate without grant → 403, no session created (admin client still its own user on get-session).
2. Impersonate a platform-admin target (with grant in a tenant where target has a role) → 403.
3. Grant expired (opened with `now` in the past so it lapsed) → 403. Ended grant → 403.
4. Grant for another tenant only → 403 (lintas tenant).
5. Caller not platform admin (Better Auth `admin` role but no platform_admins row) → 403.
6. With grant: 200; `session` row `expires_at - created_at <= 60 min`; after a request that touches activity (`/api/auth/sessions/current/activity` or a management surface), `expires_at` not later than before.
7. Audit: impersonation start writes `support_access.impersonation_started` in the tenant's `audit_logs` (`event->>'actorId'` = admin, `event->>'sensitiveAccess'` true, after.impersonatedUserId = tenant user); stop (`POST /api/auth/admin/stop-impersonating`) writes `support_access.impersonation_ended` cause `stopped`. No such row in the other tenant.
8. read_write grant: a mutation (e.g. `PATCH /api/access/roles/:id` or `POST /api/org/domains` if it audits — pick an endpoint that writes an audit row; check with grep for recordAudit in the route's service) → the audit row has `actorId` = admin, `support.impersonatedUserId` = tenant user, `sensitiveAccess` true; the same mutation on the tenant's normal session has `actorId` = tenant user and no `support`.

Update `support-session-readonly.test.ts`: cases that impersonate with no grant / other-tenant grant / platform-admin target now must expect the impersonate call to be refused (keep the cg071 post-impersonation guard tested via ended/expired grant cases; for "never a platform admin even when the user is one", insert the target's platform_admins row AFTER impersonation starts).

Run on the base (before implementation) with:
`bash -c 'cd <your worktree> && pwd && LEGEND_TEST_FILES="src/test/impersonation-grant.test.ts src/test/support-session-readonly.test.ts" pnpm test 2>&1 | tail -60'` and report which cases fail (expected: most new ones). DB needs Docker (`~/.claude/scripts/colima-up` if down). Report the file paths and failing case names; do not commit.
