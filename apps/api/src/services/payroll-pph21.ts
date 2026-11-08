// PPh 21 for one employee and one tax period (PRD v1.7 §3 D.30 "PPh 21",
// F30, PAYR-03, R15; bead legend-5cnk).
//
// Pure, whole rupiah, no I/O. The caller resolves the statutory table
// versions in force for the period (statutory.ts `resolveStatutoryTable`) and
// passes their parameters; nothing here hard-codes a rate.
//
// Method (PP 58/2023, PMK 168/2023):
// - Every period except the last one of the tax year: monthly TER. Tax =
//   bruto x TER rate of the employee's PTKP category (PP 58/2023 Pasal 2-3).
// - Last tax period (December, or the month employment ends): annual
//   recalculation with Pasal 17 ayat (1) huruf a. Annual bruto - biaya jabatan
//   (5%, capped at the annual cap pro rata per month worked, i.e. Rp500.000 a
//   month) - employee JHT/JP - PTKP = PKP, rounded down to the table multiple
//   (Pasal 17 ayat (4)). Ordinary joiners and leavers are not annualised and
//   keep the full PTKP. Period tax = annual tax - PPh 21 of earlier periods;
//   a negative result is lebih potong, refunded.
// - No tax id (NPWP/NIK): tax x (100% + surcharge), Pasal 21 ayat (5a) UU PPh.
//   The surcharge is the `pph21_annual` table's `noTaxIdSurchargeBp` and is
//   applied in TER months too (same statutory rule; the TER table has no own
//   field). Rounded after the base tax, so base tax and surcharge each follow
//   the regulation's order: compute the tax, then 120% of it.
//
// Tax schemes per component (components.ts `taxScheme`):
// - gross: tax withheld from the employee.
// - gross_up: the employer adds a tax allowance (tunjangan pajak) equal to the
//   tax attributable to the gross-up components plus the allowance itself. The
//   allowance is taxable income, so it is the least fixed point
//   A = floor(T(X(A)) x (U + A) / X(A)), found by iterating from 0; the map is
//   monotone, so the iteration rises to the least solution and stops.
// - net: the employer bears the tax attributable to the component, without an
//   allowance line.
// Attribution is pro rata to the period's taxable base: TER is one flat rate
// on the whole base, and the annual recalculation has no per-component split
// in the regulation, so the base share is the neutral rule.
//   borne = floor(T x N / X), withheld = T - borne (withheld absorbs rounding).
// Employer BPJS JKK/JKM/Kesehatan shares are a taxable benefit (gross scheme).

import { divideRounded, idr } from "@starter/shared/core";
import type { Idr, RoundingMode } from "@starter/shared/core";
import { computeProgressiveTax } from "@starter/shared/hris/payroll";
import type {
  PtkpParameters,
  TerParameters,
  Pph21AnnualParameters,
  TaxScheme,
  TerCategory,
} from "@starter/shared/hris/payroll";
import { PayrollError } from "@starter/shared/hris/payroll";
import type { PtkpStatus } from "@starter/shared/hris";

export type Pph21Tables = {
  ptkp: PtkpParameters;
  ter: TerParameters;
  annual: Pph21AnnualParameters;
};

export type Pph21Line = { amountIdr: Idr | number; taxScheme: TaxScheme };

export type Pph21PeriodInput = {
  ptkpStatus: PtkpStatus;
  /** False when the employee has no NPWP/NIK registered as tax id. */
  hasTaxId: boolean;
  /** December, or the month employment ends (masa pajak terakhir). */
  lastTaxPeriod: boolean;
  /** Months at this employer in the tax year, this one included (1..12). */
  monthsWorked: number;
  /** Taxable earnings of the period; never the tax allowance itself. */
  taxableLines: readonly Pph21Line[];
  /** Employer JKK + JKM + BPJS Kesehatan shares (taxable benefit). */
  employerBenefitIdr: Idr | number;
  /** Employee JHT + JP of the period (deductible in the annual computation). */
  employeeDeductibleIdr: Idr | number;
  /** Earlier periods of the tax year at this employer (last period only). */
  prior: {
    /** Sum of X (taxableGrossIdr) of earlier periods. */
    taxableGrossIdr: Idr | number;
    employeeDeductibleIdr: Idr | number;
    /** PPh 21 owed in earlier periods (withheld + employer-borne). */
    pph21Idr: Idr | number;
  };
};

