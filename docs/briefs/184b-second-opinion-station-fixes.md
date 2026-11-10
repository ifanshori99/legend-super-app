# Brief 184b: second opinion, station printer fixes and station gate union (legend-4xai, legend-cy2e)

Role: second-opinion (Codex). Tier K (authorization, data integrity). Effort high. Read-only: do not edit, commit or push.

## Where
- Repo: `/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/station-fixes`, branch `ws/station-fixes`.
- Diff range: `9a2c1e86..fb359f65` (commits 37b04e3a code+tests, fb359f65 migration 0148). Ignore `docs/PROGRESS.md`.
- Background: `bd show legend-4xai`, `bd show legend-cy2e`. These fix your earlier findings in `docs/briefs/159-second-opinion-station-printer.result.md` and `docs/briefs/152-second-opinion-station-scope.result.md`.

## Run (one pass, about 200 non-test lines)
Files:
- `apps/api/src/middleware/permissions.ts` `requireStationScopePermission`: now mints the union of the outlet/brand reach and the outlets of the stations a station grant reaches (was: station reach only when outlet reach was empty).
- `apps/api/src/services/device.service.ts` `revokeDevice`: clears `stations.printer_device_id` for the revoked device in the same transaction, after the device `FOR UPDATE`; emits a menu station event per cleared station and audits `clearedStationIds`.
- `apps/api/drizzle/0148_station_printer_binding_cleanup.sql`: one-off data migration clearing every binding that is not an active printer of the same tenant and outlet (lifts and restores FORCE RLS on stations and devices).
- `apps/api/src/services/menu.service.ts` `updateStation` / `toStation`, `packages/shared/src/menu/{schemas,endpoints}.ts`: station DTO carries `updatedAt`; the update body takes `expectedUpdatedAt`, required whenever `printerDeviceId` is sent (400 otherwise); a stale value answers 409 through an early check and a conditional `UPDATE ... WHERE date_trunc('milliseconds', updated_at) = expected`.
- Comment only: `ai-action-executors/access.ts`, `ai-gateway.service.ts`, `docs/plan/contracts.md`.
Tests (intent only, they do not count): `apps/api/src/test/station-printer.test.ts`, `station-printer-revoke.test.ts`, `station-printer-binding-cleanup.test.ts`, `station-scope-union.test.ts`.
Context: `apps/api/src/services/station-access.ts`, `kds.service.ts` (`assertTicketStationPermission`), `menu.service.ts` `permittedStationIds`, `packages/shared/src/access/scope.ts` (`outletReachOf`, `stationReachOf`).

## Invariants to try to break
1. After a printer is revoked, no station of any outlet keeps it as `printer_device_id`, including a station create/update racing the revoke (lock order device before station, no deadlock).
2. A printer change from a form loaded before a newer change never overwrites that change: it answers 409 and writes nothing. A printer change without `expectedUpdatedAt` is refused.
3. A caller with outlet A plus station B1 sees and acts on tickets and stations of outlet A and of B1, and never on B2 or any other station of outlet B, on every route that uses `requireStationScopePermission`. Every such route's service narrows by station; list them.
4. No route outside station-bound services gains outlet-wide reach from a station grant.
5. Tenant isolation on every query touched.

## Report
Findings with file:line, severity (High/Medium/Low), a concrete failing scenario and a suggested fix, or "no findings". Plain text, at most 600 words. Write it to `docs/briefs/184b-second-opinion-station-fixes.result.md` in the main checkout.
