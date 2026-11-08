// POS-06 reprint mark: a receipt printed again carries `reprint: true` and
// shows "CETAK ULANG" in the PDF and the e-receipt email; a first print shows
// no mark. Pure document/render level (no database).
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-receipt-reprint-mark.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import {
  cafeLegendPosFixtures,
  receiptDocumentSchema,
  type ReceiptDocument,
} from "@starter/shared/pos";
import { renderReceiptEmail } from "../services/pos-receipt-email.ts";
import { renderDocumentPdf } from "../services/pos-receipt-pdf.ts";

const MARK = "CETAK ULANG";

function firstPrint(): ReceiptDocument {
  const doc = cafeLegendPosFixtures.receiptDocuments[0];
  if (!doc) throw new Error("fixture receipt document missing");
  return receiptDocumentSchema.parse(doc);
}

const pdfText = (doc: ReceiptDocument) =>
  renderDocumentPdf(doc).toString("latin1");

describe("POS-06 CETAK ULANG mark", () => {
  it("the document model carries the reprint flag and requires it", () => {
    const doc = firstPrint();
    expect(doc.reprint).toBe(false);
    expect(receiptDocumentSchema.parse({ ...doc, reprint: true }).reprint).toBe(
      true,
    );
    const withoutFlag: Record<string, unknown> = { ...doc };
    delete withoutFlag.reprint;
    expect(receiptDocumentSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it("first print shows no mark in the PDF or the email", () => {
    const doc = firstPrint();
    expect(pdfText(doc)).not.toContain(MARK);
    const email = renderReceiptEmail(doc, "https://example.test/r/abc");
    expect(email.body).not.toContain(MARK);
    expect(email.subject).not.toContain(MARK);
  });

  it("a reprint shows the mark in the PDF and the email", () => {
    const doc = { ...firstPrint(), reprint: true };
    expect(pdfText(doc)).toContain(`(${MARK})`);
    expect(renderReceiptEmail(doc, null).body).toContain(MARK);
  });
});
