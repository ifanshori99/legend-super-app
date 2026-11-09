import { describe, expect, it } from "vitest";
import {
  ecrResultDetailsSchema,
  edcTransactionSchema,
  hasPanLengthDigits,
} from "@starter/shared/edc";

// Card-number patterns: digits split by spaces, tabs or dashes, repeated or mixed,
// must be caught the same way in the write path (provider answer) and the read
// path (stored ledger row). Reference columns use a 13+ digit threshold (a
// 12-digit RRN is legitimate); free text uses 12+. `hasPanLengthDigits` stays
// contiguous (see its tests).

const row = {
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

const spacedPans = [
  "4111 1111 1111 1111",
  "4111  1111  1111  1111",
  "4111 - 1111-1111 1111",
  "4111--1111--1111--1111",
  "4111-1111 1111-1111",
  "4111\t1111\t1111\t1111",
];

// Dots are thousands separators in rupiah amounts, never a card separator.
const rupiahAmount = "Rp 1.250.000.000.000";

describe("free-text message (write path)", () => {
  const write = (message: string) =>
    ecrResultDetailsSchema.parse({ message }).message;

  it("masks a card number split by repeated or mixed separators", () => {
    for (const pan of spacedPans) {
      expect(write(`kartu ${pan} ditolak`)).toBe("kartu [disamarkan] ditolak");
    }
  });

  it("masks a 12-digit run, plain or split", () => {
    expect(write("kartu 411111111111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
    expect(write("kartu 4111 1111 1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
    expect(write("kartu 4111  1111--1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("masks a tab-separated card number", () => {
    expect(write("kartu 4111\t1111\t1111\t1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("keeps a rupiah amount written with dots", () => {
    expect(write(`total ${rupiahAmount} ok`)).toBe(`total ${rupiahAmount} ok`);
  });

  it("keeps an 11-digit run", () => {
    expect(write("ref 41111111111 ok")).toBe("ref 41111111111 ok");
    expect(write("ref 4111 1111 111 ok")).toBe("ref 4111 1111 111 ok");
  });
});

describe("free-text message (read path)", () => {
  const read = (message: string) =>
    edcTransactionSchema.parse({ ...row, message }).message;

  it("masks a card number split by repeated or mixed separators", () => {
    for (const pan of spacedPans) {
      expect(read(`kartu ${pan} ditolak`)).toBe("kartu [disamarkan] ditolak");
    }
  });

  it("masks a 12-digit run, plain or split", () => {
    expect(read("kartu 411111111111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
    expect(read("kartu 4111 1111 1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("masks a tab-separated card number", () => {
    expect(read("kartu 4111\t1111\t1111\t1111 ditolak")).toBe(
      "kartu [disamarkan] ditolak",
    );
  });

  it("keeps a rupiah amount written with dots", () => {
    expect(read(`total ${rupiahAmount} ok`)).toBe(`total ${rupiahAmount} ok`);
  });

  it("keeps an 11-digit run", () => {
    expect(read("ref 41111111111 ok")).toBe("ref 41111111111 ok");
  });
});

describe("reference columns on read", () => {
  const read = (value: string) =>
    edcTransactionSchema.parse({
      ...row,
      rrn: value,
      invoiceNo: value,
      batchNo: value,
    });

  it("drops a value with a card number split by repeated or mixed separators", () => {
    for (const pan of spacedPans) {
      const parsed = read(pan);
      expect(parsed.rrn).toBeNull();
      expect(parsed.invoiceNo).toBeNull();
      expect(parsed.batchNo).toBeNull();
    }
    const mixed = read("4111  1111-1111 1111");
    expect(mixed.rrn).toBeNull();
    expect(mixed.invoiceNo).toBeNull();
    expect(mixed.batchNo).toBeNull();
  });

  it("drops a tab-separated card number", () => {
    const parsed = read("4111\t1111\t1111\t1111");
    expect(parsed.rrn).toBeNull();
    expect(parsed.invoiceNo).toBeNull();
    expect(parsed.batchNo).toBeNull();
  });

  it("keeps a 12-digit RRN, plain or split", () => {
    for (const value of ["123456789012", "1234 5678 9012"]) {
      const parsed = read(value);
      expect(parsed.rrn).toBe(value);
      expect(parsed.invoiceNo).toBe(value);
      expect(parsed.batchNo).toBe(value);
    }
  });
});

describe("hasPanLengthDigits", () => {
  // Contiguous on purpose: it guards stored reference values, which are
  // alphanumeric, and must not flag order numbers split by a dash.
  it("is true for 13 to 19 digits in a row, alone or with letters", () => {
    for (let n = 13; n <= 19; n += 1) {
      const digits = "4".repeat(n);
      expect(hasPanLengthDigits(digits)).toBe(true);
      expect(hasPanLengthDigits(`RRN${digits}X`)).toBe(true);
    }
  });

  it("is false for an order number whose digits span the dash", () => {
    expect(hasPanLengthDigits("P261109-12345678")).toBe(false);
    expect(hasPanLengthDigits("GF261109-87654321")).toBe(false);
  });

  it("is false for a rupiah amount written with dots", () => {
    expect(hasPanLengthDigits(rupiahAmount)).toBe(false);
  });

  it("is false for 12 digits in a row", () => {
    expect(hasPanLengthDigits("123456789012")).toBe(false);
  });
});
