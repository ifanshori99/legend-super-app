// Payslip PPh 21 step (beads legend-iwgb, legend-5cnk; PRD v1.7 §3 D.30).
// The one place a payslip's tax is computed, used by the payroll run (API)
// and by the FE mock payslip builder (fixtures.ts), so both agree to the
// rupiah. It maps payslip earnings to the PPh 21 engine (pph21.ts): taxable
// earnings carry their component's tax scheme, non-taxable earnings and the
// tax allowance itself never enter the base. The engine owns every rule.
//
// `buildPph21Prior` (bead legend-s5c1) sums the earlier payslips of the tax
// year into the engine's `prior`, with the employer-funded tax allowance and
// the scheme mix: without them the last period charges a gross-up employee
// the company-funded shortfall and refunds them tax the company paid.

import { idr } from "../../core/index.ts";
import type { Idr } from "../../core/index.ts";
import type { PtkpStatus } from "../organization.ts";
import type { TaxScheme } from "./components.ts";
import type { PayslipTax } from "./payslips.ts";
import type { Pph21PolicyParameters } from "./pph21-policy.ts";
import { computePph21Period, pph21GrossSchemeBase } from "./pph21.ts";
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
  /** Scheme of the employment agreement this period (see pph21.ts). */
  contractTaxScheme?: TaxScheme;
  employeeDeductibleIdr: Idr | number;
  /** Authoritative cap on the employee's PPh 21 (see pph21.ts `employeeWithholdingCapIdr`). */
  employeeWithholdingCapIdr?: Idr | number;
  /** TER month total of the earlier payslips of the same tax month (see pph21.ts). */
  monthPrior?: Pph21PeriodInput["monthPrior"];
  prior: Pph21PeriodInput["prior"];
};

export type PayslipTaxResult = {
  tax: PayslipTax;
  result: Pph21PeriodResult;
};

/**
 * The pay left for the employee's PPh 21 (`employeeWithholdingCapIdr`, bead
 * legend-xzid): cash earnings without the tax allowance and the PPh 21 refund
 * line, minus every employee BPJS share (JHT, JP, health) and the pre-net
 * deductions that are not loans (e.g. LATE). Loans and the employee
 * receivable are collected after PPh 21 from what is left.
 */
export function payslipWithholdingCap(input: {
  cashEarningsIdr: Idr | number;
  bpjsEmployeeIdr: Idr | number;
  preNetDeductionsIdr: Idr | number;
}): Idr {
  const cash = wholeRupiah(Number(input.cashEarningsIdr), "cashEarningsIdr");
  const bpjs = wholeRupiah(Number(input.bpjsEmployeeIdr), "bpjsEmployeeIdr");
  const preNet = wholeRupiah(
    Number(input.preNetDeductionsIdr),
    "preNetDeductionsIdr",
  );
  const left = cash - bpjs - preNet;
  return idr(Number(left > 0n ? left : 0n));
}

export function computePayslipTax(input: PayslipTaxInput): PayslipTaxResult {
  const taxableLines = input.earnings
    .filter((earning) => earning.taxable)
    .map((earning) => ({
      amountIdr: earning.amountIdr,
      taxScheme: earning.taxScheme,
    }));
  const result = computePph21Period(input.tables, input.policy, {
    ptkpStatus: input.ptkpStatus,
    hasTaxId: input.hasTaxId,
    lastTaxPeriod: input.lastTaxPeriod,
    monthsWorked: input.monthsWorked,
    partialYearTaxSubject: input.partialYearTaxSubject ?? false,
    taxableLines,
    employerBenefitIdr: input.employerBenefitIdr,
    ...(input.contractTaxScheme === undefined
      ? {}
      : { contractTaxScheme: input.contractTaxScheme }),
    employeeDeductibleIdr: input.employeeDeductibleIdr,
    ...(input.employeeWithholdingCapIdr === undefined
      ? {}
      : { employeeWithholdingCapIdr: input.employeeWithholdingCapIdr }),
    ...(input.monthPrior === undefined ? {} : { monthPrior: input.monthPrior }),
    prior: input.prior,
  });
  const grossSchemeBaseIdr = pph21GrossSchemeBase(
    taxableLines,
    input.employerBenefitIdr,
    input.contractTaxScheme,
  );
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
      pph21EmployerAllowanceRefundIdr: result.pph21EmployerAllowanceRefundIdr,
      pph21ReceivableIdr: result.pph21ReceivableIdr,
      noTaxIdSurchargeApplied: result.noTaxIdSurchargeApplied,
      grossSchemeBaseIdr,
      employerSchemeBaseIdr: idr(result.taxableGrossIdr - grossSchemeBaseIdr),
    },
  };
}

/** One earlier payslip of the tax year, as stored by the run that made it. */
export type Pph21PriorPeriod = {
  /** The payslip's stored tax (scheme bases included). */
  tax: PayslipTax;
  /** Employee JHT + JP of that payslip. */
  employeeDeductibleIdr: Idr | number;
};

/** `prior` for the engine with every field filled. */
export type Pph21Prior = {
  [K in keyof Pph21PeriodInput["prior"]]-?: Idr;
};

