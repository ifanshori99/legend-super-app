// legend-1162: edge-printed receipts show the DP (uang muka) bucket. DP is
// prepaid, never a tender: it adds no cash and no change. Pure render level
// (no database).
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-1162-edge-print-dp.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import {
  cafeLegendPosFixtures,
  receiptDocumentSchema,
  type ReceiptDocument,
} from "@starter/shared/pos";
import { renderReceipt } from "../edge/print/templates.ts";
import type { ReceiptData } from "../edge/print/types.ts";
import { receiptData } from "../services/pos-receipt-edge-print.ts";

const AT = new Date("2026-11-08T07:05:00.000Z");

const base: ReceiptData = {
  outletName: "Cafe Legend Kemang",
  receiptNumber: "R-20261108-0042",
  cashierName: "Siti",
  issuedAt: AT,
  lines: [{ name: "Katering", qty: 1, unitPrice: 100000, total: 100000 }],
  subtotal: 100000,
  total: 100000,
  payments: [],
};

/** Printable text lines: control bytes (ESC/GS commands) removed. */
function textLines(bytes: Uint8Array): string[] {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i] as number;
    if (byte === 0x1b || byte === 0x1d) {
      // ESC/GS commands used by the builder are 2 to 4 bytes; skip the
      // command byte and its operand(s) by known length.
      const next = bytes[i + 1] as number;
      const length =
        byte === 0x1b ? (next === 0x40 ? 2 : 3) : next === 0x56 ? 4 : 3;
      i += length;
      continue;
    }
    out += byte === 0x0a ? "\n" : String.fromCharCode(byte);
    i += 1;
  }
  return out.split("\n");
}

const amountOf = (row: string | undefined) =>
  Number((row ?? "").replace(/[^0-9]/g, ""));

describe("legend-1162 edge receipt DP row", () => {
  it("DP-only receipt shows DP and total with no phantom cash or change", () => {
    const rows = textLines(
      renderReceipt({ ...base, depositAppliedIdr: 100000 }, 32),
    );
    const dp = rows.find((row) => row.includes("Uang muka (DP)"));
    const total = rows.findIndex((row) => row.startsWith("TOTAL"));
    expect(dp).toBeDefined();
    expect(amountOf(dp)).toBe(100000);
    expect(rows.indexOf(dp as string)).toBeGreaterThan(total);
    expect(rows.some((row) => row.includes("Kembali"))).toBe(false);
    expect(rows.some((row) => /tunai|cash/i.test(row))).toBe(false);
  });

  it("partial DP shows DP before tender rows and they sum to the total", () => {
    const rows = textLines(
      renderReceipt(
        {
          ...base,
          depositAppliedIdr: 40000,
          payments: [{ method: "QRIS", amount: 60000 }],
        },
        32,
      ),
    );
    const dpAt = rows.findIndex((row) => row.includes("Uang muka (DP)"));
    const qrisAt = rows.findIndex((row) => row.startsWith("QRIS"));
    expect(dpAt).toBeGreaterThan(-1);
    expect(qrisAt).toBeGreaterThan(dpAt);
    expect(amountOf(rows[dpAt]) + amountOf(rows[qrisAt])).toBe(100000);
  });

  it("DP 0 or absent prints byte-identical output and no DP row", () => {
    const paid: ReceiptData = {
      ...base,
      payments: [{ method: "Tunai", amount: 100000 }],
    };
    const before = renderReceipt(paid, 32);
    const withZero = renderReceipt({ ...paid, depositAppliedIdr: 0 }, 32);
    expect(Buffer.from(withZero).equals(Buffer.from(before))).toBe(true);
    expect(textLines(before).some((row) => row.includes("Uang muka"))).toBe(
      false,
    );
  });

  it("maps the document DP bucket and never turns it into a tender", () => {
    const fixture = cafeLegendPosFixtures.receiptDocuments[0];
    if (!fixture) throw new Error("fixture receipt document missing");
    const parsed: ReceiptDocument = receiptDocumentSchema.parse(fixture);
    const tenderTotal = parsed.tenders.reduce(
      (sum, row) => sum + Number(row.amountIdr),
      0,
    );
    const dpOnly = {
      ...parsed,
      tenders: [],
      depositAppliedIdr: parsed.totalIdr,
    } as ReceiptDocument;
    const mapped = receiptData(dpOnly);
    expect(mapped.depositAppliedIdr).toBe(Number(parsed.totalIdr));
    expect(mapped.payments).toEqual([]);
    expect(mapped.change ?? 0).toBe(0);

    const plain = receiptData(parsed);
    expect(plain.depositAppliedIdr ?? 0).toBe(Number(parsed.depositAppliedIdr));
    expect(plain.payments.reduce((sum, row) => sum + row.amount, 0)).toBe(
      tenderTotal,
    );
  });
});
