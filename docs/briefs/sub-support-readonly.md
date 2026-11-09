# Sub-brief: support session read-only (legend-cg071, tier K: auth)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/support-readonly`
(branch `ws/support-readonly`). Do not commit, push, or touch files outside your part.
Off limits: refund, pos-day, pos-shift, edge, receipt_sequences, payroll,
auto-journal, `worker-main.ts`, DB schema/migrations.

## Facts (already verified)

- A "support session" is a `support_access_grants` row (tenantId,
  superAdminUserId, accessMode `read_only|read_write`, endedAt, expiresAt).
  Service guard: `assertSupportAccess({tenantId, actorUserId, dataClass, intent})`
  in `apps/api/src/services/platform-support.service.ts:667`. It throws
  `PlatformError("SUPPORT_ACCESS_REQUIRED")` / `("SUPPORT_ACCESS_READ_ONLY")`;
  the error handler maps PlatformError to its status (403). With
  `dataClass: "personal"` it throws REQUIRED when no active grant; with
  `intent: "write"` it throws READ_ONLY for a read_only grant. It also rejects
  a grant whose holder is no longer a platform admin.
- No route calls it. Tenant routes (`requireTenantPermission` etc.) only use
  tenant role assignments, so a Super Admin cannot reach /kelola APIs directly.
- The ONLY way a platform person acts inside a tenant today is Better Auth admin
  impersonation (`apps/api/src/lib/auth.ts:91`, ADMIN_ROLES=["admin"]): it makes
  a session whose `session.impersonatedBy` = admin user id. Nothing reads it.
  The impersonated session gets the tenant user's full permissions = hole.
- The /kelola banner (`SupportSessionBanner source="org"` in
  `apps/web/src/components/layout/area-frame.tsx:159,178`) is a NOTICE for
  tenant users. Normal tenant users must keep full write access.

## Decision: "support session" on a request = session with `impersonatedBy`

Policy for an impersonated session (`req.auth.session.impersonatedBy` non-null),
tenant = `findTenantContext(req)` (`middleware/tenant.ts:92`):

1. Tenant resolved, no active grant for (tenant, impersonatedBy) → 403
   `SUPPORT_ACCESS_REQUIRED` for every method (TEN-04).
2. Grant `read_only` and method not GET/HEAD/OPTIONS → 403
   `SUPPORT_ACCESS_READ_ONLY`.
3. Grant `read_write` → pass.
4. No tenant resolved: safe methods pass; mutations → 403
   `SUPPORT_ACCESS_READ_ONLY`.
5. Normal (non-impersonated) sessions: untouched, no extra DB query.
6. Better Auth `/api/auth/*` mutations under an impersonated session: deny
   (403 `SUPPORT_ACCESS_READ_ONLY`) except exits: `/api/auth/sign-out`,
   `/api/auth/admin/stop-impersonating`. Support never changes a user's
   credentials, even in read_write.

Response shape is the app's normal error JSON (whatever `send()` in
`middleware/error-handler.ts` produces) — throw the PlatformError, never
`res.status()` by hand.

## Part A — API guard (implementer A)

Files: new `apps/api/src/middleware/support-session.ts`; `middleware/auth.ts`
(call the guard inside `requireAuth` after the session is set — the single
chokepoint every cookie router mounts); `app.ts` only to mount the
`/api/auth/*` guard (rule 6) between `limitAuthBody` and `toNodeHandler(auth)`
— must not read/consume the body (headers only). Also check routers that
authenticate cookie sessions WITHOUT `requireAuth` (e.g.
`routes/identity-auth.routes.ts`, `platform-brand.routes.ts`, `qr*.routes.ts`):
list them in your report; wire the guard only if trivial, else report.
Export a helper `supportSessionOf(req)` returning
`{ impersonatedBy, accessMode, expiresAt } | null` (cached per request) for Part B.
Add a short comment block explaining the policy.

## Part B — shared contract + /api/me/access (implementer B)

Files: the shared schema behind `myAccessViewSchema` (`@starter/shared/access`)
and `apps/api/src/routes/me.routes.ts`. Add field
`supportSession: { accessMode: "read_only" | "read_write"; expiresAt: string } | null`
(ISO string). Populate from `req.auth.session.impersonatedBy` + active grant via
`assertSupportAccess({ tenantId, actorUserId: impersonatedBy, dataClass:
"configuration", intent: "read" })` (returns grant or null without throwing);
null for normal sessions. Update any fixtures/mocks of the access view that
the type change breaks (grep `myAccessView`, e2e mocks under `e2e/`).

## Part C — web shared read-only pattern (implementer C)

Field from Part B: `access.supportSession` (see shape above). Files under
`apps/web/src`:

- New `features/ws01-support-access/read-only.tsx`: `SupportReadOnlyProvider`
  (value: boolean), `useSupportReadOnly()`, and a wrapper that blocks form
  submits inside it (`onSubmitCapture` → preventDefault + toast
  "Sesi dukungan hanya baca: perubahan tidak disimpan."; React portals bubble
  through the React tree so dialogs are covered).
- `components/ui/button.tsx`: when `useSupportReadOnly()` is true and
  `type="submit"`, render disabled (read context with a safe default false so
  Button works outside the provider). Add opt-out prop only if needed.
