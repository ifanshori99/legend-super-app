// Pure unit tests of the Coretax A1 (BPA1) XML builder (bead legend-838hi,
// brief docs/briefs/949-context.md "838hi"). Mirrors coretax-bpmp.ts.
//
// Interface under test (module does not exist yet, so every test fails first
// on the missing import):
//   lib/payroll-export/coretax-a1.ts
//     buildA1BulkXml({ withholderTin16, nitku22, rows: A1Row[] }): string
//
// Assumptions (the brief names the module, the function and the field names but
// no row shape or XML layout; contest them):
// - A1Row = { taxYear (number), nik16, ptkpStatus, position, withholdingDate
//   (YYYY-MM-DD), statusOfWithholding
//   ("FullYear" | "PartialYear" | "Annualized"), and integer IDR amounts
//   salaryPensionJhtThtIdr, otherBenefitIdr, honorariumIdr,
//   insurancePaidByEmployerIdr, naturaIdr, tantiemBonusThrIdr,
//   pensionContributionJhtThtFeeIdr, zakatIdr }.
// - Root <A1Bulk> with <TIN>, one <A1> block per row, element names from the
//   brief (SalaryPensionJhtTht, OtherBenefit, Honorarium,
//   InsurancePaidByEmployer, Natura, TantiemBonusThr,
//   PensionContributionJhtThtFee, Zakat, StatusOfWithholding), plus
//   TaxPeriodYear and CounterpartTin (NIK). Exact whitespace is not asserted.
// - Bad input (non-integer or negative amount, non 16-digit NIK or TIN, year
//   not YYYY, duplicate NIK in rows) makes the builder throw: it must never
//   guess or silently merge.
import { describe, expect, it } from "vitest";
import { buildA1BulkXml } from "../lib/payroll-export/coretax-a1.ts";

const TIN = "0029482015507000";
const NITKU = `${TIN}000000`;

function row(over: Record<string, unknown> = {}) {
  return {
    taxYear: 2025,
    nik16: "3275010905770021",
    ptkpStatus: "TK/0",
    position: "Kasir",
    statusOfWithholding: "FullYear",
    withholdingDate: "2025-12-31",
    salaryPensionJhtThtIdr: 60_000_000,
    otherBenefitIdr: 1_000_000,
    honorariumIdr: 2_000_000,
    insurancePaidByEmployerIdr: 3_000_000,
    naturaIdr: 4_000_000,
    tantiemBonusThrIdr: 5_000_000,
    pensionContributionJhtThtFeeIdr: 600_000,
    zakatIdr: 150_000,
    ...over,
  };
}
// The builder's row type is the engineer's to define; tests pass plain objects.
const build = (rows: Record<string, unknown>[]) =>
  buildA1BulkXml({
    withholderTin16: TIN,
    nitku22: NITKU,
    rows,
  } as unknown as Parameters<typeof buildA1BulkXml>[0]);
const tag = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map(
    (m) => m[1],
  );

describe("buildA1BulkXml", () => {
  it("[a1-builder-layout] writes the A1Bulk root, the withholder TIN and one A1 block with every mapped amount", () => {
    const xml = build([row()]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
    expect(xml).toContain("<A1Bulk");
    expect(xml.trimEnd().endsWith("</A1Bulk>")).toBe(true);
    expect(tag(xml, "TIN")).toEqual([TIN]);
    expect(xml.match(/<A1>/g)).toHaveLength(1);
    expect(tag(xml, "TaxPeriodYear")).toEqual(["2025"]);
    expect(tag(xml, "CounterpartTin")).toEqual(["3275010905770021"]);
    expect(tag(xml, "StatusOfWithholding")).toEqual(["FullYear"]);
    expect(tag(xml, "SalaryPensionJhtTht")).toEqual(["60000000"]);
    expect(tag(xml, "OtherBenefit")).toEqual(["1000000"]);
    expect(tag(xml, "Honorarium")).toEqual(["2000000"]);
    expect(tag(xml, "InsurancePaidByEmployer")).toEqual(["3000000"]);
    expect(tag(xml, "Natura")).toEqual(["4000000"]);
    expect(tag(xml, "TantiemBonusThr")).toEqual(["5000000"]);
    expect(tag(xml, "PensionContributionJhtThtFee")).toEqual(["600000"]);
    expect(tag(xml, "Zakat")).toEqual(["150000"]);
    expect(xml).toContain("2025-12-31");
  });

  it("[a1-builder-one-block-per-row] two employees give two blocks in row order, amounts not mixed", () => {
    const xml = build([
      row(),
      row({
        nik16: "3275010905770022",
        salaryPensionJhtThtIdr: 9_000_000,
        statusOfWithholding: "PartialYear",
      }),
    ]);
    expect(xml.match(/<A1>/g)).toHaveLength(2);
    expect(tag(xml, "CounterpartTin")).toEqual([
      "3275010905770021",
      "3275010905770022",
    ]);
    expect(tag(xml, "SalaryPensionJhtTht")).toEqual(["60000000", "9000000"]);
    expect(tag(xml, "StatusOfWithholding")).toEqual([
      "FullYear",
      "PartialYear",
    ]);
  });

  it("[a1-builder-no-duplicate-employee] two rows with the same NIK make the builder throw", () => {
    expect(() => build([row(), row({ salaryPensionJhtThtIdr: 1 })])).toThrow();
  });

  it("[a1-builder-xml-escape] position text is XML escaped", () => {
    const xml = build([row({ position: `Kasir & "Barista" <A>` })]);
    expect(xml).toContain("Kasir &amp; ");
    expect(xml).not.toContain("<A>");
    expect(xml).not.toContain("& ");
  });

  it("[a1-builder-integer-idr] fractional, negative or non-finite amounts throw, never rounded", () => {
    for (const bad of [100.5, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => build([row({ salaryPensionJhtThtIdr: bad })])).toThrow();
    expect(() => build([row({ zakatIdr: 0.5 })])).toThrow();
  });

  it("[a1-builder-validates-ids] a NIK or withholder TIN that is not 16 digits, or a year that is not YYYY, throws", () => {
    expect(() => build([row({ nik16: "123" })])).toThrow();
    expect(() => build([row({ nik16: "32750109057700AB" })])).toThrow();
    expect(() => build([row({ taxYear: 25 })])).toThrow();
    expect(() => build([row({ taxYear: "2025-03" })])).toThrow();
    expect(() =>
      buildA1BulkXml({
        withholderTin16: "123",
        nitku22: NITKU,
        rows: [row()],
      } as unknown as Parameters<typeof buildA1BulkXml>[0]),
    ).toThrow();
  });

  it("[a1-builder-withholding-date] a withholding date that is not a valid YYYY-MM-DD throws", () => {
    for (const bad of ["2025-13-01", "31-12-2025", "2025-02-30"])
      expect(() => build([row({ withholdingDate: bad })])).toThrow();
  });

  it("[a1-builder-status-values] StatusOfWithholding accepts FullYear, PartialYear, Annualized only", () => {
    for (const ok of ["FullYear", "PartialYear", "Annualized"])
      expect(
        tag(build([row({ statusOfWithholding: ok })]), "StatusOfWithholding"),
      ).toEqual([ok]);
    expect(() => build([row({ statusOfWithholding: "Other" })])).toThrow();
  });
});
