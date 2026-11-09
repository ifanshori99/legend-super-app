// PPh 21 take-home cap (beads legend-4ndx; brief
// docs/briefs/sub-pph21-takehome-cap.md).
//
// Seeded property tests: build a year month by month (TER months, then
// December as lastTaxPeriod), the prior accumulated from each month's result
// (including pph21ReceivableIdr), grossSchemeBaseIdr from pph21GrossSchemeBase,
// employerSchemeBaseIdr = taxable gross - gross base. The cap applies in every
// period, TER months too, so the fuzz checks every month of the year, for both
// mixedSchemeAllocation policies:
//   1. employee withheld W = pph21WithheldIdr - taxAllowanceIdr <= cap, where
//      cap = max(0, sum of gross + gross_up + net line amounts - deductible),
//      lowered by employeeWithholdingCapIdr when the caller gives one;
//   2. withheld + employer borne + receivable - refund - employer refund =
//      pph21Idr (the deposit);
//   3. take-home = pay - W + refund - employeeDeductible >= 0;
//   4. refunds >= 0 and no payer is both charged and refunded;
//   5. pph21ReceivableIdr >= 0: whatever the pay cannot cover is the employee's
//      receivable (founder decision B8, bead legend-kn3n), never borne by the
//      company and never grossed up;
//   6. the employee's refund <= the tax withheld from the employee in the
//      earlier periods plus their receivable (sum pph21WithheldIdr - sum
//      taxAllowanceIdr + sum pph21ReceivableIdr);
//   7. the employer's refund <= sum borne + sum allowance of the earlier periods.
// The year fuzz also has months with only an employer benefit (no salary, cap
// 0, so the employee's whole tax is a receivable in a TER month) and months
// with a benefit beside the lines. Fixed cases (CTO S2, architect C2, reviewer
// K1/K2/K3/K4, caller cap lower / higher than the default) pin the exact
// amounts, hand computed in the comments below (W capped at the available
// pay, the excess is the employee's receivable, the deposit stays T; the
// receivable counts as tax the employee owes, so December never charges it
// again and a refund of it goes to the employee).
//
// Assumptions (spec silent): a caller cap above the default cap changes nothing
// (the input can only lower the cap); "pay" is the sum of the period's line
// amounts (the cap's own base); a payer is "charged" in a period when its
// withheld (net of the allowance for the employee) or borne tax is > 0; the
// employeeDeductibleIdr is the same in each month of a case (and deducted from
// the pay on the same footing), except that a month without salary has none
// (a BPJS deduction needs pay to come out of).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PPH21_POLICY,
  computePph21Period,
  pph21GrossSchemeBase,
  type Pph21Line,
  type Pph21PolicyParameters,
} from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Scheme = Pph21Line["taxScheme"];
type Month = { amountIdr: number; taxScheme: Scheme }[];

const ALLOCATIONS = ["proportional", "gross_first"] as const;
const SCHEMES: readonly Scheme[] = ["gross", "gross_up", "net"];
const CASES = 1500;
const SEED = 0x4e9d21;

const policyOf = (
  allocation: Pph21PolicyParameters["mixedSchemeAllocation"],
): Pph21PolicyParameters => ({
  ...DEFAULT_PPH21_POLICY,
  mixedSchemeAllocation: allocation,
});

// mulberry32: small deterministic PRNG, no dependency.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Outcome = {
  pay: number;
  cap: number;
  w: number;
  taxIdr: number;
  deposit: number;
  takeHome: number;
  refund: number;
  employerRefund: number;
  chargedAndRefunded: boolean;
  x: number;
  borne: number;
  allowance: number;
  receivable: number;
  /** Tax withheld from the employee in the earlier periods (withheld - allowance). */
  priorEmployeeTax: number;
  /** Tax the company paid in the earlier periods (borne + allowance). */
  priorEmployerTax: number;
};

/** One month: its lines plus the optional extras the fuzz and K1 need. */
type Spec = {
  lines: Month;
  benefitIdr?: number;
  /** Scheme of the agreement, needed for a month with only a benefit. */
  contract?: Scheme;
  /** Overrides the case's deductible (a month without pay has none). */
  deductibleIdr?: number;
  /** employeeWithholdingCapIdr of a TER month (December takes the argument). */
  capIdr?: number;
};

const asSpec = (month: Month | Spec): Spec =>
  Array.isArray(month) ? { lines: month } : month;

