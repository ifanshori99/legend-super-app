# Second opinion (Codex): support read_write needs tenant owner approval — legend-c9kbk (tier K: auth, personal data)

Branch `ws/support-rw-owner-approval` (worktree `.worktrees/support-rw-owner-approval`),
based on `ws/impersonate-expiry-cap` a0f0c127. Review `git diff a0f0c127..ws/support-rw-owner-approval`.
Read-only review; report findings with file:line, severity and a concrete failure scenario. Do not edit.

## What the change claims

- Founder Q37: a Super Admin's read_write support session needs the tenant owner's approval first.
  Q38: durations 15/30/60/120 (default 60), read_write still max 30, impersonation still ≤ 60 min.
- New tenant table `support_access_requests` (migration `apps/api/drizzle/0160_support_access_requests.sql`,
  journal `when` 1794239000000; forced RLS via `app.enforce_tenant_rls`; CHECKs for status/decision pairs,
  24 h window, `decided_by <> super_admin_user_id`; BEFORE UPDATE trigger freezing decided rows and
  immutable columns; backfill of `org.support_access.approve` into existing owner template roles).
- While pending / rejected / expired there is NO `support_access_grants` row, so every existing grant
  predicate (guard `assertSupportAccess`, `middleware/support-session.ts`, impersonation
  `findImpersonationGrants`, `impersonationSessionEnd`) sees no grant. Approval inserts an ordinary
  read_write grant with `started_at = approval time` in the same transaction.
- `requestSupportAccess` with read_write → 409 `SUPPORT_ACCESS_OWNER_APPROVAL_REQUIRED`, no row.
- Service `apps/api/src/services/platform-support.service.ts`: `requestSupportWriteAccess`,
  `listSupportAccessRequests`, `approveSupportAccessRequest`, `rejectSupportAccessRequest`,
  request expiry in `expireDueSupportAccessGrants` (worker sweep) and lazily on decide/new request.
  Locking: advisory lock per (tenant, super admin) first, then rows FOR UPDATE.
- Routes: platform POST `/api/platform/tenants/:tenantId/support-access-requests` (Super Admin + fresh MFA
  code, same chain as the grant POST); org GET `/api/org/support-access/requests`, POST
  `/api/org/support-access/requests/:requestId/approve|reject` (`requireTenantPermission("org.support_access.approve")`,
  refuse impersonated session, `getAccessSnapshot(req).mfaVerified` required, strict empty body); the service
  re-checks an active owner-template assignment in that tenant and self-approval.
- Audit (TEN-04): `support_access.requested|approved|rejected|request_expired` (+ `support_access.granted`
  on approval), Indonesian labels in `packages/shared/src/i18n/messages/audit-settings.ts`.
  Outbox event `support_access.requested` → notification to holders of `org.support_access.approve`
  (`apps/api/src/worker/notification-adapters.ts`).

- Added after internal review K (commit 788efa5f):
  - `support_access_grants.approval_request_id`, with a tenant-bound FK to the request and `CHECK (access_mode = 'read_only' OR approval_request_id IS NOT NULL) NOT VALID`. The database refuses an unapproved read_write grant even from an old API instance.
  - `support_access_requests.grant_id` has no FK, on purpose (only the reverse FK binds).
  - REVOKE DELETE/TRUNCATE on requests from legend_app.
  - Independence rule `hasIndependentOwnerStanding`: an approver's owner assignment must not be `assigned_by` the requester, and must not be `assigned_at` inside any grant window of the requester in that tenant. Error 403 `SUPPORT_APPROVER_NOT_INDEPENDENT`. This stops a read_write session from creating a second owner that approves later requests.
  - Approval re-checks that the requester is still a Super Admin (409 `SUPPORT_REQUESTER_NOT_ADMIN`).
  - The list endpoint has the same owner, 2FA and no-impersonation guards as decide.
  - Notifications go only to owner-template holders.

## Please check

1. Any path where read_write access (guard, impersonation, MCP, login challenges) works without an
   approved request, or after rejection/expiry.
2. Authorization of decide: non-owner with a custom role holding the permission, owner of another tenant
   (RLS + service), impersonated owner, owner without 2FA, Super Admin who is also owner (self approval,
   case of user ids), owner assignment ended/outlet-scoped.
3. Races: two owners deciding at once, approve vs sweep, approve vs new request, approve while an open
   grant exists; deadlocks between advisory lock and row locks.
4. Migration: CHECKs vs every service write, trigger allows exactly pending → decided once, backfill is
   idempotent under forced RLS, `db:generate` empty.
5. Window: grant starts at approval, ends approval + duration; approval exactly at the 24 h boundary.

## Invariants (PRD §3 F4 Support Access, TEN-04)

- Tenant data opens only through a time-boxed grant, read-only by default; read_write only after owner approval.
- Impersonated session ≤ 60 min and never valid after its grant ends.
- No MFA bypass through a grant or a request.
