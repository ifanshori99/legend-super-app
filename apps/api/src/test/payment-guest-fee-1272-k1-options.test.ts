// 1272 K1 (CTO decision on the guest options): the guest sees the service fee
// before choosing a method. GET payment-options takes the same order or split
// part the create call names (never an amount); the server reads the bill and
// prices each bank, and each method without banks, with the gateway's own
// schedule (the gross-up the create call uses). The create call recomputes:
// it never reads the quote.
//
// Rules under test
// - Quote equals the created payment's fee and charged total (e-wallet, VA,
//   card; QRIS fee 0).
// - A channel without a usable rate is not offered at fee 0: left out.
// - The create call recomputes: a rate changed after the quote is charged at
//   the new rate.
// - A target outside the session (another guest's order, an unknown order or
//   part) is 404; an amount or two targets in the query are refused.
// - No target: the options as before, every fee null.
//
// Run: LEGEND_TEST_FILES="src/test/payment-guest-fee-1272-k1-options.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUlid } from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createPaymentLink } from "../services/payment.service.ts";
import { agent, originHeader } from "./helpers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentMethod,
  type GuestFeeSchedule,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  grossUpGuestFee,
  guestFeeFor,
  type GuestFeeRate,
} from "../services/payment-guest-fee.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const OFFERED = [
  { method: "qris" as const, enabled: true, channels: [] },
  {
    method: "va" as const,
    enabled: true,
    channels: [
      { code: "BC", name: "BCA Virtual Account" },
      // No rate below: never offered at fee 0.
      { code: "I1", name: "BNI Virtual Account" },
    ],
  },
  { method: "bank_transfer" as const, enabled: false, channels: [] },
  {
    method: "ewallet" as const,
    enabled: true,
    channels: [{ code: "OV", name: "OVO" }],
  },
  {
    method: "card" as const,
    enabled: true,
    channels: [{ code: "VC", name: "Credit Card" }],
  },
];

const RATES = (): Map<string, GuestFeeRate> =>
  new Map([
    ["OV", { bps: 150, flatIdr: 0 }],
    ["BC", { bps: 0, flatIdr: 4_000 }],
    ["VC", { bps: 290, flatIdr: 2_000 }],
  ]);

/** Duitku-like double whose fee schedule is the shared pure gross-up. */
class FeeGateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  rates = RATES();
  readonly created: GatewayIntentRequest[] = [];
  async health() {
    return { status: "available" as const };
  }
  async methods() {
    return OFFERED;
  }
  async channels(_context: unknown, method?: GatewayPaymentMethod) {
    return OFFERED.find((entry) => entry.method === method)?.channels ?? [];
  }
  async guestFeeSchedule(): Promise<GuestFeeSchedule> {
    const rates = this.rates;
    return (method, channelCode, baseIdr) =>
      guestFeeFor({
        method,
        channelCode: method === "card" ? "VC" : channelCode,
        baseIdr,
        rates,
        feeMethods: ["va", "ewallet", "card"],
      });
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created.push(input);
    const providerRef = `K1Q-${randomUUID()}`;
    const instructions =
      input.method === "va"
        ? {
            method: "va",
            channelCode: input.channelCode ?? "BC",
            channelName: "BCA Virtual Account",
            virtualAccountNumber: `8808${String(this.created.length).padStart(8, "0")}`,
          }
        : input.method === "qris"
          ? { method: "qris", qrPayload: "00020101021226K1Q", issuer: null }
          : {
              method: input.method,
              channelCode: input.channelCode ?? "VC",
              channelName: input.method === "card" ? "Credit Card" : "OVO",
              paymentUrl: `https://pay.example.test/${providerRef}`,
            };
    return {
      providerRef,
      instructions: instructions as PaymentInstructions,
      expiresAt: input.expiresAt,
      feeQuoteIdr: input.guestFeeIdr ?? 0,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
}

let fx: HoldFixture;
const gw = new FeeGateway();

beforeAll(async () => {
  fx = await holdFixture("pay-k1-options", { provider: "duitku" });
  for (const method of ["ewallet", "card"])
    await owner.query(
      `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
       VALUES ($1, NULL, $2, 'duitku', NULL, true, 'system:test')
       ON CONFLICT DO NOTHING`,
      [fx.tenant.tenantId, method],
    );
  setPaymentGateway(gw);
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Bank = {
  code: string;
  name: string;
  guestFeeIdr: number | null;
  chargedIdr: number | null;
};
type Option = {
  method: string;
  enabled: boolean;
  banks: Bank[];
  guestFeeIdr: number | null;
  chargedIdr: number | null;
};

const options = (guest: Guest, query: Record<string, string> = {}) =>
  agent(fx.app)
    .get(`/api/table-sessions/${guest.sessionId}/payment-options`)
    .query(query)
    .set(fx.headers)
    .set(originHeader)
    .set("Authorization", `Bearer ${guest.token}`);

const methodOf = (body: { data: { methods: Option[] } }, method: string) => {
  const option = body.data.methods.find((entry) => entry.method === method);
  expect(option, `${method} listed`).toBeDefined();
  return option!;
};

const pay = (
  guest: Guest,
  orderId: string,
  method: "qris" | "va" | "ewallet" | "card",
  bankCode?: string,
  expectedChargedIdr?: number | null,
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(bankCode === undefined ? {} : { bankCode }),
    ...(expectedChargedIdr == null ? {} : { expectedChargedIdr }),
    idempotencyKey: randomUUID(),
  });

async function wholeOrder() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  return { guest, order };
}

describe("1272 K1 guest options: no target", () => {
  it("lists the options as before with every fee null", async () => {
    gw.rates = RATES();
    const guest = await fx.newGuest();
    const res = await options(guest);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const option of res.body.data.methods as Option[]) {
      expect(option.guestFeeIdr, option.method).toBeNull();
      expect(option.chargedIdr, option.method).toBeNull();
      for (const bank of option.banks) {
        expect(bank.guestFeeIdr, bank.code).toBeNull();
        expect(bank.chargedIdr, bank.code).toBeNull();
      }
    }
    // Unpriced listing keeps every channel the gateway offers.
    expect(methodOf(res.body, "va").banks.map((bank) => bank.code)).toEqual([
      "BC",
      "I1",
    ]);
  });
});