/** All twelve periods of the year: index 0..10 TER months, 11 December. */
function simulate(
  months: readonly (Month | Spec)[],
  december: Month | Spec,
  deductibleIdr: number,
  allocation: Pph21PolicyParameters["mixedSchemeAllocation"],
  callerCapIdr?: number,
  lastMonthsWorked = 12,
  /**
   * December only (K4): "as_withheld" passes the history's receivable as
   * withheld tax (the oracle: the same tax as if the employee had paid it),
   * "dropped" passes the history without it.
   */
  priorReceivable: "kept" | "as_withheld" | "dropped" = "kept",
): Outcome[] {
  const policy = policyOf(allocation);
  const prior = {
    taxableGrossIdr: 0,
    employeeDeductibleIdr: 0,
    pph21WithheldIdr: 0,
    pph21EmployerBorneIdr: 0,
    taxAllowanceIdr: 0,
    pph21ReceivableIdr: 0,
    grossSchemeBaseIdr: 0,
    employerSchemeBaseIdr: 0,
  };
  const outcomes: Outcome[] = [];
  const run = (
    spec: Spec,
    lastTaxPeriod: boolean,
    monthsWorked: number,
    capArg: number | undefined,
    receivableMode: "kept" | "as_withheld" | "dropped" = "kept",
  ) => {
    const deductible = spec.deductibleIdr ?? deductibleIdr;
    const benefit = spec.benefitIdr ?? 0;
    const r = computePph21Period(REFERENCE_TABLES, policy, {
      ptkpStatus: "TK/0",
      hasTaxId: true,
      lastTaxPeriod,
      monthsWorked,
      taxableLines: spec.lines,
      employerBenefitIdr: benefit,
      ...(spec.contract === undefined
        ? {}
        : { contractTaxScheme: spec.contract }),
      employeeDeductibleIdr: deductible,
      ...(capArg === undefined ? {} : { employeeWithholdingCapIdr: capArg }),
      prior:
        receivableMode === "kept"
          ? { ...prior }
          : {
              ...prior,
              pph21ReceivableIdr: 0,
              ...(receivableMode === "as_withheld"
                ? {
                    pph21WithheldIdr:
                      prior.pph21WithheldIdr + prior.pph21ReceivableIdr,
                  }
                : {}),
            },
    });
    const pay = spec.lines.reduce((sum, line) => sum + line.amountIdr, 0);
    const w = r.pph21WithheldIdr - r.taxAllowanceIdr;
    const refund = r.pph21RefundIdr;
    const employerRefund = r.pph21EmployerRefundIdr;
    outcomes.push({
      pay,
      cap: Math.min(
        Math.max(0, pay - deductible),
        capArg ?? Number.MAX_SAFE_INTEGER,
      ),
      w,
      taxIdr: r.pph21Idr,
      deposit:
        r.pph21WithheldIdr +
        r.pph21EmployerBorneIdr +
        r.pph21ReceivableIdr -
        refund -
        employerRefund,
      takeHome: pay - w + refund - deductible,
      refund,
      employerRefund,
      x: r.taxableGrossIdr,
      borne: r.pph21EmployerBorneIdr,
      allowance: r.taxAllowanceIdr,
      receivable: r.pph21ReceivableIdr,
      priorEmployeeTax:
        prior.pph21WithheldIdr -
        prior.taxAllowanceIdr +
        prior.pph21ReceivableIdr,
      priorEmployerTax: prior.pph21EmployerBorneIdr + prior.taxAllowanceIdr,
      chargedAndRefunded:
        (refund > 0 && w > 0) ||
        (employerRefund > 0 && r.pph21EmployerBorneIdr > 0),
    });
    const grossBase = Number(
      pph21GrossSchemeBase(spec.lines, benefit, spec.contract),
    );
    prior.taxableGrossIdr += r.taxableGrossIdr;
    prior.employeeDeductibleIdr += deductible;
    prior.pph21WithheldIdr += r.pph21WithheldIdr;
    prior.pph21EmployerBorneIdr += r.pph21EmployerBorneIdr;
    prior.taxAllowanceIdr += r.taxAllowanceIdr;
    prior.pph21ReceivableIdr += r.pph21ReceivableIdr;
    prior.grossSchemeBaseIdr += grossBase;
    prior.employerSchemeBaseIdr += r.taxableGrossIdr - grossBase;
  };
  months.forEach((month, index) => {
    const spec = asSpec(month);
    run(spec, false, index + 1, spec.capIdr);
  });
  run(asSpec(december), true, lastMonthsWorked, callerCapIdr, priorReceivable);
  return outcomes;
}

/** December only (the case the earlier rounds of this file pinned). */
function runYear(
  months: readonly (Month | Spec)[],
  december: Month | Spec,
  deductibleIdr: number,
  allocation: Pph21PolicyParameters["mixedSchemeAllocation"],
  callerCapIdr?: number,
): Outcome {
  const outcome = simulate(
    months,
    december,
    deductibleIdr,
    allocation,
    callerCapIdr,
  ).at(-1);
  if (outcome === undefined) throw new Error("no outcome");
  return outcome;
}

function violationsOf(o: Outcome): string[] {
  const found: string[] = [];
  if (o.w > o.cap) found.push(`W ${o.w} > cap ${o.cap}`);
  if (o.deposit !== o.taxIdr)
    found.push(`deposit ${o.deposit} != pph21Idr ${o.taxIdr}`);
  if (o.takeHome < 0) found.push(`take-home ${o.takeHome} < 0`);
  if (o.refund < 0 || o.employerRefund < 0)
    found.push(`negative refund ${o.refund} / ${o.employerRefund}`);
  if (o.chargedAndRefunded) found.push("a payer is charged and refunded");
  if (o.receivable < 0) found.push(`receivable ${o.receivable} < 0`);
  if (o.refund > o.priorEmployeeTax)
    found.push(
      `employee refund ${o.refund} > employee tax of earlier periods ${o.priorEmployeeTax}`,
    );
  if (o.employerRefund > o.priorEmployerTax)
    found.push(
      `employer refund ${o.employerRefund} > employer tax of earlier periods ${o.priorEmployerTax}`,
    );
  return found;
}

