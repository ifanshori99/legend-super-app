# Sub-brief: station-aware query scope (legend-cot3)

Repo/worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/station-scope` (branch ws/station-scope, base integ/m1-batch5). Work ONLY here.

Goal: a user whose role assignment is scoped to a station (target type `station`) inside an outlet must NOT read/mutate
data of another station in the same outlet, nor outlet-level data outside their station, through service or route.
Deny by default. RLS only filters by `app.outlet_ids` (station assignment expands to outlet for RLS — TEN-03), so the
service layer must filter. Existing helper: `apps/api/src/services/station-access.ts`
(`assertStationPermission`, `permittedStationIds`), resolver `apps/api/src/services/permission-resolver.ts`
(`AccessSnapshot.allows`, `stationsFor`, `stationReachOf`), middleware `apps/api/src/middleware/permissions.ts`.
Existing tests: `apps/api/src/test/station-auth.test.ts`, `apps/api/src/middleware/permissions.test.ts`.

Out of scope (do not edit): app.ts, routes/index.ts, worker-main.ts, edge/runtime.ts, migrations, payment/refund/tax modules, UI.

## Explore areas (read-only; report file:line, concise)
- A. KDS: kds.service.ts, kds-support.ts, kds-realtime.ts, kds-realtime-auth.ts, routes/kds.routes.ts. For every exported
  service fn/route: does it take station id / return station-bound rows? Is assertStationPermission/permittedStationIds applied?
  List gaps (e.g. list without station filter, ticket by id without checking ticket's station, bump/recall, expo, station config CRUD, realtime subscribe).
- B. Menu/printer/device: menu.service.ts (station routing of items/categories), menu-print.service.ts, device.service.ts,
  device-*.ts, edge-device-sync*.ts, related routes. Same questions: station-bound reads/writes and whether filtered.
- C. Authorization semantics: permission-resolver.ts + middleware/permissions.ts + packages/shared/src/permissions.ts / access.
  How does a station-scoped assignment answer an OUTLET-target check (`allows(perm, {type:"outlet"})`)? Does requirePermission
  on outlet-level routes (orders, pos, qr-order, delivery-orders, reports, inventory) let a station-only user through?
  What do `stationReachOf`/`stationsFor` return for outlet/brand/tenant scopes? Brand empty/unknown handling (legend-cyu.8).
- D. Tests: station-auth.test.ts, permissions.test.ts — what is covered; fixtures/helpers to create tenant/outlet/station/user
  with station-scoped role; how route tests are built (app factory, auth header); how `LEGEND_TEST_FILES=... pnpm test` works.

## Round 2 findings so far (engineer)
- Only entry points that admit a station-only user: `requireStationScopePermission`, `requireStationPermission` (menu.routes.ts:171-176, kds.routes.ts:58-64), `kds-realtime-auth.ts` contextFor(station), `/api/me/access`. Outlet/tenant/menu/device guards deny station scope (scope.ts:196-203).
- `membershipContext`/`isOutletMember` (device-pin-support.ts:49-105) give a station user outlet RLS reach; used by staff-override (self-only rows) and platform-approval.service.ts:394,873,938,1024 (unchecked).

## Round 2 Explore areas
- E. Leakage inside admitted paths: (1) `allows()` uses surface "pos" (permission-resolver.ts:330) but `stationReachOf` uses surface "kds" (scope.ts:384) — what does `surface` change in authorize()? Can permittedStationIds and assertStationPermission disagree? (2) KDS payloads: do getKitchenTicketDetail, listStationTickets, readStationFeed, realtime messages include order lines/items routed to OTHER stations, or outlet-level order data (other tables, totals, payments)? (3) kds-realtime.ts recheck timer (~:322): does it re-assert station permission and drop revoked clients? (4) listStations response fields. file:line, <60 lines.
- F. Other entry points: (1) platform-approval.service.ts membershipContext usage: is the data self-only or outlet-wide? (2) any other code minting outlet RLS from a station assignment (grep stationReachOf, scope.type === "station", stations.outletId used to build contexts). (3) other realtime/websocket auth (qr-order-realtime, pos) — station users admitted? (4) device tokens bound to a station (devices.stationId): do KDS/printer device-token routes (edge sync, heartbeat, print agent) read other stations' data? (5) AI tools (services/ai-tools/**) reachable by station-only user? file:line, <60 lines.

## Wave 1 edits (implementers). Shared rules
- Worktree root above. Tests are integration (real app, Better Auth, PG, RLS). Copy local helper patterns from
  `apps/api/src/test/station-auth.test.ts:1-170` (asOwnerTenant, createStation, customRole, roleClient, tenantContext, cleanup in afterAll)
  and `apps/api/src/test/floor-test-helpers.ts` (`createIsolatedTenant`, `owner`). Do NOT edit station-auth.test.ts or any non-test file.
- Every denial test has a POSITIVE CONTROL first (same request/role shape that succeeds), so a 403 is not a broken fixture.
- Test names start with `legend-cot3`. Station denial message is "Anda hanya dapat mengakses stasiun yang ditugaskan." (403 PERMISSION_DENIED).
- Run only your file: `LEGEND_TEST_FILES="src/test/<file>" pnpm test` from worktree root (light; DB auto). Iterate until green. Report: test names, pass/fail output tail, any behaviour that looks like a real authz bug (do not "fix" product code — report it).
- Engineer adds `stationScopeCondition(column, stationIds)` + `stationScopeFilter(tx, ctx, actor, perm, column, now)` to services/station-access.ts in parallel; do not depend on them.

### W1-B  file `apps/api/src/test/station-scope.test.ts` (new)
1. Route matrix, same outlet: role with menu.item.view, menu.item.manage, menu.price.view, kds.ticket.process, device.registry.manage, order.view (check names in packages/shared/src/access/permissions.ts; use those that exist; allowedScopeTypes all four).
   User S = that role at station A (outlet A). User O = same role at outlet A.
   - S: GET menu stations lists exactly [A] (not B, same outlet); PATCH station A ok; PATCH/DELETE station B 403 and B unchanged (verify via owner SQL).
   - O: lists A and B; PATCH B ok (positive control).
   - Outlet-level routes deny S but allow O (positive control first): menu categories list, menu items list, device list (`GET /api/devices?outletId=`), menu print latest, and one POS/order list route if one exists. Find paths in routes/*.routes.ts + shared endpoints. Deny = 403 (or 404 where the route hides existence — assert the exact code you observe for S and that O gets 200).
2. Service level: `listStations(ctx, S.userId, {limit})` returns only A; `updateStation`/`deleteStation` on B reject PERMISSION_DENIED; on A resolves (positive). Use tenantContext() like station-auth.test.ts.
3. Deny by default: assignment with valid_until in the past, and a role lacking the permission → permittedStationIds [] and assertStationPermission rejects; positive control with an active assignment.

### W1-C  file `apps/api/src/test/station-scope-tenancy.test.ts` (new)
1. Tenant isolation: tenant B via `createIsolatedTenant` with its own station. Station-A user and outlet-A manager of the seeded tenant: assertStationPermission(tenantB station) rejects; PATCH /menu stations/<tenantB station> refused with the same status/body as an unknown random uuid; listStations never contains it. Positive control: own station ok. Also tenant B user cannot reach seeded tenant's station A (use tenant B Host header as floor-test-helpers/kds.test.ts do).
2. Brands: assignment at scope_type 'brand' (check role_assignments schema/allowed scope types; extend customRole allowedScopeTypes with "brand"):
   - real brand of fixtures → permittedStationIds includes stations of its outlets (positive).
   - a brand row that exists but has no outlets (insert in `brands` as owner; check schema apps/api/src/db/schema) → [] and assertStationPermission rejects, GET stations list empty / PATCH denied.
   - unknown brand uuid (no row) → same denial.
3. Pure consistency (no DB): import `authorize`, `stationReachOf`, `scopeCovers` from `@starter/shared/access` (check exports) and build a small OrgIndex (2 brands, one empty; 2 outlets; 3 stations). For scopes tenant/brand/emptyBrand/unknownBrand/outlet/station: stationReachOf(...) must equal the stations where authorize(...target station...) allows, and station scope must never allow an outlet or tenant target.

### W1-D  edit `apps/api/src/test/kds.test.ts` (append only, inside "KDS isolation and authorization" describe, reuse its helpers `kds`, `barista`, `placeOrder`, `ticketOn`, `ids`)
- legend-cot3: station-scoped barista: priority change and item actions (start/serve an item) on OWN station ticket succeed (positive), on kitchenA ticket 403 and DB unchanged (priority value, item status).
- legend-cot3: barista realtime: check existing test ~2191; add the cross-station case if missing (socket on kitchenA refused).
