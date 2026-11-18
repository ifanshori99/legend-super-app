// Brief 936: the mock order wire must satisfy the strict contract. A voucher
// discount carries its code, and every EDC request carries the terminal bank,
// method and mode (all required-nullable in the shared schema).
import assert from "node:assert/strict";
import { posOrderDetailSchema } from "@starter/shared/pos";
import { orderDetailWire } from "@/features/ws04-pos-kasir/mock-wire";
import type { EngineOrder } from "@/features/ws04-pos-kasir/types";

const AT_MS = Date.parse("2026-11-08T06:00:00.000Z");

function order(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    id: "01JBQ9T0000000000000000048",
    orderNo: "POS-0048",
    tableLabel: "Meja 4",
    guestCount: 2,
    items: [{ name: "Nasi Goreng", qty: 1, amountIdr: 100_000 }],
    subtotalIdr: 100_000,
    serviceIdr: 0,
    taxIdr: 0,
    totalIdr: 100_000,
    deposit: null,
    tenders: [],
    attempts: [],
    checkOutcome: "confirm",
    receiptNo: null,
    receiptPrints: 0,
    version: 0,
    code: null,
    ...overrides,
  };
}

test("936: an order with a voucher parses and keeps the voucher code", () => {
  const wire = orderDetailWire(
    order({ voucher: { code: "HEMAT10", discountIdr: 10_000 } }),
    90_000,
  );
  const parsed = posOrderDetailSchema.parse(wire);
  assert.equal(parsed.discounts.length, 1);
  assert.equal(parsed.discounts[0].source, "voucher");
  assert.equal(parsed.discounts[0].voucherCode, "HEMAT10");
});

test("936: a declined EDC request parses with bank, method and mode", () => {
  const wire = orderDetailWire(
    order({
      attempts: [
        {
          id: "00000000-0000-4000-8000-0000000a0001",
          sequence: 1,
          method: "edc",
          status: "declined",
          amountIdr: 100_000,
          startedAtMs: AT_MS,
          edc: {
            terminalId: "edc-02",
            terminalLabel: "Bank B · EDC 02",
            bank: "Bank B",
            mode: "card",
            lockedAmountIdr: 100_000,
            declineReason: "Saldo tidak cukup",
            responseCode: "51",
          },
        },
      ],
    }),
    100_000,
  );
  const parsed = posOrderDetailSchema.parse(wire);
  assert.equal(parsed.edcAttempts.length, 1);
  const [attempt] = parsed.edcAttempts;
  assert.equal(attempt.status, "declined");
  assert.equal(attempt.declineReason, "Saldo tidak cukup");
  assert.equal(attempt.responseCode, "51");
  assert.equal(attempt.bank, "bni");
  assert.equal(attempt.method, "card");
  assert.equal(attempt.mode, "ecr");
});