const roundTo = (value: number, step: number) =>
  Math.round(value / step) * step;

function randomLines(
  next: () => number,
  profile: Scheme | "mixed",
  min: number,
  max: number,
): Month {
  const count = 1 + Math.floor(next() * 2);
  return Array.from({ length: count }, () => ({
    amountIdr: Math.max(min, roundTo(min + next() * (max - min), 1_000)),
    taxScheme:
      profile === "mixed"
        ? SCHEMES[Math.floor(next() * SCHEMES.length)]!
        : profile,
  }));
}

function randomCase(next: () => number) {
  // Each month keeps one scheme profile; the pay level shifts across the year
  // (a raise, a scheme change, a short December) so the history and December
  // disagree, which is where the over-withholding appears.
  const pick = (): Scheme | "mixed" =>
    next() < 0.25 ? "mixed" : SCHEMES[Math.floor(next() * SCHEMES.length)]!;
  const levels = [
    [4_000_000, 8_000_000],
    [8_000_000, 20_000_000],
    [20_000_000, 40_000_000],
  ] as const;
  const firstProfile = pick();
  const secondProfile = pick();
  const split = 1 + Math.floor(next() * 10);
  const level = () => levels[Math.floor(next() * levels.length)]!;
  const [lowA, highA] = level();
  const [lowB, highB] = level();
  const months = Array.from({ length: 11 }, (_, index) =>
    index < split
      ? randomLines(next, firstProfile, lowA, highA)
      : randomLines(next, secondProfile, lowB, highB),
  );
  const decemberProfile = pick();
  const [lowD, highD] =
    next() < 0.4
      ? ([1_000_000, 6_000_000] as const)
      : next() < 0.5
        ? ([lowB, highB] as const)
        : level();
  const december = randomLines(next, decemberProfile, lowD, highD);
  const deductibleIdr = next() < 0.4 ? roundTo(next() * 400_000, 1_000) : 0;
  return { months, december, deductibleIdr };
}

const describeCase = (c: ReturnType<typeof randomCase>, index: number) =>
  `case ${index}: deductible ${c.deductibleIdr}, months ${JSON.stringify(
    c.months,
  )}, december ${JSON.stringify(c.december)}`;

describe("legend-4ndx: December take-home cap (seeded fuzz)", () => {
  for (const allocation of ALLOCATIONS) {
    it(`withheld <= cap, deposit = tax, take-home >= 0, refunds >= 0 (${allocation})`, () => {
      const next = prng(SEED);
      const bad: string[] = [];
      for (let index = 0; index < CASES; index += 1) {
        const c = randomCase(next);
        const found = violationsOf(
          runYear(c.months, c.december, c.deductibleIdr, allocation),
        );
        if (found.length > 0)
          bad.push(`${found.join("; ")} | ${describeCase(c, index)}`);
      }
      expect(
        bad,
        `${bad.length} of ${CASES} cases violate an invariant (${allocation}). First: ${bad[0] ?? "none"}`,
      ).toEqual([]);
    });
  }
});

describe("legend-4ndx: December take-home cap with a caller cap (seeded fuzz)", () => {
  for (const allocation of ALLOCATIONS) {
    it(`a random employeeWithholdingCapIdr <= the default cap is never exceeded; the other invariants hold (${allocation})`, () => {
      const next = prng(SEED + 1);
      const bad: string[] = [];
      for (let index = 0; index < CASES; index += 1) {
        const c = randomCase(next);
        const pay = c.december.reduce((sum, line) => sum + line.amountIdr, 0);
        const defaultCap = Math.max(0, pay - c.deductibleIdr);
        const callerCap = roundTo(next() * defaultCap, 1_000);
        const outcome = runYear(
          c.months,
          c.december,
          c.deductibleIdr,
          allocation,
          Math.min(callerCap, defaultCap),
        );
        const found = violationsOf(outcome);
        if (found.length > 0)
          bad.push(
            `${found.join("; ")} | caller cap ${callerCap} | ${describeCase(c, index)}`,
          );
      }
      expect(
        bad,
        `${bad.length} of ${CASES} cases violate an invariant (${allocation}, caller cap). First: ${bad[0] ?? "none"}`,
      ).toEqual([]);
    });
  }
});

