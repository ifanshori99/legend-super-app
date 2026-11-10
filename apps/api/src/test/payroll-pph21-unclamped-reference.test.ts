// PPh 21 reference suite, Part F: every payer's Jan-Nov balance is settled on
// its own, with NO clamp (bead legend-mmgd; brief
// docs/briefs/sub-pph21-unclamped.md, tingkat K; PMK 168/2023 Pasal 15(1)-(3)
// and Pasal 21). One payer's over-payment must not cover the other payer's
// shortfall (the old rule B clamp to [0, H] and the legend-u1xq clamp to
// [0, C] did exactly that).
//
// Every expected value below is computed BY HAND (python3 big-integer
// arithmetic) from the regulation and the brief's design, using
// REFERENCE_TABLES (fixtures/payroll/statutory-tables.ts), never by calling or
// copying engine code. Conventions as payroll-pph21-history-split-reference
// (X = G + U + N + tax allowance + employer-borne tax; TER on X, one half_up
// rounding per tax amount; biaya jabatan = min(5% x bruto, 6_000_000); PKP
// floored to whole thousands; TK/0, with NPWP; months = 12).
//
// Notation (brief): priorTax = prior withheld + prior borne; H = annual(prior)
// - priorTax (signed: + under-paid, - over-paid); T = annual(prior + X) -
// priorTax; D = T - H = annual(prior + X) - annual(prior). pET = prior borne +
// prior allowance (the company's tax), pEeT = priorTax - pET (the employee's).
// E / Gs = prior employer / gross scheme base, mix = E + Gs. G* = this month's
// employee (gross-scheme) part, U = gross_up, N = net, X = G + U + N + covered.
// Signed balances, bE + bR = H (bE the employee's, bR the company's; no clamp):
//   scheme base sent, `gross_first`:  bE = annual(Gs) - pEeT, bR = H - bE;
//   scheme base sent, `proportional`: bR = floor(annual(prior) x E / mix) - pET,
//                                     bE = H - bR;
//   no scheme base, priorTax > 0:     bR = trunc(H x pET / priorTax), bE = H - bR.
// One path for all months:
//   De = employee's share of D (`proportional` floor(D x G*/X), 0 if X = 0;
//        `gross_first` min(D, annual(Gs + G*) - annual(Gs)) when the earlier
//        scheme mix is sent (bead legend-y2lf, founder Q52; before: annual(prior
//        + G*) - annual(prior)), else the old formula), Dr = D - De.
//   covered (the company's money that feeds X): covered_0 = 0, covered_{k+1} =
//        max(0, Dr(X0 + covered_k) + bR), stop at the first non-increase.
//   Employee: e = De + bE; W = max(0, e), employee refund = max(0, -e).
//   Company: r = Dr + bR; r >= 0: A (allowance) = min(covered x U/(U+N), r),
//        B (borne) = r - A; r < 0: company refund = -r.
// Invariants asserted in every case (brief):
//   withheld(W + A) + borne(B) - refund - employerRefund = T (= pph21Idr);
//   W <= De + max(0, bE); refund <= max(0, -bE); employerRefund <= max(0, -bR);
//   a payer is never withheld from and refunded in the same month.
// When bE and bR have the same sign (or one is 0) the figures equal the old
// engine's; they change only when the clamp used to bind (cases C1-C6 are the
// changed ones, N1-N5 must not move). Bead legend-y2lf (founder Q52) moved the
// December `gross_first` employee part De to annual(Gs + G*) - annual(Gs): the
// `gross_first` figures of C1-C6 and N1 changed by that rule alone (see each
// case); `proportional` and N2-N6 did not move.
//
// Assumptions where the brief is silent (flagged in the report):
// - U1: pph21Idr is T (also negative); pph21WithheldIdr = W + A, so W = withheld
//   - taxAllowanceIdr; the employee refund is pph21RefundIdr and the company's
//   is pph21EmployerRefundIdr (same readings as the over-withholding suite).
// - U2: the fixed point's result X uses the covered_k at which the iteration
//   stopped (last row of each trace); r, A and B are evaluated at that X.
// - U3: cases C4, C5 and C6 use an ASSUMED round-number Jan-Nov ledger (a
//   payer-mix where the clamp binds with H > 0 cannot be reached with plain
//   TER months), so the ledger is stated in the comment, not simulated.
// - U4: A = min(floor(covered x U/(U+N)), r); only cases with U = 0 or N = 0
//   are used, so the rounding of that product never matters.
import { describe, expect, it } from "vitest";
import { DEFAULT_PPH21_POLICY } from "@starter/shared/hris/payroll";
import type { Pph21PolicyParameters } from "@starter/shared/hris/payroll";
import { computePph21Period } from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Input = Parameters<typeof computePph21Period>[2];
type Result = ReturnType<typeof computePph21Period>;
type Line = { amountIdr: number; taxScheme: "gross" | "gross_up" | "net" };

const ALLOCATIONS = ["proportional", "gross_first"] as const;

const prior = (
  taxableGrossIdr: number,
  pph21WithheldIdr: number,
  pph21EmployerBorneIdr = 0,
) => ({
  taxableGrossIdr,
  employeeDeductibleIdr: 0,
  pph21WithheldIdr,
  pph21EmployerBorneIdr,
});

const run = (
  over: Partial<Input>,
  policy: Partial<Pph21PolicyParameters> = {},
) =>
  computePph21Period(REFERENCE_TABLES, { ...DEFAULT_PPH21_POLICY, ...policy }, {
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked: 12,
    taxableLines: [],
    employerBenefitIdr: 0,
    employeeDeductibleIdr: 0,
    prior: prior(0, 0),
    ...over,
  } as Input);

// What one case expects for one allocation policy (all in rupiah).
//   x = taxableGrossIdr, t = pph21Idr, annual = annual tax of prior + X,
//   w = the employee's own tax (pph21WithheldIdr - taxAllowanceIdr),
//   a = allowance, b = borne, refund / employerRefund as named,
//   de = the employee's share of D, bE / bR = the signed balances.
type Expect = {
  x: number;
  t: number;
  annual: number;
  w: number;
  a: number;
  b: number;
  refund: number;
  employerRefund: number;
  de: number;
  bE: number;
  bR: number;
};

