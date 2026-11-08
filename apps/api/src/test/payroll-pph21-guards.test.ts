// Input guards of the PPh 21 period engine (bead legend-5cnk). The reference
// values live in payroll-pph21-ter.test.ts and payroll-pph21-annual.test.ts;
// this file only pins how bad input fails closed.
import { describe, expect, it } from "vitest";
import { DEFAULT_PPH21_POLICY } from "@starter/shared/hris/payroll";
import type { TaxScheme } from "@starter/shared/hris/payroll";
import { computePph21Period } from "../services/payroll-pph21.ts";
import type { Pph21PeriodInput } from "../services/payroll-pph21.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";

const base: Pph21PeriodInput = {
  ptkpStatus: "TK/0",
  hasTaxId: true,
  lastTaxPeriod: false,
  monthsWorked: 1,
  taxableLines: [{ amountIdr: 10_000_000, taxScheme: "gross" }],
  employerBenefitIdr: 0,
  employeeDeductibleIdr: 0,
  prior: {
    taxableGrossIdr: 0,
    employeeDeductibleIdr: 0,
    pph21WithheldIdr: 0,
    pph21EmployerBorneIdr: 0,
  },
};
const run = (input: Pph21PeriodInput) =>
  computePph21Period(REFERENCE_TABLES, DEFAULT_PPH21_POLICY, input);

describe("PPh 21 engine guards", () => {
  it("rejects an unknown tax scheme instead of shifting tax to the employer", () => {
    expect(() =>
      run({
        ...base,
        taxableLines: [
          { amountIdr: 10_000_000, taxScheme: "bogus" as TaxScheme },
        ],
      }),
    ).toThrow(RangeError);
  });

  it.each([0, 13, 1.5])("rejects monthsWorked %s", (monthsWorked) => {
    expect(() => run({ ...base, monthsWorked })).toThrow(RangeError);
  });

  it.each([-1, 0.5, Number.NaN])("rejects line amount %s", (amountIdr) => {
    expect(() =>
      run({
        ...base,
        taxableLines: [{ amountIdr, taxScheme: "gross" }],
      }),
    ).toThrow(RangeError);
  });

  it("rejects a fractional or negative prior PPh 21", () => {
    for (const bad of [0.5, -1])
      expect(() =>
        run({
          ...base,
          lastTaxPeriod: true,
          prior: { ...base.prior, pph21WithheldIdr: bad },
        }),
      ).toThrow(RangeError);
  });

  it("rejects a partial-year tax subject outside the last period", () => {
    expect(() => run({ ...base, partialYearTaxSubject: true })).toThrow(
      RangeError,
    );
  });

  it("flags the no-tax-id rule even in the 0% TER row (nothing added)", () => {
    // X = 5_000_000, TER A row 1 (s.d. 5_400_000) 0% => 0; 0 x 120% = 0.
    const r = run({
      ...base,
      hasTaxId: false,
      taxableLines: [{ amountIdr: 5_000_000, taxScheme: "gross" }],
    });
    expect(r.pph21Idr).toBe(0);
    expect(r.noTaxIdSurchargeApplied).toBe(true);
  });
});