// A year with employer benefits and months without salary, so the cap bites in
// TER months and the prior carries pph21ReceivableIdr into December.
function randomBenefitYear(next: () => number) {
  const base = randomCase(next);
  const payOf = (lines: Month) =>
    lines.reduce((sum, line) => sum + line.amountIdr, 0);
  const benefitOnly = (): Spec => ({
    lines: [],
    benefitIdr: roundTo(100_000 + next() * 7_900_000, 1_000),
    contract: SCHEMES[Math.floor(next() * SCHEMES.length)]!,
    deductibleIdr: 0,
  });
  const months: Spec[] = base.months.map((lines) => {
    const roll = next();
    if (roll < 0.2) return benefitOnly();
    const spec: Spec = { lines };
    if (roll < 0.55)
      spec.benefitIdr = roundTo(50_000 + next() * 450_000, 1_000);
    if (next() < 0.25) {
      const defaultCap = Math.max(0, payOf(lines) - base.deductibleIdr);
      spec.capIdr = roundTo(next() * defaultCap, 1_000);
    }
    return spec;
  });
  const roll = next();
  const december: Spec =
    roll < 0.1
      ? benefitOnly()
      : roll < 0.4
        ? {
            lines: base.december,
            benefitIdr: roundTo(50_000 + next() * 450_000, 1_000),
          }
        : { lines: base.december };
  return { months, december, deductibleIdr: base.deductibleIdr };
}

describe("legend-4ndx: the cap holds in every month, benefit-only months included (seeded fuzz)", () => {
  for (const allocation of ALLOCATIONS) {
    it(`each of the 12 periods keeps W <= cap, deposit = tax, take-home >= 0, refunds >= 0, receivable >= 0 (${allocation})`, () => {
      const next = prng(SEED + 2);
      const bad: string[] = [];
      let capBitInTerMonth = 0;
      for (let index = 0; index < CASES; index += 1) {
        const c = randomBenefitYear(next);
        const outcomes = simulate(
          c.months,
          c.december,
          c.deductibleIdr,
          allocation,
        );
        outcomes.forEach((o, month) => {
          if (month < 11 && o.receivable > 0) capBitInTerMonth += 1;
          const found = violationsOf(o);
          if (found.length > 0)
            bad.push(
              `month ${month + 1}: ${found.join("; ")} | case ${index}: deductible ${c.deductibleIdr}, months ${JSON.stringify(
                c.months,
              )}, december ${JSON.stringify(c.december)}`,
            );
        });
      }
      expect(
        bad,
        `${bad.length} period results violate an invariant (${allocation}, year fuzz). First: ${bad[0] ?? "none"}`,
      ).toEqual([]);
      // Guard against a fuzz that never reaches the case it is for.
      expect(capBitInTerMonth).toBeGreaterThan(0);
    });
  }
});

describe("legend-4ndx: CTO S2 (net 30 jt Jan-Jun, gross 5.4 jt Jul-Nov, December gross 1 jt)", () => {
  const repeat = (count: number, amountIdr: number, taxScheme: Scheme) =>
    Array.from({ length: count }, (): Month => [{ amountIdr, taxScheme }]);
  const months = [
    ...repeat(6, 30_000_000, "net"),
    ...repeat(5, 5_400_000, "gross"),
  ];
  const december: Month = [{ amountIdr: 1_000_000, taxScheme: "gross" }];

  for (const allocation of ALLOCATIONS) {
    it(`keeps every invariant (${allocation})`, () => {
      const outcome = runYear(months, december, 0, allocation);
      expect(
        violationsOf(outcome),
        `S2 ${allocation}: ${JSON.stringify(outcome)}`,
      ).toEqual([]);
      // The employee cannot be charged more than the 1 jt they are paid.
      expect(outcome.w).toBeLessThanOrEqual(1_000_000);
    });
  }

  // Hand computation (architect, brief section "Hitung tangan"), TK/0, TER
  // months Jan-Nov, December gross 1_000_000, cap = 1_000_000 + 0 + 0 - 0.
  // Prior: the net months' tax is added to X (net = the company pays it), so
  // prior X = 236_302_326 and prior tax pET = 29_302_326 (all employer-borne), Gs = 27_000_000 (5 x 5_400_000),
  // E = 209_302_326 = prior X - Gs. December: X = 1_000_000, annual tax
  // aP = 20_445_300, H = aP - priorTax = -8_857_026, D = 150_000, so
  // T = H + D = -8_707_026 (a refund of tax overpaid in Jan-Jun).
  it("S2 proportional: W 1_000_000 (the whole pay), receivable 1_486_089, the company is refunded 11_193_115, take-home 0", () => {
    // bR = floor(aP x E / mix) - pET = 18_109_211 - 29_302_326 = -11_193_115,
    // bE = H - bR = 2_336_089, so the employee's own amount is De + bE =
    // 150_000 + 2_336_089 = 2_486_089. Cap 1_000_000: W = 1_000_000 and the
    // excess 1_486_089 is the employee's receivable (founder decision B8), not
    // a company cost. The company's side is its refund alone, exactly the
    // balance bR: refund 11_193_115 (before B8 the excess was netted into the
    // company's refund, 9_707_026). Deposit: W + receivable - refund =
    // 1_000_000 + 1_486_089 - 11_193_115 = -8_707_026 = T.
    const o = runYear(months, december, 0, "proportional");
    expect(o.x).toBe(1_000_000);
    expect(o.taxIdr).toBe(-8_707_026);
    expect(o.w).toBe(1_000_000);
    expect(o.borne).toBe(0);
    expect(o.allowance).toBe(0);
    expect(o.receivable).toBe(1_486_089);
    expect(o.refund).toBe(0);
    expect(o.employerRefund).toBe(11_193_115);
    expect(o.deposit).toBe(-8_707_026);
    expect(o.takeHome).toBe(0);
  });

  it("S2 gross_first: unchanged by the cap (W 150_000, take-home 850_000, the company is refunded 8_857_026)", () => {
    // annual(Gs) is 0 under gross_first, so the employee's own amount is only
    // D = 150_000, below the cap 1_000_000: no excess. The company gets the
    // rest of the overpayment: H = -8_857_026 -> refund 8_857_026.
    // Deposit: 150_000 - 8_857_026 = -8_707_026 = T.
    const o = runYear(months, december, 0, "gross_first");
    expect(o.x).toBe(1_000_000);
    expect(o.taxIdr).toBe(-8_707_026);
    expect(o.w).toBe(150_000);
    expect(o.borne).toBe(0);
    expect(o.receivable).toBe(0);
    expect(o.refund).toBe(0);
    expect(o.employerRefund).toBe(8_857_026);
    expect(o.deposit).toBe(-8_707_026);
    expect(o.takeHome).toBe(850_000);
  });
});

