// 1273 (Duitku second opinion, P3-4): a settlement CSV reference that starts
// like a spreadsheet formula is refused, so it cannot turn into a formula when
// a later export opens in a spreadsheet.
import { describe, expect, it } from "vitest";
import {
  GatewaySettlementCsvError,
  parseGatewaySettlementCsv,
} from "../services/payment-settlement-csv-parse.ts";

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
    "refuses %j with a reference row error",
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
        { row: 2, reason: "reference" },
      ]);
    },
  );
});
