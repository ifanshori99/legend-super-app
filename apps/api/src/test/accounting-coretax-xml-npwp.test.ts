// legend-xysyi: the Coretax XML carries the real NPWP (opened at export), only
// when it is 15 or 16 digits, with XML-safe escaping, and never the mask.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaxReportLine } from "@starter/shared/accounting";
import { buildCoretaxXml } from "../services/accounting-coretax-xml";
import { normalizeNpwp } from "../services/accounting-coretax-tax-ids";

const NPWP15 = "012345678901234";
const NPWP16 = "0123456789011234";

const line = (
  subjectId: string,
  over: Partial<TaxReportLine> = {},
): TaxReportLine =>
  ({
    subjectType: "supplier",
    subjectId,
    subjectName: "CV Satu",
    taxIdMasked: "NPWP ****1234",
    outletId: null,
    baseIdr: 100_000,
    taxIdr: 2_000,
    references: [],
    ...over,
  }) as unknown as TaxReportLine;

const build = (
  lines: TaxReportLine[],
  ids: Record<string, string>,
  taxpayer: string | null = null,
) =>
  buildCoretaxXml(
    {
      id: randomUUID(),
      legalEntityId: randomUUID(),
      type: "pph23",
      period: "2026-11",
      revisionNo: 0,
      amountIdr: 2_000,
      lines,
      finalizedAt: new Date("2026-12-01T00:00:00Z"),
    } as never,
    { lines: new Map(Object.entries(ids)), taxpayer },
  );

describe("Coretax XML real NPWP", () => {
  it("writes the real 15 and 16 digit NPWP, not the mask", () => {
    const a = randomUUID();
    const b = randomUUID();
    const xml = build([line(a), line(b)], { [a]: NPWP15, [b]: NPWP16 });
    expect(xml).toContain(`<TaxId>${NPWP15}</TaxId>`);
    expect(xml).toContain(`<TaxId>${NPWP16}</TaxId>`);
    expect(xml).not.toContain("****");
  });

  it("writes the taxpayer NPWP of the legal entity in the header", () => {
    const a = randomUUID();
    const xml = build([line(a)], { [a]: NPWP15 }, NPWP16);
    expect(xml).toContain(`<TaxpayerId>${NPWP16}</TaxpayerId>`);
  });

  it.each(["1234", "12345678901234", "01234567890123456", "01234567890123A"])(
    "refuses a malformed NPWP (%s) without echoing it",
    (bad) => {
      const a = randomUUID();
      let message = "";
      try {
        build([line(a)], { [a]: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(bad);
    },
  );

  it("refuses an NPWP whose last 4 digits differ from the report mask", () => {
    const a = randomUUID();
    let message = "";
    try {
      build([line(a)], { [a]: "012345678909999" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("09999");
  });

  it("refuses a line whose NPWP could not be opened", () => {
    expect(() => build([line(randomUUID())], {})).toThrow();
  });

  it("refuses a malformed taxpayer NPWP", () => {
    const a = randomUUID();
    expect(() => build([line(a)], { [a]: NPWP15 }, "123")).toThrow();
  });

  it("keeps an empty TaxId for a line that never had a tax id", () => {
    const xml = build([line(randomUUID(), { taxIdMasked: null })], {});
    expect(xml).toContain("<TaxId></TaxId>");
  });

  it("escapes XML special characters in names and strips control chars", () => {
    const a = randomUUID();
    const xml = build([line(a, { subjectName: `A&B <"C"> 'D'\u0001` })], {
      [a]: NPWP15,
    });
    expect(xml).toContain(
      "<SubjectName>A&amp;B &lt;&quot;C&quot;&gt; &apos;D&apos;</SubjectName>",
    );
    expect(xml).not.toContain("\u0001");
  });

  it("normalizes separators and rejects wrong lengths", () => {
    expect(normalizeNpwp("01.234.567.8-901.234")).toBe(NPWP15);
    expect(normalizeNpwp("1234")).toBeNull();
    expect(normalizeNpwp("0123456789012345678")).toBeNull();
  });
});