describe("legend-4ndx: C2 (TK/0, gross 10 jt Jan-Nov, December gross 200_000) the excess over the pay is the employee's receivable", () => {
  // Jan-Nov: X = 10_000_000 each, TER A 2% => 200_000 a month, prior tax
  // 2_200_000 (all withheld), prior X 110_000_000 (all gross).
  // annual(110_000_000) = cost 5_500_000, PKP 50_500_000, 5% = 2_525_000, so
  // H = 2_525_000 - 2_200_000 = 325_000, all the employee's (bE = 325_000,
  // bR = 0). Default cap = 200_000 (gross line 200_000).
  // December: the employee's own amount is T = H + D with D the tax of the
  // 200_000 pay (X = 200_000, gross 110_200_000, cost 5_510_000, PKP
  // 50_690_000, annual 2_534_500): T = 334_500, above the cap. Founder
  // decision B8: no gross-up and no company share, so X stays 200_000 and
  // the deposit stays T = 334_500; W = 200_000 (the whole pay) and the
  // 134_500 above it is the employee's receivable. (Before B8 the company
  // bore the excess and X grew to 341_200 by fixed point.) Take-home 0.
  const december: Month = [{ amountIdr: 200_000, taxScheme: "gross" }];
  const months = Array.from({ length: 11 }, (): Month => [
    { amountIdr: 10_000_000, taxScheme: "gross" },
  ]);

  for (const allocation of ALLOCATIONS) {
    it(`W 200_000, receivable 134_500, no borne tax, X 200_000, T 334_500, take-home 0 (${allocation})`, () => {
      const o = runYear(months, december, 0, allocation);
      expect(violationsOf(o)).toEqual([]);
      expect(o.x).toBe(200_000);
      expect(o.taxIdr).toBe(334_500);
      expect(o.w).toBe(200_000);
      expect(o.borne).toBe(0);
      expect(o.allowance).toBe(0);
      expect(o.receivable).toBe(134_500);
      expect(o.refund).toBe(0);
      expect(o.employerRefund).toBe(0);
      expect(o.deposit).toBe(334_500);
      expect(o.takeHome).toBe(0);
    });

    it(`a caller cap 100_000 below the default 200_000 lowers W to 100_000 and raises the receivable to 234_500, X does not grow (${allocation})`, () => {
      // Same history and same T = 334_500 (X stays 200_000: the excess is a
      // receivable, not a taxable benefit of the company). cap = min(200_000,
      // 100_000) = 100_000, so the receivable is T - 100_000 = 234_500; the
      // employee keeps 200_000 - 100_000 = 100_000.
      const o = runYear(months, december, 0, allocation, 100_000);
      expect(violationsOf(o)).toEqual([]);
      expect(o.x).toBe(200_000);
      expect(o.taxIdr).toBe(334_500);
      expect(o.w).toBe(100_000);
      expect(o.borne).toBe(0);
      expect(o.receivable).toBe(234_500);
      expect(o.refund).toBe(0);
      expect(o.employerRefund).toBe(0);
      expect(o.deposit).toBe(334_500);
      expect(o.takeHome).toBe(100_000);
    });

    it(`a caller cap 500_000 above the default 200_000 is ignored: same as without it (${allocation})`, () => {
      const without = runYear(months, december, 0, allocation);
      const o = runYear(months, december, 0, allocation, 500_000);
      expect(o).toEqual(without);
      expect(o.x).toBe(200_000);
      expect(o.w).toBe(200_000);
      expect(o.receivable).toBe(134_500);
    });
  }
});

