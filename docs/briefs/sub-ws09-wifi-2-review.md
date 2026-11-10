# Sub-brief WS-09 Wi-Fi hardening, review 1 fixes

Worktree `.worktrees/ws09-wifi-2`, branch `ws/ws09-wifi-hardening`. Rules as `docs/briefs/sub-ws09-wifi-2.md` (targeted tests only via `LEGEND_TEST_FILES=... pnpm test`, no heavy for tests, no commit, never pkill).

## R1 (P2) timed-out authorize lands after revoke, no retry

`apps/api/src/services/edge-wifi-agent.service.ts` ~402-411 (`unknown` path) and `revokeRow` ~516-526.
A `ProviderTimeout` authorize leaves the row `unknown`; `revokeRow` then succeeds (controller had nothing yet) and sets `revoked` with `revoke_retry_at` NULL; the authorize lands later and the device stays online up to `duration_seconds`.
Fix: when `revokeRow` succeeds on a row whose authorize outcome is unsure (status `unknown`, or `pending` with an authorize possibly still running), set `revoke_retry_at = at + REVOKE_RETRY_MIN_SECONDS` in the same UPDATE, so one delayed confirming revoke goes out (step 1b clears it on success). Do not set it for rows whose authorize is known applied/known failed.
Test in `apps/api/src/test/edge-wifi-agent.test.ts`: authorize times out, revoke happens, the late authorize lands at the fake controller, after backoff reconcile revokes it again and clears the marker.

## R2 (P3) marker on a live row

- Step 1b query (~888): add `inArray(wifiDeviceGrants.status, [terminal statuses])`.
- Add CHECK `revoke_retry_at IS NULL OR status IN ('superseded','revoked','failed')` via drizzle `check()` in `apps/api/src/db/schema/edge-wifi.ts` (follow existing check style there), then `pnpm db:generate` produces a new 0102 migration. Do NOT edit 0101. Afterwards `pnpm db:generate` again must be empty. Check whether 0102 needs the FORCE RLS bracket (no FK, so normally not).
- Test in `apps/api/src/test/edge-wifi-rls.test.ts`: setting `revoke_retry_at` on an `active` row fails with a check violation.

## Done when

`LEGEND_TEST_FILES="src/test/edge-wifi-agent.test.ts src/test/edge-wifi-rls.test.ts src/test/edge-wifi-runtime.test.ts src/test/edge-wifi-retention.test.ts" pnpm test` green, prettier + eslint clean on touched files. Report: files changed, test counts, migration filename.
