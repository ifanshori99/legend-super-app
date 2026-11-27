// 1272 K1 review P3-3: whether a method can be issued is read at the amount
// the gateway charges (bill + guest fee), not at the bill alone; a fee method
// without a usable rate is not offered. Without a fee schedule the amount is
// the bill, as before.
import { afterEach, describe, expect, it } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  resetPaymentGateways,
  setPaymentGateway,
  type GuestFeeSchedule,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { methodIssuable } from "../services/payment-gateway-select.ts";

const context = {} as unknown as ScopedTenantContext;
const routing = {
  provider: "duitku",
  fallbackProvider: null,
  enabled: true,
  isDefault: false,
};
const BILL = 100_000;
const FEE = 2_000;

function port(
  schedule: GuestFeeSchedule | undefined,
  limitIdr: number,
  askedAt: number[],
): PaymentGatewayPort {
  return {
    provider: "duitku",
    async health() {
      return { status: "available" as const };
    },
    async methods(_context: unknown, _outlet: unknown, amountIdr?: number) {
      askedAt.push(amountIdr ?? -1);
      return [
        {
          method: "ewallet" as const,
          // Out of limits above the cap, as Duitku lists it.
          enabled: (amountIdr ?? 0) <= limitIdr,
          channels: [{ code: "OV", name: "OVO" }],
        },
      ];
    },
    async channels() {
      return [];
    },
    ...(schedule ? { guestFeeSchedule: async () => schedule } : {}),
  } as unknown as PaymentGatewayPort;
}

const choice = {
  method: "ewallet" as const,
  channelCode: "OV",
  amountIdr: BILL,
};

afterEach(() => resetPaymentGateways());

describe("methodIssuable at the charged amount (K1 review P3-3)", () => {
  it("a method within limits at the bill but over them at bill + fee is not offered", async () => {
    const askedAt: number[] = [];
    setPaymentGateway(port(() => FEE, BILL, askedAt));
    expect(await methodIssuable(context, "outlet", routing, choice)).toBe(
      "not_offered",
    );
    expect(askedAt).toEqual([BILL + FEE]);
  });

  it("is offered when bill + fee is within the limits", async () => {
    const askedAt: number[] = [];
    setPaymentGateway(port(() => FEE, BILL + FEE, askedAt));
    expect(await methodIssuable(context, "outlet", routing, choice)).toBe(
      "yes",
    );
  });

  it("a fee method without a usable rate is not offered", async () => {
    setPaymentGateway(port(() => null, BILL * 10, []));
    expect(await methodIssuable(context, "outlet", routing, choice)).toBe(
      "not_offered",
    );
  });

  it("a gateway without a fee schedule is read at the bill, as before", async () => {
    const askedAt: number[] = [];
    setPaymentGateway(port(undefined, BILL, askedAt));
    expect(await methodIssuable(context, "outlet", routing, choice)).toBe(
      "yes",
    );
    expect(askedAt).toEqual([BILL]);
  });
});
