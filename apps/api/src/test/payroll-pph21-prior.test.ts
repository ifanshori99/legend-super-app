// PPh 21 prior-year builder (bead legend-s5c1; PRD v1.7 §3 D.30, PAYR-03).
//
// The last tax period recomputes the year from the earlier payslips. The
// engine needs, besides the sums of X / deductions / withheld / borne tax,
// the employer-funded tax allowance (gross-up) inside `withheld` and the
// earlier scheme mix. Without them a gross-up employee is charged the
// company-funded Jan-Nov shortfall and is refunded tax the company paid.
// `buildPph21Prior` derives every field from the stored payslips, so a run
// cannot forget them.
//
// These cases replay a year through `computePayslipTax` (TER months, then the
// last period) and check the payer split, comparing the builder with the old
// four-field sum. Exact hand-computed amounts live in
// payroll-pph21-prior-reference.test.ts.
import { describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import {
  DEFAULT_PPH21_POLICY,
  buildPph21Prior,
  computePayslipTax,
  payslipTaxSchema,
  type PayslipTaxEarning,
  type Pph21PolicyParameters,
  type Pph21PriorPeriod,
} from "@starter/shared/hris/payroll";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

type Month = {
  earnings: PayslipTaxEarning[];
  employerBenefitIdr?: number;
  employeeDeductibleIdr?: number;
};

const policyOf = (allocation: Pph21PolicyParameters["mixedSchemeAllocation"]) =>
  ({ ...DEFAULT_PPH21_POLICY, mixedSchemeAllocation: allocation }) as const;

function earlierPeriods(
  months: readonly Month[],
  policy: Pph21PolicyParameters,
): Pph21PriorPeriod[] {
  return months.map((month) => {
    const employerBenefitIdr = month.employerBenefitIdr ?? 0;
    const employeeDeductibleIdr = month.employeeDeductibleIdr ?? 0;
    const { tax } = computePayslipTax({
      tables: REFERENCE_TABLES,
      policy,
      ptkpStatus: "TK/0",
      hasTaxId: true,
      lastTaxPeriod: false,
      monthsWorked: 12,
      earnings: month.earnings,
      employerBenefitIdr,
      employeeDeductibleIdr,
      prior: buildPph21Prior([]),
    });
    return { tax, employeeDeductibleIdr };
  });
}

/** The four-field sum a run used to pass (no allowance, no scheme mix). */
function naivePrior(periods: readonly Pph21PriorPeriod[]) {
  const sum = (pick: (p: Pph21PriorPeriod) => number) =>
    periods.reduce((total, p) => total + pick(p), 0);
  return {
    taxableGrossIdr: sum((p) => p.tax.taxableGrossIdr),
    employeeDeductibleIdr: sum((p) => Number(p.employeeDeductibleIdr)),
    pph21WithheldIdr: sum((p) => p.tax.pph21WithheldIdr),
    pph21EmployerBorneIdr: sum((p) => p.tax.pph21EmployerBorneIdr),
  };
}

function lastPeriod(
  month: Month,
  prior: Parameters<typeof computePayslipTax>[0]["prior"],
  policy: Pph21PolicyParameters,
  monthsWorked: number,
) {
  return computePayslipTax({
    tables: REFERENCE_TABLES,
    policy,
    ptkpStatus: "TK/0",
    hasTaxId: true,
    lastTaxPeriod: true,
    monthsWorked,
    earnings: month.earnings,
    employerBenefitIdr: month.employerBenefitIdr ?? 0,
    employeeDeductibleIdr: month.employeeDeductibleIdr ?? 0,
    prior,
  }).tax;
}

const grossUp = (amountIdr: number): Month => ({
  earnings: [{ amountIdr, taxable: true, taxScheme: "gross_up" }],
});

describe("buildPph21Prior: gross-up history stays the company's", () => {
  for (const allocation of ["proportional", "gross_first"] as const) {
    const policy = policyOf(allocation);

    it(`refunds the company, not the employee, when a gross-up leaver was over-withheld (${allocation})`, () => {
      // Gross-up 15 jt Jan-May (TER), leaves in June with 1 jt: the year's
      // annual tax is below the TER withheld, so June is lebih potong. Every
      // rupiah of tax so far was the company's tax allowance.
      const periods = earlierPeriods(
        Array.from({ length: 5 }, () => grossUp(15_000_000)),
        policy,
      );
      const prior = buildPph21Prior(periods);
      expect(prior.taxAllowanceIdr).toBe(prior.pph21WithheldIdr);
      expect(prior.taxAllowanceIdr).toBeGreaterThan(0);

      const fixed = lastPeriod(grossUp(1_000_000), prior, policy, 6);
      expect(fixed.pph21Idr).toBeLessThan(0);
      expect(fixed.pph21RefundIdr).toBe(0);
      expect(fixed.pph21EmployerRefundIdr).toBe(-fixed.pph21Idr);

      // The old four-field prior paid the company's tax back to the employee.
      const old = lastPeriod(
        grossUp(1_000_000),
        naivePrior(periods),
        policy,
        6,
      );
      expect(old.pph21RefundIdr).toBeGreaterThan(0);
    });

    it(`keeps the Jan-Nov shortfall off the employee of a gross-up year (${allocation})`, () => {
      // Gross-up 8 jt Jan-Nov, December 8 jt + 40 jt gross-up bonus: the
      // year's tax exceeds the TER paid. With the allowance reported, all of
      // it (shortfall included) is the company's: withheld == allowance.
      const periods = earlierPeriods(
        Array.from({ length: 11 }, () => grossUp(8_000_000)),
        policy,
      );
      const december: Month = {
        earnings: [
          { amountIdr: 8_000_000, taxable: true, taxScheme: "gross_up" },
          { amountIdr: 40_000_000, taxable: true, taxScheme: "gross_up" },
        ],
      };
      const fixed = lastPeriod(december, buildPph21Prior(periods), policy, 12);
      expect(fixed.pph21Idr).toBeGreaterThan(0);
      expect(fixed.pph21WithheldIdr).toBe(fixed.taxAllowanceIdr);
      expect(fixed.pph21EmployerBorneIdr + fixed.taxAllowanceIdr).toBe(
        fixed.pph21Idr,
      );
    });
  }
});

describe("buildPph21Prior: sums and scheme mix", () => {
  const policy = DEFAULT_PPH21_POLICY;

  it("returns all-zero history for no earlier period", () => {
    expect(buildPph21Prior([])).toEqual({
      taxableGrossIdr: 0,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      taxAllowanceIdr: 0,
      // Always reported since bead legend-4ndx, 0 when no period had one.
      pph21CapExcessIdr: 0,
      grossSchemeBaseIdr: 0,
      employerSchemeBaseIdr: 0,
    });
  });

  it("sums the stored payslip taxes and splits each X by scheme", () => {
    // Gross 6 jt + net 2 jt + employer benefit 200_000 (+ 100_000 JHT/JP):
    // gross scheme = 6_000_000 + floor(200_000 x 6/8) = 6_150_000; the rest
    // of X (net line, its benefit share, the borne tax) is the employer's.
    const month: Month = {
      earnings: [
        { amountIdr: 6_000_000, taxable: true, taxScheme: "gross" },
        { amountIdr: 2_000_000, taxable: true, taxScheme: "net" },
        { amountIdr: 300_000, taxable: false, taxScheme: "gross" },
      ],
      employerBenefitIdr: 200_000,
      employeeDeductibleIdr: 100_000,
    };
    const periods = earlierPeriods([month, month, month], policy);
    const [first] = periods;
    if (first === undefined) throw new Error("no period");
    const x = first.tax.taxableGrossIdr;
    const prior = buildPph21Prior(periods);
    expect(prior).toEqual({
      taxableGrossIdr: 3 * x,
      employeeDeductibleIdr: 300_000,
      pph21WithheldIdr: 3 * first.tax.pph21WithheldIdr,
      pph21EmployerBorneIdr: 3 * first.tax.pph21EmployerBorneIdr,
      taxAllowanceIdr: 0,
      pph21CapExcessIdr: 0,
      grossSchemeBaseIdr: 3 * 6_150_000,
      employerSchemeBaseIdr: 3 * (x - 6_150_000),
    });
    expect(first.tax.pph21EmployerBorneIdr).toBeGreaterThan(0);
  });

  it("puts a tax-free all-net year (TER 0%) on the employer scheme", () => {
    const net: Month = {
      earnings: [{ amountIdr: 5_400_000, taxable: true, taxScheme: "net" }],
    };
    const prior = buildPph21Prior(
      earlierPeriods(
        Array.from({ length: 11 }, () => net),
        policy,
      ),
    );
    expect(prior.pph21WithheldIdr + prior.pph21EmployerBorneIdr).toBe(0);
    expect(prior.grossSchemeBaseIdr).toBe(0);
    expect(prior.employerSchemeBaseIdr).toBe(59_400_000);
  });

  it("keeps all of the employer benefit on the gross scheme for gross-only pay", () => {
    const prior = buildPph21Prior(
      earlierPeriods(
        [
          {
            earnings: [
              { amountIdr: 7_000_000, taxable: true, taxScheme: "gross" },
            ],
            employerBenefitIdr: 250_000,
          },
        ],
        policy,
      ),
    );
    expect(prior.grossSchemeBaseIdr).toBe(7_250_000);
    expect(prior.employerSchemeBaseIdr).toBe(0);
  });
});

describe("buildPph21Prior: refuses an inconsistent history", () => {
  const [base] = earlierPeriods([grossUp(10_000_000)], DEFAULT_PPH21_POLICY);
  if (base === undefined) throw new Error("no period");

  it("refuses an earlier annual recalculation (a year already closed)", () => {
    expect(() =>
      buildPph21Prior([
        { ...base, tax: { ...base.tax, method: "annual_recalculation" } },
      ]),
    ).toThrow(RangeError);
  });

  it("refuses an earlier lebih potong refund", () => {
    expect(() =>
      buildPph21Prior([
        { ...base, tax: { ...base.tax, pph21RefundIdr: idr(1) } },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      buildPph21Prior([
        { ...base, tax: { ...base.tax, pph21EmployerRefundIdr: idr(1) } },
      ]),
    ).toThrow(RangeError);
  });

  it("refuses scheme bases that do not sum to the stored taxable gross", () => {
    expect(() =>
      buildPph21Prior([
        {
          ...base,
          tax: {
            ...base.tax,
            employerSchemeBaseIdr: idr(base.tax.employerSchemeBaseIdr + 1),
          },
        },
      ]),
    ).toThrow(RangeError);
  });

  it("refuses employer-covered tax above the employer scheme base", () => {
    // Gross-up 10 jt: X = 10_000_000 + allowance, all on the employer scheme.
    // Moving it to the gross scheme leaves no room for the allowance.
    expect(base.tax.employerSchemeBaseIdr).toBe(base.tax.taxableGrossIdr);
    expect(() =>
      buildPph21Prior([
        {
          ...base,
          tax: {
            ...base.tax,
            grossSchemeBaseIdr: base.tax.taxableGrossIdr,
            employerSchemeBaseIdr: idr(0),
          },
        },
      ]),
    ).toThrow(RangeError);
  });

  it("refuses an allowance above the withheld tax", () => {
    expect(() =>
      buildPph21Prior([
        {
          ...base,
          tax: {
            ...base.tax,
            taxAllowanceIdr: idr(base.tax.pph21WithheldIdr + 1),
          },
        },
      ]),
    ).toThrow(RangeError);
  });

  it("refuses a stored PPh 21 that is not withheld + borne", () => {
    expect(() =>
      buildPph21Prior([
        { ...base, tax: { ...base.tax, pph21Idr: idr(base.tax.pph21Idr + 1) } },
      ]),
    ).toThrow(RangeError);
  });

  it("refuses a negative or fractional amount", () => {
    expect(() =>
      buildPph21Prior([{ ...base, employeeDeductibleIdr: -1 }]),
    ).toThrow(RangeError);
    expect(() =>
      buildPph21Prior([{ ...base, employeeDeductibleIdr: 0.5 }]),
    ).toThrow(RangeError);
  });
});

/** A stored tax as an older payslip had it: no pph21CapExcessIdr key. */
function withoutCapExcess<T extends { pph21CapExcessIdr?: unknown }>(
  tax: T,
): Omit<T, "pph21CapExcessIdr"> {
  const copy = { ...tax };
  delete copy.pph21CapExcessIdr;
  return copy;
}

describe("buildPph21Prior: pph21CapExcessIdr (bead legend-4ndx)", () => {
  const grossMonth = (amountIdr: number): Month => ({
    earnings: [{ amountIdr, taxable: true, taxScheme: "gross" }],
  });
  // A net month: the company bears all of the tax, so there is room for a cap
  // excess (part of the borne tax) of any size up to the borne tax.
  const netMonth: Month = {
    earnings: [{ amountIdr: 10_000_000, taxable: true, taxScheme: "net" }],
  };
  const [base] = earlierPeriods([netMonth], DEFAULT_PPH21_POLICY);
  if (base === undefined) throw new Error("no period");
  const borne = base.tax.pph21EmployerBorneIdr;
  const withCapExcess = (value: number | undefined): Pph21PriorPeriod => {
    const rest = withoutCapExcess(base.tax);
    return {
      ...base,
      tax:
        value === undefined ? rest : { ...rest, pph21CapExcessIdr: idr(value) },
    };
  };

  it("has a borne tax to attach the excess to", () => {
    expect(borne).toBeGreaterThan(300);
  });

  it("sums the cap excess of the earlier periods", () => {
    const prior = buildPph21Prior([
      withCapExcess(100),
      withCapExcess(250),
      withCapExcess(0),
    ]);
    expect(prior.pph21CapExcessIdr).toBe(350);
    expect(prior.pph21EmployerBorneIdr).toBe(3 * borne);
  });

  it("reads an absent cap excess as 0", () => {
    expect(buildPph21Prior([withCapExcess(undefined)]).pph21CapExcessIdr).toBe(
      0,
    );
    expect(
      buildPph21Prior([withCapExcess(undefined), withCapExcess(40)])
        .pph21CapExcessIdr,
    ).toBe(40);
  });

  it("accepts a cap excess equal to the borne tax", () => {
    expect(buildPph21Prior([withCapExcess(borne)]).pph21CapExcessIdr).toBe(
      borne,
    );
  });

  it("refuses a cap excess above the borne tax of its period", () => {
    expect(() => buildPph21Prior([withCapExcess(borne + 1)])).toThrow(
      RangeError,
    );
    // The sum may not hide it: period 2's excess alone is above its borne tax.
    expect(() =>
      buildPph21Prior([withCapExcess(0), withCapExcess(borne + 1)]),
    ).toThrow(RangeError);
  });

  it("refuses a negative or fractional cap excess", () => {
    expect(() => buildPph21Prior([withCapExcess(-1)])).toThrow(RangeError);
    expect(() => buildPph21Prior([withCapExcess(0.5)])).toThrow(RangeError);
  });

  for (const allocation of ["proportional", "gross_first"] as const) {
    it(`a January with only a benefit (cap 0) is not charged back in December (${allocation})`, () => {
      // K1 of the take-home cap brief: January has an 8_000_000 benefit and no
      // salary under a gross agreement, February-December 10_000_000 gross.
      // The stored January tax carries the cap excess; the builder passes it
      // on, so December charges W 788_011 / 785_000, not 908_006 / 905_000.
      const policy = policyOf(allocation);
      const january = computePayslipTax({
        tables: REFERENCE_TABLES,
        policy,
        ptkpStatus: "TK/0",
        hasTaxId: true,
        lastTaxPeriod: false,
        monthsWorked: 1,
        earnings: [],
        employerBenefitIdr: 8_000_000,
        contractTaxScheme: "gross",
        employeeDeductibleIdr: 0,
        prior: buildPph21Prior([]),
      }).tax;
      const expectedExcess = allocation === "proportional" ? 119_999 : 120_000;
      expect(january.pph21CapExcessIdr).toBe(expectedExcess);
      expect(january.pph21EmployerBorneIdr).toBe(121_827);
      expect(january.pph21WithheldIdr).toBe(0);
      const months = [
        { tax: january, employeeDeductibleIdr: 0 },
        ...earlierPeriods(
          Array.from({ length: 10 }, () => grossMonth(10_000_000)),
          policy,
        ),
      ];
      const prior = buildPph21Prior(months);
      expect(prior.pph21CapExcessIdr).toBe(expectedExcess);
      const december = lastPeriod(grossMonth(10_000_000), prior, policy, 12);
      const expected =
        allocation === "proportional"
          ? { x: 10_000_962, w: 788_011, borne: 962 }
          : { x: 10_004_123, w: 785_000, borne: 4_123 };
      expect(december.taxableGrossIdr).toBe(expected.x);
      expect(december.pph21WithheldIdr).toBe(expected.w);
      expect(december.pph21EmployerBorneIdr).toBe(expected.borne);
      expect(december.pph21RefundIdr).toBe(0);
      expect(december.pph21EmployerRefundIdr).toBe(0);

      // Dropping the field (an old payslip) charges the excess back.
      const januaryOld = withoutCapExcess(january);
      const old = lastPeriod(
        grossMonth(10_000_000),
        buildPph21Prior([
          { ...months[0]!, tax: januaryOld },
          ...months.slice(1),
        ]),
        policy,
        12,
      );
      expect(old.pph21WithheldIdr).toBeGreaterThan(december.pph21WithheldIdr);
    });
  }
});

describe("payslipTaxSchema: pph21CapExcessIdr (bead legend-4ndx)", () => {
  const [base] = earlierPeriods(
    [
      {
        earnings: [{ amountIdr: 10_000_000, taxable: true, taxScheme: "net" }],
      },
    ],
    DEFAULT_PPH21_POLICY,
  );
  if (base === undefined) throw new Error("no period");
  const borne = base.tax.pph21EmployerBorneIdr;
  const withoutField = withoutCapExcess(base.tax);

  it("accepts a stored tax without the field, with 0, and equal to the borne tax", () => {
    expect(payslipTaxSchema.safeParse(withoutField).success).toBe(true);
    expect(
      payslipTaxSchema.safeParse({ ...withoutField, pph21CapExcessIdr: 0 })
        .success,
    ).toBe(true);
    expect(
      payslipTaxSchema.safeParse({ ...withoutField, pph21CapExcessIdr: borne })
        .success,
    ).toBe(true);
  });

  it("rejects a cap excess above the employer borne tax", () => {
    const result = payslipTaxSchema.safeParse({
      ...withoutField,
      pph21CapExcessIdr: borne + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative or fractional cap excess", () => {
    expect(
      payslipTaxSchema.safeParse({ ...withoutField, pph21CapExcessIdr: -1 })
        .success,
    ).toBe(false);
    expect(
      payslipTaxSchema.safeParse({ ...withoutField, pph21CapExcessIdr: 0.5 })
        .success,
    ).toBe(false);
  });
});
