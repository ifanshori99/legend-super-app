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
// lines, S = employer-covered tax (allowance A + borne B), X = G+U+N+S.
// In the last period H = annual tax on the prior income alone - tax already
// paid (0 in a TER month) and T = H + D, D >= 0 the tax this month adds.
// - D follows this month's mix per policy (`proportional`: D x G* / X, G* the
//   gross-scheme part; `gross_first`: the tax G* would add alone, capped at D);
//   the employer part is Dr.
// - H is split into each payer's own balance of the prior year (by the
//   earlier scheme mix, else the payer history), unclamped: one payer's
//   overpayment never covers the other's shortfall (bead legend-mmgd).
// - Each payer nets its part of D with its balance: positive is charged
//   (withheld W from the employee; A or B for the company), negative refunded
//   to that payer. So withheld may exceed T beside an employer refund, and a
//   borne amount may stand beside an employee refund (beads legend-u1xq,
//   legend-mmgd).
// - W never exceeds the pay left: cap = gross lines + U + N - employee JHT/JP
//   (lowered by `employeeWithholdingCapIdr` when given), in every period (TER
//   months too, bead legend-4ndx). The employee's charge above the cap is an
//   employee receivable (`pph21ReceivableIdr`): the employer deposits it and
//   collects it from later pay (founder decision B8, bead legend-kn3n). It is
//   not a benefit, so it never enters X (no gross-up), and a later annual
//   recalculation counts it as tax the employee paid. Always withheld + borne
//   + receivable - employee refund - employer refund = T, the deposit.
// S is the least fixed point of S = max(0, Dr(X(S)) + employer balance),
// iterated from 0 (monotone, so it rises to the least solution). A = S x U /
// (U + N), B = the rest. Withheld = W + A, so the employee's take-home is
// exactly G + U + N - W + employee refund: the allowance cancels out.

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
  /**
   * Optional cap on the employee's PPh 21 (W): cash pay without the tax
   * allowance, minus every employee BPJS share (JHT, JP, health). It can only
   * lower the engine's own cap (gross lines + U + N - employeeDeductibleIdr);
   * the employee's tax above it is `pph21ReceivableIdr` (beads legend-4ndx,
   * legend-kn3n). Fill it with `payslipWithholdingCap` (payslip-tax.ts).
   */
  employeeWithholdingCapIdr?: Idr | number;
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
    /**
     * Employee receivable of earlier periods (results' `pph21ReceivableIdr`,
     * default 0): employee tax above the cap that the employer deposited.
     * Counts as tax paid by the employee, whether collected yet or not.
     */
    pph21ReceivableIdr?: Idr | number;
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
   * The employee's tax above the withholding cap: deposited by the employer,
   * owed back by the employee (employee receivable, founder decision B8).
   * Not in X. Pass the sum of earlier periods as `prior.pph21ReceivableIdr`.
   */
  pph21ReceivableIdr: Idr;
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

  const { g, grossLines, u, n, employeeG, coverU, coverN } = schemeSplit(
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
  // Employee tax above the cap in earlier periods, deposited by the employer
  // and owed back by the employee (employee receivable, founder B8).
  const priorReceivable = nonNegativeInt(
    input.prior.pph21ReceivableIdr ?? 0,
    "prior.pph21ReceivableIdr",
  );
  const priorTax = priorWithheld + priorBorne + priorReceivable;
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

  // Last period only: the history balance H = annual tax on the prior income
  // alone minus what was already paid (0 in a TER month): > 0 a shortfall
  // (kurang bayar), < 0 a credit (lebih potong Jan-Nov).
  const history = input.lastTaxPeriod ? taxOf(0n).tax : 0n;
  // Each payer's own balance of the prior year, unclamped (beads legend-6q7o,
  // legend-u1xq, legend-mmgd): employee + employer = H, each > 0 when that
  // payer underpaid its share and < 0 when it overpaid. With the earlier
  // scheme mix known, the annual tax on the prior income aP = priorTax + H is
  // shared by scheme base (`proportional`), or the employee's share is the tax
  // their gross-scheme pay carries alone (`gross_first`), and each payer's
  // balance is its share minus what it already paid. The two may differ in
  // sign: one payer's overpayment never covers the other's shortfall. Without
  // the mix, H follows the payer history (same sign for both), else (nothing
  // paid yet) this month's mix.
  const lineBase = g + u + n;
  let employerBalance = 0n;
  if (input.lastTaxPeriod && priorMix > 0n) {
    if (policy.mixedSchemeAllocation === "gross_first")
      employerBalance =
        history - (annualOf(priorGrossScheme).annualTax - priorEmployeeTax);
    else
      employerBalance =
        ((priorTax + history) * priorEmployerScheme) / priorMix -
        priorEmployerTax;
  } else if (history !== 0n && priorTax > 0n)
    // BigInt division truncates toward 0, so the employer's balance is the
    // smaller in size: the odd rupiah is the employee's, charged on a
    // shortfall (H > 0), refunded on a credit (H < 0).
    employerBalance = (history * priorEmployerTax) / priorTax;
  else if (history > 0n && lineBase > 0n)
    employerBalance = (history * (lineBase - employeeG)) / lineBase;
  const employeeBalance = history - employerBalance;

  // The tax this period adds, D = T - H >= 0 (T = D in a TER month), split by
  // this month's scheme mix: `proportional` by the employee's gross share
  // employeeG / X (gross lines plus their share of the employer benefit), so
  // the net / gross-up part is the company's and a net-only employee is never
  // charged for it; `gross_first` the tax the employee's gross components add
  // alone, capped at D. Nothing paid this period (X = 0): D = 0.
  const employeeAloneAdded = taxOf(employeeG).tax - history;
  const addedSplit = (at: bigint) => {
    const added = taxOf(at).tax - history;
    let employeePart: bigint;
    if (policy.mixedSchemeAllocation === "gross_first")
      employeePart = employeeAloneAdded < added ? employeeAloneAdded : added;
    else employeePart = at === 0n ? 0n : (added * employeeG) / at;
    return { employeePart, employerPart: added - employeePart };
  };

  const cashLeft = grossLines + u + n - deductible;
  let cap = cashLeft > 0n ? cashLeft : 0n;
  if (input.employeeWithholdingCapIdr !== undefined) {
    const callerCap = nonNegativeInt(
      input.employeeWithholdingCapIdr,
      "employeeWithholdingCapIdr",
    );
    if (callerCap < cap) cap = callerCap;
  }
  // Employer-covered tax S = max(0, Dr(X(S)) + employer balance): least fixed
  // point from 0. Dr rises with X, so the map is monotone. With the pro rata
  // floor it can dip by a rupiah; stop on the first non-increase and let the
  // borne amount absorb the residual (take-home stays exact).
  let covered = 0n;
  for (let i = 0; ; i++) {
    if (i >= MAX_ITERATIONS)
      throw new RangeError("Employer-covered tax did not converge");
    const { employerPart } = addedSplit(lineBase + covered);
    const next = employerPart + employerBalance;
    if (next <= covered) break;
    covered = next;
  }
  const x = lineBase + covered;
  const period = taxOf(x);
  const tax = period.tax;
  const { employeePart, employerPart } = addedSplit(x);
  // Each payer nets its part of D with its own balance: positive is charged,
  // negative refunded to that payer. The employee's charge above the cap is
  // the employee receivable, never moved to the employer (founder B8).
  const charge = employeePart + employeeBalance;
  const w = charge <= 0n ? 0n : charge < cap ? charge : cap;
  const receivable = charge > cap ? charge - cap : 0n;
  const employeeRefund = charge < 0n ? -charge : 0n;
  const employerNet = employerPart + employerBalance;
  let allowance = 0n;
  let borne = 0n;
  let employerRefund = 0n;
  if (employerNet >= 0n) {
    allowance =
      coverU + coverN > 0n ? (covered * coverU) / (coverU + coverN) : 0n;
    if (allowance > employerNet) allowance = employerNet;
    borne = employerNet - allowance;
  } else employerRefund = -employerNet;
  const withheld = w + allowance;

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
    pph21ReceivableIdr: toIdr(receivable),
    noTaxIdSurchargeApplied: surchargeApplies,
    annual: period.annual,
  };
}
