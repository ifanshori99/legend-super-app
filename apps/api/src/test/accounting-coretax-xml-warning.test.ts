// legend-powk0 / legend-wqorb: an auditor warning on a tax report line (the
// `warnings` field, e.g. non-PBJT tax left out of the PBJT figures) is for the
// screen only. It must never be written into the Coretax XML that is uploaded
// to the tax office.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TaxReportLine } from "@starter/shared/accounting";
import { buildCoretaxXml } from "../services/accounting-coretax-xml";

const WARNING = "Pajak non-PBJT Rp2000 tidak ikut";

const line = (references: string[], warnings: string[]): TaxReportLine =>
  ({
    subjectType: "outlet",
    subjectId: randomUUID(),
    subjectName: "Outlet Satu",
    taxIdMasked: null,
    outletId: randomUUID(),
    baseIdr: 100_000,
    taxIdr: 10_000,
    references,
    warnings,
  }) as unknown as TaxReportLine;

const xmlOf = (lines: TaxReportLine[]) =>
  buildCoretaxXml({
    id: randomUUID(),
    tenantId: randomUUID(),
    legalEntityId: randomUUID(),
    type: "pbjt",
    period: "2026-11",
    revisionNo: 0,
    amountIdr: 10_000,
    lines,
    finalizedAt: new Date("2026-12-01T00:00:00Z"),
  } as never);

describe("legend-powk0 Coretax XML leaves out auditor warnings", () => {
  it("does not write a line warning into the XML", () => {
    const xml = xmlOf([line([], [WARNING])]);
    expect(xml).not.toContain("Peringatan");
    expect(xml).not.toContain("non-PBJT");
    expect(xml).toContain("<References>");
  });

  it("keeps the real source-document references of the same line", () => {
    const xml = xmlOf([line(["INV-001", "INV-002"], [WARNING])]);
    expect(xml).toContain("<Reference>INV-001</Reference>");
    expect(xml).toContain("<Reference>INV-002</Reference>");
    expect(xml).not.toContain("Peringatan");
  });

  it("is unchanged for a line without a warning", () => {
    const xml = xmlOf([line(["INV-009"], [])]);
    expect(xml).toContain("<Reference>INV-009</Reference>");
  });

  it("still leaves out a 'Peringatan:' reference of an old stored report", () => {
    const legacy = line(["INV-001", `Peringatan: ${WARNING}`], []);
    const xml = xmlOf([legacy]);
    expect(xml).toContain("<Reference>INV-001</Reference>");
    expect(xml).not.toContain("Peringatan");
    expect(xml).not.toContain("non-PBJT");
  });
});
