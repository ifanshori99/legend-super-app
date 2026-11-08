// Input guards of the PPh 21 period engine (bead legend-5cnk). The reference
// values live in payroll-pph21-ter.test.ts and payroll-pph21-annual.test.ts;
// this file only pins how bad input fails closed.
import { describe, expect, it } from "vitest";
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
  prior: { taxableGrossIdr: 0, employeeDeductibleIdr: 0, pph21Idr: 0 },
};

describe("PPh 21 engine guards", () => {
  it("rejects an unknown tax scheme instead of shifting tax to the employer", () => {
    expect(() =>
      computePph21Period(REFERENCE_TABLES, {
        ...base,
        taxableLines: [
          { amountIdr: 10_000_000, taxScheme: "bogus" as TaxScheme },
        ],
      }),
    ).toThrow(RangeError);
  });

  it.each([0, 13, 1.5])("rejects monthsWorked %s", (monthsWorked) => {
    expect(() =>
      computePph21Period(REFERENCE_TABLES, { ...base, monthsWorked }),
    ).toThrow(RangeError);
  });

  it.each([-1, 0.5, Number.NaN])("rejects line amount %s", (amountIdr) => {
    expect(() =>
      computePph21Period(REFERENCE_TABLES, {
        ...base,
        taxableLines: [{ amountIdr, taxScheme: "gross" }],
      }),
    ).toThrow(RangeError);
  });

  it("rejects a fractional prior PPh 21", () => {
    expect(() =>
      computePph21Period(REFERENCE_TABLES, {
        ...base,
        lastTaxPeriod: true,
        prior: { taxableGrossIdr: 0, employeeDeductibleIdr: 0, pph21Idr: 0.5 },
      }),
    ).toThrow(RangeError);
  });

  it("flags the no-tax-id rule even in the 0% TER row (nothing added)", () => {
    // X = 5_000_000, TER A row 1 (s.d. 5_400_000) 0% => 0; 0 x 120% = 0.
    const r = computePph21Period(REFERENCE_TABLES, {
      ...base,
      hasTaxId: false,
      taxableLines: [{ amountIdr: 5_000_000, taxScheme: "gross" }],
    });
    expect(r.pph21Idr).toBe(0);
    expect(r.noTaxIdSurchargeApplied).toBe(true);
  });
});
