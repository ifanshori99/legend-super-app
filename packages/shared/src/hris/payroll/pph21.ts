// PPh 21 for one employee and one tax period (PRD v1.7 §3 D.30 "PPh 21",
// F30, PAYR-03, R15; beads legend-5cnk, legend-y4wp).
//
// Pure, whole rupiah, BigInt arithmetic, no I/O. The caller resolves the
// statutory table versions in force for the period (statutory.ts
// `resolveStatutoryTable`) and the tenant PPh 21 policy in force
// (pph21-policy.ts `resolvePph21Policy`) and passes their parameters.
//
// Method (PP 58/2023; PMK 168/2023
// https://www.jdih.kemenkeu.go.id/api/download/e60a82e0-b218-40f5-9d18-b924aa1e11ce/2023pmkeuangan168.pdf):
// - Every period except the last one of the tax year: monthly TER, tax =
//   bruto x TER rate of the PTKP category (PP 58/2023 Pasal 2-3, Lampiran).
// - Last tax period (December, or the month employment ends; PMK 168 Pasal
//   15(1)-(3)): Pasal 17 ayat (1) huruf a on the year. Bruto - biaya jabatan
//   (5%, cap per policy; Pasal 10(2)) - employee JHT/JP = neto; PKP = neto -
//   PTKP rounded down to thousands (Pasal 17(4) UU PPh). Ordinary joiners and
//   leavers keep the full PTKP and are not annualised. When the subjective tax
//   obligation itself starts or ends within the year (Pasal 15(3), Lampiran
//   I.2.2.3), neto is annualised (x 12 / months) and the tax is taken pro rata
//   (x months / 12). Period tax = annual tax - PPh 21 of earlier periods; a
//   negative result is lebih potong, returned (Pasal 21).
// - No tax id: rate 20% higher (Pasal 21(5a) UU PPh), the table's
//   `noTaxIdSurchargeBp`, in TER months too unless the policy says
//   `annual_only`.
// - Every tax amount is rounded ONCE with the policy's rounding mode (half up
//   for Coretax periods, PER-11/PJ/2025 Pasal 129): the surcharge and the
//   partial-year fraction are multiplied into the numerator first.
//
// Tax schemes per component (components.ts `taxScheme`):
// - gross: the tax is withheld from the employee.
// - gross_up: the employer pays a tax allowance (taxable earning line).
// - net: the employer bears the tax; the borne tax is itself a taxable benefit
//   (FAQ DJP PMK-66/2023 no. 40), so it enters the bruto like the allowance.
// Let G = gross lines + employer BPJS benefit, U = gross_up lines, N = net
// lines, S = employer-covered tax (allowance A + borne B), X = G+U+N+S. The
// employee's share W of the tax follows the policy (`proportional`: T x G / X;
// `gross_first`: the tax G would carry alone, capped at T). S is the least
// fixed point of S = T(X(S)) - W(X(S)), iterated from 0 (monotone, so it rises
// to the least solution). A = S x U / (U + N), B = T - W - A. Withheld = W + A,
// so the employee's take-home is exactly G + U + N - W: the allowance cancels
// out to the rupiah.
// Lebih potong is split by the year's payer history (prior withheld vs prior
// employer-borne), never by this month's mix, so tax withheld from the
// employee always goes back to the employee.

import { divideRounded, idr } from "../../core/index.ts";
import type { Idr, RoundingMode } from "../../core/index.ts";
import type { PtkpStatus } from "../organization.ts";
import type { TaxScheme } from "./components.ts";
import { PayrollError } from "./errors.ts";
import type { Pph21PolicyParameters } from "./pph21-policy.ts";
import type {
  PtkpParameters,
  TerParameters,
  Pph21AnnualParameters,
  TerCategory,
} from "./statutory.ts";

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
  /**
   * The subjective tax obligation starts or ends within the year (PMK 168
   * Pasal 15(3)), e.g. the employee leaves Indonesia for good. Only in the
   * last tax period. Not for an ordinary joiner or leaver.
   */
  partialYearTaxSubject?: boolean;
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
    /** PPh 21 deducted from the employee in earlier periods. */
    pph21WithheldIdr: Idr | number;
    /** PPh 21 borne by the employer in earlier periods (net scheme). */
    pph21EmployerBorneIdr: Idr | number;
    /**
     * Optional scheme mix of the earlier periods' taxable base: the part paid
     * on the gross scheme (employee carries its tax) and the part on
     * gross_up / net (employer carries it). Used only when no tax was paid in
     * the year yet, to split the history shortfall between payers.
     */
    grossSchemeBaseIdr?: Idr | number;
    employerSchemeBaseIdr?: Idr | number;
    /**
     * Part of `pph21WithheldIdr` that was the employer-funded tax allowance
     * (gross-up) of earlier periods. It is withheld on the payslip but the
     * company paid for it, so it counts as employer tax like the borne tax.
     */
    taxAllowanceIdr?: Idr | number;
  };
};

