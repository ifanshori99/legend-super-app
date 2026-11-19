// legend-j772n: the receipt/invoice document contract carries an explicit
// reservation-DP bucket, `depositAppliedIdr` (additive, optional, default 0).
//
// Contract assumed here (from the card text; docs/SPEC.md has no document DP
// rule):
//  - the document balances as sum(tenders) + depositAppliedIdr === totalIdr;
//  - DP is never a tender method (no fake cash) and is never counted twice;
//  - depositAppliedIdr must not exceed totalIdr;
//  - DP-only (depositAppliedIdr === totalIdr) is a real sale paid fully by the
//    DP credit, so `tenders` may then be empty. With no DP, at least one tender
//    is still required, as before.
//  - a legacy document without the field parses and gets depositAppliedIdr 0.
//
// Run: LEGEND_TEST_FILES="src/test/pos-1162-shared-document-dp.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import {
  cafeLegendPosFixtures,
  invoiceDocumentSchema,
  receiptDocumentSchema,
  POS_TENDER_METHODS,
} from "@starter/shared/pos";

const TOTAL = 120_100;

const baseReceipt = () => {
  const doc = cafeLegendPosFixtures.receiptDocuments.find(
    (row) => row.documentKind === "receipt",
  );
  if (!doc) throw new Error("fixture receipt document missing");
  return structuredClone(doc) as Record<string, unknown>;
};

const baseInvoice = () => {
  const doc = cafeLegendPosFixtures.invoices[0];
  if (!doc) throw new Error("fixture invoice document missing");
  return structuredClone(doc) as Record<string, unknown> & {
    totalIdr: number;
  };
};

const receiptWith = (
  depositAppliedIdr: number | undefined,
  tenders: { method: string; amountIdr: number; reference: string | null }[],
) => {
  const doc = baseReceipt();
  doc.tenders = tenders;
  if (depositAppliedIdr !== undefined)
    doc.depositAppliedIdr = depositAppliedIdr;
  return doc;
};

const cash = (amountIdr: number) => ({
  method: "cash",
  amountIdr,
  reference: null,
});

/** Paths of the issues, and whether a missing field made the key "unknown". */
function failure(result: {
  success: boolean;
  error?: { issues: { code: string; path: PropertyKey[] }[] };
}) {
  if (result.success) return null;
  const issues = result.error?.issues ?? [];
  return {
    paths: issues.map((issue) => issue.path.join(".")),
    unrecognizedKey: issues.some((issue) => issue.code === "unrecognized_keys"),
  };
}

