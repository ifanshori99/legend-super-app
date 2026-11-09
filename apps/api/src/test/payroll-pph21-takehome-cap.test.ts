// PPh 21 take-home cap (beads legend-4ndx; brief
// docs/briefs/sub-pph21-takehome-cap.md).
//
// Seeded property tests: build a year month by month (TER months, then
// December as lastTaxPeriod), the prior accumulated from each month's result
// (including pph21CapExcessIdr), grossSchemeBaseIdr from pph21GrossSchemeBase,
// employerSchemeBaseIdr = taxable gross - gross base. The cap applies in every
// period, TER months too, so the fuzz checks every month of the year, for both
// mixedSchemeAllocation policies:
//   1. employee withheld W = pph21WithheldIdr - taxAllowanceIdr <= cap, where
//      cap = max(0, sum of gross + gross_up + net line amounts - deductible),
//      lowered by employeeWithholdingCapIdr when the caller gives one;
//   2. withheld + employer borne - refund - employer refund = pph21Idr;
//   3. take-home = pay - W + refund - employeeDeductible >= 0;
//   4. refunds >= 0 and no payer is both charged and refunded;
//   5. pph21CapExcessIdr <= pph21EmployerBorneIdr (and >= 0).
// The year fuzz also has months with only an employer benefit (no salary, cap
// 0, so the employee's tax is taken over by the company in a TER month) and
// months with a benefit beside the lines. Fixed cases (CTO S2, architect C2,
// reviewer K1, caller cap lower / higher than the default) pin the exact
// amounts, hand computed in the comments below from the brief's decisions (W
// capped at the available pay, the excess is the company's: borne when the
// employer's net stays >= 0, else it only lowers the employer refund; borne
// excess counts as tax the employee already paid, so December never charges it
// back).
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
  capExcess: number;
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
): Outcome[] {
  const policy = policyOf(allocation);
  const prior = {
    taxableGrossIdr: 0,
    employeeDeductibleIdr: 0,
    pph21WithheldIdr: 0,
    pph21EmployerBorneIdr: 0,
    taxAllowanceIdr: 0,
    pph21CapExcessIdr: 0,
    grossSchemeBaseIdr: 0,
    employerSchemeBaseIdr: 0,
  };
  const outcomes: Outcome[] = [];
  const run = (
    spec: Spec,
    lastTaxPeriod: boolean,
    monthsWorked: number,
    capArg: number | undefined,
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
      prior: { ...prior },
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
        r.pph21WithheldIdr + r.pph21EmployerBorneIdr - refund - employerRefund,
      takeHome: pay - w + refund - deductible,
      refund,
      employerRefund,
      x: r.taxableGrossIdr,
      borne: r.pph21EmployerBorneIdr,
      allowance: r.taxAllowanceIdr,
      capExcess: r.pph21CapExcessIdr,
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
    prior.pph21CapExcessIdr += r.pph21CapExcessIdr;
    prior.grossSchemeBaseIdr += grossBase;
    prior.employerSchemeBaseIdr += r.taxableGrossIdr - grossBase;
  };
  months.forEach((month, index) => {
    const spec = asSpec(month);
    run(spec, false, index + 1, spec.capIdr);
  });
  run(asSpec(december), true, 12, callerCapIdr);
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
  if (o.capExcess < 0 || o.capExcess > o.borne)
    found.push(`cap excess ${o.capExcess} outside 0..borne ${o.borne}`);
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
// TER months and the prior carries pph21CapExcessIdr into December.
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
    it(`each of the 12 periods keeps W <= cap, deposit = tax, take-home >= 0, refunds >= 0, cap excess <= borne (${allocation})`, () => {
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
          if (month < 11 && o.capExcess > 0) capBitInTerMonth += 1;
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
  it("S2 proportional: W 1_000_000 (the whole pay), the company is refunded 9_707_026, take-home 0", () => {
    // bR = floor(aP x E / mix) - pET = 18_109_211 - 29_302_326 = -11_193_115,
    // bE = H - bR = 2_336_089, so the employee's own amount is De + bE =
    // 150_000 + 2_336_089 = 2_486_089 (the engine before the cap withheld
    // exactly this and left take-home -1_486_089). Cap 1_000_000, excess
    // 1_486_089 -> W = 1_000_000. Employer net = Dr + bR + excess =
    // 0 - 11_193_115 + 1_486_089 = -9_707_026 < 0: refund 9_707_026, no borne
    // tax, so X stays 1_000_000. Deposit: 1_000_000 - 9_707_026 = -8_707_026 = T.
    const o = runYear(months, december, 0, "proportional");
    expect(o.x).toBe(1_000_000);
    expect(o.taxIdr).toBe(-8_707_026);
    expect(o.w).toBe(1_000_000);
    expect(o.borne).toBe(0);
    expect(o.allowance).toBe(0);
    expect(o.refund).toBe(0);
    expect(o.employerRefund).toBe(9_707_026);
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
    expect(o.refund).toBe(0);
    expect(o.employerRefund).toBe(8_857_026);
    expect(o.deposit).toBe(-8_707_026);
    expect(o.takeHome).toBe(850_000);
  });
});

describe("legend-4ndx: C2 (TK/0, gross 10 jt Jan-Nov, December gross 200_000) forces the company to bear tax", () => {
  // Jan-Nov: X = 10_000_000 each, TER A 2% => 200_000 a month, prior tax
  // 2_200_000 (all withheld), prior X 110_000_000 (all gross).
  // annual(110_000_000) = cost 5_500_000, PKP 50_500_000, 5% = 2_525_000, so
  // H = 2_525_000 - 2_200_000 = 325_000, all the employee's (bE = 325_000,
  // bR = 0). Default cap = 200_000 (gross line 200_000).
  // December: the employee's own amount is T (H + D with D the new tax, all
  // gross scheme), above the cap, so the excess is borne by the company and
  // is itself taxable (fixed point on S = excess, X = 200_000 + S, gross =
  // 110_000_000 + X, cost = min(5%, 6_000_000), T = annual - 2_200_000):
  //   S0=0       X 200_000 gross 110_200_000 cost 5_510_000 PKP 50_690_000 annual 2_534_500 T 334_500 excess 134_500
  //   S1=134_500 X 334_500 gross 110_334_500 cost 5_516_725 PKP 50_817_000 annual 2_540_850 T 340_850 excess 140_850
  //   S2=140_850 X 340_850 gross 110_340_850 cost 5_517_042 PKP 50_823_000 annual 2_541_150 T 341_150 excess 141_150
  //   S3=141_150 X 341_150 gross 110_341_150 cost 5_517_057 PKP 50_824_000 annual 2_541_200 T 341_200 excess 141_200
  //   S4=141_200 X 341_200 gross 110_341_200 cost 5_517_060 PKP 50_824_000 annual 2_541_200 T 341_200 stable.
  // (The engine before the cap withheld W = 334_500 from a 200_000 pay.)
  // W = 200_000 (the whole pay), B = 141_200, take-home 0.
  const december: Month = [{ amountIdr: 200_000, taxScheme: "gross" }];
  const months = Array.from({ length: 11 }, (): Month => [
    { amountIdr: 10_000_000, taxScheme: "gross" },
  ]);

  for (const allocation of ALLOCATIONS) {
    it(`W 200_000, borne 141_200, X = T = 341_200, take-home 0 (${allocation})`, () => {
      const o = runYear(months, december, 0, allocation);
      expect(violationsOf(o)).toEqual([]);
      expect(o.x).toBe(341_200);
      expect(o.taxIdr).toBe(341_200);
      expect(o.w).toBe(200_000);
      expect(o.borne).toBe(141_200);
      expect(o.allowance).toBe(0);
      expect(o.refund).toBe(0);
      expect(o.employerRefund).toBe(0);
      expect(o.deposit).toBe(341_200);
      expect(o.takeHome).toBe(0);
    });

    it(`a caller cap 100_000 below the default 200_000 lowers W to 100_000 and the company bears more: X 446_150 (${allocation})`, () => {
      // Same history. cap = min(200_000, 100_000) = 100_000, excess = T -
      // 100_000, so more of the tax is the company's and X grows:
      //   S0=0       X 200_000 T 334_500 excess 234_500
      //   S1=234_500 X 434_500 gross 110_434_500 cost 5_521_725 PKP 50_912_000 annual 2_545_600 T 345_600 excess 245_600
      //   S2=245_600 X 445_600 gross 110_445_600 cost 5_522_280 PKP 50_923_000 annual 2_546_150 T 346_150 excess 246_150
      //   S3=246_150 X 446_150 gross 110_446_150 cost 5_522_307 PKP 50_923_000 annual 2_546_150 T 346_150 stable.
      // X = 446_150, T = 346_150, W = 100_000, B = 246_150; the employee keeps
      // 200_000 - 100_000 = 100_000.
      const o = runYear(months, december, 0, allocation, 100_000);
      expect(violationsOf(o)).toEqual([]);
      expect(o.x).toBe(446_150);
      expect(o.taxIdr).toBe(346_150);
      expect(o.w).toBe(100_000);
      expect(o.borne).toBe(246_150);
      expect(o.refund).toBe(0);
      expect(o.employerRefund).toBe(0);
      expect(o.deposit).toBe(346_150);
      expect(o.takeHome).toBe(100_000);
    });

    it(`a caller cap 500_000 above the default 200_000 is ignored: same as without it (${allocation})`, () => {
      const without = runYear(months, december, 0, allocation);
      const o = runYear(months, december, 0, allocation, 500_000);
      expect(o).toEqual(without);
      expect(o.x).toBe(341_200);
      expect(o.w).toBe(200_000);
      expect(o.borne).toBe(141_200);
    });
  }
});

describe("legend-4ndx: K1 (reviewer round 1) a TER-month cap excess is not charged back in December", () => {
  // TK/0 with a tax id. January: no salary, only an employer benefit of
  // 8_000_000 under a `gross` agreement (cap 0: the employee has no pay to
  // withhold from). February-December: gross 10_000_000 a month, no benefit,
  // no deductible.
  //
  // January (TER A, 1.5% for X between 7_500_000 and 8_550_000). Fixed point on
  // the employer-covered tax S, X = 8_000_000 + S:
  //   S0=0         X 8_000_000: tax 120_000
  //   S1=120_000   X 8_120_000: tax 121_800
  //   S2=121_800   X 8_121_800: tax 121_827
  //   S3=121_827   X 8_121_827: tax 121_827 (121_827.405 rounds down), stable.
  // The whole benefit is the employee's scheme, so the tax splits by their
  // share of X, the employee's part being above the cap 0 (the excess):
  //   proportional: floor(121_827 x 8_000_000 / 8_121_827) = 119_999
  //   gross_first : min(tax of 8_000_000 alone = 120_000, 121_827) = 120_000
  // The company takes over that excess: W = 0, borne B = 121_827 = T, and
  // pph21CapExcessIdr = the excess (119_999 / 120_000). Gross scheme base
  // 8_000_000, employer scheme base 121_827.
  //
  // February-November: X = 10_000_000, TER 2% => 200_000 withheld each (ten
  // months, 2_000_000). Prior at December: X 108_121_827, withheld 2_000_000,
  // borne 121_827, cap excess E1, gross base 108_000_000, employer base 121_827.
  // priorTax 2_121_827. The cap excess counts as the employee's own tax paid
  // (reviewer fix, variant C): prior employer tax = 121_827 - E1 (no allowance).
  //
  // December: annual(108_121_827) = cost 5_406_091, net 102_715_736, PKP
  // 48_715_000, 5% = 2_435_750, so H = 2_435_750 - 2_121_827 = 313_923.
  // Both policies: the employer's balance only covers its own (tiny) share.
  //
  // proportional (E1 = 119_999): prior employer tax 1_828, employee tax
  //   2_119_999. employer balance = floor(2_435_750 x 121_827 / 108_121_827) -
  //   1_828 = 2_744 - 1_828 = 916, employee balance = 313_923 - 916 = 313_007.
  //   Fixed point on S (X = 10_000_000 + S, December tax T = annual - 2_121_827,
  //   D = T - H, employee part floor(D x 10_000_000 / X)):
  //   S0=0: T 788_923, D 475_000, employee 475_000, employer 0 -> 916
  //   S1=916: X 10_000_916, T 788_973 (PKP 58_216_000, 5% 2_910_800), D 475_050,
  //     employee 475_006, employer 44 -> 960
  //   S2=960: X 10_000_960, employee 475_004, employer 46 -> 962
  //   S3=962: X 10_000_962, employee 475_004, employer 46 -> 962 stable.
  //   X 10_000_962, T 788_973, W = 475_004 + 313_007 = 788_011, B = 962 (every
  //   gross-scheme month, so no allowance), no refund. Before the fix the
  //   excess counted as the company's tax, the employee was charged it back and
  //   W was 908_006.
  //
  // gross_first (E1 = 120_000): prior employer tax 1_827, employee tax
  //   2_120_000; annual(108_000_000) = 2_430_000, so employer balance =
  //   313_923 - (2_430_000 - 2_120_000) = 3_923, employee balance 310_000.
  //   The employee's own added tax is that of 10_000_000 alone: 475_000.
  //   S0=0: employer 3_923; S1=3_923: X 10_003_923, T 789_123, D 475_200,
  //   employee 475_000, employer 200 -> 4_123; stable at S=4_123 (T 789_123).
  //   X 10_004_123, T 789_123, W = 475_000 + 310_000 = 785_000, B = 4_123.
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

  it("proportional: January the company takes over 119_999; December W 788_011, B 962, no charge back", () => {
    const all = simulate(months, december, 0, "proportional");
    const [jan, , , , , , , , , , , dec] = all;
    if (jan === undefined || dec === undefined) throw new Error("no outcome");
    for (const o of all) expect(violationsOf(o)).toEqual([]);
    expect(jan.cap).toBe(0);
    expect(jan.x).toBe(8_121_827);
    expect(jan.taxIdr).toBe(121_827);
    expect(jan.w).toBe(0);
    expect(jan.allowance).toBe(0);
    expect(jan.borne).toBe(121_827);
    expect(jan.capExcess).toBe(119_999);
    expect(jan.takeHome).toBe(0);
    expect(dec.x).toBe(10_000_962);
    expect(dec.taxIdr).toBe(788_973);
    expect(dec.w).toBe(788_011);
    expect(dec.borne).toBe(962);
    expect(dec.allowance).toBe(0);
    expect(dec.refund).toBe(0);
    expect(dec.employerRefund).toBe(0);
    expect(dec.capExcess).toBe(0);
    expect(dec.deposit).toBe(788_973);
    expect(dec.takeHome).toBe(10_000_000 - 788_011);
  });

  it("gross_first: January the company takes over 120_000; December W 785_000, B 4_123, no charge back", () => {
    const all = simulate(months, december, 0, "gross_first");
    const [jan, , , , , , , , , , , dec] = all;
    if (jan === undefined || dec === undefined) throw new Error("no outcome");
    for (const o of all) expect(violationsOf(o)).toEqual([]);
    expect(jan.cap).toBe(0);
    expect(jan.x).toBe(8_121_827);
    expect(jan.taxIdr).toBe(121_827);
    expect(jan.w).toBe(0);
    expect(jan.allowance).toBe(0);
    expect(jan.borne).toBe(121_827);
    expect(jan.capExcess).toBe(120_000);
    expect(jan.takeHome).toBe(0);
    expect(dec.x).toBe(10_004_123);
    expect(dec.taxIdr).toBe(789_123);
    expect(dec.w).toBe(785_000);
    expect(dec.borne).toBe(4_123);
    expect(dec.allowance).toBe(0);
    expect(dec.refund).toBe(0);
    expect(dec.employerRefund).toBe(0);
    expect(dec.capExcess).toBe(0);
    expect(dec.deposit).toBe(789_123);
    expect(dec.takeHome).toBe(10_000_000 - 785_000);
  });
});