const verify = (
  r: Result,
  c: Expect,
  priorTaxIdr: number,
  employeePayIdr: number,
) => {
  expect(r.method).toBe("annual_recalculation");
  expect(r.taxableGrossIdr).toBe(c.x);
  expect(r.pph21Idr).toBe(c.t);
  expect(r.taxAllowanceIdr).toBe(c.a);
  expect(r.pph21WithheldIdr).toBe(c.w + c.a);
  expect(r.pph21EmployerBorneIdr).toBe(c.b);
  expect(r.pph21RefundIdr).toBe(c.refund);
  expect(r.pph21EmployerRefundIdr).toBe(c.employerRefund);
  expect(r.annual?.annualTaxIdr).toBe(c.annual);
  expect(r.annual?.priorPph21Idr).toBe(priorTaxIdr);

  // Accounting: what leaves the employee and the company, less what is paid
  // back to each, is exactly T.
  expect(
    r.pph21WithheldIdr +
      r.pph21EmployerBorneIdr -
      r.pph21RefundIdr -
      r.pph21EmployerRefundIdr,
  ).toBe(r.pph21Idr);
  // Bounds: nobody pays more than his own share plus his own shortfall, nobody
  // is refunded more than he over-paid.
  const employeeTax = r.pph21WithheldIdr - r.taxAllowanceIdr;
  expect(employeeTax).toBeLessThanOrEqual(c.de + Math.max(0, c.bE));
  expect(r.pph21RefundIdr).toBeLessThanOrEqual(Math.max(0, -c.bE));
  expect(r.pph21EmployerRefundIdr).toBeLessThanOrEqual(Math.max(0, -c.bR));
  // A payer is never withheld from and refunded in the same month.
  expect(employeeTax > 0 && r.pph21RefundIdr > 0).toBe(false);
  expect(
    r.taxAllowanceIdr + r.pph21EmployerBorneIdr > 0 &&
      r.pph21EmployerRefundIdr > 0,
  ).toBe(false);
  // Take-home = pay - own tax + refund.
  expect(employeePayIdr - employeeTax + r.pph21RefundIdr).toBe(
    employeePayIdr - c.w + c.refund,
  );
};

// One case, run once per allocation policy.
const cases = (
  id: string,
  title: string,
  input: Partial<Input>,
  employeePayIdr: number,
  priorTaxIdr: number,
  expected: Record<(typeof ALLOCATIONS)[number], Expect>,
) => {
  for (const allocation of ALLOCATIONS) {
    it(`${id} (${allocation}) ${title}`, () => {
      const r = run(input, { mixedSchemeAllocation: allocation });
      verify(r, expected[allocation], priorTaxIdr, employeePayIdr);
    });
  }
};

// Jan-Jun net 5_400_000 (TER A row 1, 0%, bound inclusive: no tax, X =
// 5_400_000, all the company's scheme), Jul-Nov gross 20_000_000 (TER A row
// 19, 9%: 1_800_000 each, withheld 9_000_000, all the employee's scheme).
// Prior gross 6 x 5_400_000 + 5 x 20_000_000 = 132_400_000, withheld 9_000_000,
// borne 0, allowance 0; E = 32_400_000, Gs = 100_000_000.
const ARCHITECT_YEAR = {
  ...prior(132_400_000, 9_000_000, 0),
  taxAllowanceIdr: 0,
  grossSchemeBaseIdr: 100_000_000,
  employerSchemeBaseIdr: 32_400_000,
};

