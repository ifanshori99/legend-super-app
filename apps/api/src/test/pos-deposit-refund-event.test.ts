// Q81 contract keeps DP's real gateway method and enforces the balanced total.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { orderRefundedPayloadSchema } from "@starter/shared/pos";

const event = () => ({
  orderId: createUlid(),
  outletId: randomUUID(),
  businessDate: "2026-11-12",
  refundId: randomUUID(),
  amountIdr: 40_000,
  reason: "quality_complaint",
  reasonNote: "Retur bagian DP",
  approvedBy: randomUUID(),
  overrideId: null,
  approvalRequestId: randomUUID(),
  grossSalesIdr: 40_000,
  discountIdr: 0,
  serviceChargeIdr: 0,
  pbjtIdr: 0,
  refundCashIdr: 15_000,
  refundGatewayIdr: 25_000,
  refundEdcIdr: 0,
  refundPointsIdr: 0,
  lines: [{ method: "cash", amountIdr: 15_000 }],
  depositLines: [{ method: "bank_transfer", amountIdr: 25_000 }],
  refundedAt: "2026-11-12T00:00:00.000Z",
});
describe("legend-77r0 Q81 refund event contract", () => {
  it("Q81-E1: tender15k+original bank transfer DP25k is a balanced40k refund without changing payer method", () => {
    expect(orderRefundedPayloadSchema.parse(event()).depositLines).toEqual([
      { method: "bank_transfer", amountIdr: 25_000 },
    ]);
  });
  it.each([
    { amountIdr: 39_999 },
    { refundGatewayIdr: 24_999 },
    { depositLines: [{ method: "bank_transfer", amountIdr: 25_001 }] },
    { depositLines: [{ method: "cash", amountIdr: 25_000 }] },
    { lines: [{ method: "cash", amountIdr: 40_000 }] },
  ])(
    "Q81-E2: mismatched totals or cash redirection are rejected: %j",
    (change) => {
      expect(
        orderRefundedPayloadSchema.safeParse({ ...event(), ...change }).success,
      ).toBe(false);
    },
  );
});
