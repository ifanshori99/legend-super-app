// PPh 21 shortfall becomes an employee receivable (beads legend-kn3n part 2,
// legend-6ajk, legend-xzid; brief docs/briefs/sub-pph21-receivable.md, founder
// decision B8).
//
// The rule under test: when the tax the employee owes is more than the cash the
// payslip can withhold (the cap), the shortfall is `pph21ReceivableIdr`, an
// open receivable from the employee. It is NOT the company's cost: no borne
// tax, no tax allowance, no gross-up in X. The deposit stays T:
//   withheld + borne + receivable - employee refund - employer refund = T.
//
// Round 2: the engine has the typed field `pph21ReceivableIdr` (result and
// `prior`), and the exact amounts of the architect's model are pinned.
//
// Assumptions (the brief is silent):
// - "withheld" in the identity is `pph21WithheldIdr`, which already contains the
//   company's `taxAllowanceIdr` (gross_up money), as in the take-home cap file.
// - The employee's cash withheld is W = pph21WithheldIdr - taxAllowanceIdr and
//   the cap is the earlier file's: pay - deductible, lowered by the caller cap.
// - The receivable is carried into the next period's prior as
//   `prior.pph21ReceivableIdr` (a running sum), as the brief proposes.
// - A pure-gross year (no benefit) never has a company share: borne, allowance
//   and the employer refund are 0 and X equals the pay, whatever the cap.
// - Refund of the employee against an open receivable is not pinned here (Q2
//   is the architect's call); only the deposit identity covers it.
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
type BaseInput = Parameters<typeof computePph21Period>[2];
type PriorIn = BaseInput["prior"];
type PeriodInput = BaseInput;

const policyOf = (
  allocation: Pph21PolicyParameters["mixedSchemeAllocation"] = "proportional",
): Pph21PolicyParameters => ({
  ...DEFAULT_PPH21_POLICY,
  mixedSchemeAllocation: allocation,
});

const compute = (
  input: PeriodInput,
  allocation?: Pph21PolicyParameters["mixedSchemeAllocation"],
) => computePph21Period(REFERENCE_TABLES, policyOf(allocation), input);

type Result = ReturnType<typeof compute>;

const priorOf = (
  taxableGrossIdr: number,
  pph21WithheldIdr: number,
  pph21EmployerBorneIdr = 0,
): PriorIn => ({
  taxableGrossIdr,
  employeeDeductibleIdr: 0,
  pph21WithheldIdr,
  pph21EmployerBorneIdr,
});

const base = (over: Partial<PeriodInput>): PeriodInput => ({
  ptkpStatus: "TK/0",
  hasTaxId: true,
  lastTaxPeriod: false,
  monthsWorked: 1,
  taxableLines: [],
  employerBenefitIdr: 0,
  employeeDeductibleIdr: 0,
  prior: priorOf(0, 0),
  ...over,
});