describe("PPh 21 unclamped payer balances, H < 0 with one payer short (legend-mmgd)", () => {
  describe("C1 architect example: net 5,4 jt Jan-Jun, gross 20 jt Jul-Nov, December gross 20 jt", () => {
    // priorTax 9_000_000, pET = 0, pEeT = 9_000_000.
    // aP = annual(132_400_000): cost min(6_620_000, 6_000_000) = 6_000_000, net
    //   126_400_000, PKP 72_400_000, tax 3_000_000 + 15% x 12_400_000 =
    //   4_860_000 => H = -4_140_000 (everyone together over-paid).
    // Balances:
    //   proportional: bR = floor(4_860_000 x 32_400_000 / 132_400_000) - 0 =
    //     floor(1_189_305,14) = 1_189_305, bE = -4_140_000 - 1_189_305 =
    //     -5_329_305. (The old clamp made the employee fund exactly 1_189_305
    //     of the company's tax in December.)
    //   gross_first: annual(Gs = 100_000_000): cost 5_000_000, net 95_000_000,
    //     PKP 41_000_000, tax 2_050_000 => bE = 2_050_000 - 9_000_000 =
    //     -6_950_000, bR = -4_140_000 + 6_950_000 = 2_810_000. (Old: the
    //     employee funded 2_810_000.)
    //   So the employee over-paid and the company under-paid.
    // December gross 20_000_000: G* = X0, U = N = 0 so the company's covered
    //   tax is all borne. annual(prior + G*) = annual(152_400_000): net
    //   146_400_000, PKP 92_400_000, tax 3_000_000 + 15% x 32_400_000 =
    //   7_860_000. gross_first (bead legend-y2lf, founder Q52): De =
    //   annual(Gs + G*) - annual(Gs) = annual(120_000_000) - 2_050_000 =
    //   3_000_000 - 2_050_000 = 950_000 (annual(120 jt): cost 6_000_000, net
    //   114_000_000, PKP 60_000_000), capped at D (D is larger at every step).
    // proportional (D = annual(prior + X) - 4_860_000, De = floor(D x 20M/X)):
    // S0=0 X=20000000 annual=7860000 T=-1140000 D=3000000 De=3000000 Dr=0 next=1189305
    // S1=1189305 X=21189305 annual=8038350 T=-961650 D=3178350 De=2999956 Dr=178394 next=1367699
    // S2=1367699 X=21367699 annual=8065050 T=-934950 D=3205050 De=2999901 Dr=205149 next=1394454
    // S3=1394454 X=21394454 annual=8069100 T=-930900 D=3209100 De=2999936 Dr=209164 next=1398469
    // S4=1398469 X=21398469 annual=8069700 T=-930300 D=3209700 De=2999934 Dr=209766 next=1399071
    // S5=1399071 X=21399071 annual=8069850 T=-930150 D=3209850 De=2999990 Dr=209860 next=1399165
    // S6=1399165 X=21399165 annual=8069850 T=-930150 D=3209850 De=2999976 Dr=209874 next=1399179
    // S7=1399179 X=21399179 annual=8069850 T=-930150 D=3209850 De=2999974 Dr=209876 next=1399181
    // S8=1399181 X=21399181 annual=8069850 T=-930150 D=3209850 De=2999974 Dr=209876 next=1399181
    // gross_first (De = 950_000 every step; updated for bead legend-y2lf):
    // S0=0 X=20000000 annual=7860000 T=-1140000 D=3000000 De=950000 Dr=2050000 next=4860000
    // S1=4860000 X=24860000 annual=8589000 T=-411000 D=3729000 De=950000 Dr=2779000 next=5589000
    // S2=5589000 X=25589000 annual=8698350 T=-301650 D=3838350 De=950000 Dr=2888350 next=5698350
    // S3=5698350 X=25698350 annual=8714700 T=-285300 D=3854700 De=950000 Dr=2904700 next=5714700
    // S4=5714700 X=25714700 annual=8717100 T=-282900 D=3857100 De=950000 Dr=2907100 next=5717100
    // S5=5717100 X=25717100 annual=8717550 T=-282450 D=3857550 De=950000 Dr=2907550 next=5717550
    // S6=5717550 X=25717550 annual=8717550 T=-282450 D=3857550 De=950000 Dr=2907550 next=5717550
    // Result proportional: X = 21_399_181, T = 8_069_850 - 9_000_000 =
    //   -930_150. e = 2_999_974 - 5_329_305 < 0 => W = 0, employee refund
    //   2_329_331. r = Dr + bR = 209_876 + 1_189_305 = 1_399_181 = B (borne).
    //   Check: 0 + 1_399_181 - 2_329_331 = -930_150 = T.
    // Result gross_first: X = 25_717_550, T = 8_717_550 - 9_000_000 =
    //   -282_450. e = 950_000 - 6_950_000 < 0 => W = 0, employee refund
    //   6_000_000. B = 2_907_550 + 2_810_000 = 5_717_550.
    //   Check: 5_717_550 - 6_000_000 = -282_450 = T. (Before legend-y2lf
    //   De was 3_000_000: refund 3_950_000, B 3_305_750.)
    cases(
      "C1",
      "the employee gets his over-payment back in cash and the company bears its own shortfall, instead of the employee funding it",
      {
        taxableLines: [{ amountIdr: 20_000_000, taxScheme: "gross" }],
        prior: ARCHITECT_YEAR,
      },
      20_000_000,
      9_000_000,
      {
        proportional: {
          x: 21_399_181,
          t: -930_150,
          annual: 8_069_850,
          w: 0,
          a: 0,
          b: 1_399_181,
          refund: 2_329_331,
          employerRefund: 0,
          de: 2_999_974,
          bE: -5_329_305,
          bR: 1_189_305,
        },
        gross_first: {
          x: 25_717_550,
          t: -282_450,
          annual: 8_717_550,
          w: 0,
          a: 0,
          b: 5_717_550,
          refund: 6_000_000,
          employerRefund: 0,
          de: 950_000,
          bE: -6_950_000,
          bR: 2_810_000,
        },
      },
    );
  });

  describe("C2 architect history, December gross 10 jt + gross_up 10 jt: the company's shortfall is booked as allowance", () => {
    // Same history (H = -4_140_000, proportional bE = -5_329_305, bR =
    // 1_189_305; gross_first bE = -6_950_000, bR = 2_810_000).
    // X0 = 20_000_000, G* = 10_000_000, U = 10_000_000, N = 0 so
    // A = min(covered x U/(U+N), r) = r (all allowance), B = 0.
    // gross_first (bead legend-y2lf, founder Q52): De = annual(Gs + G*) -
    //   annual(Gs) = annual(110_000_000) - 2_050_000 = 2_525_000 - 2_050_000 =
    //   475_000 (annual(110 jt): cost 5_500_000, net 104_500_000, PKP
    //   50_500_000), capped at D (D is larger at every step).
    // proportional (De = floor(D x 10M/X)):
    // S0=0 X=20000000 annual=7860000 T=-1140000 D=3000000 De=1500000 Dr=1500000 next=2689305
    // S1=2689305 X=22689305 annual=8263350 T=-736650 D=3403350 De=1499979 Dr=1903371 next=3092676
    // S2=3092676 X=23092676 annual=8323800 T=-676200 D=3463800 De=1499956 Dr=1963844 next=3153149
    // S3=3153149 X=23153149 annual=8332950 T=-667050 D=3472950 De=1499990 Dr=1972960 next=3162265
    // S4=3162265 X=23162265 annual=8334300 T=-665700 D=3474300 De=1499982 Dr=1974318 next=3163623
    // S5=3163623 X=23163623 annual=8334450 T=-665550 D=3474450 De=1499959 Dr=1974491 next=3163796
    // S6=3163796 X=23163796 annual=8334450 T=-665550 D=3474450 De=1499948 Dr=1974502 next=3163807
    // S7=3163807 X=23163807 annual=8334450 T=-665550 D=3474450 De=1499947 Dr=1974503 next=3163808
    // S8=3163808 X=23163808 annual=8334450 T=-665550 D=3474450 De=1499947 Dr=1974503 next=3163808
    // gross_first (De = 475_000 every step; updated for bead legend-y2lf):
    // S0=0 X=20000000 annual=7860000 T=-1140000 D=3000000 De=475000 Dr=2525000 next=5335000
    // S1=5335000 X=25335000 annual=8660250 T=-339750 D=3800250 De=475000 Dr=3325250 next=6135250
    // S2=6135250 X=26135250 annual=8780250 T=-219750 D=3920250 De=475000 Dr=3445250 next=6255250
    // S3=6255250 X=26255250 annual=8798250 T=-201750 D=3938250 De=475000 Dr=3463250 next=6273250
    // S4=6273250 X=26273250 annual=8800950 T=-199050 D=3940950 De=475000 Dr=3465950 next=6275950
    // S5=6275950 X=26275950 annual=8801250 T=-198750 D=3941250 De=475000 Dr=3466250 next=6276250
    // S6=6276250 X=26276250 annual=8801400 T=-198600 D=3941400 De=475000 Dr=3466400 next=6276400
    // S7=6276400 X=26276400 annual=8801400 T=-198600 D=3941400 De=475000 Dr=3466400 next=6276400
    // Result proportional: X = 23_163_808, T = 8_334_450 - 9_000_000 =
    //   -665_550. e = 1_499_947 - 5_329_305 => W = 0, employee refund
    //   3_829_358. r = 1_974_503 + 1_189_305 = 3_163_808 = A.
    //   Check: 3_163_808 - 3_829_358 = -665_550 = T (withheld = allowance).
    // Result gross_first: X = 26_276_400, T = 8_801_400 - 9_000_000 =
    //   -198_600. W = 0, employee refund 6_475_000 (475_000 -
    //   6_950_000). r = 3_466_400 + 2_810_000 = 6_276_400 = A.
    //   Check: 6_276_400 - 6_475_000 = -198_600 = T. (Before
    //   legend-y2lf De was 1_500_000: refund 5_450_000, A 5_070_500.)
    cases(
      "C2",
      "the employee is refunded and his December salary carries the company's allowance",
      {
        taxableLines: [
          { amountIdr: 10_000_000, taxScheme: "gross" },
          { amountIdr: 10_000_000, taxScheme: "gross_up" },
        ],
        prior: ARCHITECT_YEAR,
      },
      20_000_000,
      9_000_000,
      {
        proportional: {
          x: 23_163_808,
          t: -665_550,
          annual: 8_334_450,
          w: 0,
          a: 3_163_808,
          b: 0,
          refund: 3_829_358,
          employerRefund: 0,
          de: 1_499_947,
          bE: -5_329_305,
          bR: 1_189_305,
        },
        gross_first: {
          x: 26_276_400,
          t: -198_600,
          annual: 8_801_400,
          w: 0,
          a: 6_276_400,
          b: 0,
          refund: 6_475_000,
          employerRefund: 0,
          de: 475_000,
          bE: -6_950_000,
          bR: 2_810_000,
        },
      },
    );
  });

  describe("C5 assumed ledger, H < 0: the employee is short, the company over-paid", () => {
    // ASSUMED Jan-Nov ledger: prior gross 220_000_000 (Gs = 100_000_000 gross
    //   scheme, E = 120_000_000 net scheme), withheld 0, borne 20_000_000,
    //   allowance 0. priorTax = pET = 20_000_000, pEeT = 0.
    // aP = annual(220_000_000): net 214_000_000, PKP 160_000_000, tax
    //   3_000_000 + 15% x 100_000_000 = 18_000_000 => H = -2_000_000.
    //   proportional: bR = floor(18_000_000 x 120_000_000 / 220_000_000) -
    //     20_000_000 = 9_818_181 - 20_000_000 = -10_181_819,
    //     bE = -2_000_000 + 10_181_819 = 8_181_819.
    //   gross_first: annual(Gs) = 2_050_000 (see C1) => bE = 2_050_000 - 0,
    //     bR = -2_000_000 - 2_050_000 = -4_050_000.
    //   (The company over-paid by more than the whole credit, and the old
    //   clamp to [0, C = 2_000_000] hid the employee's shortfall.)
    // December gross 10_000_000 (G* = X0 = X, no covered tax): annual(230_000_000)
    //   = 3_000_000 + 15% x 110_000_000 = 19_500_000, T = 19_500_000 -
    //   20_000_000 = -500_000, D = 19_500_000 - 18_000_000 = 1_500_000,
    //   De = D (G* = X), Dr = 0, r = bR < 0 so covered stays 0:
    // S0=0 X=10000000 annual=19500000 T=-500000 D=1500000 De=1500000 Dr=0 next=0
    // proportional: e = 1_500_000 + 8_181_819 => W = 9_681_819; company
    //   refund 10_181_819. Check: 9_681_819 - 10_181_819 = -500_000 = T.
    // gross_first (updated for bead legend-y2lf, founder Q52): De = annual(Gs
    //   + G*) - annual(Gs) = annual(110_000_000) - 2_050_000 = 2_525_000 -
    //   2_050_000 = 475_000 (was 1_500_000). Dr = D - De = 1_025_000, Dr + bR <
    //   0 so covered stays 0: e = 475_000 + 2_050_000 => W = 2_525_000; company
    //   refund 4_050_000 - 1_025_000 = 3_025_000.
    //   Check: 2_525_000 - 3_025_000 = -500_000 = T.
    cases(
      "C5",
      "the employee pays his own shortfall and the company is refunded its over-payment, not netted away",
      {
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        prior: {
          ...prior(220_000_000, 0, 20_000_000),
          taxAllowanceIdr: 0,
          grossSchemeBaseIdr: 100_000_000,
          employerSchemeBaseIdr: 120_000_000,
        },
      },
      10_000_000,
      20_000_000,
      {
        proportional: {
          x: 10_000_000,
          t: -500_000,
          annual: 19_500_000,
          w: 9_681_819,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 10_181_819,
          de: 1_500_000,
          bE: 8_181_819,
          bR: -10_181_819,
        },
        gross_first: {
          x: 10_000_000,
          t: -500_000,
          annual: 19_500_000,
          w: 2_525_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 3_025_000,
          de: 475_000,
          bE: 2_050_000,
          bR: -4_050_000,
        },
      },
    );
  });

  describe("C6 mixed assumed ledger (as the over-withholding suite), December gross 10 jt", () => {
    // ASSUMED Jan-Nov ledger of payroll-pph21-overwithhold-reference: prior
    //   gross 220_000_000 (Gs 100_000_000, E 120_000_000), withheld
    //   17_550_000 of which 15_000_000 allowance, borne 2_450_000; priorTax =
    //   20_000_000, pET = 17_450_000, pEeT = 2_550_000. aP = 18_000_000 (C5),
    //   H = -2_000_000.
    //   proportional: bR = 9_818_181 - 17_450_000 = -7_631_819, bE =
    //     -2_000_000 + 7_631_819 = 5_631_819 => the employee is SHORT while the
    //     company over-paid (opposite signs: the old clamp binds).
    //   gross_first: bE = annual(Gs) - pEeT = 2_050_000 - 2_550_000 =
    //     -500_000, bR = -2_000_000 + 500_000 = -1_500_000 => both over-paid,
    //     same sign: (the figures moved only through De, see below).
    // December gross 10_000_000 as C5: T = -500_000, D = 1_500_000 = De, Dr = 0,
    //   covered 0.
    // proportional: e = 1_500_000 + 5_631_819 => W = 7_131_819; company refund
    //   7_631_819. Check: 7_131_819 - 7_631_819 = -500_000 = T.
    // gross_first (updated for bead legend-y2lf, founder Q52): De = annual(Gs
    //   + G*) - annual(Gs) = annual(110_000_000) - 2_050_000 = 475_000 (was
    //   1_500_000), Dr = 1_025_000, Dr + bR < 0 so covered stays 0:
    //   e = 475_000 - 500_000 = -25_000 => W = 0, employee refund 25_000;
    //   company refund 1_500_000 - 1_025_000 = 475_000.
    //   Check: -25_000 - 475_000 = -500_000 = T.
    cases(
      "C6",
      "H < 0 after a mixed year: each payer settles its own balance",
      {
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        prior: {
          ...prior(220_000_000, 17_550_000, 2_450_000),
          taxAllowanceIdr: 15_000_000,
          grossSchemeBaseIdr: 100_000_000,
          employerSchemeBaseIdr: 120_000_000,
        },
      },
      10_000_000,
      20_000_000,
      {
        proportional: {
          x: 10_000_000,
          t: -500_000,
          annual: 19_500_000,
          w: 7_131_819,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 7_631_819,
          de: 1_500_000,
          bE: 5_631_819,
          bR: -7_631_819,
        },
        gross_first: {
          x: 10_000_000,
          t: -500_000,
          annual: 19_500_000,
          w: 0,
          a: 0,
          b: 0,
          refund: 25_000,
          employerRefund: 475_000,
          de: 475_000,
          bE: -500_000,
          bR: -1_500_000,
        },
      },
    );
  });
});