- `components/layout/area-frame.tsx`: for tenant areas (not platform), when
  the access view says `supportSession.accessMode === "read_only"`, mount the
  provider around content and show a persistent notice for the impersonator:
  "Sesi dukungan · Hanya baca. Perubahan dinonaktifkan." plus a button
  "Akhiri sesi" calling Better Auth `authClient.admin.stopImpersonating()`
  then full reload to `/`. Find how the area layout gets the access view
  (`lib/areas/load-access.ts`). Use i18n like the existing banner
  (`useT`, keys under `supportAccess.readOnlyMode.*`; add id + en strings
  where the catalog lives).
- Follow `~/.agents/team/ui-standard.md`. Keep tokens/classes like
  `session-banner.tsx`.

## Part D — tests (test-writer)

`apps/api/src/test/support-session-readonly.test.ts`. Use helpers from
`src/test/helpers.ts` and the open-grant pattern from
`src/test/platform-support-access.test.ts` (platform_admins row,
`requestSupportAccess`). Make an impersonated session via Better Auth
`POST /api/auth/admin/impersonate-user` with an `admin`-role account
(`setRole`). Pick one real /kelola endpoint pair (a GET list + a
POST/PATCH/PUT/DELETE the tenant user may do). Cases:

1. Impersonated + read_only grant: GET 200; POST, PATCH/PUT, DELETE → 403
   `SUPPORT_ACCESS_READ_ONLY`; nothing changed in DB.
2. Impersonated + no grant → 403 `SUPPORT_ACCESS_REQUIRED` (GET too).
3. Cross-tenant: grant for tenant B, request on tenant A → REQUIRED.
4. Impersonated + read_write grant → mutation allowed.
5. Normal tenant user session (same user, not impersonated) → mutation allowed.
6. Exit works: `POST /api/auth/admin/stop-impersonating` succeeds under the
   read_only impersonated session; Better Auth `update-user` is refused.
7. Ended or expired grant → REQUIRED.
8. `/api/me/access` returns `supportSession` (read_only) under impersonation,
   null for normal session.
   Run: `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/support-session-readonly.test.ts" pnpm test'`.

## Round 2 fixes (review findings; keep Parts A–D intact)

Shared allowlist (one constant in `middleware/support-session.ts`, exact path
after stripping query + trailing slash): `/api/auth/get-session`,
`/api/auth/sign-out`, `/api/auth/admin/stop-impersonating`,
`/api/auth/sessions/current/activity` (idle keep-alive).

- **R1 (implementer, files: `middleware/support-session.ts`, `app.ts`,
  `routes/identity-auth.routes.ts`)**
  - Mount `guardImpersonatedAuthRoutes` with `app.use("/api/auth", ...)` BEFORE
    the login-challenges mount (app.ts ~265) so it covers login-challenges,
    `identityAuthRouter` and Better Auth; remove the per-route copy. Headers
    only, never the body.
  - Under an impersonated session it refuses EVERY method on `/api/auth/*`
    except the allowlist (403 `SUPPORT_ACCESS_READ_ONLY`). Look up the session
    only when the path is not allowlisted and a cookie/authorization header is
    present.
  - `enforceSupportSession` rule 4 (no tenant): refuse every method unless the
    path is allowlisted (fail closed).
  - Lasting credentials are denied under impersonation even with read_write:
    a `CREDENTIAL_PATHS` list in the same file checked in
    `enforceSupportSession` → 403 `SUPPORT_ACCESS_READ_ONLY`. Include
    `POST /api/ai/mcp/authorize` (`routes/ai-mcp-admin.routes.ts:128`); grep
    device pairing / device token / API key minting routes and add those.
  - Belt and braces in `identity-auth.routes.ts`: when
    `signedIn.session.impersonatedBy` is set, refuse the WhatsApp link
    (`SUPPORT_ACCESS_READ_ONLY`).
- **R2 (implementer, files: `middleware/platform-admin.ts`,
  `services/kds-realtime-auth.ts`)**
  - platform-admin: an impersonated session (`req.auth.session.impersonatedBy`)
    is never a platform admin → refuse with the middleware's normal denial.
  - KDS socket: if the cookie session has `impersonatedBy`, call
    `assertSupportAccess({ tenantId, actorUserId: impersonatedBy, dataClass:
"personal", intent: "read" })`; on throw return null (deny). Make sure the
    existing periodic recheck runs the same path so expiry cuts the socket.
- **R3 (implementer, files: `apps/web/src/features/ws01-support-access/read-only.tsx`,
  `apps/web/src/components/ui/button.tsx`)**: opt-out for read-only forms
  (search/filter): `<form data-support-readonly-allow>` skips the submit
  blocker; `Button` prop `allowInReadOnly` keeps a submit button enabled.
  Document both in the file header comment. Do not apply it anywhere yet.
- **R4 (test-writer, file: `apps/api/src/test/support-session-readonly.test.ts`)**:
  add cases: impersonated POST `/api/auth/login-challenges/whatsapp` → 403;
  impersonated GET `/api/auth/list-sessions` → 403, GET `/api/auth/get-session`
  → 200; keep-alive `POST /api/auth/sessions/current/activity` → not 403 under
  read_only grant; impersonated platform admin target → platform route refused;
  `POST /api/ai/mcp/authorize` under read_write → 403 READ_ONLY. KDS socket if a
  helper exists for it, else skip and say so.
