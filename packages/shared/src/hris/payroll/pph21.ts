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
// `gross_first`: the tax G would carry alone, capped at T). In the last
// period the Jan-Nov shortfall H inside T is split first, by the earlier
// scheme mix (else the payer history), under both policies; only T - H
// follows this month's mix. S is the least
// fixed point of S = T(X(S)) - W(X(S)), iterated from 0 (monotone, so it rises
// to the least solution). A = S x U / (U + N), B = T - W - A. Withheld = W + A,
// so the employee's take-home is exactly G + U + N - W: the allowance cancels
// out to the rupiah.
// Jan-Nov lebih potong (H < 0, bead legend-u1xq): T = D - C, D the tax this
// month adds (>= 0), C = -H. D follows this month's mix as above; C goes back
// to whoever overpaid it (by the earlier scheme mix, else the payer history).
// Each payer nets its own two parts, so the company's credit never lowers the
// employee's tax: withheld may exceed T, with an employer refund beside it,
// and a refund may stand beside a borne or withheld amount. Always
// withheld + borne - employee refund - employer refund = T.

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
  /**
   * Tax scheme of the employment agreement in force this period (bead
   * legend-m9gx). Required when the period has an employer benefit but its
   * taxable lines add up to 0 (none, or only zero amounts; e.g. unpaid leave
   * with BPJS still paid): the benefit then follows the agreement's scheme.
   * Ignored when a taxable line has an amount.
   */
  contractTaxScheme?: TaxScheme;
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

type SchemeSplit = {
  benefit: bigint;
  /** G: gross lines + employer benefit. */
  g: bigint;
  grossLines: bigint;
  /** U: gross_up lines. */
  u: bigint;
  /** N: net lines. */
  n: bigint;
  /** Part of G + U + N on the employee's (gross) scheme. */
  employeeG: bigint;
  /** Weights splitting the employer-covered tax into allowance (gross-up) and borne (net). */
  coverU: bigint;
  coverN: bigint;
};

function schemeSplit(
  taxableLines: readonly Pph21Line[],
  employerBenefitIdr: Idr | number,
  contractTaxScheme: TaxScheme | undefined,
): SchemeSplit {
  const benefit = nonNegativeInt(employerBenefitIdr, "employerBenefitIdr");
  let grossLines = 0n;
  let u = 0n;
  let n = 0n;
  for (const line of taxableLines) {
    const amount = nonNegativeInt(line.amountIdr, "line amountIdr");
    if (line.taxScheme === "gross") grossLines += amount;
    else if (line.taxScheme === "gross_up") u += amount;
    else if (line.taxScheme === "net") n += amount;
    else throw new RangeError("Unknown taxScheme");
  }
  const g = benefit + grossLines;
  // Employer BPJS (in g) is taxable income. Its tax follows the schemes of the
  // month's lines: the gross lines' share (floor) is the employee's, the rest
  // is the company's (it joins the employer-covered tax: allowance or borne,
  // never take-home). Gross-only pay (no net / gross-up line) keeps all of it.
  const lineBase = grossLines + u + n;
  // No line but a benefit (unpaid leave, BPJS still paid): the benefit follows
  // the employment agreement's scheme (bead legend-m9gx), so a gross-up or
  // net employee keeps no part of its tax and the company's cover is an
  // allowance (gross-up) or borne (net).
  if (lineBase === 0n && benefit > 0n) {
    if (contractTaxScheme === undefined)
      throw new RangeError(
        "contractTaxScheme is required for a period with only an employer benefit",
      );
    if (
      contractTaxScheme !== "gross" &&
      contractTaxScheme !== "gross_up" &&
      contractTaxScheme !== "net"
    )
      throw new RangeError("Unknown contractTaxScheme");
    return {
      benefit,
      g,
      grossLines,
      u,
      n,
      employeeG: contractTaxScheme === "gross" ? g : 0n,
      coverU: contractTaxScheme === "gross_up" ? benefit : 0n,
      coverN: contractTaxScheme === "net" ? benefit : 0n,
    };
  }
  const employeeG =
    u + n === 0n ? g : grossLines + (benefit * grossLines) / lineBase;
  return { benefit, g, grossLines, u, n, employeeG, coverU: u, coverN: n };
}

/**
 * Employee (gross-scheme) part of one period's taxable lines and employer
 * benefit, split as the engine splits them: the gross lines plus their share
 * (floor) of the benefit, all of the benefit for gross-only pay. The rest of
 * X (gross-up / net lines, their benefit share, the covered tax) is the
 * employer's. Stored on the payslip (payslip-tax.ts) for `buildPph21Prior`.
 */