describe("1272 K1 guest options: priced for the named order", () => {
  it("quotes each method with the gross-up of the server's bill", async () => {
    gw.rates = RATES();
    const { guest, order } = await wholeOrder();
    const res = await options(guest, { orderId: order.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const bill = order.totalIdr;
    const qris = methodOf(res.body, "qris");
    expect(qris).toMatchObject({ guestFeeIdr: 0, chargedIdr: bill });
    const ov = methodOf(res.body, "ewallet").banks[0]!;
    const ovFee = grossUpGuestFee(bill, { bps: 150, flatIdr: 0 });
    expect(ov).toMatchObject({
      code: "OV",
      guestFeeIdr: ovFee,
      chargedIdr: bill + ovFee,
    });
    const card = methodOf(res.body, "card");
    const cardFee = grossUpGuestFee(bill, { bps: 290, flatIdr: 2_000 });
    expect(card).toMatchObject({
      enabled: true,
      guestFeeIdr: cardFee,
      chargedIdr: bill + cardFee,
    });
    const va = methodOf(res.body, "va");
    // BNI has no rate: left out, never at fee 0. A method with banks is
    // priced per bank.
    expect(va.banks.map((bank) => bank.code)).toEqual(["BC"]);
    expect(va.banks[0]!.guestFeeIdr).toBe(
      grossUpGuestFee(bill, { bps: 0, flatIdr: 4_000 }),
    );
    expect(va.guestFeeIdr).toBeNull();
  });

  for (const [method, bankCode] of [
    ["ewallet", "OV"],
    ["va", "BC"],
    ["card", undefined],
    ["qris", undefined],
  ] as const) {
    it(`the quote equals the created ${method} payment`, async () => {
      gw.rates = RATES();
      const { guest, order } = await wholeOrder();
      const quoted = await options(guest, { orderId: order.id });
      expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
      const option = methodOf(quoted.body, method);
      const price =
        bankCode === undefined
          ? option
          : option.banks.find((bank) => bank.code === bankCode)!;
      expect(price.guestFeeIdr).not.toBeNull();

      const before = gw.created.length;
      const created = await pay(
        guest,
        order.id,
        method,
        bankCode,
        price.chargedIdr,
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.data).toMatchObject({
        amountIdr: order.totalIdr,
        guestFeeIdr: price.guestFeeIdr,
        chargedIdr: price.chargedIdr,
      });
      expect(gw.created.slice(before)).toHaveLength(1);
      expect(gw.created[before]!.guestFeeIdr ?? 0).toBe(price.guestFeeIdr);
    });
  }

  it("a rate changed after the quote: 409 FEE_CHANGED, nothing issued; the new total is accepted", async () => {
    gw.rates = RATES();
    const { guest, order } = await wholeOrder();
    const quoted = await options(guest, { orderId: order.id });
    const quote = methodOf(quoted.body, "ewallet").banks[0]!;
    gw.rates = new Map([...RATES(), ["OV", { bps: 300, flatIdr: 0 }]]);
    const before = gw.created.length;
    const stale = await pay(guest, order.id, "ewallet", "OV", quote.chargedIdr);
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("FEE_CHANGED");
    expect(gw.created).toHaveLength(before);
    const fee = grossUpGuestFee(order.totalIdr, { bps: 300, flatIdr: 0 });
    expect(fee).not.toBe(quote.guestFeeIdr);
    const created = await pay(
      guest,
      order.id,
      "ewallet",
      "OV",
      order.totalIdr + fee,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      guestFeeIdr: fee,
      chargedIdr: order.totalIdr + fee,
    });
    gw.rates = RATES();
  });

  it("a method with a fee needs the total the guest saw; QRIS does not", async () => {
    gw.rates = RATES();
    const { guest, order } = await wholeOrder();
    const before = gw.created.length;
    const missing = await pay(guest, order.id, "ewallet", "OV");
    expect(missing.status, JSON.stringify(missing.body)).toBe(409);
    expect(missing.body.error.code).toBe("FEE_CHANGED");
    expect(gw.created).toHaveLength(before);
    const qris = await pay(guest, order.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
  });
});

describe("1272 K1 guest options: the target belongs to the session", () => {
  it("another guest's order is 404", async () => {
    const { order } = await wholeOrder();
    const stranger = await fx.newGuest();
    const res = await options(stranger, { orderId: order.id });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("an unknown order or split part is 404", async () => {
    const guest = await fx.newGuest();
    expect((await options(guest, { orderId: createUlid() })).status).toBe(404);
    expect((await options(guest, { billSplitId: randomUUID() })).status).toBe(
      404,
    );
  });

  it("an amount or two targets in the query are refused", async () => {
    const { guest, order } = await wholeOrder();
    const withAmount = await options(guest, {
      orderId: order.id,
      amountIdr: "1",
    });
    expect(withAmount.status).toBeGreaterThanOrEqual(400);
    expect(withAmount.status).toBeLessThan(500);
    const both = await options(guest, {
      orderId: order.id,
      billSplitId: randomUUID(),
    });
    expect(both.status).toBeGreaterThanOrEqual(400);
    expect(both.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Fee second opinion re-review: a payment link (the guest page) is price-locked
// on a replay (P3-c) and on a refresh (P2), like a first create.
// ---------------------------------------------------------------------------

const LINK_TOTAL = 100_000;

async function openLink() {
  const opened = await createPaymentLink(
    fx.context,
    {
      outletId: fx.tenant.outletId as never,
      reference: `K1L-${randomUUID().slice(0, 8)}`,
      tableLabel: null,
      pax: null,
      subtotalIdr: LINK_TOTAL,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: LINK_TOTAL,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  return opened;
}

const linkIntent = (token: string, body: Record<string, unknown>) =>
  agent(fx.app)
    .post(`/api/payments/links/${token}/intents`)
    .set(fx.headers)
    .send({
      method: "ewallet",
      channelCode: "OV",
      idempotencyKey: randomUUID(),
      ...body,
    });

describe("1272 re-review P3-c: a replay of a create names the same total", () => {
  it("the same key with another expected total is 409 FEE_CHANGED, not the old code", async () => {
    gw.rates = RATES();
    const { token } = await openLink();
    const fee = grossUpGuestFee(LINK_TOTAL, { bps: 150, flatIdr: 0 });
    const key = randomUUID();
    const first = await linkIntent(token, {
      idempotencyKey: key,
      expectedChargedIdr: LINK_TOTAL + fee,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await linkIntent(token, {
      idempotencyKey: key,
      expectedChargedIdr: LINK_TOTAL + fee + 500,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    expect(replay.body.error.code).toBe("FEE_CHANGED");
    const same = await linkIntent(token, {
      idempotencyKey: key,
      expectedChargedIdr: LINK_TOTAL + fee,
    });
    expect(same.status, JSON.stringify(same.body)).toBe(201);
    expect(same.body.data.id).toBe(first.body.data.id);
  });
});

describe("1272 re-review P2: a refresh never replaces a priced code at another price", () => {
  it("a changed rate is 409 FEE_CHANGED and no code is issued; the same rate refreshes at the same total", async () => {
    gw.rates = RATES();
    const { token, linkId } = await openLink();
    const fee = grossUpGuestFee(LINK_TOTAL, { bps: 150, flatIdr: 0 });
    const first = await linkIntent(token, {
      expectedChargedIdr: LINK_TOTAL + fee,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    await owner.query(
      "UPDATE payment_intents SET status = 'expired', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, oldId],
    );

    gw.rates = new Map([...RATES(), ["OV", { bps: 300, flatIdr: 0 }]]);
    const before = gw.created.length;
    const changed = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents/${oldId}/refresh`)
      .set(fx.headers);
    expect(changed.status, JSON.stringify(changed.body)).toBe(409);
    expect(changed.body.error.code).toBe("FEE_CHANGED");
    expect(gw.created).toHaveLength(before);

    gw.rates = RATES();
    const same = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents/${oldId}/refresh`)
      .set(fx.headers);
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body.data.id).not.toBe(oldId);
    expect(same.body.data.chargedIdr).toBe(LINK_TOTAL + fee);
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2",
      [fx.tenant.tenantId, linkId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});