export type Pph21AnnualBreakdown = {
  grossIdr: Idr;
  occupationalCostIdr: Idr;
  deductibleIdr: Idr;
  ptkpIdr: Idr;
  taxableIncomeIdr: Idr;
  annualTaxIdr: Idr;
  priorPph21Idr: Idr;
};

export type Pph21PeriodResult = {
  method: "ter" | "annual_recalculation";
  terCategory: TerCategory | null;
  terRateBp: number | null;
  /** X = taxable lines + employer benefit + tax allowance. */
  taxableGrossIdr: Idr;
  /** Gross-up tunjangan pajak (an extra earning line). */
  taxAllowanceIdr: Idr;
  /** Tax owed for the period; negative = lebih potong. */
  pph21Idr: Idr;
  /** Deducted from the employee (gross and gross-up shares). */
  pph21WithheldIdr: Idr;
  /** Borne by the employer (net share). */
  pph21EmployerBorneIdr: Idr;
  /** Lebih potong paid back to the employee (their share of the refund). */
  pph21RefundIdr: Idr;
  /**
   * The no-tax-id rule applies to this employee (no tax id and the table has
   * a surcharge), even when the period's base tax is 0 and nothing was added.
   */
  noTaxIdSurchargeApplied: boolean;
  annual: Pph21AnnualBreakdown | null;
};

const MAX_GROSS_UP_ITERATIONS = 1000;