function wholeRupiah(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative whole rupiah amount`);
  return BigInt(value);
}

/**
 * The engine's `prior` from the earlier payslips of the CURRENT period of
 * service in the tax year at this employer: sums of X, employee JHT/JP,
 * withheld and borne tax, the gross-up tax allowance inside the withheld tax
 * (the company's, like the borne tax) and the stored scheme mix of every X.
 * The caller passes only the payslips after the latest annual recalculation
 * (a rehire in the same year starts a new period with its own bukti potong);
 * an annual recalculation or lebih potong refund among them, and a stored tax
 * that does not add up, are refused with a RangeError.
 */
export function buildPph21Prior(
  periods: readonly Pph21PriorPeriod[],
): Pph21Prior {
  let taxableGross = 0n;
  let deductible = 0n;
  let withheld = 0n;
  let borne = 0n;
  let allowance = 0n;
  let receivable = 0n;
  let grossScheme = 0n;
  let employerScheme = 0n;
  periods.forEach((period, index) => {
    const at = `prior period ${index}`;
    const { tax } = period;
    if (tax.method !== "ter")
      throw new RangeError(`${at} is an annual recalculation`);
    if (
      wholeRupiah(tax.pph21RefundIdr, `${at} pph21RefundIdr`) > 0n ||
      wholeRupiah(tax.pph21EmployerRefundIdr, `${at} pph21EmployerRefundIdr`) >
        0n
    )
      throw new RangeError(`${at} has a lebih potong refund`);
    const x = wholeRupiah(tax.taxableGrossIdr, `${at} taxableGrossIdr`);
    const periodWithheld = wholeRupiah(
      tax.pph21WithheldIdr,
      `${at} pph21WithheldIdr`,
    );
    const periodAllowance = wholeRupiah(
      tax.taxAllowanceIdr,
      `${at} taxAllowanceIdr`,
    );
    const periodBorne = wholeRupiah(
      tax.pph21EmployerBorneIdr,
      `${at} pph21EmployerBorneIdr`,
    );
    const periodReceivable = wholeRupiah(
      tax.pph21ReceivableIdr ?? 0,
      `${at} pph21ReceivableIdr`,
    );
    const periodGrossScheme = wholeRupiah(
      tax.grossSchemeBaseIdr,
      `${at} grossSchemeBaseIdr`,
    );
    const periodEmployerScheme = wholeRupiah(
      tax.employerSchemeBaseIdr,
      `${at} employerSchemeBaseIdr`,
    );
    if (periodAllowance > periodWithheld)
      throw new RangeError(`${at} taxAllowanceIdr exceeds pph21WithheldIdr`);
    if (
      wholeRupiah(tax.pph21Idr, `${at} pph21Idr`) !==
      periodWithheld + periodBorne + periodReceivable
    )
      throw new RangeError(
        `${at} pph21Idr is not pph21WithheldIdr + pph21EmployerBorneIdr + pph21ReceivableIdr`,
      );
    if (periodGrossScheme + periodEmployerScheme !== x)
      throw new RangeError(`${at} scheme bases do not sum to taxableGrossIdr`);
    // The covered tax (allowance + borne) is part of X on the employer's side.
    if (periodAllowance + periodBorne > periodEmployerScheme)
      throw new RangeError(
        `${at} employer-covered tax exceeds employerSchemeBaseIdr`,
      );
    taxableGross += x;
    deductible += wholeRupiah(
      Number(period.employeeDeductibleIdr),
      `${at} employeeDeductibleIdr`,
    );
    withheld += periodWithheld;
    borne += periodBorne;
    allowance += periodAllowance;
    receivable += periodReceivable;
    grossScheme += periodGrossScheme;
    employerScheme += periodEmployerScheme;
  });
  const out = (value: bigint, name: string): Idr => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError(`prior ${name} is too large`);
    return idr(Number(value));
  };
  return {
    taxableGrossIdr: out(taxableGross, "taxableGrossIdr"),
    employeeDeductibleIdr: out(deductible, "employeeDeductibleIdr"),
    pph21WithheldIdr: out(withheld, "pph21WithheldIdr"),
    pph21EmployerBorneIdr: out(borne, "pph21EmployerBorneIdr"),
    taxAllowanceIdr: out(allowance, "taxAllowanceIdr"),
    pph21ReceivableIdr: out(receivable, "pph21ReceivableIdr"),
    grossSchemeBaseIdr: out(grossScheme, "grossSchemeBaseIdr"),
    employerSchemeBaseIdr: out(employerScheme, "employerSchemeBaseIdr"),
  };
}

/**
 * `buildPph21Prior` plus the earlier annual-recalculation payslips of the SAME
 * last tax period (a second run in December: a THR or off-cycle run after the
 * regular one). Each such payslip is folded in as its cumulative effect:
 * X, JHT/JP, scheme bases and receivable add up; the tax it left standing
 * (withheld less the lebih potong refund and the employer's allowance refund,
 * borne less the employer's refund of borne tax) joins the earlier year's, so
 * the engine's prior tax equals the annual tax of everything paid so far, and
 * the later run owes the annual tax of the whole year minus that. The year's
 * sum is the annual tax on all income, rounded once. Anything that is not an
 * annual-recalculation payslip, a stored tax that does not add up, or a
 * cumulative value below 0 is refused with a RangeError.
 */
export function buildPph21PriorWithLastPeriod(
  periods: readonly Pph21PriorPeriod[],
  lastPeriodEarlier: readonly Pph21PriorPeriod[],
): Pph21Prior {
  const base = buildPph21Prior(periods);
  let taxableGross = BigInt(base.taxableGrossIdr);
  let deductible = BigInt(base.employeeDeductibleIdr);
  let withheld = BigInt(base.pph21WithheldIdr);
  let borne = BigInt(base.pph21EmployerBorneIdr);
  let allowance = BigInt(base.taxAllowanceIdr);
  let receivable = BigInt(base.pph21ReceivableIdr);
  let grossScheme = BigInt(base.grossSchemeBaseIdr);
  let employerScheme = BigInt(base.employerSchemeBaseIdr);
  lastPeriodEarlier.forEach((period, index) => {
    const at = `last period payslip ${index}`;
    const { tax } = period;
    if (tax.method !== "annual_recalculation")
      throw new RangeError(`${at} is not an annual recalculation`);
    const x = wholeRupiah(tax.taxableGrossIdr, `${at} taxableGrossIdr`);
    const w = wholeRupiah(tax.pph21WithheldIdr, `${at} pph21WithheldIdr`);
    const allow = wholeRupiah(tax.taxAllowanceIdr, `${at} taxAllowanceIdr`);
    const slipBorne = wholeRupiah(
      tax.pph21EmployerBorneIdr,
      `${at} pph21EmployerBorneIdr`,
    );
    const recv = wholeRupiah(
      tax.pph21ReceivableIdr ?? 0,
      `${at} pph21ReceivableIdr`,
    );
    const refund = wholeRupiah(tax.pph21RefundIdr, `${at} pph21RefundIdr`);
    const empRefund = wholeRupiah(
      tax.pph21EmployerRefundIdr,
      `${at} pph21EmployerRefundIdr`,
    );
    const empAllowRefund = wholeRupiah(
      tax.pph21EmployerAllowanceRefundIdr ?? 0,
      `${at} pph21EmployerAllowanceRefundIdr`,
    );
    const slipGrossScheme = wholeRupiah(
      tax.grossSchemeBaseIdr,
      `${at} grossSchemeBaseIdr`,
    );
    const slipEmployerScheme = wholeRupiah(
      tax.employerSchemeBaseIdr,
      `${at} employerSchemeBaseIdr`,
    );
    // pph21Idr is signed: a lebih potong refund can take it below 0.
    if (!Number.isSafeInteger(tax.pph21Idr))
      throw new RangeError(`${at} pph21Idr must be a whole rupiah amount`);
    if (BigInt(tax.pph21Idr) !== w + slipBorne + recv - refund - empRefund)
      throw new RangeError(
        `${at} pph21Idr does not match its withheld, borne, receivable and refund amounts`,
      );
    if (empAllowRefund > empRefund)
      throw new RangeError(
        `${at} pph21EmployerAllowanceRefundIdr exceeds pph21EmployerRefundIdr`,
      );
    if (slipGrossScheme + slipEmployerScheme !== x)
      throw new RangeError(`${at} scheme bases do not sum to taxableGrossIdr`);
    taxableGross += x;
    deductible += wholeRupiah(
      Number(period.employeeDeductibleIdr),
      `${at} employeeDeductibleIdr`,
    );
    withheld += w - refund - empAllowRefund;
    allowance += allow - empAllowRefund;
    borne += slipBorne - (empRefund - empAllowRefund);
    receivable += recv;
    grossScheme += slipGrossScheme;
    employerScheme += slipEmployerScheme;
  });
  // The cumulative sign checks run once, after every slip is folded in, so the
  // result never depends on the order of `lastPeriodEarlier`.
  if (withheld < 0n || allowance < 0n || borne < 0n)
    throw new RangeError(
      "last period payslips leave a negative cumulative tax",
    );
  if (allowance > withheld)
    throw new RangeError(
      "last period payslips leave taxAllowanceIdr above pph21WithheldIdr",
    );
  const out = (value: bigint, name: string): Idr => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError(`prior ${name} is too large`);
    return idr(Number(value));
  };
  return {
    taxableGrossIdr: out(taxableGross, "taxableGrossIdr"),
    employeeDeductibleIdr: out(deductible, "employeeDeductibleIdr"),
    pph21WithheldIdr: out(withheld, "pph21WithheldIdr"),
    pph21EmployerBorneIdr: out(borne, "pph21EmployerBorneIdr"),
    taxAllowanceIdr: out(allowance, "taxAllowanceIdr"),
    pph21ReceivableIdr: out(receivable, "pph21ReceivableIdr"),
    grossSchemeBaseIdr: out(grossScheme, "grossSchemeBaseIdr"),
    employerSchemeBaseIdr: out(employerScheme, "employerSchemeBaseIdr"),
  };
}
