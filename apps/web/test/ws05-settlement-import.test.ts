// C4b (legend-osqou.8): Duitku settlement import screen rules.
//   1. A file is checked before it is sent (name, empty, the API's cap); the
//      period follows the API's rules (order, at most 31 days).
//   2. "Unduh template" is the header only: no sample line can be imported.
//   3. A 422 with rowErrors lists the lines with a reason code; an unknown code
//      reads as "other"; MFA_REQUIRED is not an error view (the step-up opens).
//   4. The result shows the server's amounts and counts; a replay says
//      "sudah ada" and that nothing changed.
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { EDC_SETTLEMENT_CSV_MAX_CHARS } from "@starter/shared/payment/admin";
import { ApiError } from "@/lib/api/errors";
import {
  checkPeriod,
  checkSettlementCsv,
  dataRowCount,
  settlementErrorView,
  settlementTemplateCsv,
} from "@/features/ws05-payment-admin/settlement-lib.ts";
import { SettlementImportResult } from "@/features/ws05-payment-admin/components/settlement-import-result.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) =>
    createElement("a", null, children),
}));

describe("C4b Duitku settlement import rules", () => {
  it("checks the file and the period before sending", () => {
    expect(checkSettlementCsv("laporan.xlsx", "a")).toBe("notCsv");
    expect(checkSettlementCsv("laporan.csv", "  \n")).toBe("empty");
    expect(
      checkSettlementCsv(
        "laporan.csv",
        "x".repeat(EDC_SETTLEMENT_CSV_MAX_CHARS + 1),
      ),
    ).toBe("tooLarge");
    expect(checkSettlementCsv("laporan.CSV", "reference\n")).toBeNull();
    expect(dataRowCount("reference,amount_idr,fee_idr\r\nA,1,0\r\n\r\nB,2,0")).toBe(2);
    expect(checkPeriod("", "2026-11-01")).toBe("periodRequired");
    expect(checkPeriod("2026-11-02", "2026-11-01")).toBe("periodOrder");
    expect(checkPeriod("2026-11-01", "2026-12-01")).toBe("periodTooLong");
    expect(checkPeriod("2026-11-01", "2026-11-30")).toBeNull();
    expect(checkPeriod("2026-11-01", "2026-11-01")).toBeNull();
  });

  it("offers the template header only", () => {
    expect(settlementTemplateCsv()).toBe("reference,amount_idr,fee_idr\r\n");
  });

  it("words the server's answers", () => {
    const rows = new ApiError(422, "VALIDATION_ERROR", "2 baris", undefined, {
      rowErrors: [
        { row: 3, reason: "amount" },
        { row: 4, reason: "mystery" },
      ],
    });
    expect(settlementErrorView(rows)).toEqual({
      kind: "rows",
      rows: [
        { row: 3, reason: "amount" },
        { row: 4, reason: "other" },
      ],
    });
    expect(
      settlementErrorView(
        new ApiError(422, "VALIDATION_ERROR", "Kolom harus tepat"),
      ),
    ).toEqual({ kind: "message", detail: "Kolom harus tepat" });
    expect(
      settlementErrorView(new ApiError(409, "SETTLEMENT_CONFLICT", "x")),
    ).toEqual({ kind: "conflict" });
    expect(settlementErrorView(new ApiError(403, "FORBIDDEN", "x"))).toEqual({
      kind: "forbidden",
    });
    expect(settlementErrorView(new ApiError(404, "NOT_FOUND", "x"))).toEqual({
      kind: "notFound",
    });
    expect(settlementErrorView(new Error("boom"))).toEqual({ kind: "generic" });
  });

  it("shows the server's amounts and counts, and a replay as already there", () => {
    const html = renderToString(
      createElement(SettlementImportResult, {
        result: {
          id: "00000000-0000-4000-8000-000000000001",
          outletId: "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13" as never,
          source: "gateway",
          provider: "duitku",
          reference: "STL-20261101",
          periodStart: "2026-11-01",
          periodEnd: "2026-11-01",
          grossIdr: 95_000 as never,
          feeIdr: 695 as never,
          netIdr: 94_305 as never,
          lineCount: 3,
          matchedLines: 1,
          mismatchLines: 1,
          unmatchedLines: 1,
          casesCreated: 3,
          replayed: true,
          createdAt: "2026-11-02T02:00:00.000Z",
        },
      }),
    );
    expect(html).toContain("STL-20261101");
    expect(html).toContain("94.305");
    expect(html).toContain("695");
    expect(html).toContain("Sudah ada");
    expect(html).toContain("Kasus dibuat");
  });
});
