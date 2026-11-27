// X2-UI (legend-wasr7.18): the EDC settlement CSV upload screen. Pinned from
// the brief and the X2 API contract, not from the implementation:
//   1. A file is checked before it is sent: empty, over the API's character
//      cap, and a name that is not .csv/.txt are refused with a plain reason.
//   2. A 422 from the parser names the rows ("Baris 3, 5 tidak dapat
//      dibaca ..."): the screen lists those rows as numbers, in finance words.
//   3. MFA_REQUIRED asks for the second factor; a missing outlet or permission
//      says so; nothing shows a raw code.
//   4. The result shows the server's counts (matched, cleared, mismatch,
//      unmatched, duplicate); a replayed file says nothing new was applied.
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EDC_SETTLEMENT_CSV_MAX_CHARS } from "@starter/shared/payment/admin";
import { createTranslator } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";
import {
  checkCsvUpload,
  importErrorView,
} from "@/features/edc-settlement-import/lib.ts";
import { ImportResult } from "@/features/edc-settlement-import/components/import-result.tsx";

// The result only links to the queue; no router is mounted in these tests.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) =>
    createElement("a", null, children),
}));

const t = createTranslator();

describe("checkCsvUpload", () => {
  it("accepts a normal csv", () => {
    expect(checkCsvUpload("settle-bca.csv", "TID,RRN\n1,2")).toBeNull();
  });
  it("refuses an empty file", () => {
    expect(checkCsvUpload("a.csv", "  \n ")).toBe("empty");
  });
  it("refuses a file over the API cap", () => {
    expect(
      checkCsvUpload("a.csv", "x".repeat(EDC_SETTLEMENT_CSV_MAX_CHARS + 1)),
    ).toBe("tooLarge");
    expect(
      checkCsvUpload("a.csv", "x".repeat(EDC_SETTLEMENT_CSV_MAX_CHARS)),
    ).toBeNull();
  });
  it("refuses other file kinds", () => {
    expect(checkCsvUpload("laporan.xlsx", "a,b")).toBe("notCsv");
    expect(checkCsvUpload("laporan.pdf", "a,b")).toBe("notCsv");
  });
});

describe("importErrorView", () => {
  it("lists the rows the parser could not read", () => {
    const view = importErrorView(
      new ApiError(
        422,
        "VALIDATION_ERROR",
        "Baris 3, 5, 12 tidak dapat dibaca (TID, RRN atau nominal tidak valid). Tidak ada baris yang diimpor.",
      ),
    );
    expect(view.kind).toBe("rows");
    expect(view.rows).toEqual([3, 5, 12]);
  });
  it("keeps another parser message as plain text", () => {
    const view = importErrorView(
      new ApiError(
        422,
        "VALIDATION_ERROR",
        "Berkas tidak memuat baris transaksi.",
      ),
    );
    expect(view).toMatchObject({
      kind: "message",
      detail: "Berkas tidak memuat baris transaksi.",
      rows: [],
    });
  });
  it("maps MFA, permission, outlet and network", () => {
    expect(importErrorView(new ApiError(403, "MFA_REQUIRED", "x")).kind).toBe(
      "mfa",
    );
    expect(importErrorView(new ApiError(403, "FORBIDDEN", "x")).kind).toBe(
      "forbidden",
    );
    expect(importErrorView(new ApiError(404, "NOT_FOUND", "x")).kind).toBe(
      "notFound",
    );
    expect(importErrorView(new ApiError(0, "NETWORK_ERROR", "x")).kind).toBe(
      "offline",
    );
    expect(importErrorView(new Error("boom")).kind).toBe("generic");
  });
});

describe("ImportResult", () => {
  const view = {
    id: "00000000-0000-4000-8000-000000000001",
    outletId: "00000000-0000-4000-8000-000000000002",
    bank: "bca" as const,
    fileName: "settle-bca.csv",
    fileHash: "a".repeat(64),
    rowCount: 12,
    matched: 8,
    cleared: 3,
    mismatch: 1,
    unmatched: 2,
    duplicate: 1,
    replayed: false,
    createdAt: "2026-11-27T08:00:00.000Z",
  };
  const render = (over: Partial<typeof view> = {}) =>
    renderToString(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ImportResult, { result: { ...view, ...over } }),
      ),
    );

  it("shows the server counts and the file name", () => {
    const html = render();
    expect(html).toContain("settle-bca.csv");
    for (const label of [
      "matched",
      "cleared",
      "mismatch",
      "unmatched",
      "duplicate",
    ])
      expect(html).toContain(t(`edcSettlementCsv.result.${label}`));
    expect(html).not.toContain(t("edcSettlementCsv.result.replayed"));
  });
  it("says a replayed file applied nothing new", () => {
    expect(render({ replayed: true })).toContain(
      t("edcSettlementCsv.result.replayed"),
    );
  });
  it("warns when a line did not match", () => {
    expect(render()).toContain(t("edcSettlementCsv.result.mismatchHint"));
    expect(render({ mismatch: 0 })).not.toContain(
      t("edcSettlementCsv.result.mismatchHint"),
    );
  });
});
