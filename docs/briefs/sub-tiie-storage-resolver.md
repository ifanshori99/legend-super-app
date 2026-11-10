# Sub-brief: legend-tiie storage resolver (not committed)

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/support-storage-access (branch ws/support-storage-access). Do not commit, push, or touch other files.

## Goal
Give `apps/api/src/routes/core-storage.routes.ts` a real, server-verified `resolveRequest` built from tenant membership + outlet role assignments, so storage upload/read authorization is purpose-specific. Router stays UNMOUNTED in app/routes (no S3 provider or env keys exist yet; fail-closed). Export a factory so legend-7nv1 can mount it once a provider exists.

## Facts (already mapped)
- Router: `ResolveRequest = (req) => Promise<{ context: ScopedTenantContext; authorize }>` (routes/core-storage.routes.ts:22-25); handlers call `assertTrustedScopedContext`.
- `authorize(action: "upload"|"read", purpose, outletId, objectId?) => Promise<boolean>` (services/core-storage.ts:27-32). Service also checks outletId is in `context.outletScope`.
- Resolver building blocks: `middleware/permissions.ts` `loadRequestAccess(req)` (line ~74, cached snapshot), `snapshot.contextFor(permission, {type:"outlet", id})` (used by requireOutletPermission ~317), `getScopedTenantContext` (~108). Tenant from `middleware/tenant.ts`.
- Purposes: packages/shared/src/storage/index.ts:25-29 (menu_photo public; selfie, document, receipt private).
- Catalog: packages/shared/src/access/permissions.ts. No storage codes; do NOT add codes (that needs a migration backfill: out of scope).

## Permission map (use existing codes; any-of)
- menu_photo: upload `menu.item.manage`; read `menu.item.view`.
- selfie: upload `self.attendance.clock`; read `hr.attendance.manage` or `hr.attendance_correction.approve`.
- document: upload `hr.employee.manage`; read `hr.employee.view`.
- receipt: upload `purchasing.request.create`, `accounting.expense.request`, `accounting.cash_deposit.record`, `self.reimbursement.request`; read: the narrowest existing finance/purchasing review codes (check catalog, e.g. `purchasing.invoice.match`, expense approve code). State your choice in the report.
Keep the map as one exported const table so it is easy to review.

## Rules
- Authorization is decided per outlet: permission must cover `{type:"outlet", id: outletId}` (tenant-scope grants cover all outlets, as contextFor already handles). Unknown purpose/action: false. No session/tenant: let existing middleware 401/403; never default to allow.
- Context: a ScopedTenantContext whose outletScope contains only outlets the caller can reach for the requested purpose/action; if this cannot be known before body parse, pick the safe option and explain.
- Support (impersonated) sessions already pass through requireAuth guard; do not special-case.

## Files
- New: `apps/api/src/services/core-storage-access.ts` (or `middleware/storage-access.ts`): permission map + `createStorageRequestResolver()`; plus factory e.g. `createCoreStorageRouterWithAccess({database, storage, scanner})` if useful.
- Edit only the comment at routes/core-storage.routes.ts:28-29 if needed.
- New test: `apps/api/src/test/core-storage-access.test.ts` with real DB (follow patterns in test/core-storage-routes.test.ts and an outlet-permission API test). Fail-first: write tests first, run, show they fail, then implement. Cases: owner upload menu_photo allowed; user without menu.item.manage refused; outlet-scoped grant at outlet A refused at outlet B; selfie upload with self.attendance.clock allowed, selfie read without HR code refused; document read needs hr.employee.view; cross-tenant outlet refused.

## Run
`bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/support-storage-access" && pwd && LEGEND_TEST_FILES="src/test/core-storage-access.test.ts src/test/core-storage-routes.test.ts src/test/core-storage-service.test.ts" pnpm test'` (paths relative to apps/api, run from worktree root). Only run files you wrote/that cover storage. No tsc, no pnpm check.

## Report
Files, permission map chosen (receipt read especially), test fail-first output line and final pass counts, open questions.
