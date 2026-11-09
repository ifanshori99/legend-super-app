# Sub-brief WS-09 Wi-Fi hardening (after legend-hsk)

Worktree `.worktrees/ws09-wifi-2`, branch `ws/ws09-wifi-hardening` from `ws/ws09-wifi` (b9d7e40b).
Rules: same as `docs/briefs/sub-ws09-wifi.md` (targeted tests without heavy: `LEGEND_TEST_FILES="src/test/a.test.ts" pnpm test` from the worktree root; never the full suite; no commit; never pkill). Context: `docs/briefs/sub-ws09-wifi-plan.md`, `docs/briefs/sub-ws09-wifi-review1.md`.

## Shared design (fixed, code against it)

- New column on `wifi_device_grants`: `revoke_retry_at timestamptz NULL` (drizzle name `revokeRetryAt`). Non-null = the controller revoke of this reference still has to be (re)sent. Cleared (set NULL) when a revoke call succeeds.
- Trigger (legend-1mbi): on a terminal row (superseded, revoked, failed) every column is frozen EXCEPT `revoke_retry_at`. In particular `ended_at`, `end_reason`, `superseded_by`, `controller_device_id` (stays NULL), `authorized_at`, `expires_at` are frozen. Request columns stay immutable as today.
- Retention (legend-y2dg): terminal rows whose `ended_at` is older than `WIFI_GRANT_RETENTION_DAYS = 30` (exported constant) and whose `revoke_retry_at IS NULL` are deleted on the edge, in one statement that never breaks the `superseded_by` self-FK (skip a row still referenced by a row that is kept). The app role needs DELETE on the table under RLS (check the existing policies/grants; add what is missing in the migration).
- One migration `0101_wifi_device_grants_hardening.sql` (generated column + hand-written trigger/grant SQL appended, keep `edge-wifi.custom.sql` in sync) is owned by slice M only.

## Slices (disjoint files)

- M (legend-1mbi + schema): `apps/api/src/db/schema/edge-wifi.ts`, `apps/api/src/db/schema/edge-wifi.custom.sql`, `apps/api/drizzle/0101_*` + `meta/*`, `apps/api/src/test/edge-wifi-rls.test.ts`. Tests: frozen columns on terminal rows, `revoke_retry_at` may change, DELETE works only within tenant/outlet scope. `pnpm db:generate` empty afterwards.
- A (legend-nffy): `apps/api/src/services/edge-wifi-agent.service.ts`, `apps/api/src/test/edge-wifi-agent.test.ts`, `packages/shared/src/adapters/fakes.ts` (FakeWifiProvider: a reference revoked before it was seen never authorizes later), `tests/adapters-contract.test.mjs`. Late-landing grant or a failed revoke of a revoked row: set `revoke_retry_at`; reconcile step 1 retries rows with `revoke_retry_at <= now` (backoff), clears it on success.
- P (legend-y2dg): new `apps/api/src/services/edge-wifi-retention.service.ts` (`purgeExpiredWifiGrants(db, context, now)` returning the count), scheduling in `apps/api/src/edge/runtime.ts` (e.g. hourly while the Wi-Fi agent holds its lock), new `apps/api/src/test/edge-wifi-retention.test.ts` (age boundary, retry rows kept, FK-safe, cross-tenant/outlet untouched).
- T (empty walled-garden fallback test): new `apps/api/src/test/edge-wifi-garden-fallback.test.ts` only: after a restart with a failing garden build and no last good list, renewals still go out with `[]` and the fallback is never synced to the controller.
