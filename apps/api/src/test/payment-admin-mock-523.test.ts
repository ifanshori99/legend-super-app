import { beforeEach, describe, expect, it } from "vitest";
import {
  cafeLegendPaymentAdminFixtures as fixtures,
  edcCashierDefaultsViewSchema,
  edcCashierDefaultSchema,
  refundViewSchema,
  refundablePaymentSchema,
  unallocatedFundViewSchema,
} from "@starter/shared/payment/admin";
import { z } from "zod";
import { dispatchMock, resetMocks } from "../../../web/src/lib/mock/runtime.ts";
import "../../../web/src/features/ws05-payment-admin/mock.ts";

const ADMIN = "/api/payments/admin";
const outletId = fixtures.outlets[0]!.id;
const [terminalA, terminalB] = fixtures.terminals;
const [cashierA, cashierB] = fixtures.cashiers;
const fund = fixtures.unallocatedFunds.find(
  (entry) => entry.status === "open",
)!;
let nextKey = 0;
const key = () => `mock-523-key-${++nextKey}`;

async function defaults() {
  const response = await dispatchMock({
    method: "GET",
    path: `${ADMIN}/edc/cashier-defaults`,
    query: { outletId },
  });
  return z.object({ data: edcCashierDefaultsViewSchema }).parse(response).data;
}

function patchTerminal(body: unknown) {
  return dispatchMock({
    method: "PATCH",
    path: `${ADMIN}/edc/terminals/${terminalA!.id}`,
    headers: { "Idempotency-Key": key() },
    body,
  });
}

async function refunds() {
  const response = await dispatchMock({
    method: "GET",
    path: `${ADMIN}/refunds`,
    query: { outletId, limit: 100 },
  });
  return z.object({ data: z.array(refundViewSchema) }).parse(response).data;
}

async function refundablePayments() {
  const response = await dispatchMock({
    method: "GET",
    path: `${ADMIN}/refunds/refundable`,
    query: { outletId },
  });
  return z
    .object({ data: z.object({ payments: z.array(refundablePaymentSchema) }) })
    .parse(response).data.payments;
}

async function resolveFund(idempotencyKey: string, resolution = "refund") {
  const response = await dispatchMock({
    method: "POST",
    path: `${ADMIN}/unallocated-funds/${fund.id}/resolve`,
    body: { idempotencyKey, resolution, note: "Kembalikan kelebihan bayar." },
  });
  return z.object({ data: unallocatedFundViewSchema }).parse(response).data;
}

beforeEach(() => {
  resetMocks();
  nextKey = 0;
});

