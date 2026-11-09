// Payroll journal amounts: reduce a run's totals (`payrollRunTotalsSchema`) to
// the amount keys of the `payroll.locked` / `payroll.reversed` posting rules.
//
// Balance proof. Gross includes the PPh 21 refund paid as a PPH21_REFUND
// earning (rf), the service charge (SC) and reimbursements (RB); the net
// scheme's employer-borne tax (B) has no line and is not in gross. Debits:
//   (gross - rf - SC - RB)       salary_expense
//   + B                          pph21_borne_expense
//   + SC + RB + bpjsCo + R       service_charge, reimbursement_expense,
//                                bpjs_expense, employee_receivable
//   = gross - rf + bpjsCo + B + R
// Credits (erf goes to pph21_borne_expense, other to salary_expense): net +
// (bpjsEmp + bpjsCo) + pph21 + collected + loan + other + erf, where net = gross - (bpjsEmp + W + loan + collected + other) and
// pph21 = W + B + R - rf - erf. Substituting:
//   gross - bpjsEmp - W - loan - collected - other + bpjsEmp + bpjsCo
//   + W + B + R - rf - erf + collected + loan + other + erf
//   = gross + bpjsCo + B + R - rf
// which equals the debits. The totals schema guards both identities, so the
// journal balances for every parsed totals object.

import type { PayrollRunTotals } from "../hris/payroll/payslips.ts";
import { payrollRunTotalsSchema } from "../hris/payroll/payslips.ts";

export type PayrollJournalAmountKey =
  | "salaryExpenseIdr"
  | "pph21EmployerBorneIdr"
  | "pph21EmployerRefundIdr"
  | "otherDeductionsIdr"
  | "serviceChargeIdr"
  | "reimbursementIdr"
  | "bpjsCompanyIdr"
  | "bpjsTotalIdr"
  | "pph21ReceivableIdr"
  | "pph21ReceivableCollectedIdr"
  | "loanRepaymentIdr"
  | "netIdr"
  | "pph21Idr";

export function payrollJournalAmounts(
  totals: PayrollRunTotals,
): Record<PayrollJournalAmountKey, number> {
  // Parse first so the invariants hold even for a hand-built object.
  const t = payrollRunTotalsSchema.parse(totals);
  return {
    salaryExpenseIdr:
      t.grossIdr - t.pph21RefundIdr - t.serviceChargeIdr - t.reimbursementIdr,
    pph21EmployerBorneIdr: t.pph21EmployerBorneIdr,
    pph21EmployerRefundIdr: t.pph21EmployerRefundIdr,
    otherDeductionsIdr: t.otherDeductionsIdr,
    serviceChargeIdr: t.serviceChargeIdr,
    reimbursementIdr: t.reimbursementIdr,
    bpjsCompanyIdr: t.bpjsCompanyIdr,
    bpjsTotalIdr: t.bpjsEmployeeIdr + t.bpjsCompanyIdr,
    pph21ReceivableIdr: t.pph21ReceivableIdr,
    pph21ReceivableCollectedIdr: t.pph21ReceivableCollectedIdr,
    loanRepaymentIdr: t.loanRepaymentIdr,
    netIdr: t.netIdr,
    pph21Idr: t.pph21Idr,
  };
}
