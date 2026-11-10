# Brief 152: second-opinion — station-aware query scope (legend-cot3)

Tier K (authorization). Do not commit this file.

## Range

- Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/station-scope`, branch `ws/station-scope` (local, not pushed).
- Base `cc6f057e` (integ/m1-batch5) .. head `edab9370`. Review `git diff cc6f057e edab9370`.
- One run is enough: 71 non-test lines changed (well under the 800-line limit). Tests: about 1,275 lines in 3 files.

## Files

Risky, non-test:
- `apps/api/src/services/menu.service.ts`: `listStations`, `updateStation`, `deleteStation`.
- `apps/api/src/services/station-access.ts`: new `stationScopeCondition`.

Tests:
- `apps/api/src/test/station-scope.test.ts` (new)
- `apps/api/src/test/station-scope-tenancy.test.ts` (new)
- `apps/api/src/test/kds.test.ts` (one test appended, near "legend-cot3")

Context, unchanged but the design rests on it:
- `packages/shared/src/access/scope.ts`: `outletReachOf` station branch, `scopeCovers`, `stationReachOf`.
- `apps/api/src/middleware/permissions.ts`: `requireStationScopePermission`, `requireStationPermission`.
- `apps/api/src/services/kds.service.ts`: `resolveStations` around lines 423-495.

## Invariants to check

1. A station-scoped assignment never answers an outlet, brand or tenant target, and never contributes outlet-wide query reach.
2. Only `requireStationScopePermission`, `requireStationPermission` and KDS realtime admit a station-only grant. Every service behind them re-asserts the station of the row (`assertStationPermission`), or filters with `permittedStationIds` / `stationScopeCondition`.
3. Deny by default:
   - An empty station reach matches no row. `stationScopeCondition` returns `false`.
   - An unknown, soft-deleted or other-tenant station gets the same denial as an unknown id.
   - An empty brand or an unknown brand reaches no station.
   - An expired assignment, or a role without the permission, reaches nothing.
4. KDS routing (first live station of a type in the outlet, by name) is outlet configuration:
   - Renaming, retyping or deleting a station needs the outlet `menu.item.manage`.
   - A station-only grant may change only target time and printer binding.
   - An unchanged echo of name and type (compared after trimming) is never written, so it cannot undo a concurrent rename.
5. Outlet, brand and tenant grants keep reaching every station they contain.

## Questions for the second opinion

- Is there any other path where a station-only grant obtains outlet-wide rows? Candidates:
  - `device-pin-support.ts` `membershipContext` and its callers.
  - `platform-approval.service.ts:873/938/1024`.
  - `ai-gateway.service.ts:88` (`/api/ai/usage` reads tenant-wide when `ai.ask` is held at any scope).
  - `mcp-server.service.ts:134`.
- Can routing be steered from station scope through any write other than the `stations` table, for example item `stationId` or station overrides?
- Is comparing the name after trimming (`input.name.trim() !== existing.name.trim()`) safe? A whitespace-only rename by an outlet manager is now ignored.

Write your findings independently. This brief deliberately leaves out the Claude review findings.

## Run 2: AI usage and MCP scope (follow-up)

### Range

- Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-scope`.
- Branch: `ws/ai-scope` (local, not pushed), cut from `edab9370`.
- Base `edab9370` .. head `f8b6aa9d`. Review with `git diff edab9370 f8b6aa9d`. There are 2 commits: `d2c6e59c` and `f8b6aa9d`.
- Size: 7 non-test lines changed, so one run is enough. Tests add about 1,054 lines in 2 new files.

### Files

Risky, non-test:
- `apps/api/src/services/ai-governance.service.ts`: `getUsageSummary` and the condition behind `canSeeBudget`.

Tests:
- `apps/api/src/test/ai-usage-scope.test.ts` (new)
- `apps/api/src/test/mcp-scope.test.ts` (new): every MCP read tool, called as an outlet-A-only principal and as a station-only principal.

Context, unchanged, but the design rests on it:
- `apps/api/src/routes/ai-governance.routes.ts`: `requireAskPermission`, a flat `ai.ask` gate.
- `apps/api/src/services/ai-gateway.service.ts:88`: `gatewayContext` is tenant-wide, used for bookkeeping.
- `apps/api/src/services/mcp-server.service.ts:134` and `mcp-oauth.service.ts:171`: flat `ai.ask` gates.
- `apps/api/src/services/ai-tools/read-b/support.ts`: `tryResolveReach`.
- `apps/api/src/services/ai-metrics/scope.ts`: `resolveOutletScope`, `resolveTenantScope`, `toolMatches`.
- `apps/api/src/services/ai-action-executors/access.ts`: `holdsToolAccess`, `targetsOf`.
- `apps/api/src/services/ai-action-request.service.ts`: `proposeActionRequest`, `canSee`.

