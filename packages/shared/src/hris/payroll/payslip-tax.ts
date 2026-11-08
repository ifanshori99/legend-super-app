// Payslip PPh 21 step (beads legend-iwgb, legend-5cnk; PRD v1.7 §3 D.30).
// The one place a payslip's tax is computed, used by the payroll run (API)
// and by the FE mock payslip builder (fixtures.ts), so both agree to the
// rupiah. It maps payslip earnings to the PPh 21 engine (pph21.ts): taxable
// earnings carry their component's tax scheme, non-taxable earnings and the
// tax allowance itself never enter the base. The engine owns every rule.

import type { Idr } from "../../core/index.ts";
import type { PtkpStatus } from "../organization.ts";
import type { TaxScheme } from "./components.ts";
import type { PayslipTax } from "./payslips.ts";
import type { Pph21PolicyParameters } from "./pph21-policy.ts";
import { computePph21Period } from "./pph21.ts";
import type {
  Pph21PeriodInput,
  Pph21PeriodResult,
  Pph21Tables,
} from "./pph21.ts";

export type PayslipTaxEarning = {
  amountIdr: Idr | number;
  taxable: boolean;
  taxScheme: TaxScheme;
};

export type PayslipTaxInput = {
  tables: Pph21Tables;
  policy: Pph21PolicyParameters;
  ptkpStatus: PtkpStatus;
  hasTaxId: boolean;
  lastTaxPeriod: boolean;
  monthsWorked: number;
  partialYearTaxSubject?: boolean;
  /** Earnings of the period, without the tax allowance line. */
  earnings: readonly PayslipTaxEarning[];
  employerBenefitIdr: Idr | number;
  employeeDeductibleIdr: Idr | number;
  prior: Pph21PeriodInput["prior"];
};

export type PayslipTaxResult = {
  tax: PayslipTax;
  result: Pph21PeriodResult;
};

export function computePayslipTax(input: PayslipTaxInput): PayslipTaxResult {
  const result = computePph21Period(input.tables, input.policy, {
    ptkpStatus: input.ptkpStatus,
    hasTaxId: input.hasTaxId,
    lastTaxPeriod: input.lastTaxPeriod,
    monthsWorked: input.monthsWorked,
    partialYearTaxSubject: input.partialYearTaxSubject ?? false,
    taxableLines: input.earnings
      .filter((earning) => earning.taxable)
      .map((earning) => ({
        amountIdr: earning.amountIdr,
        taxScheme: earning.taxScheme,
      })),
    employerBenefitIdr: input.employerBenefitIdr,
    employeeDeductibleIdr: input.employeeDeductibleIdr,
    prior: input.prior,
  });
  return {
    result,
    tax: {
      ptkpStatus: input.ptkpStatus,
      method: result.method,
      terCategory: result.terCategory,
      terRateBp: result.terRateBp,
      taxableGrossIdr: result.taxableGrossIdr,
      pph21Idr: result.pph21Idr,
      pph21WithheldIdr: result.pph21WithheldIdr,
      taxAllowanceIdr: result.taxAllowanceIdr,
      pph21EmployerBorneIdr: result.pph21EmployerBorneIdr,
      pph21RefundIdr: result.pph21RefundIdr,
      pph21EmployerRefundIdr: result.pph21EmployerRefundIdr,
      noTaxIdSurchargeApplied: result.noTaxIdSurchargeApplied,
    },
  };
}
