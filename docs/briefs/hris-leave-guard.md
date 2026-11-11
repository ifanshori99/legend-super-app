# Brief: HRIS leave guard + attendance self endpoints (WS-D)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/hris-leave-guard`, branch `ws/hris-leave-guard` (from `ws/5nt2z-leave-partial`). API app: `apps/api`. Services in `apps/api/src/services/hris-leave-*.ts`, routes in `apps/api/src/routes/hris*.routes.ts`, tests in `apps/api/src/test/`, migrations in `apps/api/drizzle` (this branch: 0276-0278; leave flag fn = `0277_flag_attendance_for_leave.sql` and `0278_leave_clash_backfill.sql`; brief wrote 0258/0320 from other numbering). New migration: temp number 0320, journal `when` unique and higher than 1794331000002.

## Cards

- legend-0c5yg (P1, money: payroll). Leave (incl. backdated) must not change payroll of an already closed period. Rule (CTO, limits payout): leave falling in a closed payroll period is rejected 409 unless via the recorded next-period adjustment path; if that path does not exist: just reject. Fix guard in `hris-leave-request.service.ts` (~1240-1420) and the SQL flag function (0277/0278). Tests prove no double pay and no double deduction.
- legend-qmte (P2). Collective leave (cuti bersama) must not deduct employees who still worked (clock-in that date). Touches the same service as 0c5yg: do after 0c5yg.
- legend-j06v (P2). `GET /api/hris/me` already exists (hris.routes.ts ~164, test hris-api.test.ts ~254). Missing: attendance policy read (tenant AttendancePolicy: geofence radius, selfie/QR/device flags).
- legend-5nv1 (P2). Self-scoped lists (logs, corrections, shifts) for employees with only `self.*` permissions: filter in SQL by user, not by client-supplied employeeId. Selfie upload endpoint overlaps legend-bf20 (check what exists: hubzo selfie worker, C6 cloud selfie receive); do not duplicate, report.

## Rules

- Tests: vitest in `apps/api/src/test`, run only via `heavy` (targeted: `LEGEND_TEST_FILES=<file> heavy pnpm test`). ONE subagent at a time runs tests. Test-writers write tests but do not run them; the engineer runs fail-first.
- Lint gate: `pnpm exec eslint <files>` + `pnpm exec prettier --check <files>`.
- Money: no party paid more, no outlet loss; doubt = restrict payment.

## 0c5yg implementation spec (engineer decision)

- Extract `assertPayrollOpen`/`isPayrollClosed` (hris-attendance-correction.service.ts:224-281, 409 `PAYROLL_PERIOD_LOCKED`, closed = payroll_runs.status locked/paid/reversed or locked_at set, period overlaps date, filter by employee legalEntityId, no entity = all tenant runs) into a shared exported helper (e.g. `services/hris-payroll-lock.ts`); correction service imports it (behavior unchanged).
- Leave service guard: call it for every leave date range (start..end inclusive; whole leave refused if any day is inside a closed run) in createLeaveRequest (:701), decideLeaveRequest approve (:1033), cancelLeaveRequest (:1109) when approved leave, cancelApprovedLeaveOnDateByHr (:1255-1420: whole leave range, not only the log day), and before settle/applyOutcome balance moves that change pay if applicable. Guard runs before any write, inside the same tx/lock, so a refusal changes nothing. No adjustment path exists: reject only.
- Migration `0320_leave_flag_closed_payroll.sql` (CREATE OR REPLACE app.flag_attendance_for_leave from 0278, additionally skipping logs whose business_date lies in a closed payroll_runs period of the employee's legal entity; returned set = only logs actually flagged). Journal entry idx 320, `when` > 1794331000002 unique. Update test expectation ~hris-leave-clash-backfill.test.ts:900 (valid log in locked run must NOT be flagged).
- Money proof: tests in hris-leave-payroll-closed.test.ts must pass; no double pay/deduction.
