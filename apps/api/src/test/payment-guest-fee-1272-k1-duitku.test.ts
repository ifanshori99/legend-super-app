// 1272 K1 (design duitku-fee-passthrough §1-§2, §5): the Duitku adapter charges
// the bill plus the guest fee, refuses a fee its own rate does not give and a
// quote that differs from it, hides a channel without a rate, never charges a
// QRIS fee, and with DUITKU_GUEST_FEE_METHODS empty behaves exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { createDuitkuGateway } from "../services/payment-duitku";
import { grossUpGuestFee } from "../services/payment-guest-fee";

vi.mock("../services/platform-integration.service", () => ({
  loadActiveIntegrationCredentials: vi.fn(),
  loadIntegrationCredentialsById: vi.fn(),
}));

const TENANT_ID = "0b1f2c3d-0000-4000-8000-000000001272";
const INTEGRATION_ID = "0b1f2c3d-0000-4000-8000-0000000012b1";
const INTENT_ID = "11111111-2222-4333-8444-555555551272";
const NOW = new Date("2026-11-27T03:00:00.000Z");
const BILL = 50_000;

const context = {
  tenant: { tenantId: TENANT_ID },
  outletScope: { kind: "all", tenantId: TENANT_ID },
} as unknown as ScopedTenantContext;

const OV_RATE = { bps: 167, flatIdr: 0 };
const BC_RATE = { bps: 0, flatIdr: 4_000 };
const VC_RATE = { bps: 290, flatIdr: 2_000 };

const config = (guestFees: Record<string, unknown>) => ({
  environment: "production",
  notificationEmail: "owner@example.test",
  maxFeeBps_va: 0,
  maxFeeFlatIdr_va: 5_000,
  maxFeeBps_ewallet: 300,
  maxFeeBps_card: 300,
  maxFeeFlatIdr_card: 2_500,
  maxFeeBps_qris: 70,
  guestFees,
});

const fullRates = {
  OV: OV_RATE,
  BC: BC_RATE,
  VC: VC_RATE,
  SP: { bps: 70, flatIdr: 0 },
};

type Calls = { methodsAt: number[]; inquiryAmounts: number[] };

/** `quote(code, amount)`: Duitku's totalFee answer for that code. */
function gateway(
  guestFees: Record<string, unknown> = fullRates,
  quote: (code: string, amount: number) => number = () => 0,
) {
  const calls: Calls = { methodsAt: [], inquiryAmounts: [] };
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    let answer: unknown;
    if (String(url).endsWith("getpaymentmethod")) {
      calls.methodsAt.push(Number(body.amount));
      answer = {
        responseCode: "00",
        paymentFee: ["SP", "BC", "M2", "OV", "VC"].map((paymentMethod) => ({
          paymentMethod,
          paymentName: `Method ${paymentMethod}`,
          totalFee: String(quote(paymentMethod, Number(body.amount))),
        })),
      };
    } else {
      calls.inquiryAmounts.push(Number(body.paymentAmount));
      answer = {
        statusCode: "00",
        reference: "REF-1272",
        paymentUrl: "https://passport.duitku.com/pay/REF-1272",
        vaNumber: "8800123456789",
        qrString: "00020101021226QRSTRING",
        amount: String(body.paymentAmount),
      };
    }
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;
  const loaded = {
    integration: {
      id: INTEGRATION_ID,
      outletId: null,
      config: config(guestFees),
    },
    credentials: { merchantCode: "DS1272", apiKey: "api-key-SECRET" },
  };
  const port = createDuitkuGateway({
    fetch: fetchImpl,
    now: () => NOW,
    callbackBaseUrl: "https://api.example.test",
    returnUrl: "https://app.example.test/paid",
    loadCredentials: async () => loaded,
    loadCredentialsById: async () => loaded,
  });
  return { port, calls };
}

const request = (
  method: "qris" | "va" | "ewallet" | "card",
  channelCode: string | null,
  guestFeeIdr?: number,
) => ({
  context,
  provider: "duitku",
  intentId: INTENT_ID,
  method,
  channelCode,
  amountIdr: BILL,
  ...(guestFeeIdr === undefined ? {} : { guestFeeIdr }),
  idempotencyKey: "idem-1272",
  expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
});

/** Duitku's own MDR as a percentage of the charged amount plus a flat part. */
const mdr =
  (rates: Record<string, { bps: number; flatIdr: number }>) =>
  (code: string, amount: number) => {
    const rate = rates[code];
    return rate ? Math.ceil((amount * rate.bps) / 10_000) + rate.flatIdr : 0;
  };

const saved = {
  methods: env.DUITKU_ENABLED_METHODS,
  fee: env.DUITKU_GUEST_FEE_METHODS,
};
beforeEach(() => {
  env.DUITKU_ENABLED_METHODS = ["qris", "va", "ewallet", "card"];
  env.DUITKU_GUEST_FEE_METHODS = ["va", "ewallet", "card"];
});
afterEach(() => {
  env.DUITKU_ENABLED_METHODS = saved.methods;
  env.DUITKU_GUEST_FEE_METHODS = saved.fee;
});

async function expectFeeChanged(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(409);
  expect((error as HttpError).code).toBe("FEE_CHANGED");
}