describe("legend-4ndx: K1 (reviewer round 1) a TER-month excess is an employee receivable, not charged back in December", () => {
  // TK/0 with a tax id. January: no salary, only an employer benefit of
  // 8_000_000 under a `gross` agreement (cap 0: the employee has no pay to
  // withhold from). February-December: gross 10_000_000 a month, no benefit,
  // no deductible.
  //
  // January (TER A, 1.5% for X between 7_500_000 and 8_550_000): the benefit
  // is the employee's scheme, so the tax 8_000_000 x 1.5% = 120_000 is the
  // employee's, above the cap 0. Founder decision B8: no gross-up, no company
  // share: X stays 8_000_000, T = 120_000 is deposited by the company, W 0,
  // B 0, and the whole 120_000 is the employee's receivable. (Before B8 the
  // company took it over: X 8_121_827, B 121_827.) Same for both policies.
  //
  // February-November: X = 10_000_000, TER 2% => 200_000 withheld each (ten
  // months, 2_000_000). Prior at December: X 108_000_000 (8_000_000 + ten x
  // 10_000_000), withheld 2_000_000, receivable 120_000, no borne tax, all
  // gross scheme. The receivable counts as tax the employee owes, so priorTax
  // = 2_120_000 and December does not charge it a second time.
  // December X = 10_000_000, cumulated 118_000_000: cost min(5%, 6_000_000) =
  // 5_900_000, net 112_100_000, PKP 58_100_000 x 5% = 2_905_000, so
  // T = 2_905_000 - 2_120_000 = 785_000, W = 785_000, B 0, no refund.
  const january: Spec = {
    lines: [],
    benefitIdr: 8_000_000,
    contract: "gross",
  };
  const months: Spec[] = [
    january,
    ...Array.from({ length: 10 }, (): Spec => ({
      lines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
    })),
  ];
  const december: Month = [{ amountIdr: 10_000_000, taxScheme: "gross" }];

  for (const allocation of ALLOCATIONS) {
    it(`January receivable 120_000 (X 8_000_000, B 0); December W 785_000, B 0, no charge back (${allocation})`, () => {
      const all = simulate(months, december, 0, allocation);
      const [jan, , , , , , , , , , , dec] = all;
      if (jan === undefined || dec === undefined) throw new Error("no outcome");
      for (const o of all) expect(violationsOf(o)).toEqual([]);
      expect(jan.cap).toBe(0);
      expect(jan.x).toBe(8_000_000);
      expect(jan.taxIdr).toBe(120_000);
      expect(jan.w).toBe(0);
      expect(jan.allowance).toBe(0);
      expect(jan.borne).toBe(0);
      expect(jan.receivable).toBe(120_000);
      expect(jan.deposit).toBe(120_000);
      expect(jan.takeHome).toBe(0);
      expect(dec.x).toBe(10_000_000);
      expect(dec.taxIdr).toBe(785_000);
      expect(dec.w).toBe(785_000);
      expect(dec.borne).toBe(0);
      expect(dec.allowance).toBe(0);
      expect(dec.refund).toBe(0);
      expect(dec.employerRefund).toBe(0);
      expect(dec.receivable).toBe(0);
      expect(dec.deposit).toBe(785_000);
      expect(dec.takeHome).toBe(10_000_000 - 785_000);
    });
  }
});

// A year that starts with benefit-only months (the company takes over the
// employee's tax, cap excess > 0) and then pays a small salary (1 jt to 5.3 jt,
// below the TER 0% limit and below the PTKP when annualised). December's
// annual tax is then below the tax already paid (H < 0), the case where the
// refund must go to the right payer.
function randomBenefitThenLowPayYear(next: () => number) {
  const scheme = (): Scheme => SCHEMES[Math.floor(next() * SCHEMES.length)]!;
  const benefitOnly = (): Spec => ({
    lines: [],
    benefitIdr: roundTo(500_000 + next() * 11_500_000, 1_000),
    contract: scheme(),
    deductibleIdr: 0,
  });
  const lowPay = (): Month => [
    {
      amountIdr: roundTo(1_000_000 + next() * 4_300_000, 1_000),
      taxScheme: scheme(),
    },
  ];
  const benefitMonths = 1 + Math.floor(next() * 4);
  const months: Spec[] = Array.from({ length: 11 }, (_, index) =>
    index < benefitMonths ? benefitOnly() : { lines: lowPay() },
  );
  const december: Month = [
    {
      amountIdr: roundTo(1_000_000 + next() * 4_300_000, 1_000),
      taxScheme: scheme(),
    },
  ];
  return { months, december, benefitMonths };
}

describe("legend-4ndx: benefit-only months then a small salary (H < 0), every period (seeded fuzz)", () => {
  for (const allocation of ALLOCATIONS) {
    it(`no refund exceeds the tax that payer paid in earlier periods; the other invariants hold (${allocation})`, () => {
      const next = prng(SEED + 3);
      const bad: string[] = [];
      let employerRefunded = 0;
      for (let index = 0; index < CASES; index += 1) {
        const c = randomBenefitThenLowPayYear(next);
        const outcomes = simulate(c.months, c.december, 0, allocation);
        outcomes.forEach((o, month) => {
          if (o.employerRefund > 0) employerRefunded += 1;
          const found = violationsOf(o);
          if (found.length > 0)
            bad.push(
              `month ${month + 1}: ${found.join("; ")} | case ${index}: months ${JSON.stringify(
                c.months,
              )}, december ${JSON.stringify(c.december)}`,
            );
        });
      }
      expect(
        bad,
        `${bad.length} period results violate an invariant (${allocation}, benefit then low pay). First: ${bad[0] ?? "none"}`,
      ).toEqual([]);
      // Guard: the fuzz must reach the case it is for (a refund to the
      // company for the tax it took over).
      expect(employerRefunded).toBeGreaterThan(0);
    });
  }
});

