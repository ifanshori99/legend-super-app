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

## Round 3 — UI audit fixes (CTO, 9 Nov)

MFA decision: option (a), unchanged. Only the read-only support case changes;
plain `disabled` buttons keep today's behaviour. Follow
`~/.agents/team/ui-standard.md` (WCAG 2.2 AA, touch ≥ 44 px on touch screens).

- **U1 (implementer, files: `apps/web/src/components/ui/button.tsx`,
  `apps/web/src/features/ws01-support-access/read-only.tsx`,
  `e2e/legend-cg071.mock.spec.ts`)**
  - A submit Button blocked by read-only mode is NOT `disabled`: it gets
    `aria-disabled="true"`, stays focusable, its click is blocked in the
    handler (preventDefault, no submit; still call nothing else), shows a
    lucide `Lock` icon before the label, and `aria-describedby` points to a
    fixed text "Tidak bisa menyimpan di sesi dukungan (hanya baca)" (i18n key
    under `supportAccess.readOnlyMode.*`). Render that text once, visually
    hidden, inside `SupportReadOnlyProvider` with a stable id the Button reads
    from context (merge with any existing aria-describedby). Styling: same
    muted look as disabled (`aria-disabled:` variants), cursor not-allowed.
  - `allowInReadOnly` opt-out keeps working. `asChild` buttons unchanged.
  - Update the e2e spec: read-only submit has aria-disabled=true, is
    focusable, click does not submit; normal session unchanged; notice
    assertions follow U2 (`data-slot="support-session-bar"`, role=status).
    Screenshots stay `legend-cg071/kelola-readonly-{390,1440}-light.png`.
- **U2 (implementer, files: `apps/web/src/features/ws01-support-access/components/session-banner.tsx`,
  `.../components/read-only-notice.tsx` (delete or fold in),
  `apps/web/src/components/layout/area-frame.tsx`)**
  - One compact bar replaces both `SupportSessionBanner` (area-frame ~167 and
    the operations-shell mount ~178) and `SupportReadOnlyNotice`:
    `data-slot="support-session-bar"`, `role="status"`, sticky directly under
    the shell header (must not cover the header; check the header's height /
    z-index in ManagementShell and OperationsShell and offset with `top-*`
    accordingly; it must not overlap content when scrolling).
  - Content in one row (wraps on narrow): label ("Sesi akses dukungan ·
    Hanya baca" / "· Baca-tulis"), remaining time (existing countdown logic,
    `role="timer"` stays inside), and "Akhiri sesi" only for the impersonator
    (read-only support session from `access.supportSession`) calling
    `authClient.admin.stopImpersonating()` then reload to `/`. Reason and
    end time behind a disclosure (`<details>/<summary>` or a button with
    aria-expanded), collapsed by default.
  - Data: tenant users keep the org grants source (no end button);
    impersonator uses `access.supportSession` (expiresAt, accessMode) and the
    org grant if readable (for reason). Render nothing when neither exists.
  - "Akhiri sesi" ≥ 44 px tall on touch (`pointer-coarse:` / `min-h-11`),
    compact on fine pointers is fine.
  - Keep expiring-soon danger styling and existing i18n keys; add keys only
    if needed.

## Round 4 (UI audit fixes, legend-cg071)

Done by the agent already: button.tsx (hover/press reset via `not-aria-disabled:`, props spread before read-only attrs, blocked click calls `useNotifySupportReadOnlyBlocked()` toast), read-only.tsx (context holds notify fn), globals.css (`.overflow-y-auto:has([data-slot="support-session-bar"])` scroll-padding-top from `--support-bar-h`).

- R4-bar (`apps/web/src/features/ws01-support-access/components/session-banner.tsx` only):
  1. When `soon`: render visible text `t("supportAccess.banner.expiringSoon")` + `TriangleAlert` icon (aria-hidden) next to the countdown, so it is not color-only.
  2. Publish bar height: ref on the root div + ResizeObserver setting `--support-bar-h` (px) on `document.documentElement`; remove the property on unmount.
  3. `<details>`: add `group open:basis-full`; inner content div `max-h-40 overflow-y-auto`.
  4. `<summary>`: `list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1`, add `ChevronDown` (aria-hidden, `size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none`).
  5. Hide `<Power>` while `pending` (Button shows its spinner).
- R4-spec (`e2e/legend-cg071.mock.spec.ts` only):
  1. Normal session: the mock tenant HAS an active org grant (legend-335 tenant notice), so the bar may render. Replace `toHaveCount(0)` on BAR with: no "Akhiri sesi" button, and `Simpan kebijakan` has no aria-disabled and no lock.
  2. Read-only: Playwright `toBeDisabled()` counts aria-disabled, so replace `not.toBeDisabled()` with `not.toHaveAttribute("disabled")`. After the click, assert the toast text "Tidak bisa menyimpan" style message from `supportAccess.readOnlyMode.submitBlocked` (read the i18n value in packages/shared/src/i18n/messages/ws01-support-access.ts) is visible.
- No test runs, no commits. Report changed lines in 3 lines.