export type Pph21AnnualBreakdown = {
  grossIdr: Idr;
  occupationalCostIdr: Idr;
  deductibleIdr: Idr;
  /** gross - occupational cost - deductible. */
  netIdr: Idr;
  /** netIdr x 12 / months for a partial-year tax subject, else netIdr. */
  annualizedNetIdr: Idr;
  ptkpIdr: Idr;
  taxableIncomeIdr: Idr;
  /** Tax of the year (pro rata for a partial-year tax subject). */
  annualTaxIdr: Idr;
  priorPph21Idr: Idr;
};

export type Pph21PeriodResult = {
  method: "ter" | "annual_recalculation";
  /** PTKP status used for withholding (K/I/n normalised to K/n). */
  withholdingStatus: PtkpStatus;
  terCategory: TerCategory | null;
  terRateBp: number | null;
  /** X = taxable lines + employer benefit + allowance + borne tax. */
  taxableGrossIdr: Idr;
  /** Gross-up tunjangan pajak (an extra earning line). */
  taxAllowanceIdr: Idr;
  /** Tax owed for the period; negative = lebih potong. */
  pph21Idr: Idr;
  /** Deducted from the employee (their gross share + the allowance). */
  pph21WithheldIdr: Idr;
  /** Borne by the employer (net scheme), a taxable benefit in X. */
  pph21EmployerBorneIdr: Idr;
  /** Lebih potong paid back to the employee. */
  pph21RefundIdr: Idr;
  /** Lebih potong that returns to the employer (tax it bore). */
  pph21EmployerRefundIdr: Idr;
  /**
   * The no-tax-id rule applies in this period (no tax id, the table has a
   * surcharge and the policy surcharges this method), even when the base tax
   * is 0 and nothing was added.
   */
  noTaxIdSurchargeApplied: boolean;
  annual: Pph21AnnualBreakdown | null;
};

const MAX_ITERATIONS = 1000;
const BP = 10_000n;