describe("DUITKU_GUEST_FEE_METHODS empty: exactly the old behaviour", () => {
  it("no fee anywhere, every channel listed, the bill is what Duitku charges", async () => {
    env.DUITKU_GUEST_FEE_METHODS = [];
    const { port, calls } = gateway({}, mdr(fullRates));
    const schedule = await port.guestFeeSchedule!(context);
    for (const [method, code] of [
      ["qris", null],
      ["va", "BC"],
      ["va", "M2"],
      ["ewallet", "OV"],
      ["card", null],
    ] as const)
      expect(schedule(method, code, BILL)).toBe(0);
    const listed = await port.methods!(context, undefined, BILL);
    expect(
      listed
        .find((entry) => entry.method === "va")
        ?.channels.map((c) => c.code),
    ).toEqual(["BC", "M2"]);
    expect(listed.find((entry) => entry.method === "card")?.enabled).toBe(true);
    const created = await port.createIntent(request("ewallet", "OV"));
    expect(calls.inquiryAmounts).toEqual([BILL]);
    // The quote is only recorded; the outlet bears the MDR as before.
    expect(created.feeQuoteIdr).toBe(mdr(fullRates)("OV", BILL));
  });

  it("a fee sent while the flag is off is refused before any provider call", async () => {
    env.DUITKU_GUEST_FEE_METHODS = [];
    const { port, calls } = gateway();
    await expectFeeChanged(port.createIntent(request("ewallet", "OV", 900)));
    expect(calls.methodsAt).toEqual([]);
    expect(calls.inquiryAmounts).toEqual([]);
  });
});

describe("guest fee on", () => {
  it("charges bill + g, quotes at the charged amount, and the outlet nets the bill", async () => {
    const rates = { OV: OV_RATE, BC: BC_RATE, VC: VC_RATE };
    const { port, calls } = gateway(fullRates, mdr(rates));
    const schedule = await port.guestFeeSchedule!(context);
    for (const [method, code, rate] of [
      ["ewallet", "OV", OV_RATE],
      ["va", "BC", BC_RATE],
      ["card", null, VC_RATE],
    ] as const) {
      calls.methodsAt.length = 0;
      calls.inquiryAmounts.length = 0;
      const g = schedule(method, code, BILL);
      expect(g).toBe(grossUpGuestFee(BILL, rate));
      const created = await port.createIntent(request(method, code, g!));
      expect(calls.methodsAt).toEqual([BILL + g!]);
      expect(calls.inquiryAmounts).toEqual([BILL + g!]);
      const quote = mdr(rates)(method === "card" ? "VC" : code!, BILL + g!);
      expect(created.feeQuoteIdr).toBe(quote);
      expect(BILL + g! - quote).toBeGreaterThanOrEqual(BILL);
    }
  });

  it("QRIS never carries a fee, even with a filled rate", async () => {
    const { port, calls } = gateway(
      fullRates,
      mdr({ SP: { bps: 70, flatIdr: 0 } }),
    );
    const schedule = await port.guestFeeSchedule!(context);
    expect(schedule("qris", null, BILL)).toBe(0);
    await expectFeeChanged(port.createIntent(request("qris", null, 350)));
    await port.createIntent(request("qris", null));
    expect(calls.inquiryAmounts).toEqual([BILL]);
  });

  it("a quote above our fee (outlet short) creates no intent", async () => {
    const { port, calls } = gateway(fullRates, (code, amount) =>
      code === "OV" ? mdr({ OV: OV_RATE })(code, amount) + 1 : 0,
    );
    const g = grossUpGuestFee(BILL, OV_RATE);
    await expectFeeChanged(port.createIntent(request("ewallet", "OV", g)));
    expect(calls.inquiryAmounts).toEqual([]);
  });

  it("a quote more than one rupiah under our fee (guest overpays) creates no intent", async () => {
    const g = grossUpGuestFee(BILL, OV_RATE);
    const { port, calls } = gateway(fullRates, (code) =>
      code === "OV" ? g - 2 : 0,
    );
    await expectFeeChanged(port.createIntent(request("ewallet", "OV", g)));
    expect(calls.inquiryAmounts).toEqual([]);
    // One rupiah under is rounding: accepted.
    const near = gateway(fullRates, (code) => (code === "OV" ? g - 1 : 0));
    await near.port.createIntent(request("ewallet", "OV", g));
    expect(near.calls.inquiryAmounts).toEqual([BILL + g]);
  });

  it("a fee other than the rate's (0 or stale) is refused before any provider call", async () => {
    const { port, calls } = gateway(fullRates, mdr({ OV: OV_RATE }));
    await expectFeeChanged(port.createIntent(request("ewallet", "OV")));
    const g = grossUpGuestFee(BILL, OV_RATE);
    await expectFeeChanged(port.createIntent(request("ewallet", "OV", g + 1)));
    expect(calls.methodsAt).toEqual([]);
  });

  it("a channel without a usable rate is hidden and refused, never fee 0", async () => {
    // M2 has no rate; BC is above the va cap; no card rate at all.
    const { port, calls } = gateway({
      OV: OV_RATE,
      BC: { bps: 0, flatIdr: 6_000 },
    });
    const listed = await port.methods!(context, undefined, BILL);
    const byMethod = (method: string) =>
      listed.find((entry) => entry.method === method)!;
    expect(byMethod("va")).toMatchObject({ enabled: false, channels: [] });
    expect(byMethod("card")).toMatchObject({ enabled: false, channels: [] });
    expect(byMethod("ewallet").channels.map((c) => c.code)).toEqual(["OV"]);
    expect(byMethod("qris").enabled).toBe(true);
    expect(await port.channels(context, "va")).toEqual([]);
    const schedule = await port.guestFeeSchedule!(context);
    expect(schedule("va", "M2", BILL)).toBeNull();
    expect(schedule("card", null, BILL)).toBeNull();
    for (const [method, code] of [
      ["va", "M2"],
      ["va", "BC"],
      ["card", null],
    ] as const) {
      const error = await port.createIntent(request(method, code, 0)).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeTruthy();
    }
    expect(calls.inquiryAmounts).toEqual([]);
  });
});
