# Sub-brief: union-permission sweep (legend-dak5). Do not commit this file.

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-scope, branch ws/ai-scope, head f8b6aa9d.

## Background

- `AccessSnapshot.permissions` (and any similar list or set) is the FLAT UNION over every scope: station, outlet, brand and tenant.
- A station grant also expands to its outlet for RLS (`app.outlet_ids`).
- Deciding access with `permissions.includes(x)` alone therefore lets a station-, outlet- or brand-scoped grant pass for data that is wider than its reach.
- Correct pattern: `access.allows(perm, target)`, `contextFor(perm, target)`, `assertOutletPermission`, `assertStationPermission`, `requireOutletPermission` or `requireTenantPermission`, with the target being the row's real scope.

## Known points

- `services/menu-internals.ts:142` `assertAnyPermission`, used at `menu.service.ts:1751` and `:1981`.
- `routes/hris-announcement.routes.ts:52`.
- Fixed earlier: `ai-governance.service.ts` `getUsageSummary`.

## Triaged earlier as safe (services/ and routes/ only)

- Prefilter followed by a scoped check:
  - `metrics.routes:56`, `support.ts:90`, `purchasing-supplier:227`, `hris.routes:86`, `hris-sop-gate:69`, `hris-leave.routes:107`, `tl-10:66`.
- Self-only: the `hris-*` self checks.
- AI entry gates `ai.ask` (accepted by design): `ai-governance.routes:33`, `mcp-server:134`, `mcp-oauth:171`.

## Sweep task (Explore)

Search ALL of `apps/api/src` (including middleware/, lib/, realtime, edge, jobs and workers; excluding test/) for every pattern that decides access from the flat union. Include:
- `permissions.includes`, `permissions.some`, `permissions.every`, `permissions.has`, `new Set(...permissions)`, `permissionSet`.
- Helpers such as `hasPermission(snapshot`, `hasAny`, `holds(`.
- Role-template permission lists checked without a target.
- `.permissions` read off a snapshot or `contextFor` result and then compared.

For each hit, give `file:line`, a class, and one line of reason. Classes:
- (a) prefilter, then a scoped check
- (b) self-only permission
- (c) LEAK: decides access to non-self data wider than the grant
- (d) not an access decision (UI listing, diff, logging)

For (a), name the scoped check that follows. Read the code around every (c) and every ambiguous hit. Do not assume.

Output: (c) hits first, with a concrete scenario (which scoped grant reads or writes what), then (a), (b) and (d). Be compact.

## Wave: fix points (implementers). Common rules

- Test FIRST, against the current code, and show that it FAILS. Then fix and show that it PASSES. Report both outputs in short.
- Run tests from the worktree root only:
  `LEGEND_TEST_FILES="src/test/<file>.test.ts ..." pnpm test`
  Never run from apps/api, because that runs the whole suite.
- Deny by default. Every denial gets a positive control first: the same call by a correctly scoped user succeeds.
- Do not touch: app.ts, routes/index.ts, worker-main.ts, edge/runtime.ts, migrations, UI, e2e/acceptance. Edit only the files of your point.
- Do not commit. Do not run tsc or lint (the parent does). Run prettier --write on the files you touched.
- Test helpers: see `apps/api/src/test/station-scope.test.ts` (customRole, roleClient, station assignment) and `floor-test-helpers.ts` `createIsolatedTenant`.
- Test titles start with "legend-dak5".

### P1 menu modifiers: services/menu-internals.ts `assertAnyPermission` (used by listModifierGroups and listModifiers in menu.service.ts)

- Leak: it passes on the flat union. A station-only `menu.item.view` grant reads every modifier group and modifier of the tenant at service level. The route gate `requireMenuPermission` already denies station-only callers, so the leak sits at the service boundary.
- Intended model: modifiers are tenant-shared, so a brand or outlet reader keeps reading them.
- Fix: require the permission at the tenant target, OR at some outlet of the tenant (`snapshot.allows(p, {type:"outlet", id})` over the tenant's outlets, the same style as `assertBrandReadPermission` above it). A station-only grant, or no grant, is denied with PERMISSION_DENIED.
- Tests in a new file `apps/api/src/test/menu-modifier-scope.test.ts`, at service level, calling `listModifierGroups` and `listModifiers` directly with a context such as the one the route would mint:
  - Station-only is denied.
  - Outlet-scoped and brand-scoped users are allowed.
  - Tenant-scoped is allowed.
  - A route check confirms station-only gets 403 and an outlet user gets 200.

### P2 suppliers: services/purchasing-supplier.service.ts `requireSupplierRead` (~:210-228)

- Leak: `reaches && snapshot.permissions.includes(p)`. A user who holds a supplier read permission ONLY at station scope, plus any other permission at an outlet (so the context has outlet reach), passes at service level.
- Fix: allowed only when some read permission `allows` at the tenant target, or at an outlet id in `context.outletScope.outletIds`. Deny by default.
- Tests in a new file `apps/api/src/test/purchasing-supplier-scope.test.ts`, at service level, calling `listSuppliers` (plus one detail read) with an outlet context:
  - A station-only supplier-read holder is denied.
  - The outlet-scoped holder is allowed.
  - A tenant holder is allowed.
  - A route check confirms the outlet holder gets 200 and the station-only holder gets 403.

### P3 announcement feed surface: routes/hris-announcement.routes.ts `feedSurface` (:49-56)

- Issue: the surface is picked by the flat `permissions.includes("hr.sop.manage")`. A user who holds `hr.sop.manage` ONLY at a station (no outlet reach, so `requireHrisLearning` and the service give them only the self view) is still routed through the back-office gate.
- Fix: pick back office only when `hr.sop.manage` has real reach:
  - `snapshot.contextFor(code, {type:"tenant"})`, or
  - `outletReachOf` is non-null, the same computation as `requireHrisLearning` in hris-sop-gate.ts.
  - You may add an exported helper in hris-sop-gate.ts.
- Before fixing, find out what the back-office surface does to such a user (`middleware/identity.ts`, `services/surface-access.service.ts`). Write a test that shows the wrong outcome, for example a 403 or MFA demand for an employee whose manage grant is station-only, while their self feed should work.
- If you prove there is no observable difference, report that and still make the fix with a unit-level test of the surface choice.
- Positive control: a real outlet manager still goes through back office, and gets the manager feed.
- Tests in a new file `apps/api/src/test/hris-announcement-scope.test.ts`.

## Review K (reviewer Opus + architect), diff `git diff f8b6aa9d 592cd7d2`

Read the "Background" section above.

What changed:
- P1 menu-internals `assertAnyPermission`: tenant target, or some outlet.
- P2 purchasing-supplier `requireSupplierRead`: tenant target, or an outlet in `context.outletScope`.
- P3 hris-announcement `feedSurface`: now uses the extracted `resolveHrisLearningContext`, a refactor of `requireHrisLearning`.

Check:
1. Is each fix correct, and does it deny by default?
   - Does any legitimate caller lose access? For example a brand-scoped reader, a tenant context with an outlet-only holder, or soft-deleted outlets.
   - Is the P3 refactor behaviour-preserving for `requireHrisLearning`?
2. Do the tests prove the leak? Look for vacuous assertions, and for controls that are missing.
3. Did the sweep miss any flat-union decision in `apps/api/src`? The sweep result is in the sections above.

Report real findings only, as `file:line`, severity and scenario. Under 400 words.