describe("legend-4ndx: K2 (reviewer round 2) a refund of a receivable goes to the employee, the company is not refunded", () => {
  // TK/0 with a tax id. January: only an employer benefit of 8_000_000 under a
  // `gross` agreement (same as K1: X 8_000_000, T 120_000, W 0, B 0,
  // receivable 120_000). February-December: gross 1_000_000 a month, below the
  // TER 0% limit (5_400_000), no deductible.
  //
  // February-November: TER 0%, nothing withheld. Prior at December: X =
  // 8_000_000 + 10 x 1_000_000 = 18_000_000, withheld 0, receivable 120_000.
  // December: X = 1_000_000, annual(18_000_000): cost 900_000, net
  // 17_100_000 < PTKP 54_000_000, PKP 0, annual tax 0. So H = 0 - priorTax
  // (120_000) = -120_000, D = 0, T = -120_000: the year's tax is 0, so the
  // 120_000 the company deposited for the employee in January comes back.
  // Under B8 that money was the employee's (their receivable), so the refund
  // is the employee's: refund 120_000 as an earning (the planner nets it
  // against the open receivable), the company's refund is 0 and December's
  // receivable is 0. Deposit: 0 - 120_000 = T. Take-home = 1_000_000 + the
  // refund 120_000.
  const january: Spec = { lines: [], benefitIdr: 8_000_000, contract: "gross" };
  const months: Spec[] = [
    january,
    ...Array.from({ length: 10 }, (): Spec => ({
      lines: [{ amountIdr: 1_000_000, taxScheme: "gross" }],
    })),
  ];
  const december: Month = [{ amountIdr: 1_000_000, taxScheme: "gross" }];

  for (const allocation of ALLOCATIONS) {
    it(`December: X 1_000_000, T -120_000, W 0, employee refund 120_000, company refund 0 (${allocation})`, () => {
      const all = simulate(months, december, 0, allocation);
      const jan = all[0];
      const dec = all.at(-1);
      if (jan === undefined || dec === undefined) throw new Error("no outcome");
      for (const o of all) expect(violationsOf(o)).toEqual([]);
      expect(jan.borne).toBe(0);
      expect(jan.receivable).toBe(120_000);
      expect(jan.w).toBe(0);
      for (const o of all.slice(1, 11)) expect(o.w).toBe(0);
      expect(dec.x).toBe(1_000_000);
      expect(dec.taxIdr).toBe(-120_000);
      expect(dec.w).toBe(0);
      expect(dec.borne).toBe(0);
      expect(dec.allowance).toBe(0);
      expect(dec.receivable).toBe(0);
      expect(dec.refund).toBe(120_000);
      expect(dec.employerRefund).toBe(0);
      expect(dec.deposit).toBe(-120_000);
      expect(dec.takeHome).toBe(1_000_000 + 120_000);
    });
  }
});

describe("legend-4ndx: K3 (reviewer round 2) the employee leaves in February (monthsWorked 2, last period)", () => {
  // Same January as K2 (benefit-only 8_000_000, `gross` agreement, X
  // 8_000_000, receivable 120_000). February is the last tax period
  // (monthsWorked 2): gross pay 1_000_000, X = 1_000_000.
  // Cumulated X = 9_000_000, nowhere near the PTKP (54_000_000 for the year),
  // so the tax of the period is 0 and H = 0 - 120_000 = -120_000, D = 0,
  // T = -120_000. As in K2 the refund is the employee's (the 120_000 was
  // their receivable): refund 120_000, company refund 0.
  const january: Spec = { lines: [], benefitIdr: 8_000_000, contract: "gross" };
  const february: Month = [{ amountIdr: 1_000_000, taxScheme: "gross" }];

  for (const allocation of ALLOCATIONS) {
    it(`February: X 1_000_000, T -120_000, W 0, employee refund 120_000, company refund 0 (${allocation})`, () => {
      const all = simulate([january], february, 0, allocation, undefined, 2);
      expect(all).toHaveLength(2);
      const [jan, feb] = all;
      if (jan === undefined || feb === undefined) throw new Error("no outcome");
      for (const o of all) expect(violationsOf(o)).toEqual([]);
      expect(jan.borne).toBe(0);
      expect(jan.receivable).toBe(120_000);
      expect(jan.w).toBe(0);
      expect(feb.x).toBe(1_000_000);
      expect(feb.taxIdr).toBe(-120_000);
      expect(feb.w).toBe(0);
      expect(feb.borne).toBe(0);
      expect(feb.receivable).toBe(0);
      expect(feb.refund).toBe(120_000);
      expect(feb.employerRefund).toBe(0);
      expect(feb.deposit).toBe(-120_000);
      expect(feb.takeHome).toBe(1_000_000 + 120_000);
    });
  }
});

