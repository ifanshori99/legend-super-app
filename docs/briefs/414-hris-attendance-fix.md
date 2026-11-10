# 414 HRIS absensi fix (legend-whiwv) — shared brief
Worktree: .worktrees/fix-414 (branch fix/codex-414-hris-attendance). Run commands from there. Heavy cmds via `heavy <cmd>`; tests terarah via LEGEND_TEST_FILES. Do not commit (engineer commits).
Files: apps/api/src/services/hris-attendance.service.ts (S), hris-attendance-admin.service.ts (A), apps/api/src/worker/attendance-selfie-purge.job.ts (P), schema in packages/db (migration, temp number).

Findings:
1 (P1, S:~974) leave/izin checked without outlet scope: employee on leave at outlet A but home outlet/shift at B can clock in at B. Check leave against TARGET outlet before building scope.
2 (P1, S:~785) no atomic uniqueness per (employee, shift, attendance kind): two clock-in with different idempotency keys both recorded + emit events. Need DB-level unique (partial index) that accounts for corrections and rejections (rejected/corrected rows excluded).
3 (P2, A:~345) selfie URL signed without checking photo belongs to that log: validate sourceId + outlet first.
4 (P2, P:~167) 10,000 row cap counts not-yet-due photos and cursor resets to start: filter due per outlet in SQL or persist cursor.
5 (P2, S:~1001) retry re-picks outlet before idempotency-key lookup: look up original log with owner authorization first.
6 (P2, S:~1025) two identical concurrent retries: serialize per key (advisory lock/ON CONFLICT) or redo lookup when selfie validation fails.
Migration: temp number, merge train renumbers; check legacy duplicate rows first and write handling in report.
Tests: fail-first per finding (unit/integration incl. two parallel requests).

## Explore notes (admin + purge + schema)
- Finding 3: admin.service.ts:345 `signPhoto(context,row.photoKey,tx)` no ownership check; audit `photo_url_issued` at 346-359. Reference fix: hris-attendance.service.ts:386-406 (select core_storage_objects sourceId,outletId by tenantId+id=photoKey; foreign if sourceId null && outletId!==row.outletId, or sourceId set && !== ulidToUuid(row.id); foreign => null URL). Existing test: apps/api/src/test/hris-attendance-correction.test.ts ~1058.
- Finding 4: purge.job.ts:164-232, BATCH=200, MAX_BATCHES_PER_TENANT=50; SQL filter dueBefore=now-min(retention); exact per-outlet due check in JS (205-215); cursor local, resets each run. Tests: apps/api/src/test/hris-attendance-purge.test.ts.
- Run: from apps/api? `LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test` (verify cwd).
- Schema: apps/api/src/db/schema/hris-attendance.ts attendanceLogs :273 (type in/out/break_start/break_end, shiftAssignmentId, businessDate, validity valid/flagged/rejected, reviewStatus, correctionId, clientEventId unique per tenant). Partial unique idx example :147. Next migration temp 0242 in apps/api/drizzle (check _journal.json idx 241 last; when +1000000).

## Explore notes (service) — clockAttendance S:941-1061, storeAttendanceLog S:627-838
- Phase 1 (969-999) withTenant: loadHrisAccess, `access.snapshot.permissions.includes(HRIS_ATTENDANCE_CLOCK_CODE)` at 974 = ANY-scope check ("izin" = permission, not leave). Outlet picked at 997 `shift?.outletId ?? own.homeOutletId`. Fix finding 1: after outlet known, require `access.snapshot.allows(HRIS_ATTENDANCE_CLOCK_CODE, {type:"outlet", id: outletId})` (see hris-access.ts permissionsAt). Forbidden otherwise.
- Phase 2 (1001-1060): outletScoped ctx; findLogByClientEvent idempotency lookup 1006-1024 (employee+type reuse check); assertSelfieUsable 1025 (def ~852); storeAttendanceLog (insert ~785, onConflictDoNothing on (tenant, clientEventId) ~814, re-lookup ~820); event emit appendAttendanceLogged ~830 (skipped when rejected); linkClockSelfie 1058.
- Finding 5: outlet pick (997) precedes idempotency lookup (1006): a retry (after shift/outlet changed) re-picks outlet. Fix: look up original log by clientEventId first with owner (employee) authorization, return it regardless of current outlet pick.
- Finding 6: concurrent identical retries: twin consumed selfie => assertSelfieUsable throws at 1025; redo lookup then / serialize per key.
- Schema apps/api/src/db/schema/hris-attendance.ts attendanceLogs 273-377: unique (tenant,id),(tenant,client_event_id); no unique (employee, shift, type).
- Tests: apps/api/src/test/hris-attendance-clock.test.ts (Express createApp + helpers.ts + pg Pool STARTER_TEST_DATABASE_URL). Run: LEGEND_TEST_FILES="src/test/x.test.ts" pnpm test (from worktree root).

## Legacy duplicates (finding 2)
No migration and no unique index (see REVISION below), so there is no legacy-data risk: existing rows are untouched and the guard only looks at new submissions.

## REVISION after architect review (finding 2 redesign) — supersedes migration approach
Architect found P1: UI (apps/web/src/features/ws10-hris-employee/state.ts:83-100) re-offers `break_start` after break_end and `in` after `out` (re-entry), so a unique index per (employee, shift, type) blocks valid repeats (returns earlier log with 200 = lost data). Decision:
- DROP migration 0242 + meta/0242_snapshot.json + journal entry + the schema uniqueIndex (attendance_logs_active_shift_kind_key). No migration at all. Remove the "Legacy duplicates" section's migration text; keep a short note that no migration/ no legacy-data risk.
- Atomic duplicate guard instead: in storeAttendanceLog (online path only, `offline:false`; NOT edge/offline sync, so no offline log is merged away), inside the tx take `pg_xact advisory lock` on hash(tenant, employee, shift_assignment_id) BEFORE the check, then look up the immediate predecessor = latest live log (validity<>'rejected', correction_id null, method<>'manual_correction') of same employee+shift with occurred_at <= new occurredAt. If predecessor.type === new type (consecutive duplicate: in,in / out,out / break_start,break_start / break_end,break_end) => return the existing predecessor row (created=false, no event). Otherwise insert as now. Legit sequences in,break_start,break_end,break_start,break_end,out,in all still work.
- Duplicate response: loser of the race returns existing log, 200 (same as idempotent replay) is acceptable; keep.
- Tests: unique-414 file: keep parallel/sequential dupe tests; ADD: second break_start after break_end succeeds (new row), in after out succeeds, in,in via different keys dedupes, parallel 5 clock-ins different keys => 1 row + 1 event. Rejected/correction rows must not count as predecessor.
- Also fix nits: none else. Do not touch other findings.