describe("legend-kn3n: unpaid December shortfall is an employee receivable (R63-like)", () => {
  // Jan-Nov paid 132 jt, nothing withheld; December pays nothing.
  // Hand computed: gross 132_000_000, cost 6_000_000, net 126_000_000,
  // PKP 72_000_000, tax 3_000_000 + 15% x 12_000_000 = 4_800_000 = T. No pay in
  // December means cap 0, so the employee cannot be charged. The company does
  // not bear it and nothing is grossed up: X = 0 (no lines, no benefit).
  it("no lines, no benefit: borne 0, allowance 0, W 0, X 0, receivable = T", () => {
    const r = compute(
      base({
        lastTaxPeriod: true,
        monthsWorked: 12,
        prior: priorOf(132_000_000, 0),
      }),
    );
    expect(r.pph21Idr).toBe(4_800_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBe(0);
    expect(r.taxableGrossIdr).toBe(0);
    expect(r.pph21ReceivableIdr).toBe(4_800_000);
    expect(r.pph21RefundIdr).toBe(0);
    expect(r.pph21EmployerRefundIdr).toBe(0);
  });

  // With a 500_000 employer benefit (gross contract): gross 132_500_000, cost
  // capped at 6_000_000, PKP 72_500_000, tax 3_000_000 + 15% x 12_500_000 =
  // 4_875_000 = T. The benefit is taxable income but not cash, so W is still 0.
  // X = line amount (0) + benefit, without any covered tax.
  it("benefit only (gross contract): X = benefit, borne 0, W 0, receivable = T", () => {
    const r = compute(
      base({
        lastTaxPeriod: true,
        monthsWorked: 12,
        employerBenefitIdr: 500_000,
        contractTaxScheme: "gross",
        prior: priorOf(132_000_000, 0),
      }),
    );
    expect(r.pph21Idr).toBe(4_875_000);
    expect(r.taxableGrossIdr).toBe(500_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21ReceivableIdr).toBe(4_875_000);
  });
});

describe("legend-kn3n: TER month with only an employer benefit (M1-like)", () => {
  // Benefit 8_000_000 falls in TER A row 7 (1,5%): T = 120_000 on X = 8_000_000.
  // No pay, so cap 0: the employee's tax is a receivable, not borne, no gross-up.
  it("benefit 8_000_000, gross contract: borne 0, X = benefit, W 0, receivable = T = 120_000", () => {
    const r = compute(
      base({ employerBenefitIdr: 8_000_000, contractTaxScheme: "gross" }),
    );
    expect(r.method).toBe("ter");
    expect(r.pph21Idr).toBe(120_000);
    expect(r.taxableGrossIdr).toBe(8_000_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.pph21WithheldIdr).toBe(0);
    expect(r.pph21ReceivableIdr).toBe(120_000);
  });

  // Benefit 3_000_000 is TER A row 1 (0%): no tax, so no receivable.
  it("benefit 3_000_000 (0% row): no tax, receivable is exactly 0", () => {
    const r = compute(
      base({ employerBenefitIdr: 3_000_000, contractTaxScheme: "gross" }),
    );
    expect(r.pph21Idr).toBe(0);
    expect(r.taxableGrossIdr).toBe(3_000_000);
    expect(r.pph21ReceivableIdr).toBe(0);
  });
});

describe("legend-kn3n: caller cap below the tax in a TER month", () => {
  // Gross 10_000_000 is TER A row 9 (2%): T = 200_000. Cap 150_000: W = cap,
  // the remaining 50_000 is the receivable. Not borne, X stays the pay.
  it("W = cap, receivable = T - cap, no borne, no gross-up", () => {
    const r = compute(
      base({
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        employeeWithholdingCapIdr: 150_000,
      }),
    );
    expect(r.pph21Idr).toBe(200_000);
    expect(r.pph21WithheldIdr - r.taxAllowanceIdr).toBe(150_000);
    expect(r.pph21EmployerBorneIdr).toBe(0);
    expect(r.taxAllowanceIdr).toBe(0);
    expect(r.taxableGrossIdr).toBe(10_000_000);
    expect(r.pph21ReceivableIdr).toBe(50_000);
  });

  it("a cap at or above the tax leaves no receivable", () => {
    const r = compute(
      base({
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        employeeWithholdingCapIdr: 200_000,
      }),
    );
    expect(r.pph21WithheldIdr).toBe(200_000);
    expect(r.pph21ReceivableIdr).toBe(0);
  });
});

// legend-6ajk (Codex 156 run 3): the old settlement of a cap excess entered X
// and pushed PKP over a rounding threshold, which raised December W from
// 658_540 to 658_589. With a receivable there is no settlement, so W cannot
// rise because of it. Scenario: TK/0, NPWP, proportional; Jan gross 10 jt with
// caller cap 199_998; Feb net 5_400_000; Mar-Nov gross 10 jt; Dec gross
// 9_900_147. 658_540 is the literal figure of the baseline without any cap
// excess (git 6e20273a), taken from the second-opinion result.
describe("legend-6ajk: no settlement path, December W cannot rise", () => {
  const history = () => {
    const prior = {
      taxableGrossIdr: 0,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      taxAllowanceIdr: 0,
      grossSchemeBaseIdr: 0,
      employerSchemeBaseIdr: 0,
      pph21ReceivableIdr: 0,
    };
    const results: Result[] = [];
    const months: { lines: Month; cap?: number }[] = [
      { lines: [{ amountIdr: 10_000_000, taxScheme: "gross" }], cap: 199_998 },
      { lines: [{ amountIdr: 5_400_000, taxScheme: "net" }] },
      ...Array.from({ length: 9 }, () => ({
        lines: [{ amountIdr: 10_000_000, taxScheme: "gross" as const }],
      })),
    ];
    const step = (
      lines: Month,
      lastTaxPeriod: boolean,
      monthsWorked: number,
      cap?: number,
    ) => {
      const r = compute({
        ptkpStatus: "TK/0",
        hasTaxId: true,
        lastTaxPeriod,
        monthsWorked,
        taxableLines: lines,
        employerBenefitIdr: 0,
        employeeDeductibleIdr: 0,
        ...(cap === undefined ? {} : { employeeWithholdingCapIdr: cap }),
        prior: { ...prior },
      });
      const grossBase = Number(pph21GrossSchemeBase(lines, 0, undefined));
      prior.taxableGrossIdr += r.taxableGrossIdr;
      prior.pph21WithheldIdr += r.pph21WithheldIdr;
      prior.pph21EmployerBorneIdr += r.pph21EmployerBorneIdr;
      prior.taxAllowanceIdr += r.taxAllowanceIdr;
      prior.grossSchemeBaseIdr += grossBase;
      prior.employerSchemeBaseIdr += r.taxableGrossIdr - grossBase;
      prior.pph21ReceivableIdr += r.pph21ReceivableIdr;
      results.push(r);
      return r;
    };
    months.forEach((m, index) => step(m.lines, false, index + 1, m.cap));
    const december = step(
      [{ amountIdr: 9_900_147, taxScheme: "gross" }],
      true,
      12,
    );
    return { results, december };
  };

  it("January: the 2 rupiah over the caller cap is a receivable, not borne tax and not in X", () => {
    // T = 2% x 10_000_000 = 200_000; cap 199_998; shortfall 2.
    const jan = history().results[0]!;
    expect(jan.pph21Idr).toBe(200_000);
    expect(jan.pph21WithheldIdr - jan.taxAllowanceIdr).toBe(199_998);
    expect(jan.pph21EmployerBorneIdr).toBe(0);
    expect(jan.taxAllowanceIdr).toBe(0);
    expect(jan.taxableGrossIdr).toBe(10_000_000);
    expect(jan.pph21ReceivableIdr).toBe(2);
  });

  it("December: exact W 658_538, B 124_062, X 10_024_209, T 782_600, PKP 55_652_000, no new receivable", () => {
    // Architect's model (B8): December W 658_538 is below the 658_540 baseline
    // of the run without any shortfall (git 6e20273a), so the January shortfall
    // cannot raise it. Only the February net line is the company's (B 124_062);
    // January contributes no borne tax. T = W + B = 658_538 + 124_062 = 782_600.
    const { results, december } = history();
    expect(december.taxableGrossIdr).toBe(10_024_209);
    expect(december.pph21Idr).toBe(782_600);
    expect(december.pph21WithheldIdr - december.taxAllowanceIdr).toBe(658_538);
    expect(december.taxAllowanceIdr).toBe(0);
    expect(december.pph21EmployerBorneIdr).toBe(124_062);
    expect(december.annual?.taxableIncomeIdr).toBe(55_652_000);
    expect(december.pph21RefundIdr).toBe(0);
    expect(december.pph21EmployerRefundIdr).toBe(0);
    expect(december.pph21ReceivableIdr).toBe(0);
    expect(results[0]!.pph21EmployerBorneIdr).toBe(0);
    expect(december.pph21WithheldIdr + december.pph21EmployerBorneIdr).toBe(
      december.pph21Idr,
    );
  });

  it("January pinned: W 199_998, receivable 2, X 10_000_000", () => {
    const jan = history().results[0]!;
    expect(jan.pph21WithheldIdr).toBe(199_998);
    expect(jan.pph21ReceivableIdr).toBe(2);
    expect(jan.taxableGrossIdr).toBe(10_000_000);
  });
});

// Seeded year fuzz (pattern of payroll-pph21-takehome-cap.test.ts).
const ALLOCATIONS = ["proportional", "gross_first"] as const;
const SCHEMES: readonly Scheme[] = ["gross", "gross_up", "net"];
const CASES = 1000;
const SEED = 0x6a1d21;

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

const roundTo = (value: number, step: number) =>
  Math.round(value / step) * step;

type Spec = {
  lines: Month;
  benefitIdr?: number;
  contract?: Scheme;
  deductibleIdr?: number;
  capIdr?: number;
};

type Outcome = {
  label: string;
  pay: number;
  cap: number;
  deductible: number;
  w: number;
  taxIdr: number;
  deposit: number;
  takeHome: number;
  borne: number;
  allowance: number;
  employerRefund: number;
  x: number;
  benefit: number;
  receivable: number;
};

function simulate(
  months: readonly Spec[],
  december: Spec,
  deductibleIdr: number,
  allocation: Pph21PolicyParameters["mixedSchemeAllocation"],
  decemberCapIdr?: number,
): Outcome[] {
  const prior = {
    taxableGrossIdr: 0,
    employeeDeductibleIdr: 0,
    pph21WithheldIdr: 0,
    pph21EmployerBorneIdr: 0,
    taxAllowanceIdr: 0,
    grossSchemeBaseIdr: 0,
    employerSchemeBaseIdr: 0,
    pph21ReceivableIdr: 0,
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
    const r = compute(
      {
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
      },
      allocation,
    );
    const pay = spec.lines.reduce((sum, line) => sum + line.amountIdr, 0);
    const w = r.pph21WithheldIdr - r.taxAllowanceIdr;
    const receivable = r.pph21ReceivableIdr;
    outcomes.push({
      label: lastTaxPeriod ? "december" : `month ${monthsWorked}`,
      pay,
      cap: Math.min(
        Math.max(0, pay - deductible),
        capArg ?? Number.MAX_SAFE_INTEGER,
      ),
      deductible,
      w,
      taxIdr: r.pph21Idr,
      deposit:
        r.pph21WithheldIdr +
        r.pph21EmployerBorneIdr +
        receivable -
        r.pph21RefundIdr -
        r.pph21EmployerRefundIdr,
      takeHome: pay - w + r.pph21RefundIdr - deductible,
      borne: r.pph21EmployerBorneIdr,
      allowance: r.taxAllowanceIdr,
      employerRefund: r.pph21EmployerRefundIdr,
      x: r.taxableGrossIdr,
      benefit,
      receivable,
    });
    const grossBase = Number(
      pph21GrossSchemeBase(spec.lines, benefit, spec.contract),
    );
    prior.taxableGrossIdr += r.taxableGrossIdr;
    prior.employeeDeductibleIdr += deductible;
    prior.pph21WithheldIdr += r.pph21WithheldIdr;
    prior.pph21EmployerBorneIdr += r.pph21EmployerBorneIdr;
    prior.taxAllowanceIdr += r.taxAllowanceIdr;
    prior.grossSchemeBaseIdr += grossBase;
    prior.employerSchemeBaseIdr += r.taxableGrossIdr - grossBase;
    prior.pph21ReceivableIdr += receivable;
  };
  months.forEach((spec, index) => run(spec, false, index + 1, spec.capIdr));
  run(december, true, 12, decemberCapIdr);
  return outcomes;
}

function violationsOf(o: Outcome): string[] {
  const found: string[] = [];
  if (typeof o.receivable !== "number") {
    found.push("pph21ReceivableIdr missing from the result");
    return found;
  }
  if (!Number.isInteger(o.receivable) || o.receivable < 0)
    found.push(`receivable ${o.receivable} is not an integer >= 0`);
  if (o.w > o.cap) found.push(`W ${o.w} > cap ${o.cap}`);
  if (o.deposit !== o.taxIdr)
    found.push(
      `withheld + borne + receivable - refunds = ${o.deposit} != T ${o.taxIdr}`,
    );
  if (o.takeHome < 0) found.push(`take-home ${o.takeHome} < 0`);
  if (o.receivable > 0 && o.w !== o.cap)
    found.push(`receivable ${o.receivable} > 0 but W ${o.w} != cap ${o.cap}`);
  return found;
}

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

const LEVELS = [
  [4_000_000, 8_000_000],
  [8_000_000, 20_000_000],
  [20_000_000, 40_000_000],
] as const;

/**
 * A year whose pay level shifts (so December disagrees with the history), with
 * random caller caps below the default cap in some months. `profile` fixes the
 * scheme of every line; `withBenefits` adds benefit-only months and benefits
 * beside the lines.
 */
function randomYear(
  next: () => number,
  profile: Scheme | "mixed",
  withBenefits: boolean,
) {
  const level = () => LEVELS[Math.floor(next() * LEVELS.length)]!;
  const split = 1 + Math.floor(next() * 10);
  const [lowA, highA] = level();
  const [lowB, highB] = level();
  const deductibleIdr = next() < 0.4 ? roundTo(next() * 400_000, 1_000) : 0;
  const payOf = (lines: Month) =>
    lines.reduce((sum, line) => sum + line.amountIdr, 0);
  const months: Spec[] = Array.from({ length: 11 }, (_, index) => {
    const [low, high] = index < split ? [lowA, highA] : [lowB, highB];
    const roll = next();
    if (withBenefits && roll < 0.2)
      return {
        lines: [],
        benefitIdr: roundTo(100_000 + next() * 7_900_000, 1_000),
        contract: SCHEMES[Math.floor(next() * SCHEMES.length)]!,
        deductibleIdr: 0,
      };
    const lines = randomLines(next, profile, low, high);
    const spec: Spec = { lines };
    if (withBenefits && roll < 0.55)
      spec.benefitIdr = roundTo(50_000 + next() * 450_000, 1_000);
    if (next() < 0.35) {
      const defaultCap = Math.max(0, payOf(lines) - deductibleIdr);
      spec.capIdr = roundTo(next() * defaultCap, 1_000);
    }
    return spec;
  });
  const [lowD, highD] =
    next() < 0.4 ? ([1_000_000, 6_000_000] as const) : level();
  const decemberLines = randomLines(next, profile, lowD, highD);
  const december: Spec = { lines: decemberLines };
  if (withBenefits && next() < 0.3)
    december.benefitIdr = roundTo(50_000 + next() * 450_000, 1_000);
  const defaultCap = Math.max(0, payOf(decemberLines) - deductibleIdr);
  const decemberCap =
    next() < 0.35 ? roundTo(next() * defaultCap, 1_000) : undefined;
  return { months, december, decemberCap, deductibleIdr };
}

describe("legend-kn3n: receivable invariants over a year (seeded fuzz)", () => {
  for (const allocation of ALLOCATIONS) {
    it(`withheld + borne + receivable - refunds = T, W <= cap, receivable >= 0, receivable > 0 means W = cap, take-home >= 0 (${allocation})`, () => {
      const next = prng(SEED);
      const bad: string[] = [];
      let receivableMonths = 0;
      for (let index = 0; index < CASES; index += 1) {
        const c = randomYear(next, "mixed", true);
        const outcomes = simulate(
          c.months,
          c.december,
          c.deductibleIdr,
          allocation,
          c.decemberCap,
        );
        outcomes.forEach((o) => {
          if (o.receivable > 0) receivableMonths += 1;
          const found = violationsOf(o);
          if (found.length > 0)
            bad.push(
              `${o.label}: ${found.join("; ")} | case ${index}: deductible ${c.deductibleIdr}, months ${JSON.stringify(c.months)}, december ${JSON.stringify(c.december)}, december cap ${c.decemberCap}`,
            );
        });
      }
      expect(
        bad.length,
        `${bad.length} period results violate an invariant (${allocation}). First: ${(bad[0] ?? "none").slice(0, 600)}`,
      ).toBe(0);
      // Guard: the fuzz must reach the case it is for.
      expect(receivableMonths).toBeGreaterThan(0);
    });
  }
});

describe("legend-6ajk / legend-kn3n: a pure-gross year has no company share (seeded fuzz)", () => {
  for (const allocation of ALLOCATIONS) {
    it(`borne 0, allowance 0, employer refund 0 and X = pay in every period, whatever the cap (${allocation})`, () => {
      const next = prng(SEED + 1);
      const bad: string[] = [];
      let receivableMonths = 0;
      for (let index = 0; index < CASES; index += 1) {
        const c = randomYear(next, "gross", false);
        const outcomes = simulate(
          c.months,
          c.december,
          c.deductibleIdr,
          allocation,
          c.decemberCap,
        );
        outcomes.forEach((o) => {
          if (o.receivable > 0) receivableMonths += 1;
          const found = violationsOf(o);
          if (o.borne !== 0) found.push(`borne ${o.borne} != 0`);
          if (o.allowance !== 0) found.push(`allowance ${o.allowance} != 0`);
          if (o.employerRefund !== 0)
            found.push(`employer refund ${o.employerRefund} != 0`);
          if (o.x !== o.pay + o.benefit)
            found.push(`X ${o.x} != pay ${o.pay} (receivable grossed up)`);
          if (found.length > 0)
            bad.push(
              `${o.label}: ${found.join("; ")} | case ${index}: deductible ${c.deductibleIdr}, months ${JSON.stringify(c.months)}, december ${JSON.stringify(c.december)}, december cap ${c.decemberCap}`,
            );
        });
      }
      expect(
        bad.length,
        `${bad.length} period results violate an invariant (${allocation}, pure gross). First: ${(bad[0] ?? "none").slice(0, 600)}`,
      ).toBe(0);
      expect(receivableMonths).toBeGreaterThan(0);
    });
  }
});
