# 6pha bundle 2 — HR approval by creator refused (CTO decision 2026-11-11)

Rule (PAYR-01, PRD: approver always differs from creator; doubt = restrict):
- approve_hr by run.createdBy -> PayrollError PAYROLL_APPROVER_NOT_DISTINCT (reducer, run.ts ~565)
- payrollRunSchema superRefine: approvedByHr === createdBy -> issue on "approvedByHr"; keep approvedByFinance===createdBy and HR===Finance issues
- lock guard: also refuse approvedByHr === createdBy (PAYROLL_RUN_NOT_APPROVED)
- Update header comments (run.ts top, endpoints.ts line ~10).

Fixtures (packages/shared/src/hris/payroll/fixtures.ts): runBase.createdBy (:1486) = new third user `runCreator` = userId(1001) (exists in packages/shared/src/hris/fixtures.ts:2069), exported as cafeLegendPayrollFixtures.userIds.runCreator (userIds object ~:1727). October (paid) and November (simulated) runs then have creator != HR != Finance.

Web mock (apps/web/src/features/ws10-payroll-run/mock.ts): approve_final pre-check :526-532 returns 409 but error table says PAYROLL_APPROVER_NOT_DISTINCT = 403 -> remove the 409 pre-check so reducer's PayrollError (403) surfaces (verify the mock maps PayrollError via payrollErrorHttpStatus); add same for approve_hr falling through to reducer. Check currentActor() (:276-281) and run creation (who is createdBy in mock) so the mock flow still works; check e2e/legend-zn4g.mock.spec.ts (:94-110 expects message/status) and keep it green or report exactly what breaks.

Tests: apps/api/src/test/payroll-run-approver-distinct.test.ts — flip "still lets the creator give HR approval" to refusal; rebase setups on userIds.runCreator as creator; add schema + lock cases for HR===creator.