function nonNegativeInt(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative whole rupiah amount`);
  return BigInt(value);
}

const toIdr = (value: bigint): Idr => idr(Number(value));

function terRateBp(
  brackets: TerParameters["bracketsByCategory"]["A"],
  amount: bigint,
): number {
  const bracket = brackets.find(
    (b) => b.upToIdr === null || amount <= BigInt(b.upToIdr),
  );
  if (!bracket) throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");
  return bracket.rateBp;
}

/** Sum of slice x rateBp over the Pasal 17 brackets (rupiah x bp, exact). */
function progressiveScaled(
  brackets: Pph21AnnualParameters["brackets"],
  income: bigint,
): bigint {
  if (income <= 0n) return 0n;
  let lower = 0n;
  let scaled = 0n;
  for (const bracket of brackets) {
    const upper = bracket.upToIdr === null ? income : BigInt(bracket.upToIdr);
    const top = upper < income ? upper : income;
    if (top > lower) scaled += (top - lower) * BigInt(bracket.rateBp);
    if (bracket.upToIdr === null || upper >= income) break;
    lower = upper;
  }
  return scaled;
}

/** K/I/n is an SPT status; withholding uses K/n (or refuses, per policy). */
function withholdingStatusOf(
  status: PtkpStatus,
  policy: Pph21PolicyParameters,
): PtkpStatus {
  if (!status.startsWith("K/I/")) return status;
  if (policy.combinedSpouseStatus === "reject")
    throw new PayrollError("PAYROLL_PPH21_STATUS_UNSUPPORTED");
  return status.replace("K/I/", "K/") as PtkpStatus;
}

type PeriodTax = {
  tax: bigint;
  terRateBp: number | null;
  annual: Pph21AnnualBreakdown | null;
};

export function computePph21Period(
  tables: Pph21Tables,
  policy: Pph21PolicyParameters,
  input: Pph21PeriodInput,
): Pph21PeriodResult {
  if (
    !Number.isInteger(input.monthsWorked) ||
    input.monthsWorked < 1 ||
    input.monthsWorked > 12
  )
    throw new RangeError("monthsWorked must be 1..12");
  const partialYear = input.partialYearTaxSubject === true;
  if (partialYear && !input.lastTaxPeriod)
    throw new RangeError("partialYearTaxSubject applies to the last period");

  const benefit = nonNegativeInt(
    input.employerBenefitIdr,
    "employerBenefitIdr",
  );
  let g = benefit;
  let grossLines = 0n;
  let u = 0n;
  let n = 0n;
  for (const line of input.taxableLines) {
    const amount = nonNegativeInt(line.amountIdr, "line amountIdr");
    if (line.taxScheme === "gross") {
      g += amount;
      grossLines += amount;
    } else if (line.taxScheme === "gross_up") u += amount;
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
  const priorWithheld = nonNegativeInt(
    input.prior.pph21WithheldIdr,
    "prior.pph21WithheldIdr",
  );
  const priorBorne = nonNegativeInt(
    input.prior.pph21EmployerBorneIdr,
    "prior.pph21EmployerBorneIdr",
  );
  const priorTax = priorWithheld + priorBorne;
  const priorGrossScheme = nonNegativeInt(
    input.prior.grossSchemeBaseIdr ?? 0,
    "prior.grossSchemeBaseIdr",
  );
  const priorEmployerScheme = nonNegativeInt(
    input.prior.employerSchemeBaseIdr ?? 0,
    "prior.employerSchemeBaseIdr",
  );
  const priorAllowance =
    input.prior.taxAllowanceIdr === undefined
      ? null
      : nonNegativeInt(input.prior.taxAllowanceIdr, "prior.taxAllowanceIdr");
  if (priorAllowance !== null && priorAllowance > priorWithheld)
    throw new RangeError(
      "prior.taxAllowanceIdr exceeds prior.pph21WithheldIdr",
    );
  const priorMix = priorGrossScheme + priorEmployerScheme;
  // Employer-funded share of the tax paid so far: borne + allowance when the
  // caller reports the allowance, else the earlier scheme mix when given (a
  // gross-up allowance sits in `withheld`, so borne alone would call it the
  // employee's), else the borne tax alone.
  let priorEmployerTax = priorBorne;
  if (priorAllowance !== null) priorEmployerTax = priorBorne + priorAllowance;
  else if (priorMix > 0n)
    priorEmployerTax = (priorTax * priorEmployerScheme) / priorMix;
  const priorEmployeeTax = priorTax - priorEmployerTax;
  // Employer BPJS (in g) is taxable income, but for a net / gross-up employee
  // (no gross line) the tax on it is the company's: it joins the employer-
  // covered tax (allowance or borne) and never reduces take-home. With any
  // gross line the benefit stays in the employee's gross share.
  const employeeG = u + n > 0n && grossLines === 0n ? 0n : g;

  const status = withholdingStatusOf(input.ptkpStatus, policy);
  const category = tables.ter.categoryByPtkpStatus[status];
  const ptkp = tables.ptkp.annualAmountIdrByStatus[status];
  if (category === undefined || ptkp === undefined)
    throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");

  const tableSurcharge = tables.annual.noTaxIdSurchargeBp;
  const surchargeApplies =
    !input.hasTaxId &&
    tableSurcharge !== null &&
    (input.lastTaxPeriod || policy.noTaxIdSurcharge === "ter_and_annual");
  const factor = BP + BigInt(surchargeApplies ? (tableSurcharge ?? 0) : 0);
  const mode: RoundingMode = policy.roundingMode;
  const months = BigInt(input.monthsWorked);

  const taxOf = (x: bigint): PeriodTax => {
    if (!input.lastTaxPeriod) {
      const rateBp = terRateBp(tables.ter.bracketsByCategory[category], x);
      return {
        tax: divideRounded(x * BigInt(rateBp) * factor, BP * BP, mode),
        terRateBp: rateBp,
        annual: null,
      };
    }
    const params = tables.annual;
    const gross = priorGross + x;
    const rawCost = (gross * BigInt(params.occupationalCostRateBp)) / BP;
    const annualCap = BigInt(params.occupationalCostAnnualCapIdr);
    const cap =
      policy.occupationalCostCap === "full_annual"
        ? annualCap
        : (annualCap * months) / 12n;
    const cost = rawCost < cap ? rawCost : cap;
    const totalDeductible = priorDeductible + deductible;
    const net = gross - cost - totalDeductible;
    const annualizedNet = partialYear && net > 0n ? (net * 12n) / months : net;
    const step = BigInt(params.taxableIncomeRoundDownToIdr);
    const beforeRounding = annualizedNet - BigInt(ptkp);
    const pkp = beforeRounding <= 0n ? 0n : (beforeRounding / step) * step;
    const fractionNumerator = partialYear ? months : 12n;
    const annualTax = divideRounded(
      progressiveScaled(params.brackets, pkp) * factor * fractionNumerator,
      BP * BP * 12n,
      mode,
    );
    return {
      tax: annualTax - priorTax,
      terRateBp: null,
      annual: {
        grossIdr: toIdr(gross),
        occupationalCostIdr: toIdr(cost),
        deductibleIdr: toIdr(totalDeductible),
        netIdr: toIdr(net),
        annualizedNetIdr: toIdr(annualizedNet),
        ptkpIdr: idr(ptkp),
        taxableIncomeIdr: toIdr(pkp),
        annualTaxIdr: toIdr(annualTax),
        priorPph21Idr: toIdr(priorTax),
      },
    };
  };

  // Last period only: the history shortfall H = annual tax on the prior
  // income alone minus what was already paid (0 in a TER month). Its employee
  // part follows the year's payer history, like a refund: the share the
  // employer bore before stays with the employer.
  const history = input.lastTaxPeriod ? taxOf(0n).tax : 0n;
  // With nothing paid yet (priorTax = 0) the payer history is unknown, so the
  // shortfall follows the earlier scheme mix, else this month's mix.
  const historyBase0 = g + u + n;
  let employerHistory = 0n;
  if (history > 0n && priorTax > 0n)
    employerHistory = (history * priorEmployerTax) / priorTax;
  else if (history > 0n && priorMix > 0n)
    employerHistory = (history * priorEmployerScheme) / priorMix;
  else if (history > 0n && historyBase0 > 0n)
    employerHistory = (history * (historyBase0 - employeeG)) / historyBase0;
  const employeeHistory = history - employerHistory;
  // gross_first: the employee bears the tax their gross components add on top
  // of the prior income, plus their part of H; the employer covers the rest.
  const grossFirstShare =
    policy.mixedSchemeAllocation === "gross_first"
      ? taxOf(employeeG).tax - history + employeeHistory
      : 0n;

  // Employee gross share of the period tax T at base x.
  const employeeShare = (tax: bigint, x: bigint): bigint => {
    if (tax <= 0n) return 0n;
    // Nothing paid this period (last period only can owe tax at X = 0): no
    // employer benefit exists to carry it, so the employee owes it all.
    if (x === 0n) return tax;
    if (policy.mixedSchemeAllocation === "gross_first") {
      const alone = grossFirstShare > 0n ? grossFirstShare : 0n;
      return alone < tax ? alone : tax;
    }
    return (tax * employeeG) / x;
  };

  // Employer-covered tax S: least fixed point from 0. With the pro rata floor
  // the map can dip by a rupiah; stop on the first non-increase and let the
  // borne amount absorb the residual (take-home stays exact).
  // Runs for gross-only pay too: under gross_first the employer's part of the
  // history shortfall is borne, hence taxable as well. Otherwise the first
  // step returns 0 and the loop stops at once.
  let covered = 0n;
  for (let i = 0; ; i++) {
    if (i >= MAX_ITERATIONS)
      throw new RangeError("Employer-covered tax did not converge");
    const x = g + u + n + covered;
    const { tax } = taxOf(x);
    const next = tax > 0n ? tax - employeeShare(tax, x) : 0n;
    if (next <= covered) break;
    covered = next;
  }

  const x = g + u + n + covered;
  const period = taxOf(x);
  const tax = period.tax;
  let withheld = 0n;
  let allowance = 0n;
  let borne = 0n;
  let employeeRefund = 0n;
  let employerRefund = 0n;
  if (tax >= 0n) {
    const w = employeeShare(tax, x);
    const employerPart = tax - w;
    allowance = u + n > 0n ? (covered * u) / (u + n) : 0n;
    if (allowance > employerPart) allowance = employerPart;
    borne = employerPart - allowance;
    withheld = w + allowance;
  } else {
    const owedBack = -tax;
    if (policy.mixedSchemeAllocation === "gross_first") {
      employeeRefund =
        owedBack < priorEmployeeTax ? owedBack : priorEmployeeTax;
      employerRefund = owedBack - employeeRefund;
    } else {
      employerRefund =
        priorTax > 0n ? (owedBack * priorEmployerTax) / priorTax : 0n;
      employeeRefund = owedBack - employerRefund;
    }
  }

  return {
    method: input.lastTaxPeriod ? "annual_recalculation" : "ter",
    withholdingStatus: status,
    terCategory: input.lastTaxPeriod ? null : category,
    terRateBp: period.terRateBp,
    taxableGrossIdr: toIdr(x),
    taxAllowanceIdr: toIdr(allowance),
    pph21Idr: toIdr(tax),
    pph21WithheldIdr: toIdr(withheld),
    pph21EmployerBorneIdr: toIdr(borne),
    pph21RefundIdr: toIdr(employeeRefund),
    pph21EmployerRefundIdr: toIdr(employerRefund),
    noTaxIdSurchargeApplied: surchargeApplies,
    annual: period.annual,
  };
}
