// Kasbon limits the employee form checks before sending (bead legend-23nc).
//
// The contract's `loanPolicySchema` is tenant data. There is no employee-facing
// policy endpoint yet, so the form borrows the Cafe Legend demo policy from the
// payroll fixtures; the mock enforces the same object with the contract's
// `assertLoanWithinPolicy`, and the API remains authoritative for a real
// request. These checks are UX hints, never authorization.
import type { LoanPolicy } from "@starter/shared/hris/payroll";
import { cafeLegendPayrollFixtures } from "@starter/shared/hris/payroll";

export const DEMO_LOAN_POLICY: LoanPolicy =
  cafeLegendPayrollFixtures.loanPolicy;
