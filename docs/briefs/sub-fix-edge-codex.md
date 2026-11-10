# Sub-brief: fix edge Codex 108 (legend-ddoy, legend-12ku, legend-aor4)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/fix-edge-codex`, branch `ws/fix-edge-codex`. Tier K (auth + stock/GL). Do not commit; the engineer commits.

## Rules for every slice

- Test first: write the test, run it, and record that it FAILS on current code (paste the failing assertion line). Then fix, rerun, record that it passes.
- Run only your own test file: `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` from the worktree root (path relative to `apps/api`). Never the full suite. Never `pkill`/`killall`.
- Edit only the files listed for your slice. Keep existing comments. Comments explain why, referencing the bead id.
- Report: files changed, fail-before line, pass-after summary, anything uncertain.

## Slice A — legend-ddoy (P1): atomic stock-source owner claim

Files: `apps/api/src/services/inventory.service.ts` (function `recordReplicatedStockMovementInTransaction` ~1211, helper `sourcePostedByOtherOutlet` ~1152), new test `apps/api/src/test/inventory-edge-source-race.test.ts`.
Bug: two outlets' edge nodes post the same `(tenant_id, source_type, source_id)` concurrently with different locations. Location advisory locks differ, and `sourcePostedByOtherOutlet` reads committed rows only in its own tx, so both pass; later `inventory-gl-consumer.ts:412` fails 'Stock source spans more than one outlet'.
Fix: inside `tx`, before the `sourcePostedByOtherOutlet` check, take `pg_advisory_xact_lock(hashtextextended(<key>, 0))` with a key built like `inventoryLocationLockKey` (see ~227) but for `stock-source:${tenantId}:${sourceType}:${sourceIdToDb(sourceId)}` (lowercase ids). The lock holds until commit, so the second outlet waits, then its separate read sees the committed rows and gets 409 CONFLICT. Keep lock order deterministic (location lock, then source lock) and note deadlock reasoning in a comment. Update the doc comment of `sourcePostedByOtherOutlet` (it currently says concurrency is not caught).
Test: real PG. Two outlets, two locations, same source; run both `recordReplicatedStockMovementInTransaction` calls concurrently in separate transactions (use the fixtures/setup style of `src/test/inventory.test.ts`; force overlap, e.g. a barrier or hold tx1 open after its insert with `pg_sleep`/a deferred promise before commit). Expect exactly one success and one 409, and ledger rows for the source on one outlet only. Also: same outlet replay still idempotent.

## Slice B — legend-12ku (P2): reserve failed-auth slot before await

Files: `apps/api/src/edge/link-server.ts` (~285-335), `apps/api/src/lib/fixed-window-counter.ts`, test in `apps/api/src/test/edge-link-hardening-2.test.ts` (lockout describe ~640, helpers `start()`/`attempt()`).
Bug: line 309 `failures.peek` checks, `failures.take` runs only after `await deps.authenticate`, so with limit 10 twenty parallel bad auths all reach authenticate before any 429.
Fix: add `reserve(key, now)` to the counter: increments like `take` and returns `{ retryAfter: number | null; release(): void }`; `release` undoes that one count only if the same window object is still current (identity check) and only once. In link-server, for an unknown credential reserve the failure slot before the await; on success (and on the 503 catch path) release it; on failure keep it (no second take). Known credentials keep skipping the lockout; their failure still counts via `take` as today. Over-limit reserve answers 429 with retry-after + no-store as today. Keep `peek` if still used elsewhere.
Test: limit 10 (or `authFailureLimit` override), fire 20 parallel bad-credential upgrades from one address with an `authenticate` that awaits a shared deferred promise; assert `authenticate` called at most limit times and the rest got 429. Plus: a good credential after successful auth does not consume a slot. Add a small unit test for `reserve/release` in the same file or an existing counter test if one exists (grep first).

## Slice C — legend-aor4 (P2): limiter on edge bootstrap before credential check

Files: `apps/api/src/routes/edge-bootstrap.routes.ts`, `apps/api/src/routes/index.ts` only if the router must become a factory, test `apps/api/src/test/edge-bootstrap.test.ts` (or a new `edge-bootstrap-rate-limit.test.ts`).
Bug: GET `/` (line 24-27) calls `verifyEdgeCredential` (DB reads) for every request; a well-formed `edg1` token with random secret floods tenant/node queries with no 429.
Fix: copy the pattern of `routes/staff-pin-sync.routes.ts:68` `staffPinSyncRateLimit` / `createStaffPinSyncRouter` (~117): per IP (`ip:${req.ip}`) and per sha256 of the bearer, `createFixedWindowCounter`, before `verifyEdgeCredential`; 429 `HttpError(429, "RATE_LIMITED", PUBLIC_RATE_LIMIT_MESSAGE)` with `Retry-After` and `Cache-Control: no-store`. Injectable limits/windowMs/now for tests; keep the default export/mount working. Pick limits that a real node bootstrapping never hits (bootstrap is rare); name them as constants with a why comment.
Test: flood with a well-formed fake `edg1` credential (random secret); assert 429 after the limit and that the verifier is not called past the limit (spy via `setEdgeCredentialVerifier` wrapper). A valid node from another IP still bootstraps.

## Round 2 fixes (review + architect)

### A2 — legend-ddoy (same files as Slice A)

1. In `recordReplicatedStockMovementInTransaction`, take `lockStockSource` BEFORE `lockInventoryLocations` (source then location). This removes the single-document cycle (primary + standby of one outlet posting one document over two locations in one batch).
2. Rewrite the `lockStockSource` comment: order is source then location; `db-link-store` applies a batch in one tx, so two batches touching two sources in opposite order can still deadlock; PostgreSQL aborts one (40P01), which is not a domain refusal, so the batch rolls back and is resent, and the retry gets 409. No "cannot form a cycle" claim.
3. Source document outlet check: in the tenant-wide tx of `sourcePostedByOtherOutlet` (rename if clearer), also look up the source document by id in its own table, chosen by `sourceType` (check `EDGE_STOCK_SOURCE_TYPES` and map each to its table: orders, waste logs, stock counts, stock transfers, production orders — verify names in `db/schema`). Found with another `outletId` → true (409). Not found → pass (edge documents never reach the cloud).
4. Test determinism: replace `sleep`-based overlap. Wait until A holds the source lock (poll `pg_locks` for granted advisory lock, or a signal from inside A's tx), start B, then poll `pg_locks` until B has an UNGRANTED advisory lock, assert that, then release A. Add test: cloud waste-log (or the type you mapped) row for outlet A, no ledger rows; edge B posts with that id → 409. Record fail-before for the new test (on the code without step 3) and pass-after.

### B2 — legend-12ku (same files as Slice B)

A reserve that answers 429 must not keep its count: call `slot.release()` before the 429 refusal, so only real failures and in-flight attempts count (a venue NAT reconnect burst after a cloud restart must not lock the IP out for the window). Update the unit test that asserts "one over, still counted" and add a link-server test: burst of 12 good credentials behind one address with limit 10 → after they finish, a new credential from that address is not locked out.
