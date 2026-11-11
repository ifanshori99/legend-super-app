# Brief 504: server-side leave flag filter (3jem1)

Bug (Codex 501 P2): web `fetchLeaveReviewItems` (apps/web/src/features/hr-leave-clockin-review/api.ts) reads max 5 pages x 100 of the review queue then filters `leave_approved` on the client (`isLeaveClockinItem`, enrich.ts:27). Leave cases past row 500 vanish.

Decision (CTO): filter in server + web paginates until nextCursor is null.

## Contract (DONE by engineer, do not touch)
packages/shared/src/hris/endpoints.ts `listAttendanceReviewQueue.query` gets `flagReason: attendanceStoredFlagReasonSchema.optional()`.

## API (apps/api/src/services/hris-attendance-admin.service.ts, listAttendanceReviewQueue ~:450)
- If `query.flagReason` set: push SQL filter `attendanceLogs.flagReasons @> '["<reason>"]'::jsonb` (parameterized, use sql template + JSON.stringify([reason])) next to the businessDate filter (~:515). Applies to every reviewStatus branch (pending and accepted/rejected).
- Outlet scope/permission checks unchanged (forbidden for out-of-reach outletId; reach filter stays).
- Cursor keyset unchanged. Route needs no change if it parses the contract query (verify `hris-attendance-admin.routes.ts:160-174` passes the whole parsed query).
- Mock: apps/web/src/features/hr-leave-clockin-review/mock.ts:206 must honor `flagReason`.

## Web (apps/web/src/features/hr-leave-clockin-review/api.ts)
- `fetchLeaveReviewItems`: send `flagReason: "leave_approved"` in query; read ALL pages until `nextCursor === null` for this queue read (no 5-page cap; use a dedicated loop, keep `readPages` MAX_PAGES for employees/leaves/logs). Safety guard against a non-advancing cursor (same cursor twice -> stop) is fine. Keep the client `isLeaveClockinItem` filter as defense (cheap).
- Callers queries.ts:36-37 and :57-60 keep working (detail scan benefits too).

## Tests (fail-first, targeted, no e2e)
- API (apps/api/src/test/, real DB, see hris-attendance-leave-flag.test.ts + hris-attendance-correction.test.ts helpers): seed > page-limit non-leave flagged logs NEWER than a few leave_approved logs; query with `flagReason: "leave_approved"` returns only leave logs, across cursor pages, none lost; without the filter behavior unchanged; out-of-reach outletId still forbidden; filter works for reviewStatus accepted/rejected too.
- Web: vitest for `fetchLeaveReviewItems` mocking `callEndpoint` (apps/web has no test yet: find the vitest config/include pattern first and place the test where it is picked up): sends flagReason, follows cursors past 5 pages (e.g. 7 pages), stops at nextCursor null, stops on repeated cursor.
Fail-first: run each new test BEFORE the implementation and capture failing output for the right reason (not setup/422).

## Gates (via `heavy`, ONE heavy runner at a time)
tsc api (heap 6144) + tsc web, `pnpm exec eslint <changed>`, `pnpm exec prettier --check <changed>`, targeted tests with LEGEND_TEST_FILES / `heavy vitest run <path>`.