### Invariants to check

1. Tenant-wide AI spend and budget need `ai.governance.manage` at the tenant target. An outlet, brand or station grant never sees them.
2. The flat union `AccessSnapshot.permissions` never decides access to data that is not the user's own. It may only prefilter, before a scoped `allows`, `contextFor` or `tryResolveReach`.
3. The entry gates accept `ai.ask` at any scope. Every tool then resolves reach on its own, and denies by default:
   - An outlet-scoped MCP principal reads only its own outlets.
   - A station-scoped principal reads no outlet or tenant data.
   - A request with no outlet filter narrows to the caller's reach, not to the whole tenant.
4. `gatewayContext`, the tenant-wide context, is used only for the user's own count, quota and log. It is never used for business data.
5. AI write proposals check the tool permission and the domain permission at every outlet in the payload, through a single role.

### Questions for the second opinion

- Should the entry gates (`requireAskPermission`, MCP token issue, the MCP call gate) require `ai.ask` at a concrete target, rather than at any scope?
- Does any field of `/api/ai/usage`, other than the budget, aggregate beyond the caller?
- TL-05, 06, 08, 09 and 12 are blocked over MCP for roles that require MFA, and TL-05, 08 and 20 have no seeded rows. For these, the test checks only refusals. Does any of them resolve reach differently from the others?

Write your findings independently. This brief deliberately leaves out the Claude review findings.

## Run 3: flat permission union outside AI (legend-dak5)

### Range

- Same worktree and branch `ws/ai-scope`, on top of run 2.
- Base `f8b6aa9d` .. head `4538a6e4` (2 commits). Review `git diff f8b6aa9d 4538a6e4`.
- Size: 186 non-test lines changed, counting additions and deletions. Most of that is code moved inside hris-sop-gate.ts. That is under the 800-line limit, so one run is enough. Tests: about 800 lines in 3 new files.

### Files

Risky, non-test:
- `apps/api/src/services/menu-internals.ts`: `assertAnyPermission`, which gates the modifier group and modifier reads in `menu.service.ts` (`listModifierGroups`, `listModifiers`).
- `apps/api/src/services/purchasing-supplier.service.ts`: `requireSupplierRead`.
- `apps/api/src/routes/hris-sop-gate.ts`: `resolveHrisLearningContext`, extracted from `requireHrisLearning`.
- `apps/api/src/routes/hris-announcement.routes.ts`: `feedSurface` and `feedSurfaceOf`.

Tests:
- `apps/api/src/test/menu-modifier-scope.test.ts` (new)
- `apps/api/src/test/purchasing-supplier-scope.test.ts` (new)
- `apps/api/src/test/hris-announcement-scope.test.ts` (new)

Context, unchanged:
- `apps/api/src/middleware/permissions.ts`: `requireMenuPermission`, which is also the supplier read route gate.
- `packages/shared/src/access/scope.ts`: `outletReachOf`.
- `apps/api/src/services/hris-announcement.service.ts`: `listAnnouncements`, which uses `access.reach`.

### Invariants to check

1. `AccessSnapshot.permissions`, the flat union, never decides access to non-self data by itself. Every remaining use in `apps/api/src` is one of four kinds:
   - a prefilter followed by a scoped check,
   - a self-only permission,
   - a non-decision (listing, diff, cache key),
   - the `ai.ask` entry gate.
2. Tenant-shared reads (modifiers, suppliers) need the permission at the tenant, or at an outlet. A brand grant counts through its outlets. A station-only grant never counts.
3. The supplier read check is judged against the outlets of the request context, not against any outlet.
4. The HRIS surface choice and the HRIS context use the same reach computation. A station-only `hr.sop.manage` grant gives neither manager reach nor the back-office surface.
5. Deny by default throughout: no grant, an expired grant or an empty reach gets PERMISSION_DENIED.

### Questions for the second opinion

- Can a brand-scoped reader whose brand has no outlets yet read modifiers or suppliers? Today it is denied. Is that acceptable?
- With a tenant-wide context but an outlet-only grant, `requireSupplierRead` denies. Can any route mint that combination?
- Is the `requireHrisLearning` refactor behaviour-preserving, for example for the order of the codes, or for tenant-wide versus outlets?

Write your findings independently. This brief deliberately leaves out the Claude review findings.