describe("legend-j772n document DP bucket: receipt", () => {
  it("fully paid without DP: unchanged, depositAppliedIdr defaults to 0", () => {
    const parsed = receiptDocumentSchema.parse(baseReceipt());
    expect(parsed.depositAppliedIdr).toBe(0);
    expect(parsed.totalIdr).toBe(TOTAL);
  });

  it("explicit depositAppliedIdr 0 equals the legacy shape", () => {
    const parsed = receiptDocumentSchema.parse(receiptWith(0, [cash(TOTAL)]));
    expect(parsed.depositAppliedIdr).toBe(0);
  });

  it("partial DP: DP plus tenders balance to the total", () => {
    const parsed = receiptDocumentSchema.parse(
      receiptWith(50_000, [cash(TOTAL - 50_000)]),
    );
    expect(parsed.depositAppliedIdr).toBe(50_000);
    expect(parsed.totalIdr).toBe(TOTAL);
    expect(parsed.tenders.map((tender) => tender.amountIdr)).toEqual([
      TOTAL - 50_000,
    ]);
  });

  it("partial DP across a split payment still balances", () => {
    const parsed = receiptDocumentSchema.parse(
      receiptWith(50_000, [
        { method: "points", amountIdr: 10_000, reference: "LOYALTY-1" },
        cash(TOTAL - 60_000),
      ]),
    );
    expect(
      parsed.tenders.reduce(
        (sum, tender) => sum + Number(tender.amountIdr),
        0,
      ) + Number(parsed.depositAppliedIdr),
    ).toBe(TOTAL);
  });

  it("DP-only: DP equals the total and there are no tenders", () => {
    const parsed = receiptDocumentSchema.parse(receiptWith(TOTAL, []));
    expect(parsed.depositAppliedIdr).toBe(TOTAL);
    expect(parsed.tenders).toEqual([]);
  });

  it("DP is not a tender method, so it cannot pose as cash", () => {
    for (const method of ["deposit", "dp", "down_payment"]) {
      expect(POS_TENDER_METHODS).not.toContain(method);
      const result = receiptDocumentSchema.safeParse(
        receiptWith(50_000, [
          { method, amountIdr: 50_000, reference: null },
          cash(TOTAL - 50_000),
        ]),
      );
      const issue = failure(result);
      expect(issue).not.toBeNull();
      expect(issue?.unrecognizedKey).toBe(false);
      expect(issue?.paths).toContain("tenders.0.method");
    }
  });

  it("DP counted twice is rejected: DP plus tenders equal to total plus DP", () => {
    // Tenders already cover the whole total, so the DP would be paid twice.
    const result = receiptDocumentSchema.safeParse(
      receiptWith(50_000, [cash(TOTAL)]),
    );
    const issue = failure(result);
    expect(issue).not.toBeNull();
    expect(issue?.unrecognizedKey).toBe(false);
    expect(issue?.paths).toContain("tenders");
  });

  it("DP-only with an extra tender is rejected (payment double counted)", () => {
    const issue = failure(
      receiptDocumentSchema.safeParse(receiptWith(TOTAL, [cash(TOTAL)])),
    );
    expect(issue).not.toBeNull();
    expect(issue?.unrecognizedKey).toBe(false);
    expect(issue?.paths).toContain("tenders");
  });

  it("DP plus tenders short of the total is rejected", () => {
    const issue = failure(
      receiptDocumentSchema.safeParse(
        receiptWith(50_000, [cash(TOTAL - 50_000 - 100)]),
      ),
    );
    expect(issue).not.toBeNull();
    expect(issue?.unrecognizedKey).toBe(false);
    expect(issue?.paths).toContain("tenders");
  });

  it("DP above the total is rejected on depositAppliedIdr", () => {
    const issue = failure(
      receiptDocumentSchema.safeParse(receiptWith(TOTAL + 1, [])),
    );
    expect(issue).not.toBeNull();
    expect(issue?.unrecognizedKey).toBe(false);
    expect(issue?.paths).toContain("depositAppliedIdr");
  });

  it("no DP and no tenders is still rejected", () => {
    expect(receiptDocumentSchema.safeParse(receiptWith(0, [])).success).toBe(
      false,
    );
    expect(
      receiptDocumentSchema.safeParse(receiptWith(undefined, [])).success,
    ).toBe(false);
  });

  it("no DP and tenders that miss the total keeps the old failure", () => {
    const issue = failure(
      receiptDocumentSchema.safeParse(receiptWith(0, [cash(TOTAL - 1)])),
    );
    expect(issue?.paths).toContain("tenders");
  });

  it("a negative or fractional DP is rejected", () => {
    for (const bad of [-1, 0.5]) {
      const issue = failure(
        receiptDocumentSchema.safeParse(receiptWith(bad, [cash(TOTAL)])),
      );
      expect(issue).not.toBeNull();
      expect(issue?.unrecognizedKey).toBe(false);
      expect(issue?.paths).toContain("depositAppliedIdr");
    }
  });
});

describe("legend-j772n document DP bucket: invoice", () => {
  const invoiceWith = (
    depositAppliedIdr: number | undefined,
    tenders: { method: string; amountIdr: number; reference: string | null }[],
  ) => {
    const doc = baseInvoice();
    doc.tenders = tenders;
    if (depositAppliedIdr !== undefined)
      doc.depositAppliedIdr = depositAppliedIdr;
    return doc;
  };

  it("fully paid without DP: unchanged, DP defaults to 0", () => {
    expect(invoiceDocumentSchema.parse(baseInvoice()).depositAppliedIdr).toBe(
      0,
    );
  });

  it("partial DP balances", () => {
    const total = baseInvoice().totalIdr;
    const parsed = invoiceDocumentSchema.parse(
      invoiceWith(40_000, [cash(total - 40_000)]),
    );
    expect(parsed.depositAppliedIdr).toBe(40_000);
  });

  it("DP-only invoice is valid when paid, and when refunded", () => {
    const total = baseInvoice().totalIdr;
    for (const paymentStatus of ["paid", "refunded"] as const) {
      const doc = invoiceWith(total, []);
      doc.paymentStatus = paymentStatus;
      const parsed = invoiceDocumentSchema.parse(doc);
      expect(parsed.depositAppliedIdr).toBe(total);
      expect(parsed.tenders).toEqual([]);
    }
  });

  it("DP counted twice is rejected", () => {
    const total = baseInvoice().totalIdr;
    const issue = failure(
      invoiceDocumentSchema.safeParse(invoiceWith(40_000, [cash(total)])),
    );
    expect(issue).not.toBeNull();
    expect(issue?.unrecognizedKey).toBe(false);
    expect(issue?.paths).toContain("tenders");
  });

  it("DP above the total is rejected", () => {
    const total = baseInvoice().totalIdr;
    const issue = failure(
      invoiceDocumentSchema.safeParse(invoiceWith(total + 1, [])),
    );
    expect(issue).not.toBeNull();
    expect(issue?.unrecognizedKey).toBe(false);
    expect(issue?.paths).toContain("depositAppliedIdr");
  });
});
