# Sub-brief: legend-e087 + legend-qqvf. Do not commit this file.

Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/station-printer, branch ws/station-printer, base integ/m1-batch7 (6f3063c7).

## Common rules

- Write the test FIRST and show that it FAILS on the current code. Then fix, and show that it PASSES. Report both, in short.
- Run tests from the worktree root only: `LEGEND_TEST_FILES="src/test/<file>.test.ts ..." pnpm test`. Never run from apps/api.
- Deny by default. Every denial gets a positive control first.
- Do not touch: app.ts, routes/index.ts, worker-main.ts, edge/runtime.ts, migrations, UI, e2e/acceptance. Edit only the files of your task.
- Do not commit. Do not run tsc or lint. Run `pnpm exec prettier --write` on the files you touched.
- Helpers: `apps/api/src/test/station-scope.test.ts` (customRole, roleClient, station assignment), `floor-test-helpers.ts` `createIsolatedTenant`.

## E087: station printerDeviceId must be a printer of the station's outlet

Files:
- `apps/api/src/services/menu.service.ts`: `createStation` (~:570-600) and `updateStation` (~:630-690).
- New test file: `apps/api/src/test/station-printer.test.ts`.

Background:
- `stations.printer_device_id` is a plain UUID, with no FK.
- The device registry `devices` (`apps/api/src/db/schema/device.ts`) has `tenant_id`, `outlet_id`, `type` (it includes `'printer'`), `status` ('active' | 'revoked') and `revoked_at`.
- Today any UUID is accepted, including another outlet's or another tenant's device.

Rule, when `printerDeviceId` is non-null and is being set or changed:
- A row in `devices` must exist with the same tenant, `outlet_id` equal to the station's outlet, `type = 'printer'`, `status = 'active'`, and `revoked_at` null.
- Otherwise reject. Unknown id, another outlet, another tenant, a non-printer and a revoked device all get ONE identical error, so it is not an existence oracle.
- Pick the error the menu service already uses for invalid references (look for notFound or validation errors in menu.service.ts) and keep it consistent.
- `null` (unbind) is always allowed, subject to the existing permission rules.

Echo rule:
- In `updateStation`, an unchanged `printerDeviceId` (same value as stored) is NOT re-validated.
- So a station whose printer was revoked later can still save its target time. The same echo pattern exists for name and type (legend-cot3).

Station-scoped callers keep the right to set the printer binding. Only the device validity is new.

Tests:
- Positive: an active printer of the same outlet is accepted, on both create and update.
- Denials, all with the same error: another outlet's printer, another tenant's printer, a non-printer device of the same outlet (for example 'kds'), a revoked printer, and a random UUID.
- Echo: revoke the bound printer, then update the target time with the same `printerDeviceId` and expect success.
- `null` unbinds.
- Seed devices with a direct insert. Check `device.ts` and the device tests for the required columns.

## QQVF: a foreign-station ticket must answer like an unknown ticket

Files:
- `apps/api/src/services/kds.service.ts`: the ticket-by-id paths that do `readTicket` and then `assertStationPermission`, around :751, :975, :1053, :1247, :1276 and :1341.
- Tests: `apps/api/src/test/kds.test.ts`, plus `station-scope.test.ts` and `station-scope-tenancy.test.ts` if they assert 403 for another station's ticket.

Problem:
- A station-scoped cook gets 403 for another station's ticket in the same outlet, but 404 for an id that does not exist. That difference tells the cook which ticket ids exist, an existence oracle.

Fix:
- On these by-id paths, when the station assertion fails, throw exactly the same error, with the same code, message and HTTP status, that `readTicket` throws for an unknown ticket.
- Keep checking the permission before taking any locks.
- Do not change list endpoints. Do not change the realtime subscription auth (`kds-realtime-auth.ts`), which is per station and not by id.
- Callers with no KDS permission at all are still refused at the route gate, as today.

Tests:
- Update the existing 403 assertions for a foreign-station ticket to the unknown-ticket response. This is a deliberate contract change.
- Add one test that compares the body of the foreign-station response with the unknown-id response, ignoring requestId. They must be identical.
- Cover both detail and action (start or bump).
- Positive control: the cook's own station ticket still works.

Report:
- Every 403 assertion you changed, as file:line.
- Any e2e or acceptance test or web code that expects 403 here. List it, do not edit it.

## Review (reviewer Opus + architect): `git diff 6f3063c7 91db56eb`

Commits:
- `8663be44` E087: `menu.service.ts` `assertStationPrinter`, plus `station-printer.test.ts`.
- `91db56eb` QQVF: `kds.service.ts` `assertTicketStationPermission`, plus kds.test.ts and az-d-kds.test.ts, which change from 403 to 404.

Check:
1. E087. Can a station-scoped or outlet user still bind a printer of another outlet or tenant? Look at:
   - RLS and the explicit filters.
   - Case of the UUID.
   - The echo bypass. For example: a printer that was never valid, stored before this fix, then echoed. Is that acceptable?
   - A race where the printer is revoked between the check and the write.
   Is 422 consistent with the other invalid references in menu.service?
2. QQVF. Are all by-id ticket and item paths covered (search kds.service.ts and kds-realtime for other by-id reads)? Do the foreign and unknown responses match on status, code, message and timing-relevant locks? Does a caller with no KDS permission still get 403 from the route gate? Does any non-PERMISSION_DENIED error leak?
3. Tests: look for vacuous assertions, and check that positive controls are present.

Report real findings only, as file:line, severity, and scenario. Under 400 words. Keep your turns tight, and report before you hit the turn limit.

## Fix wave (review findings), implementer. Same common rules. Edit only menu.service.ts and station-printer.test.ts.

R1, Medium. `menu.service.ts` `updateStation`: an unchanged `printerDeviceId` skips validation, but it is still written.
- Race: a cook's stale echo of a revoked printer P_old waits on the row lock, then overwrites a manager's concurrent change to P_new.
- Fix: add a `printerChanged` flag. It is true when `input.printerDeviceId !== undefined` and the value differs from the stored one, comparing case-insensitively, with null counting as a value.
- Validate only when it is changed and non-null. Write `printerDeviceId` only when it is changed. This is the same pattern as nameChanged and typeChanged.

R2, Low. In `assertStationPrinter`, take the device row `FOR SHARE` (drizzle `.for("share")`). A concurrent revoke then cannot slip between the check and the write.

R3, tests in `station-printer.test.ts`:
- A station-scoped caller, who holds the permission that `updateStation` uses for the printer binding at a station, can set a valid printer of its own outlet. The same caller is refused another outlet's printer, with the same 422.
- An echo of a revoked stored printer writes nothing: the row stays unchanged. Prove it with updated_at, or with a concurrent change simulated as follows. Change the row directly in the DB to P_new, then send the echo of P_old through the service with a stale value. The row must remain P_new.
- Make cleanup robust. A station created by mistake inside a should-be-refused test must also be deleted, for example by cleaning up by outlet in afterAll.

Prove: the R1 test fails on the current code, then passes.
Run: `LEGEND_TEST_FILES="src/test/station-printer.test.ts src/test/station-scope.test.ts src/test/kds.test.ts" pnpm test`.
