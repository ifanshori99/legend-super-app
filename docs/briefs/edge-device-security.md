# Brief: edge device security (legend-hbqj, legend-2lp.6)

Worktree: this one, branch ws/edge-device-security (from milestone/m1). Migrations: range 0480-0481 only; `pnpm db:generate` must be empty after. Do NOT touch emergency/panic alarm code.

## Card A: legend-hbqj (tier K, auth)
Today: edge box needs root `STAFF_PIN_PEPPER` so `staffPinPepper(tenantId)` (apps/api/src/services/device-pin-pepper.ts) derives the HKDF per-tenant pepper. Stolen edge box => all tenants' peppers derivable.
Goal: edge-only env (e.g. `STAFF_PIN_TENANT_PEPPER` = base64 of staffPinPepper(tenantId)) + validation in apps/api/src/config/env.ts + a mode in device-pin-pepper.ts that returns it ONLY for the edge's own tenant (other tenants: fail closed) + an operator export command (script) that prints the tenant pepper for provisioning (stdout only, never log it).
Rules: pepper never logged/returned by any API/log; PINs hashed with old derivation (root-derived) must still verify during rotation (safe rotation: verify with new tenant pepper, fall back to legacy derivation while root pepper available; edge without root pepper uses tenant pepper only). Edge consumers: apps/api/src/edge/{runtime,cloud-http,access-applier,staff-pin-resend,staff-pin-pepper-registry}.ts, services/staff-pin-sync.ts, payslip-pin.service.ts, device-pin.service.ts.

## Card B: legend-2lp.6 (tier S)
CRUD registry for printers (table edge_printers, apps/api/src/db/schema/edge-print.ts) under permission `device.registry.manage`: add/edit/list/get/(deactivate or delete) printers: network host:port or USB path, role, station, paper width, fallback printer. Link edge_printers.id to devices registry; stations.printer_device_id. Router + service + shared zod validator (packages/shared/src/validators/<x>.ts + subpath export + DTO in types/api.ts) + tests. Tenant/outlet filter in SQL; cross-tenant => 404/403; no permission => 403. Mount requireAuth, requireTrustedOrigin, requireOutletPermission/requireTenantPermission, jsonBody on POST/PATCH. Register in routes/index.ts. Model on routes/edge-wifi.routes.ts / edge-print.routes.ts and docs/backend.md.

## Evidence needed
fail-first targeted tests (LEGEND_TEST_FILES via heavy), eslint+prettier on changed files, typecheck once at end (heavy), db:generate empty.

## Update 14:50 — Card A (legend-hbqj) is OBSOLETE
Explore verified: legend-ideif + legend-jmsdx (merged in m1) already forbid root STAFF_PIN_PEPPER on an edge (config/env.ts refine ~L629, edge/runtime.ts ~L764), and the cloud delivers per-outlet v2 peppers over sync (edge/staff-pin-pepper-registry.ts, device-pin-pepper.ts staffPinPepper edge branch). Stronger than the card asked. No code for Card A. Do not implement.

## Card B contract (legend-2lp.6), decided by engineer
- CLOUD router `printerRouter` mounted at `/printers` in routes/index.ts (NOT under /edge: /edge is edge-only). Middleware like device.routes.ts: `backOffice` stack, `requireOutletPermission("device.registry.manage", ...)`, jsonBody on POST/PATCH.
  - GET    /printers?outletId=       list printers of the outlet
  - GET    /printers/:printerId      one (404 if other tenant/outlet or no permission, same as device.routes requireDevicePermission)
  - POST   /printers                 body {outletId,label,role,stationId?,transport,host?,port?,devicePath?,paperWidth?,fallbackPrinterId?} -> 201 DTO
  - PATCH  /printers/:printerId      body subset (no outletId/id/transport-less partials that break the DB check constraints)
  - DELETE /printers/:printerId      409 if still a fallback of another printer or has print jobs; else delete + revoke linked device
- Shared: strict zod endpoints + DTO in packages/shared (follow where enrollDeviceEndpoint / listOutletDevicesEndpoint live; add subpath export if new file). Validation mirrors the DB checks in db/schema/edge-print.ts (private LAN IPv4 only, port 9100-9102, /dev/(usb/lp|lp)N, paper 32|48, role receipt|station, stationId only for role station, not own fallback).
- Service `services/printer-registry.service.ts` (tenant context + withTenant; filter tenant AND outlet in SQL; stationId and fallbackPrinterId must belong to the same tenant+outlet else 422/404). Link to registry WITHOUT migration: create inserts a `devices` row (type 'printer', same id as edge_printers.id, label, stationId) in the same tx; delete revokes it; PATCH keeps label/stationId in sync. For role 'station' + stationId set `stations.printer_device_id` = printer id (clear on delete/unassign). Audit like device.service.ts does.
- No migration expected. If one proves necessary use 0480 (CHECK/FK) only.
- Tests: apps/api/src/test/printer-registry.test.ts (follow edge-sync-conflicts.test.ts / device tests for member/permission setup).