export function pph21GrossSchemeBase(
  taxableLines: readonly Pph21Line[],
  employerBenefitIdr: Idr | number,
  contractTaxScheme?: TaxScheme,
): Idr {
  return toIdr(
    schemeSplit(taxableLines, employerBenefitIdr, contractTaxScheme).employeeG,
  );
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

  const { g, u, n, employeeG, coverU, coverN } = schemeSplit(
    input.taxableLines,
    input.employerBenefitIdr,
    input.contractTaxScheme,
  );
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
  // Both bases or neither: one alone would read the rest of the income as the
  // other scheme.
  if (priorMix > 0n && priorMix !== priorGross)
    throw new RangeError(
      "prior scheme bases must add up to prior.taxableGrossIdr",
    );
  // Employer-funded share of the tax paid so far, exact: the borne tax plus
  // the gross-up allowance inside `withheld` (bead legend-6p71). A history
  // with employer-scheme pay and withheld tax may hide an allowance in the
  // withheld tax, so the caller must report it (0 when none); a ratio of the
  // scheme bases would overwrite the tax the company actually paid.
  if (priorAllowance === null && priorWithheld > 0n && priorEmployerScheme > 0n)
    throw new RangeError(
      "prior.taxAllowanceIdr is required for a history with employer-scheme pay",
    );
  const priorEmployerTax = priorBorne + (priorAllowance ?? 0n);
  const priorEmployeeTax = priorTax - priorEmployerTax;

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

  // Pasal 17 annual tax on a year's gross `gross` with this period's
  // deductions, cap, PTKP, partial-year rule and surcharge.
  const annualOf = (gross: bigint) => {
    const params = tables.annual;
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
    return { cost, totalDeductible, net, annualizedNet, pkp, annualTax };
  };

  const taxOf = (x: bigint): PeriodTax => {
    if (!input.lastTaxPeriod) {
      const rateBp = terRateBp(tables.ter.bracketsByCategory[category], x);
      return {
        tax: divideRounded(x * BigInt(rateBp) * factor, BP * BP, mode),
        terRateBp: rateBp,
        annual: null,
      };
    }
    const gross = priorGross + x;
    const { cost, totalDeductible, net, annualizedNet, pkp, annualTax } =
      annualOf(gross);
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
  // Split of H (bead legend-6q7o). With the earlier scheme mix known, the
  // annual tax on the prior income (H + priorTax) is shared by scheme base
  // and each payer owes its share minus what it already paid, clamped to
  // [0, H]: pay that was on the employer's scheme stays the employer's even
  // when the employee paid tax in other months (TER 0% net months, then taxed
  // gross months). Without the mix, H follows the payer history, else (nothing
  // paid yet) this month's mix.
  // gross_first with the mix known: the employee's part of the prior year's
  // tax is the annual tax on their gross-scheme pay alone (the company covers
  // everything on top), minus what they already paid, clamped to [0, H].
  const historyBase0 = g + u + n;
  let employerHistory = 0n;
  const clampH = (v: bigint) => (v < 0n ? 0n : v > history ? history : v);
  if (
    history > 0n &&
    priorMix > 0n &&
    policy.mixedSchemeAllocation === "gross_first"
  )
    employerHistory =
      history - clampH(annualOf(priorGrossScheme).annualTax - priorEmployeeTax);
  else if (history > 0n && priorMix > 0n)
    employerHistory = clampH(
      ((history + priorTax) * priorEmployerScheme) / priorMix -
        priorEmployerTax,
    );
  else if (history > 0n && priorTax > 0n)
    employerHistory = (history * priorEmployerTax) / priorTax;
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
    // Nothing paid this period (last period only can owe tax at X = 0): the
    // employee owes their part of H; the employer bears its part, which then
    // becomes taxable borne pay (X > 0) in the fixed point below.
    if (x === 0n) {
      const part = history > 0n ? employeeHistory : tax;
      return part < tax ? part : tax;
    }
    if (policy.mixedSchemeAllocation === "gross_first") {
      const alone = grossFirstShare > 0n ? grossFirstShare : 0n;
      return alone < tax ? alone : tax;
    }
    // proportional: the employee's part of H follows the payer history (as
    // under gross_first); the tax this month adds on top, T - H, follows this
    // month's gross share per scheme (employeeG: gross lines plus their share
    // of the employer benefit), so the net / gross-up part is the company's and
    // a net-only employee is never charged for it. T >= H (the annual tax
    // rises with the base). With no shortfall the whole T follows the mix.
    if (history > 0n) {
      const share = employeeHistory + ((tax - history) * employeeG) / x;
      return share < tax ? share : tax;
    }
    return (tax * employeeG) / x;
  };

  let x: bigint;
  let tax: bigint;
  let period: PeriodTax;
  let withheld = 0n;
  let allowance = 0n;
  let borne = 0n;
  let employeeRefund = 0n;
  let employerRefund = 0n;
  const allowanceOf = (covered: bigint, employerPart: bigint) => {
    const a =
      coverU + coverN > 0n ? (covered * coverU) / (coverU + coverN) : 0n;
    return a > employerPart ? employerPart : a;
  };

  if (history < 0n) {
    // Lebih potong Jan-Nov (bead legend-u1xq). T = D - C: D = annual(prior +
    // X) - annual(prior) >= 0 is the tax this month adds, C = -H the credit for
    // tax already overpaid. Each payer settles its own balance: D is split by
    // this month's scheme mix (De employee, Dr employer), C by who overpaid
    // (Ce, Cr), and each side nets its two parts. The company's credit never
    // lowers the employee's tax: W = De - Ce may exceed T, with the company's
    // credit going back as an employer refund. withheld + borne - refunds = T,
    // so the deposit is still exactly T.
    const credit = -history;
    const clampC = (v: bigint) => (v < 0n ? 0n : v > credit ? credit : v);
    // priorTax > 0 here: H < 0 means more was paid than the prior income owes.
    const priorAnnual = priorTax + history;
    let employeeCredit: bigint;
    if (priorMix > 0n && policy.mixedSchemeAllocation === "gross_first")
      // Their overpayment over the tax their gross-scheme pay carries alone.
      employeeCredit = clampC(
        priorEmployeeTax - annualOf(priorGrossScheme).annualTax,
      );
    else if (priorMix > 0n)
      // The company's overpayment over its scheme-base share of the prior tax.
      employeeCredit =
        credit -
        clampC(
          priorEmployerTax - (priorAnnual * priorEmployerScheme) / priorMix,
        );
    // No scheme mix: by payer history.
    else employeeCredit = credit - (credit * priorEmployerTax) / priorTax;
    const employerCredit = credit - employeeCredit;
    const employeeAloneAdded = taxOf(employeeG).tax - history;
    const addedSplit = (at: bigint) => {
      const added = taxOf(at).tax - history;
      let employeePart: bigint;
      if (policy.mixedSchemeAllocation === "gross_first")
        employeePart = employeeAloneAdded < added ? employeeAloneAdded : added;
      else employeePart = at === 0n ? 0n : (added * employeeG) / at;
      return { employeePart, employerPart: added - employeePart };
    };
    // Covered tax S = max(0, Dr(X(S)) - Cr): least fixed point from 0, same
    // stop rule as below. Dr rises with X, so the map is monotone.
    let covered = 0n;
    for (let i = 0; ; i++) {
      if (i >= MAX_ITERATIONS)
        throw new RangeError("Employer-covered tax did not converge");
      const { employerPart } = addedSplit(g + u + n + covered);
      const next =
        employerPart > employerCredit ? employerPart - employerCredit : 0n;
      if (next <= covered) break;
      covered = next;
    }
    x = g + u + n + covered;
    period = taxOf(x);
    tax = period.tax;
    const { employeePart, employerPart } = addedSplit(x);
    const employeeNet = employeePart - employeeCredit;
    const employerNet = employerPart - employerCredit;
    const w = employeeNet > 0n ? employeeNet : 0n;
    employeeRefund = employeeNet < 0n ? -employeeNet : 0n;
    if (employerNet >= 0n) {
      allowance = allowanceOf(covered, employerNet);
      borne = employerNet - allowance;
    } else employerRefund = -employerNet;
    withheld = w + allowance;
  } else {
    // Employer-covered tax S: least fixed point from 0. With the pro rata
    // floor the map can dip by a rupiah; stop on the first non-increase and
    // let the borne amount absorb the residual (take-home stays exact).
    // Runs for gross-only pay too: under gross_first the employer's part of
    // the history shortfall is borne, hence taxable as well. Otherwise the
    // first step returns 0 and the loop stops at once.
    let covered = 0n;
    for (let i = 0; ; i++) {
      if (i >= MAX_ITERATIONS)
        throw new RangeError("Employer-covered tax did not converge");
      const at = g + u + n + covered;
      const { tax: atTax } = taxOf(at);
      const next = atTax > 0n ? atTax - employeeShare(atTax, at) : 0n;
      if (next <= covered) break;
      covered = next;
    }
    x = g + u + n + covered;
    period = taxOf(x);
    tax = period.tax;
    // H >= 0: T >= H >= 0 (the annual tax rises with the base; TER >= 0).
    if (tax < 0n) throw new RangeError("Negative tax without a lebih potong");
    const w = employeeShare(tax, x);
    const employerPart = tax - w;
    allowance = allowanceOf(covered, employerPart);
    borne = employerPart - allowance;
    withheld = w + allowance;
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
