# Second opinion (Codex): support session read-only, legend-cg071 (tier K: auth)

Branch `ws/support-readonly` (worktree `.worktrees/support-readonly`), based on
`milestone/m1` f5438770. Review `git diff f5438770..ws/support-readonly`.
Read-only review; report findings with file:line, severity, and a concrete
failure scenario. Do not edit.

## What the change claims

- A platform person can act inside a tenant only via Better Auth admin
  impersonation (`session.impersonatedBy`). Before this change nothing read it,
  so an `admin` could impersonate any tenant user with full write access and
  no support-access grant (TEN-04 hole).
- New central guard (`apps/api/src/middleware/support-session.ts`, called from
  `requireAuth`, plus a pre-Better-Auth guard for `/api/auth/*` in `app.ts`):
  impersonated session without an active grant for the resolved tenant → 403
  `SUPPORT_ACCESS_REQUIRED`; `read_only` grant + mutation → 403
  `SUPPORT_ACCESS_READ_ONLY`; `/api/auth/*` mutations refused except sign-out
  and stop-impersonating. Normal sessions untouched.
- `/api/me/access` exposes `supportSession`; web disables submit buttons and
  blocks form submits in tenant areas during a read-only support session (UI
  only; API is the control).

## Please check

1. Bypasses: any cookie-session route that authenticates without
   `requireAuth` (own `auth.api.getSession`), routers mounted before the guard,
   method override, HEAD/OPTIONS handling, `/api/auth/*` path normalisation
   (case, trailing slash, encoded chars) around the allowlist.
2. Tenant binding: grant must match the resolved tenant; domain vs dev
   fallback; requests with no tenant context.
3. Grant checks: expiry against the clock, ended grants, holder no longer a
   platform admin, impersonator ≠ grant holder.
4. Error path: 403 bodies use the standard error JSON; no info leak.
5. Performance: no extra query for normal sessions.
6. Anything the impersonated session can still change (password, email,
   sessions, MFA factors, device tokens).
