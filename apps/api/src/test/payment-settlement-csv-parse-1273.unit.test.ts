// 1273 (Duitku second opinion, P3-4): a settlement CSV reference that starts
// like a spreadsheet formula is refused, so it cannot turn into a formula when
// a later export opens in a spreadsheet.
import { describe, expect, it } from "vitest";
import {
  importGatewaySettlementCsvInputSchema,
  importSettlementInputSchema,
} from "@starter/shared/payment/admin";
import {
  GatewaySettlementCsvError,
  parseGatewaySettlementCsv,
} from "../services/payment-settlement-csv-parse.ts";

const OUTLET = "3f1c0f0e-5b0a-4c3e-9c1d-2a6b7c8d9e0f";
const HEADER = "reference,amount_idr,fee_idr";
const parse = (reference: string) =>
  parseGatewaySettlementCsv(
    "legend_template_v1",
    `${HEADER}\n${reference},10000,100\n`,
  );

describe("settlement CSV reference formula guard (1273 P3-4)", () => {
  it("reads a plain reference", () => {
    expect(parse("INV-2026-11-27")).toEqual([
      { reference: "INV-2026-11-27", amountIdr: 10_000, feeIdr: 100 },
    ]);
  });

  it.each(["=1+1", "+1", "-1+1", "@SUM(A1)", "\t=1+1", "\r=1+1"])(
    "refuses %j with a formula row error",
    (reference) => {
      const quoted = `"${reference}"`;
      let caught: unknown;
      try {
        parse(quoted);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GatewaySettlementCsvError);
      expect((caught as GatewaySettlementCsvError).rowErrors).toEqual([
        { row: 2, reason: "formula" },
      ]);
    },
  );
});

describe("settlement JSON formula guard (1273 review P3-3)", () => {
  const line = (reference: string) => ({
    reference,
    amountIdr: 10_000,
    feeIdr: 100,
  });
  const report = (reference: string, lineReference: string) => ({
    outletId: OUTLET,
    source: "gateway",
    provider: "duitku",
    reference,
    periodStart: "2026-11-01",
    periodEnd: "2026-11-02",
    grossIdr: 10_000,
    feeIdr: 100,
    netIdr: 9_900,
    lines: [line(lineReference)],
  });
  const messages = (input: unknown) => {
    const parsed = importSettlementInputSchema.safeParse(input);
    return parsed.success
      ? []
      : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("refuses a formula as a line reference with its own message", () => {
    expect(messages(report("DS-1", "=1+1"))).toEqual([
      expect.stringContaining(
        "lines.0.reference: Referensi tidak boleh diawali",
      ),
    ]);
  });

  it("refuses a formula as the report reference", () => {
    expect(messages(report("@SUM(A1)", "DS-1"))).toEqual([
      expect.stringContaining("reference: Referensi tidak boleh diawali"),
    ]);
  });

  it("refuses a formula as the CSV import report reference", () => {
    const parsed = importGatewaySettlementCsvInputSchema.safeParse({
      outletId: OUTLET,
      provider: "duitku",
      format: "legend_template_v1",
      reference: "-1+1",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-02",
      fileName: "a.csv",
      csv: "reference,amount_idr,fee_idr\nDS-1,10000,100\n",
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps a plain reference", () => {
    expect(messages(report("A03-0412", "DS-1"))).toEqual([]);
  });
});