function nonNegativeInt(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative whole rupiah amount`);
  return BigInt(value);
}

function bracketRateBp(
  brackets: TerParameters["bracketsByCategory"]["A"],
  amount: bigint,
): number {
  const bracket = brackets.find(
    (b) => b.upToIdr === null || amount <= BigInt(b.upToIdr),
  );
  if (!bracket) throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");
  return bracket.rateBp;
}

function withSurcharge(
  tax: bigint,
  surchargeBp: number | null,
  mode: RoundingMode,
): bigint {
  if (surchargeBp === null || tax <= 0n) return tax;
  return divideRounded(tax * BigInt(10_000 + surchargeBp), 10_000n, mode);
}

type PeriodTax = {
  tax: bigint;
  terRateBp: number | null;
  annual: Pph21AnnualBreakdown | null;
};

export function computePph21Period(
  tables: Pph21Tables,
  input: Pph21PeriodInput,
): Pph21PeriodResult {
  if (
    !Number.isInteger(input.monthsWorked) ||
    input.monthsWorked < 1 ||
    input.monthsWorked > 12
  )
    throw new RangeError("monthsWorked must be 1..12");

  let g = nonNegativeInt(input.employerBenefitIdr, "employerBenefitIdr");
  let u = 0n;
  let n = 0n;
  for (const line of input.taxableLines) {
    const amount = nonNegativeInt(line.amountIdr, "line amountIdr");
    if (line.taxScheme === "gross") g += amount;
    else if (line.taxScheme === "gross_up") u += amount;
    else if (line.taxScheme === "net") n += amount;
    else throw new RangeError("Unknown taxScheme");
  }
  const deductible = nonNegativeInt(
    input.employeeDeductibleIdr,
    "employeeDeductibleIdr",
  );
  const priorGross = nonNegativeInt(
    input.prior.taxableGrossIdr,
    "prior.taxableGrossIdr",
  );
  const priorDeductible = nonNegativeInt(
    input.prior.employeeDeductibleIdr,
    "prior.employeeDeductibleIdr",
  );
  if (!Number.isSafeInteger(input.prior.pph21Idr))
    throw new RangeError("prior.pph21Idr must be whole rupiah");
  const priorTax = BigInt(input.prior.pph21Idr);

  const category = tables.ter.categoryByPtkpStatus[input.ptkpStatus];
  const ptkp = tables.ptkp.annualAmountIdrByStatus[input.ptkpStatus];
  if (category === undefined || ptkp === undefined)
    throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");
  const surchargeBp = input.hasTaxId ? null : tables.annual.noTaxIdSurchargeBp;

  const taxOf = (x: bigint): PeriodTax => {
    if (!input.lastTaxPeriod) {
      const rateBp = bracketRateBp(tables.ter.bracketsByCategory[category], x);
      const mode = tables.ter.roundingMode;
      const base = divideRounded(x * BigInt(rateBp), 10_000n, mode);
      return {
        tax: withSurcharge(base, surchargeBp, mode),
        terRateBp: rateBp,
        annual: null,
      };
    }
    const params = tables.annual;
    const gross = priorGross + x;
    const rawCost = divideRounded(
      gross * BigInt(params.occupationalCostRateBp),
      10_000n,
      "down",
    );
    const capCost = divideRounded(
      BigInt(params.occupationalCostAnnualCapIdr) * BigInt(input.monthsWorked),
      12n,
      "down",
    );
    const cost = rawCost < capCost ? rawCost : capCost;
    const totalDeductible = priorDeductible + deductible;
    const net = gross - cost - totalDeductible - BigInt(ptkp);
    const step = BigInt(params.taxableIncomeRoundDownToIdr);
    const pkp = net <= 0n ? 0n : (net / step) * step;
    const base = BigInt(
      computeProgressiveTax(
        params.brackets,
        idr(Number(pkp)),
        params.roundingMode,
      ),
    );
    const annualTax = withSurcharge(base, surchargeBp, params.roundingMode);
    return {
      tax: annualTax - priorTax,
      terRateBp: null,
      annual: {
        grossIdr: idr(Number(gross)),
        occupationalCostIdr: idr(Number(cost)),
        deductibleIdr: idr(Number(totalDeductible)),
        ptkpIdr: idr(ptkp),
        taxableIncomeIdr: idr(Number(pkp)),
        annualTaxIdr: idr(Number(annualTax)),
        priorPph21Idr: idr(Number(priorTax)),
      },
    };
  };

  // Gross-up allowance: least fixed point of a monotone map, from 0.
  let allowance = 0n;
  if (u > 0n) {
    for (let i = 0; ; i++) {
      if (i >= MAX_GROSS_UP_ITERATIONS)
        throw new RangeError("Gross-up allowance did not converge");
      const x = g + u + n + allowance;
      const { tax } = taxOf(x);
      const next = tax > 0n ? (tax * (u + allowance)) / x : 0n;
      // With mixed schemes the pro rata floor can dip by 1 rupiah as X grows;
      // stop on the first non-increase, keeping the larger allowance so the
      // employee is never short of the tax on their gross-up components.
      if (next <= allowance) break;
      allowance = next;
    }
  }

  const x = g + u + n + allowance;
  const period = taxOf(x);
  const tax = period.tax;
  let borne = 0n;
  let withheld = 0n;
  let refund = 0n;
  if (tax >= 0n) {
    borne = x > 0n ? (tax * n) / x : 0n;
    withheld = tax - borne;
  } else {
    const owedBack = -tax;
    const employerShare = x > 0n ? (owedBack * n) / x : 0n;
    refund = owedBack - employerShare;
  }

  return {
    method: input.lastTaxPeriod ? "annual_recalculation" : "ter",
    terCategory: input.lastTaxPeriod ? null : category,
    terRateBp: period.terRateBp,
    taxableGrossIdr: idr(Number(x)),
    taxAllowanceIdr: idr(Number(allowance)),
    pph21Idr: idr(Number(tax)),
    pph21WithheldIdr: idr(Number(withheld)),
    pph21EmployerBorneIdr: idr(Number(borne)),
    pph21RefundIdr: idr(Number(refund)),
    noTaxIdSurchargeApplied: surchargeBp !== null && surchargeBp > 0,
    annual: period.annual,
  };
}