describe("brief 523 EDC mock defaults", () => {
  it("removes an inactive terminal's defaults without removing unrelated defaults, permanently", async () => {
    await patchTerminal({ status: "inactive" });
    const after = await defaults();
    expect(after.cashiers.some((entry) => entry.id === cashierA!.id)).toBe(
      false,
    );
    expect(after.cashiers.some((entry) => entry.id === cashierB!.id)).toBe(
      true,
    );
    expect(
      after.cashiers.some((entry) => entry.defaultMethod === "qris_doit"),
    ).toBe(true);

    await patchTerminal({ status: "active" });
    expect(
      (await defaults()).cashiers.some((entry) => entry.id === cashierA!.id),
    ).toBe(false);
  });

  it("removes only the revoked method and lets a known cashier choose a new valid default", async () => {
    await dispatchMock({
      method: "PUT",
      path: `${ADMIN}/edc/cashier-defaults/${cashierB!.cashierId}`,
      headers: { "Idempotency-Key": key() },
      body: { outletId, terminalId: terminalA!.id, defaultMethod: "edc_qris" },
    });
    await patchTerminal({ supportedMethods: ["qris"] });
    const after = await defaults();
    expect(after.cashiers.some((entry) => entry.id === cashierA!.id)).toBe(
      false,
    );
    expect(
      after.cashiers.find((entry) => entry.id === cashierB!.id),
    ).toMatchObject({
      terminalId: terminalA!.id,
      defaultMethod: "edc_qris",
    });

    await patchTerminal({ supportedMethods: ["card", "qris"] });
    expect(
      (await defaults()).cashiers.some((entry) => entry.id === cashierA!.id),
    ).toBe(false);
    const reassigned = await dispatchMock({
      method: "PUT",
      path: `${ADMIN}/edc/cashier-defaults/${cashierA!.cashierId}`,
      headers: { "Idempotency-Key": key() },
      body: { outletId, terminalId: terminalB!.id, defaultMethod: "edc_card" },
    });
    expect(
      z.object({ data: edcCashierDefaultSchema }).parse(reassigned).data,
    ).toMatchObject({
      cashierId: cashierA!.cashierId,
      terminalId: terminalB!.id,
    });
    expect(
      (await defaults()).cashiers.some(
        (entry) => entry.cashierId === cashierA!.cashierId,
      ),
    ).toBe(true);
  });

  it.each(["inactive", "unsupported"] as const)(
    "filters a stale %s default on GET",
    async (scenario) => {
      const originalStatus = terminalA!.status;
      const originalMethods = terminalA!.supportedMethods;
      try {
        if (scenario === "inactive") terminalA!.status = "inactive";
        else terminalA!.supportedMethods = ["qris"];
        // Re-seeding models a persisted stale default; GET must validate it even
        // when no PATCH in this runtime was responsible for invalidating it.
        resetMocks();
      } finally {
        terminalA!.status = originalStatus;
        terminalA!.supportedMethods = originalMethods;
      }
      const after = await defaults();
      expect(after.cashiers.some((entry) => entry.id === cashierA!.id)).toBe(
        false,
      );
      expect(after.cashiers.some((entry) => entry.id === cashierB!.id)).toBe(
        true,
      );
    },
  );
});

describe("brief 523 unallocated funds mock", () => {
  it("opens exactly one pending refund for the fund and exposes it for approval without paying money", async () => {
    const before = await refunds();
    const billBalancesBefore = await refundablePayments();
    const result = await resolveFund(key());
    const after = await refunds();
    const created = after.filter(
      (entry) => !before.some((old) => old.id === entry.id),
    );

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      paymentIntentId: fund.paymentIntentId,
      amountIdr: fund.amountIdr,
      paymentReference: fund.paymentReference,
      method: fund.method,
      status: "pending",
      providerRef: null,
      approvedBy: null,
      viewerCanApprove: false,
      note: "Kembalikan kelebihan bayar.",
    });
    expect(result).toMatchObject({
      status: "open",
      resolution: null,
      approvalRef: null,
      resolvedAt: null,
    });
    // A pending refund reserves the excess only, never the bill's paid amount
    // and never a completed payout. The outlet cannot return more than excess.
    expect(created.reduce((sum, entry) => sum + entry.amountIdr, 0)).toBe(
      fund.amountIdr,
    );
    expect(fund.amountIdr).toBeLessThanOrEqual(
      fund.paidAmountIdr - fund.billTotalIdr,
    );
    expect(created.some((entry) => entry.status === "completed")).toBe(false);
    expect(await refundablePayments()).toEqual(billBalancesBefore);
  });

  it("replays the original key and rejects a second key so the excess is never reserved twice", async () => {
    const idempotencyKey = key();
    const result = await resolveFund(idempotencyKey);
    const firstRefunds = await refunds();
    expect(await resolveFund(idempotencyKey)).toEqual(result);
    expect(await refunds()).toEqual(firstRefunds);
    await expect(resolveFund(key())).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    expect(await refunds()).toEqual(firstRefunds);
    expect(
      firstRefunds.filter(
        (entry) => entry.paymentIntentId === fund.paymentIntentId,
      ),
    ).toHaveLength(1);
  });

  it("fails closed for credit without creating a refund or consuming the refund attempt", async () => {
    const before = await refunds();
    await expect(resolveFund(key(), "credit")).rejects.toMatchObject({
      status: 503,
    });
    expect(await refunds()).toEqual(before);
    await resolveFund(key());
    expect(
      (await refunds()).filter(
        (entry) => !before.some((old) => old.id === entry.id),
      ),
    ).toHaveLength(1);
  });
});
