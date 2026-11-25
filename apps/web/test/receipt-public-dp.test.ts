// legend-j772n review P2: the public e-receipt shows the DP bucket as its own
// "Uang muka (DP)" line, counts it in "Jumlah dibayar", and survives a DP-only
// sale whose tender list is empty.
import { describe, expect, it } from "vitest";
import { posReceiptPublicMessages } from "../../../packages/shared/src/i18n/messages/pos-receipt-public.ts";
import {
  paidIdr,
  singleTender,
} from "../src/features/ws04-receipt-public/lib.ts";

const cash = { method: "cash" as const, amountIdr: 40_000 };

describe("public e-receipt DP bucket", () => {
  it("the DP line comes from the text catalog", () => {
    expect(posReceiptPublicMessages.deposit).toBe("Uang muka (DP)");
  });

  it("paid is tenders plus DP: a mixed sale", () => {
    expect(paidIdr([cash], 60_000)).toBe(100_000);
  });

  it("paid is the DP alone on a DP-only sale with no tender", () => {
    expect(paidIdr([], 100_000)).toBe(100_000);
  });

  it("a sale without DP keeps the old sum", () => {
    expect(paidIdr([cash])).toBe(40_000);
    expect(paidIdr([cash], 0)).toBe(40_000);
  });

  it("an empty tender list is safe", () => {
    expect(paidIdr([], 0)).toBe(0);
    expect(singleTender([], 100_000)).toBeNull();
  });

  it("a single tender is shown as one line only when there is no DP", () => {
    expect(singleTender([cash], 0)).toBe(cash);
    expect(singleTender([cash], 60_000)).toBeNull();
    expect(singleTender([cash, cash], 0)).toBeNull();
  });
});