describe("legend-4ndx: K4 (architect round 2) an over-withheld year: the receivable counts as tax the employee owes, December does not charge it again", () => {
  // TK/0 with a tax id, no deductible.
  //   January : only an employer benefit of 8_000_000 under a `gross` agreement
  //             (as K1: X 8_000_000, T 120_000, W 0, B 0, receivable 120_000).
  //   February: gross 30_000_000, TER 12% => 3_600_000 withheld (over-withheld
  //             once the year is annualised).
  //   Mar-Nov : gross 5_000_000, TER 0% (nine months).
  //   December: gross 60_000_000 (cap 60_000_000, never binds), last period.
  //
  // Prior at December: X 83_000_000, withheld 3_600_000, receivable 120_000, no
  // borne tax, priorTax = 3_720_000, all gross scheme. Cumulated X with
  // December 143_000_000: cost capped at 6_000_000, net 137_000_000, PKP
  // 83_000_000: 5% x 60_000_000 + 15% x 23_000_000 = 6_450_000, so
  // T = 6_450_000 - 3_720_000 = 2_730_000 = W (both policies: no employer
  // share), B 0, no refund, no new receivable.
  //
  // Oracle (architect, B8): the result is the one the engine gave when the
  // January tax was withheld from the employee (commit 6e20273a): the same
  // history with the receivable passed as withheld tax gives the same
  // December. Dropping the receivable from the history charges it back: W is
  // exactly 120_000 higher (2_850_000).
  const january: Spec = { lines: [], benefitIdr: 8_000_000, contract: "gross" };
  const months: Spec[] = [
    january,
    { lines: [{ amountIdr: 30_000_000, taxScheme: "gross" }] },
    ...Array.from({ length: 9 }, (): Spec => ({
      lines: [{ amountIdr: 5_000_000, taxScheme: "gross" }],
    })),
  ];
  const december: Month = [{ amountIdr: 60_000_000, taxScheme: "gross" }];

  for (const allocation of ALLOCATIONS) {
    it(`December: W 2_730_000 = T, B 0, no refund, no new receivable (${allocation})`, () => {
      const all = simulate(months, december, 0, allocation);
      const jan = all[0];
      const dec = all.at(-1);
      if (jan === undefined || dec === undefined) throw new Error("no outcome");
      for (const o of all) expect(violationsOf(o)).toEqual([]);
      // January: the employee's tax above the cap 0 is a receivable.
      expect(jan.cap).toBe(0);
      expect(jan.w).toBe(0);
      expect(jan.borne).toBe(0);
      expect(jan.receivable).toBe(120_000);
      // February: TER 12% of 30_000_000, withheld from the employee.
      expect(all[1]?.w).toBe(3_600_000);
      for (const o of all.slice(2, 11)) expect(o.w).toBe(0);
      // December.
      expect(dec.cap).toBe(60_000_000);
      expect(dec.x).toBe(60_000_000);
      expect(dec.taxIdr).toBe(2_730_000);
      expect(dec.w).toBe(2_730_000);
      expect(dec.borne).toBe(0);
      expect(dec.allowance).toBe(0);
      expect(dec.receivable).toBe(0);
      expect(dec.refund).toBe(0);
      expect(dec.employerRefund).toBe(0);
      expect(dec.deposit).toBe(2_730_000);
      expect(dec.takeHome).toBe(60_000_000 - 2_730_000);
    });

    it(`December W equals the W of the same year with the receivable passed as withheld tax (${allocation})`, () => {
      const kept = runYear(months, december, 0, allocation);
      const asWithheld = simulate(
        months,
        december,
        0,
        allocation,
        undefined,
        12,
        "as_withheld",
      ).at(-1);
      if (asWithheld === undefined) throw new Error("no outcome");
      expect(kept.w).toBe(asWithheld.w);
      expect(kept.taxIdr).toBe(asWithheld.taxIdr);
      expect(kept.x).toBe(asWithheld.x);
      expect(kept.borne).toBe(asWithheld.borne);
      expect(kept.refund).toBe(asWithheld.refund);
      expect(kept.employerRefund).toBe(asWithheld.employerRefund);
    });

    it(`the same year without the receivable in the history: the employee is charged 120_000 more (${allocation})`, () => {
      const kept = runYear(months, december, 0, allocation);
      const dropped = simulate(
        months,
        december,
        0,
        allocation,
        undefined,
        12,
        "dropped",
      ).at(-1);
      if (dropped === undefined) throw new Error("no outcome");
      expect(dropped.w).toBe(2_850_000);
      expect(dropped.w - kept.w).toBe(120_000);
      expect(dropped.x).toBe(60_000_000);
      expect(dropped.borne).toBe(0);
      expect(dropped.refund).toBe(0);
      expect(dropped.employerRefund).toBe(0);
    });
  }
});
