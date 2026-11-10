# Sub-brief: AI usage + MCP gate scope (follow-up of legend-cot3)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-scope` (branch ws/ai-scope, base edab9370). Work only here.
Question: can a user whose assignments are only outlet- or station-scoped read data outside their reach through
(1) `GET /api/ai/usage` (gate accepts `ai.ask` at any scope; reads with `gatewayContext` = tenant-wide, apps/api/src/services/ai-gateway.service.ts:88)
(2) the MCP gate at apps/api/src/services/mcp-server.service.ts:134.
Reference pattern: AccessSnapshot.allows / contextFor (services/permission-resolver.ts), station-access.ts, scope.ts (station scope never answers outlet/tenant).
Out of scope: app.ts, routes/index.ts, worker-main.ts, edge/runtime.ts, migrations, UI.

## Explore areas (read-only, file:line, <60 lines)
- G. AI usage: find route (grep "usage" in routes/ai*.routes.ts and shared ai endpoints), its middleware, the service fn. What rows/aggregates are returned (per user? per outlet? tenant totals, cost IDR, other users' questions?). Which permission/target is checked. Would an outlet-A or station user see outlet-B data or other users' usage? Is tenant-level usage meant to be an owner/finance view (check PRD/permissions catalog for ai usage permission like `ai.usage.view` / `ai.settings.manage`)? Existing tests covering usage (apps/api/src/test/ai-*.test.ts) and helpers.
- H. MCP: mcp-server.service.ts around :134 — what the gate checks (ai.ask? mcp enabled? token scope?), how MCP tool calls get their RLS context (ai-tools/types.ts:21 contextFor(permission, target)), what target each read tool passes (read-a, read-b), and whether an outlet/station-only principal can make a tool read tenant-wide or another outlet. How MCP auth principal is built (OAuth token → user → assignments?). Existing MCP tests and helpers.

## Findings so far
- /api/ai/usage: routes/ai-governance.routes.ts:99, gate requireAskPermission (:31-40, ai.ask any scope); service getUsageSummary ai-governance.service.ts:221 under gatewayContext. Returns tenant ai settings + caller's own daily count (readDailyCount filtered by userId, ai-gateway.service.ts:251); budget/usedIdr only with ai.governance.manage (:226,:231). Existing tests ai-governance-api.test.ts:289-310.
- MCP gate mcp-server.service.ts:~134: bearer checks then access.permissions.includes("ai.ask") (flat, any scope). Tools: read-b via tryResolveReach (ai-tools/read-b/support.ts:~68-120) probes tenant then each outlet. read-a and write tools unchecked. Tests: ai-mcp-acceptance.test.ts (~:357-382), mcp-oauth.test.ts.

## Wave 2 (implementers). Rules
- Same rules as legend-cot3 wave: positive control before every denial; names start `legend-cot3 ai`; do not edit product code — if a test proves a leak, leave it failing-as-`it.fails`? NO: write the assertion of the SECURE behaviour, let it fail, and report exact failure + file:line of the leak. Run only your file with `LEGEND_TEST_FILES="src/test/<file>" pnpm test` from worktree root.
- Principals: outlet-A only, station-only (station in outlet A), tenant-wide asker (positive), governance manager (positive). Use helpers from ai-mcp-acceptance.test.ts / ai-governance-api.test.ts / station-auth.test.ts patterns.

### W2-U file apps/api/src/test/ai-usage-scope.test.ts (new)
GET /api/ai/usage for outlet-A and station-only askers: 200, budget null, usedIdr 0 (or whatever non-manager shape is), daily count = own only (seed another user's usage rows in same tenant + another tenant's rows, assert not counted), no other users'/outlets' data in body. Manager positive control sees budget/usedIdr. A user with no ai.ask anywhere → 403. Tenant B data never visible.

### W2-M file apps/api/src/test/mcp-scope.test.ts (new)
MCP over HTTP like ai-mcp-acceptance.test.ts. For station-only and outlet-A-only principals holding ai.ask + the read permissions the tools need (at that scope): tools/list result; then call EVERY read tool in the catalog (enumerate from tools/list or the registry in services/ai-tools) with args targeting outlet B / tenant-wide / no outlet: must be refused or return only outlet-A rows (station-only: refused unless tool is station-aware). Positive control: tenant-wide principal gets data for outlet B on the same calls. Seed data in outlet B that would be visible if leaked.

### W2-A Explore (read-only): every handler in apps/api/src/services/ai-tools/{read-a,read-b,write}/**: what target/permission it passes to contextFor/allows/tryResolveReach, whether it filters by outletIds when the context is wider, any handler using gatewayContext/tenant context for business data. Report suspected leaks file:line.