describe("PPh 21 unclamped payer balances, H > 0 with one payer over-paid (legend-mmgd)", () => {
  describe("C3 net TER-0% months then taxed gross months (history of H3), December gross 10 jt: the employee over-paid", () => {
    // Jan-Jun net 5_400_000 (TER 0%), Jul-Nov gross 10_000_000 (TER A row 9,
    //   2%: 200_000 each). Prior gross 6 x 5_400_000 + 5 x 10_000_000 =
    //   82_400_000, withheld 1_000_000, borne 0, allowance 0; E = 32_400_000,
    //   Gs = 50_000_000. priorTax 1_000_000, pET = 0, pEeT = 1_000_000.
    // aP = annual(82_400_000): cost 4_120_000, net 78_280_000, PKP 24_280_000,
    //   tax 1_214_000 => H = +214_000 (under-paid in total).
    //   proportional: bR = floor(1_214_000 x 32_400_000 / 82_400_000) =
    //     floor(477_349,51) = 477_349, bE = 214_000 - 477_349 = -263_349.
    //   gross_first: annual(Gs = 50_000_000) = 0 (net 47_500_000 < PTKP) =>
    //     bE = 0 - 1_000_000 = -1_000_000, bR = 214_000 + 1_000_000 =
    //     1_214_000.
    //   The employee over-paid although H > 0: the old clamp to [0, H] made
    //   him pay 0 of H and left the company with 214_000 only.
    // December gross 10_000_000 (G* = X0): annual(92_400_000): cost 4_620_000,
    //   net 87_780_000, PKP 33_780_000 => 1_689_000. proportional De starts at
    //   D = 1_689_000 - 1_214_000 = 475_000. gross_first (bead legend-y2lf,
    //   founder Q52): De = annual(Gs + G*) - annual(Gs) = annual(60_000_000) -
    //   0 = 150_000 (annual(60 jt): cost 3_000_000, net 57_000_000, PKP
    //   3_000_000; was the cap 475_000).
    // proportional:
    // S0=0 X=10000000 annual=1689000 T=689000 D=475000 De=475000 Dr=0 next=477349
    // S1=477349 X=10477349 annual=1711650 T=711650 D=497650 De=474977 Dr=22673 next=500022
    // S2=500022 X=10500022 annual=1712750 T=712750 D=498750 De=474999 Dr=23751 next=501100
    // S3=501100 X=10501100 annual=1712800 T=712800 D=498800 De=474997 Dr=23803 next=501152
    // S4=501152 X=10501152 annual=1712800 T=712800 D=498800 De=474995 Dr=23805 next=501154
    // S5=501154 X=10501154 annual=1712800 T=712800 D=498800 De=474995 Dr=23805 next=501154
    // gross_first (De = 150_000 every step; updated for bead legend-y2lf):
    // S0=0 X=10000000 annual=1689000 T=689000 D=475000 De=150000 Dr=325000 next=1539000
    // S1=1539000 X=11539000 annual=1762100 T=762100 D=548100 De=150000 Dr=398100 next=1612100
    // S2=1612100 X=11612100 annual=1765550 T=765550 D=551550 De=150000 Dr=401550 next=1615550
    // S3=1615550 X=11615550 annual=1765700 T=765700 D=551700 De=150000 Dr=401700 next=1615700
    // S4=1615700 X=11615700 annual=1765700 T=765700 D=551700 De=150000 Dr=401700 next=1615700
    // Result proportional: X = 10_501_154, T = 1_712_800 - 1_000_000 = 712_800.
    //   e = 474_995 - 263_349 = 211_646 => W = 211_646. r = 23_805 + 477_349 =
    //   501_154 = B. Check: 211_646 + 501_154 = 712_800 = T.
    // Result gross_first: X = 11_615_700, T = 1_765_700 - 1_000_000 = 765_700.
    //   e = 150_000 - 1_000_000 < 0 => W = 0, employee refund 850_000. r =
    //   401_700 + 1_214_000 = 1_615_700 = B. Check: 1_615_700 - 850_000 =
    //   765_700 = T. (Before legend-y2lf: De 475_000, refund 525_000, B
    //   1_274_500; the employee still ends at his own 150_000 tax.)
    cases(
      "C3",
      "the employee is not charged for the company's shortfall (gross_first: he is even refunded his over-payment)",
      {
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        prior: {
          ...prior(82_400_000, 1_000_000, 0),
          taxAllowanceIdr: 0,
          grossSchemeBaseIdr: 50_000_000,
          employerSchemeBaseIdr: 32_400_000,
        },
      },
      10_000_000,
      1_000_000,
      {
        proportional: {
          x: 10_501_154,
          t: 712_800,
          annual: 1_712_800,
          w: 211_646,
          a: 0,
          b: 501_154,
          refund: 0,
          employerRefund: 0,
          de: 474_995,
          bE: -263_349,
          bR: 477_349,
        },
        gross_first: {
          x: 11_615_700,
          t: 765_700,
          annual: 1_765_700,
          w: 0,
          a: 0,
          b: 1_615_700,
          refund: 850_000,
          employerRefund: 0,
          de: 150_000,
          bE: -1_000_000,
          bR: 1_214_000,
        },
      },
    );
  });

  describe("C4 assumed ledger, H > 0: the company over-paid, the employee is short", () => {
    // ASSUMED Jan-Nov ledger: prior gross 200_000_000 (Gs = 100_000_000 gross
    //   scheme, E = 100_000_000 net scheme), withheld 0, borne 14_000_000,
    //   allowance 0. priorTax = pET = 14_000_000, pEeT = 0.
    // aP = annual(200_000_000): net 194_000_000, PKP 140_000_000, tax
    //   3_000_000 + 15% x 80_000_000 = 15_000_000 => H = +1_000_000.
    //   proportional: bR = floor(15_000_000 x 100_000_000 / 200_000_000) -
    //     14_000_000 = 7_500_000 - 14_000_000 = -6_500_000, bE = 1_000_000 +
    //     6_500_000 = 7_500_000.
    //   gross_first: annual(Gs = 100_000_000) = 2_050_000 (see C1) =>
    //     bE = 2_050_000 - 0, bR = 1_000_000 - 2_050_000 = -1_050_000.
    //   (Old clamp to [0, H = 1_000_000]: the company's over-payment was used
    //   up against the employee's shortfall.)
    // December gross 10_000_000 (G* = X0 = X, covered 0 since Dr + bR < 0):
    //   annual(210_000_000): net 204_000_000, PKP 150_000_000 => 3_000_000 +
    //   15% x 90_000_000 = 16_500_000. T = 16_500_000 - 14_000_000 =
    //   2_500_000, D = 16_500_000 - 15_000_000 = 1_500_000 = De, Dr = 0.
    // S0=0 X=10000000 annual=16500000 T=2500000 D=1500000 De=1500000 Dr=0 next=0
    // proportional: e = 1_500_000 + 7_500_000 => W = 9_000_000; company
    //   refund 6_500_000. Check: 9_000_000 - 6_500_000 = 2_500_000 = T.
    // gross_first (updated for bead legend-y2lf, founder Q52): De = annual(Gs
    //   + G*) - annual(Gs) = annual(110_000_000) - 2_050_000 = 475_000 (was
    //   1_500_000), Dr = 1_025_000, Dr + bR < 0 so covered stays 0:
    //   e = 475_000 + 2_050_000 => W = 2_525_000; company refund 1_050_000 -
    //   1_025_000 = 25_000. Check: 2_525_000 - 25_000 = 2_500_000 = T.
    cases(
      "C4",
      "the company is refunded its over-payment and the employee pays his own shortfall in full",
      {
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        prior: {
          ...prior(200_000_000, 0, 14_000_000),
          taxAllowanceIdr: 0,
          grossSchemeBaseIdr: 100_000_000,
          employerSchemeBaseIdr: 100_000_000,
        },
      },
      10_000_000,
      14_000_000,
      {
        proportional: {
          x: 10_000_000,
          t: 2_500_000,
          annual: 16_500_000,
          w: 9_000_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 6_500_000,
          de: 1_500_000,
          bE: 7_500_000,
          bR: -6_500_000,
        },
        gross_first: {
          x: 10_000_000,
          t: 2_500_000,
          annual: 16_500_000,
          w: 2_525_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 25_000,
          de: 475_000,
          bE: 2_050_000,
          bR: -1_050_000,
        },
      },
    );
  });
});

