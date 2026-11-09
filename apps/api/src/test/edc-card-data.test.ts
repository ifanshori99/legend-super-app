import { describe, expect, it } from "vitest";
import {
  ecrInquiryResultSchema,
  ecrResultDetailsSchema,
  ecrResultSchema,
  edcTransactionSchema,
} from "@starter/shared/edc";

const approved = { outcome: "approved", amountIdr: 50_000 } as const;

describe("EDC card data at the provider response boundary", () => {
  it("keeps allowlisted card types, normalised to upper case", () => {
    for (const [raw, kept] of [
      ["VISA", "VISA"],
      ["visa", "VISA"],
      ["Master Card", "MASTERCARD"],
      ["jcb", "JCB"],
      ["UnionPay", "UNIONPAY"],
      ["QRIS", "QRIS"],
      ["GPN", "GPN"],
    ]) {
      expect(
        ecrResultSchema.parse({ ...approved, cardType: raw }).cardType,
      ).toBe(kept);
    }
  });

  it("never stores a PAN-like cardType", () => {
    for (const raw of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "VISA 4111111111111111",
      "378282246310005",
      "6011000990139424123",
    ]) {
      const parsed = ecrResultSchema.parse({ ...approved, cardType: raw });
      expect(parsed.cardType).toBe("UNKNOWN");
      expect(JSON.stringify(parsed)).not.toMatch(/\d{13}/);
    }
  });

  it("maps an unlisted label to UNKNOWN and keeps null as null", () => {
    expect(
      ecrResultSchema.parse({ ...approved, cardType: "SOMETHING ELSE" })
        .cardType,
    ).toBe("UNKNOWN");
    expect(ecrResultSchema.parse(approved).cardType).toBeNull();
    expect(
      ecrResultSchema.parse({ ...approved, cardType: null }).cardType,
    ).toBeNull();
  });

  it("applies to inquiry answers too", () => {
    const parsed = ecrInquiryResultSchema.parse({
      outcome: "approved",
      amountIdr: 50_000,
      cardType: "4111111111111111",
    });
    expect(parsed.cardType).toBe("UNKNOWN");
  });

  it("rejects a full PAN in maskedPan", () => {
    for (const raw of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "411111******1111 4111111111111111",
    ]) {
      expect(ecrResultDetailsSchema.safeParse({ maskedPan: raw }).success).toBe(
        false,
      );
    }
    expect(
      ecrResultDetailsSchema.parse({ maskedPan: "411111******1111" }).maskedPan,
    ).toBe("411111******1111");
  });

  it("never stores a PAN-like rrn, invoice or batch number", () => {
    const parsed = ecrResultDetailsSchema.parse({
      rrn: "4111111111111111",
      invoiceNo: "4111111111111111",
      batchNo: "4111111111111111",
      approvalCode: "A12345",
    });
    expect(parsed.rrn).toBeNull();
    expect(parsed.invoiceNo).toBeNull();
    expect(parsed.batchNo).toBeNull();
    expect(parsed.approvalCode).toBe("A12345");
    expect(ecrResultDetailsSchema.parse({ rrn: "123456789012" }).rrn).toBe(
      "123456789012",
    );
  });

  it("drops a reference that merely contains a card-length digit run", () => {
    const parsed = ecrResultDetailsSchema.parse({
      rrn: "A4111111111111111",
      invoiceNo: "4111111111111111XY",
      batchNo: "AB41111111111111",
    });
    expect(parsed.rrn).toBeNull();
    expect(parsed.invoiceNo).toBeNull();
    expect(parsed.batchNo).toBeNull();
    // Short digit runs inside a reference stay.
    expect(ecrResultDetailsSchema.parse({ rrn: "R123456789012" }).rrn).toBe(
      "R123456789012",
    );
  });

  it("still rejects an approval code longer than an approval code", () => {
    expect(
      ecrResultDetailsSchema.safeParse({ approvalCode: "A4111111111111111" })
        .success,
    ).toBe(false);
  });

  it("filters the stored ledger row on read: legacy cardType and PAN-like references", () => {
    const base = {
      id: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a11",
      tenantId: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a12",
      outletId: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a13",
      terminalId: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a14",
      bank: "bca",
      reference: "R1",
      idempotencyKey: "7b1c1c0e-8f0e-4c11-9a43-2f2f6f0c9a15",
      amountIdr: 1000,
      method: "card",
      status: "approved",
      trace: "TRACE1",
      approvalCode: null,
      rrn: null,
      cardType: null,
      maskedPan: null,
      responseCode: null,
      message: null,
      invoiceNo: null,
      batchNo: null,
      needsReconciliation: false,
      dispatchedAt: null,
      inquiryCount: 0,
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
      completedAt: null,
    };
    const parsed = edcTransactionSchema.parse({
      ...base,
      cardType: "4111111111111111",
      rrn: "4111111111111111",
      invoiceNo: "A4111111111111111",
      batchNo: "4111111111111111XY",
    });
    expect(parsed.cardType).toBe("UNKNOWN");
    expect(parsed.rrn).toBeNull();
    expect(parsed.invoiceNo).toBeNull();
    expect(parsed.batchNo).toBeNull();
    expect(
      edcTransactionSchema.parse({ ...base, cardType: "visa" }).cardType,
    ).toBe("VISA");
  });

  it("rejects an approval code that is a PAN", () => {
    expect(
      ecrResultDetailsSchema.safeParse({ approvalCode: "4111111111111111" })
        .success,
    ).toBe(false);
  });

  it("masks a PAN in the free-text message", () => {
    expect(
      ecrResultDetailsSchema.parse({ message: "kartu 4111 1111 1111 1111" })
        .message,
    ).not.toMatch(/4111/);
  });
});