describe("PPh 21 unclamped payer balances: months where nothing changes (legend-mmgd)", () => {
  // bE and bR have the same sign (or one is 0), so the old engine's figures
  // stand (values as in the over-withholding suite O1/O2).
  describe("N1 gross-up 15 jt Jan-Nov, December gross 15 jt (bead legend-u1xq example)", () => {
    // Jan-Nov: X = 16_129_032, S = 1_129_032 (TER A row 17, 7%), withheld =
    //   allowance = 12_419_352, borne 0, prior gross 177_419_352, Gs = 0.
    // aP = annual(177_419_352): cost 6_000_000, net 171_419_352, PKP
    //   117_419_000, tax 3_000_000 + 15% x 57_419_000 = 11_612_850 =>
    //   H = -806_502. pET = priorTax, pEeT = 0: bE = 0, bR = H (both policies).
    // December gross 15_000_000: annual(192_419_352): PKP 132_419_000 =>
    //   13_862_850; T = 1_443_498, D = 2_250_000 = De, Dr = 0.
    // proportional: e = 2_250_000 => W = 2_250_000; r = -806_502 => company
    //   refund 806_502. Check: 2_250_000 - 806_502 = 1_443_498 = T.
    // gross_first (updated for bead legend-y2lf, founder Q52): Gs = 0, so De =
    //   annual(Gs + G*) - annual(Gs) = annual(15_000_000) - 0 = 0 (below PTKP:
    //   net 14_250_000 < 54_000_000) instead of D = 2_250_000. Dr = D - 0, so
    //   the company bears the whole December tax and its credit is used up:
    //   e = 0 => W = 0; r = Dr + bR = 2_250_000 - 806_502 = 1_443_498 > 0, so
    //   covered S > 0, all borne (no gross-up line), fixed point (python3):
    //   S0=0 X=15000000 annual=13862850 T=1443498 D=2250000 De=0 Dr=2250000 next=1443498
    //   S1=1443498 X=16443498 annual=14079300 T=1659948 D=2466450 De=0 Dr=2466450 next=1659948
    //   S2=1659948 X=16659948 annual=14111850 T=1692498 D=2499000 De=0 Dr=2499000 next=1692498
    //   S3=1692498 X=16692498 annual=14116650 T=1697298 D=2503800 De=0 Dr=2503800 next=1697298
    //   S4=1697298 X=16697298 annual=14117400 T=1698048 D=2504550 De=0 Dr=2504550 next=1698048
    //   S5=1698048 X=16698048 annual=14117550 T=1698198 D=2504700 De=0 Dr=2504700 next=1698198
    //   S6=1698198 X=16698198 annual=14117550 T=1698198 D=2504700 De=0 Dr=2504700 next=1698198
    //   X = 16_698_198, T = 14_117_550 - 12_419_352 = 1_698_198 = borne B,
    //   W = 0. The tax on the employee's December pay moves to the company
    //   because his gross-scheme pay alone stays under PTKP (risk: flagged to
    //   the founder / tax consultant, see docs/release-notes-pph21-december.md).
    // S0=0 X=15000000 annual=13862850 T=1443498 D=2250000 De=2250000 Dr=0 next=0
    cases(
      "N1",
      "the company's credit is the company's: proportional: the employee pays 2_250_000 and the company is refunded 806_502; gross_first (legend-y2lf): the employee pays 0 and the company bears the tax",
      {
        taxableLines: [{ amountIdr: 15_000_000, taxScheme: "gross" }],
        prior: {
          ...prior(177_419_352, 12_419_352, 0),
          taxAllowanceIdr: 12_419_352,
          grossSchemeBaseIdr: 0,
          employerSchemeBaseIdr: 177_419_352,
        },
      },
      15_000_000,
      12_419_352,
      {
        proportional: {
          x: 15_000_000,
          t: 1_443_498,
          annual: 13_862_850,
          w: 2_250_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 806_502,
          de: 2_250_000,
          bE: 0,
          bR: -806_502,
        },
        gross_first: {
          x: 16_698_198,
          t: 1_698_198,
          annual: 14_117_550,
          w: 0,
          a: 0,
          b: 1_698_198,
          refund: 0,
          employerRefund: 0,
          de: 0,
          bE: 0,
          bR: -806_502,
        },
      },
    );
  });

  describe("N2 pure gross 12 jt every month", () => {
    // Jan-Nov 12_000_000 (TER A row 14, 4%: 480_000 each), withheld
    //   5_280_000, prior gross 132_000_000, Gs = 132_000_000, E = 0.
    // aP = annual(132_000_000) = 4_800_000 (cost 6_000_000, PKP 72_000_000) =>
    //   H = -480_000. pET = 0: bR = 0, bE = H (both policies).
    // December gross 12_000_000: annual(144_000_000) = 6_600_000, T =
    //   1_320_000, D = 1_800_000 = De, Dr = 0. e = 1_800_000 - 480_000 =
    //   1_320_000 = W; no company side.
    // S0=0 X=12000000 annual=6600000 T=1320000 D=1800000 De=1800000 Dr=0 next=0
    cases(
      "N2",
      "the employee gets back his own credit through a smaller December tax",
      {
        taxableLines: [{ amountIdr: 12_000_000, taxScheme: "gross" }],
        prior: {
          ...prior(132_000_000, 5_280_000, 0),
          taxAllowanceIdr: 0,
          grossSchemeBaseIdr: 132_000_000,
          employerSchemeBaseIdr: 0,
        },
      },
      12_000_000,
      5_280_000,
      {
        proportional: {
          x: 12_000_000,
          t: 1_320_000,
          annual: 6_600_000,
          w: 1_320_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 0,
          de: 1_800_000,
          bE: -480_000,
          bR: 0,
        },
        gross_first: {
          x: 12_000_000,
          t: 1_320_000,
          annual: 6_600_000,
          w: 1_320_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 0,
          de: 1_800_000,
          bE: -480_000,
          bR: 0,
        },
      },
    );
  });

  describe("N3 no pay in December after the N1 gross-up year (X = 0)", () => {
    // Same history as N1: H = -806_502, bE = 0, bR = -806_502. No lines: X =
    // 0, annual(prior) = 11_612_850, T = H = -806_502, D = 0, De = Dr = 0,
    // covered 0. The employee owes and gets nothing; the company is refunded
    // its credit. Check: 0 - 806_502 = T.
    cases(
      "N3",
      "nothing for the employee, the company's credit is refunded to the company",
      {
        taxableLines: [],
        prior: {
          ...prior(177_419_352, 12_419_352, 0),
          taxAllowanceIdr: 12_419_352,
          grossSchemeBaseIdr: 0,
          employerSchemeBaseIdr: 177_419_352,
        },
      },
      0,
      12_419_352,
      {
        proportional: {
          x: 0,
          t: -806_502,
          annual: 11_612_850,
          w: 0,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 806_502,
          de: 0,
          bE: 0,
          bR: -806_502,
        },
        gross_first: {
          x: 0,
          t: -806_502,
          annual: 11_612_850,
          w: 0,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 806_502,
          de: 0,
          bE: 0,
          bR: -806_502,
        },
      },
    );
  });

  describe("N4 pure gross 10 jt every month, H > 0", () => {
    // Jan-Nov 10_000_000 (TER A row 9, 2%: 200_000 each), withheld 2_200_000,
    //   prior gross 110_000_000, Gs = 110_000_000, E = 0.
    // aP = annual(110_000_000): cost 5_500_000, net 104_500_000, PKP
    //   50_500_000 => 2_525_000; H = +325_000. pET = 0: bR = 0 and bE = H
    //   (proportional: floor(aP x 0 / mix) - 0; gross_first: annual(Gs) -
    //   pEeT = 2_525_000 - 2_200_000).
    // December gross 10_000_000: annual(120_000_000): cost 6_000_000, net
    //   114_000_000, PKP 60_000_000 => 3_000_000; T = 800_000, D = 475_000 =
    //   De, Dr = 0. e = 475_000 + 325_000 = 800_000 = W; no company side.
    // S0=0 X=10000000 annual=3000000 T=800000 D=475000 De=475000 Dr=0 next=0
    cases(
      "N4",
      "the employee pays the whole December tax, nothing for the company",
      {
        taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        prior: {
          ...prior(110_000_000, 2_200_000, 0),
          taxAllowanceIdr: 0,
          grossSchemeBaseIdr: 110_000_000,
          employerSchemeBaseIdr: 0,
        },
      },
      10_000_000,
      2_200_000,
      {
        proportional: {
          x: 10_000_000,
          t: 800_000,
          annual: 3_000_000,
          w: 800_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 0,
          de: 475_000,
          bE: 325_000,
          bR: 0,
        },
        gross_first: {
          x: 10_000_000,
          t: 800_000,
          annual: 3_000_000,
          w: 800_000,
          a: 0,
          b: 0,
          refund: 0,
          employerRefund: 0,
          de: 475_000,
          bE: 325_000,
          bR: 0,
        },
      },
    );
  });

  for (const allocation of ALLOCATIONS) {
    it(`N5 (TER month, ${allocation}) gross 10 jt in a non-final month: 2% withheld, no history split, no refunds`, () => {
      // TER A row 9 (up to 10_050_000, 2%): 10_000_000 x 200 / 10000 =
      // 200_000, all withheld from the employee. H = 0 in TER months, so bE =
      // bR = 0 and nothing moves.
      const r = run(
        {
          lastTaxPeriod: false,
          monthsWorked: 1,
          taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
        },
        { mixedSchemeAllocation: allocation },
      );
      expect(r.method).toBe("ter");
      expect(r.taxableGrossIdr).toBe(10_000_000);
      expect(r.pph21Idr).toBe(200_000);
      expect(r.pph21WithheldIdr).toBe(200_000);
      expect(r.taxAllowanceIdr).toBe(0);
      expect(r.pph21EmployerBorneIdr).toBe(0);
      expect(r.pph21RefundIdr).toBe(0);
      expect(r.pph21EmployerRefundIdr).toBe(0);
    });
  }

  for (const allocation of ALLOCATIONS) {
    it(`N6 (TER month with a mixed prior and scheme bases, ${allocation}) outside the last tax period the history balances are 0: same result as a plain TER month`, () => {
      // lastTaxPeriod false => TER on X, no annual recalculation, H = 0 and
      // bE = bR = 0 whatever the prior says (the ASSUMED mixed ledger of C6,
      // with scheme bases sent, which would give H = -2_000_000 in December).
      // gross 5_000_000 + gross_up 5_000_000, TER A (the rate is on X = 10_000_000
      // + S, S = the company's allowance):
      //   proportional: employee part floor(T x G*/X), company S = T - part;
      //     S = 115_090: X = 10_115_090, row 10 (2,25%, bound 10_350_000),
      //     10_115_090 x 225 / 10000 = 227_589,525 -> 227_590 (stable). T =
      //     227_590, the employee's own part 112_500 (= 2,25% x 5_000_000),
      //     allowance 115_090, withheld = T.
      //   gross_first: employee part min(T, TER on G* = 5_000_000) = 0 (TER A
      //     row 1, 0%), so S = T. S0=0: T(10_000_000) = 225_000; S1=225_000:
      //     X 10_225_000 T 230_063; S2=230_063: X 10_230_063 T 230_176; S3=230_176:
      //     X 10_230_176 T 230_179; S4=230_179: X 10_230_179, 10_230_179 x 225 /
      //     10000 = 230_179,03 -> 230_179 stop. X = 10_230_179, T = 230_179 =
      //     allowance = withheld (employee part 0), borne 0.
      // No refunds either way (an earlier draft of this comment assumed the
      // proportional figures for both policies).
      const expected =
        allocation === "proportional"
          ? { x: 10_115_090, t: 227_590, allowance: 115_090 }
          : { x: 10_230_179, t: 230_179, allowance: 230_179 };
      const lines: Line[] = [
        { amountIdr: 5_000_000, taxScheme: "gross" },
        { amountIdr: 5_000_000, taxScheme: "gross_up" },
      ];
      const policy = { mixedSchemeAllocation: allocation };
      const plain = run(
        { lastTaxPeriod: false, monthsWorked: 1, taxableLines: lines },
        policy,
      );
      const withPrior = run(
        {
          lastTaxPeriod: false,
          monthsWorked: 8,
          taxableLines: lines,
          prior: {
            ...prior(220_000_000, 17_550_000, 2_450_000),
            taxAllowanceIdr: 15_000_000,
            grossSchemeBaseIdr: 100_000_000,
            employerSchemeBaseIdr: 120_000_000,
          },
        },
        policy,
      );
      for (const r of [plain, withPrior]) {
        expect(r.method).toBe("ter");
        expect(r.taxableGrossIdr).toBe(expected.x);
        expect(r.pph21Idr).toBe(expected.t);
        expect(r.taxAllowanceIdr).toBe(expected.allowance);
        expect(r.pph21WithheldIdr).toBe(expected.t);
        expect(r.pph21EmployerBorneIdr).toBe(0);
        expect(r.pph21RefundIdr).toBe(0);
        expect(r.pph21EmployerRefundIdr).toBe(0);
      }
      expect(withPrior).toEqual(plain);
    });
  }
});
