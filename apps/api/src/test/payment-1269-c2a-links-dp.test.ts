// 1269 C2a (legend-osqou.3): the payment link and the reservation DP offer VA,
// e-wallet and card, only as far as the gateway lists them.
//
// - C0 finding 5: the DP port is ready only while QRIS is routed on and listed
//   (at the DP amount when it opens).
// - C0 finding 6: the link view shows QRIS off while the gateway does not list it.
// - C0 finding 7: a refused method voids no live code (QR guest and public link).
// - Paying the old code after a method change parks the money; the bill is
//   never paid twice.
// - One return URL for every Duitku payment, without a token.
//
// Run: LEGEND_TEST_FILES="src/test/payment-1269-c2a-links-dp.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import { env } from "../config/env.ts";
import { createDuitkuGateway } from "../services/payment-duitku.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  confirmPayment,
  createIntent,
  createPaymentLink,
  getPaymentLinkView,
  refreshIntent,
} from "../services/payment.service.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent } from "./helpers.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { bindLinkToOrder, intentRow } from "./qr-va-912-3p1-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const CHANNELS: Record<string, { code: string; name: string }[]> = {
  va: [{ code: "BC", name: "BCA Virtual Account" }],
  ewallet: [{ code: "OV", name: "OVO" }],
};
const ALL: GatewayPaymentMethod[] = ["qris", "va", "ewallet", "card"];

/** Duitku-like double: `listed` is what `methods()` reports enabled. */
class Gateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  listed = new Set<GatewayPaymentMethod>(ALL);
  maxQrisIdr = Number.POSITIVE_INFINITY;
  failMethods = false;
  readonly created: GatewayIntentRequest[] = [];
  private sequence = 0;
  reset() {
    this.listed = new Set(ALL);
    this.maxQrisIdr = Number.POSITIVE_INFINITY;
    this.failMethods = false;
    this.created.length = 0;
  }
  async health() {
    return { status: "available" as const };
  }
  async methods(_context?: unknown, _outletId?: string, amountIdr?: number) {
    if (this.failMethods) throw new Error("methods down");
    return (["qris", "va", "bank_transfer", "ewallet", "card"] as const).map(
      (method) => ({
        method,
        enabled:
          this.listed.has(method) &&
          (method !== "qris" || (amountIdr ?? 0) <= this.maxQrisIdr),
        channels: CHANNELS[method] ?? [],
      }),
    );
  }
  // Like the Duitku adapter: a locked method still lists nothing here.
  async channels(_context: unknown, method: GatewayPaymentMethod) {
    return this.listed.has(method) ? (CHANNELS[method] ?? []) : [];
  }
  async createIntent(input: GatewayIntentRequest) {
    this.sequence += 1;
    this.created.push(input);
    const providerRef = `C2A-${randomUUID()}`;
    const instructions =
      input.method === "qris"
        ? { method: "qris", qrPayload: `QR${this.sequence}`, issuer: null }
        : input.method === "va"
          ? {
              method: "va",
              channelCode: input.channelCode,
              channelName: "BCA Virtual Account",
              virtualAccountNumber: `8808${String(this.sequence).padStart(8, "0")}`,
            }
          : {
              method: input.method,
              channelCode: input.channelCode ?? "VC",
              channelName: "Pay page",
              paymentUrl: `https://pay.example.test/${providerRef}`,
            };
    return {
      providerRef,
      instructions: instructions as PaymentInstructions,
      expiresAt: input.expiresAt,
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
const gw = new Gateway();

async function setRule(method: string, enabled: boolean) {
  await owner.query(
    "DELETE FROM payment_routing_rules WHERE tenant_id = $1 AND outlet_id IS NULL AND method = $2",
    [fx.tenant.tenantId, method],
  );
  await owner.query(
    `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
     VALUES ($1, NULL, $2, 'duitku', NULL, $3, 'system:test')`,
    [fx.tenant.tenantId, method, enabled],
  );
}

beforeAll(async () => {
  fx = await holdFixture("payment-1269-c2a");
  setPaymentGateway(gw);
}, 180_000);
beforeEach(async () => {
  gw.reset();
  for (const method of ["qris", "va", "ewallet", "card"])
    await setRule(method, true);
});
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

/** A bill that belongs to no order, like a reservation DP link. */
const openBill = (totalIdr = 100_000) =>
  createPaymentLink(
    fx.context,
    {
      outletId: fx.tenant.outletId,
      reference: `C2A-${randomUUID().slice(0, 8)}`,
      tableLabel: null,
      pax: null,
      subtotalIdr: totalIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr,
      returnPath: "/reservation",
    } as Parameters<typeof createPaymentLink>[1],
    "system:reservation",
  );

const pay = (
  token: string,
  method: GatewayPaymentMethod,
  channelCode: string | null,
) =>
  createIntent(fx.context, token, {
    method,
    channelCode,
    idempotencyKey: randomUUID(),
  });

async function releaseCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM payment_va_releases WHERE tenant_id = $1 AND payment_intent_id = $2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

async function expectStillLive(intentId: string) {
  expect((await intentRow(fx.tenant.tenantId, intentId)).status).toBe(
    "pending",
  );
  expect(await releaseCount(intentId), "no void row").toBe(0);
}

describe("payment link view", () => {
  it("shows QRIS off while the gateway does not list it (finding 6)", async () => {
    gw.listed.delete("qris");
    const { token } = await openBill();
    const view = await getPaymentLinkView(fx.context, token);
    expect(view.methods.find((entry) => entry.method === "qris")).toEqual({
      method: "qris",
      enabled: false,
      unavailableReason: "routing_disabled",
      channels: [],
    });
    expect(view.methods.find((entry) => entry.method === "va")?.enabled).toBe(
      true,
    );
  });

  it("offers e-wallet with its channels and card without one", async () => {
    const { token } = await openBill();
    const view = await getPaymentLinkView(fx.context, token);
    expect(view.methods.filter((entry) => entry.enabled)).toEqual([
      { method: "qris", enabled: true, unavailableReason: null, channels: [] },
      {
        method: "va",
        enabled: true,
        unavailableReason: null,
        channels: CHANNELS.va,
      },
      {
        method: "ewallet",
        enabled: true,
        unavailableReason: null,
        channels: CHANNELS.ewallet,
      },
      { method: "card", enabled: true, unavailableReason: null, channels: [] },
    ]);
  });

  it.each(["ewallet", "card"] as const)(
    "leaves %s out while unlisted, unrouted or unreadable",
    async (method) => {
      const { token } = await openBill();
      const codes = async () =>
        (await getPaymentLinkView(fx.context, token)).methods.map(
          (entry) => entry.method,
        );
      expect(await codes()).toContain(method);
      gw.listed.delete(method);
      expect(await codes()).not.toContain(method);
      gw.reset();
      await setRule(method, false);
      expect(await codes()).not.toContain(method);
      await setRule(method, true);
      gw.failMethods = true;
      expect(await codes()).not.toContain(method);
    },
  );
});

describe("e-wallet and card on a link", () => {
  it.each([
    ["ewallet", "OV"],
    ["card", null],
  ] as const)(
    "%s: issues the bill amount and a lapsed code is refreshed",
    async (method, channelCode) => {
      const { token } = await openBill();
      const intent = await pay(token, method, channelCode);
      expect(intent).toMatchObject({ method, amountIdr: 100_000 });
      const later = new Date(Date.parse(intent.expiresAt) + 1_000);
      const fresh = await refreshIntent(fx.context, token, intent.id, later);
      expect(fresh.id).not.toBe(intent.id);
      expect(fresh).toMatchObject({ method, amountIdr: 100_000 });
    },
  );

  it("e-wallet then QRIS, both paid: the bill is paid once, the other is parked", async () => {
    const { token, linkId } = await openBill();
    const wallet = await pay(token, "ewallet", "OV");
    const qris = await pay(token, "qris", null);
    const settle = async (id: string, method: "qris" | "ewallet") => {
      const row = await owner.query<{ provider_ref: string }>(
        "SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND id = $2",
        [fx.tenant.tenantId, id],
      );
      await confirmPayment(
        fx.context,
        id,
        {
          source: "verified_webhook",
          method,
          amountIdr: 100_000,
          providerRef: row.rows[0]!.provider_ref,
          at: new Date().toISOString(),
        } as Parameters<typeof confirmPayment>[2],
        { type: "system" },
      ).catch(() => undefined);
    };
    await settle(qris.id, "qris");
    await settle(wallet.id, "ewallet");
    await settle(wallet.id, "ewallet");
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, linkId],
    );
    expect(rows[0]!.paid).toBe(100_000);
    expect(
      (await unallocatedFunds(fx, wallet.id)).map((fund) => fund.amountIdr),
    ).toEqual([100_000]);
  });
});

describe("reservation DP port (finding 5)", () => {
  const port = createPaymentReservationDepositPort();
  const open = (amountIdr = 50_000) =>
    port.openDeposit({
      context: fx.context,
      outletId: fx.tenant.outletId,
      reservationId: randomUUID(),
      amountIdr,
      expiresInMinutes: 30,
      now: new Date(),
    } as Parameters<typeof port.openDeposit>[0]);

  it("is ready while QRIS is routed on and listed", async () => {
    await port.assertReady(fx.context, fx.tenant.outletId);
    expect((await open()).paymentPath).toMatch(/^\/bayar\//);
  });

  it.each([
    ["QRIS is locked", () => void gw.listed.delete("qris")],
    ["every method is locked", () => gw.listed.clear()],
    ["the method list cannot be read", () => void (gw.failMethods = true)],
    ["QRIS routing is off", () => setRule("qris", false)],
  ])("refuses when %s", async (_name, arrange) => {
    await arrange();
    await expect(
      port.assertReady(fx.context, fx.tenant.outletId),
    ).rejects.toThrow();
    await expect(open()).rejects.toThrow();
  });

  it("refuses to open a DP above what QRIS takes", async () => {
    gw.maxQrisIdr = 40_000;
    await expect(open(50_000)).rejects.toThrow();
    expect((await open(40_000)).paymentPath).toMatch(/^\/bayar\//);
  });
});

describe("a refused method voids no live code (finding 7)", () => {
  async function guestVa() {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const va = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "BC",
      idempotencyKey: randomUUID(),
    });
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    const toQris = () =>
      fx.guestPost(guest, "/payments", {
        target: { kind: "order", orderId: order.id },
        method: "qris",
        idempotencyKey: randomUUID(),
      });
    return { vaId: va.body.data.id as string, toQris };
  }

  it("QR guest: VA to a QRIS the gateway does not list keeps the VA", async () => {
    const { vaId, toQris } = await guestVa();
    gw.listed.delete("qris");
    const refused = await toQris();
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    await expectStillLive(vaId);
    expect(gw.created).toHaveLength(1);
  });

  it("QR guest: VA to a QRIS routed off keeps the VA", async () => {
    const { vaId, toQris } = await guestVa();
    await setRule("qris", false);
    const refused = await toQris();
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    await expectStillLive(vaId);
  });

  it("QR guest: VA to a listed QRIS still voids the VA and issues", async () => {
    const { vaId, toQris } = await guestVa();
    const swapped = await toQris();
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(await releaseCount(vaId)).toBe(1);
  });

  it.each([
    ["ewallet", "OV"],
    ["card", null],
    ["qris", null],
  ] as const)(
    "public link: VA to an unlisted %s keeps the VA",
    async (method, channelCode) => {
      const order = await newSubmittedOrder(fx, 0);
      const { token } = await bindLinkToOrder(fx, order);
      const post = (body: Record<string, unknown>) =>
        agent(fx.app)
          .post(`/api/payments/links/${token}/intents`)
          .send({ ...body, idempotencyKey: randomUUID() });
      const va = await post({ method: "va", channelCode: "BC" });
      expect(va.status, JSON.stringify(va.body)).toBe(201);
      gw.listed.delete(method);
      const refused = await post({ method, channelCode });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      await expectStillLive(va.body.data.id as string);
      expect(gw.created).toHaveLength(1);
    },
  );
});

describe("return URL", () => {
  it("is the same for every Duitku payment and carries no token", async () => {
    const bodies: Record<string, unknown>[] = [];
    const port = createDuitkuGateway({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const list = String(url).endsWith("getpaymentmethod");
        if (!list) bodies.push(body);
        return new Response(
          JSON.stringify(
            list
              ? {
                  responseCode: "00",
                  paymentFee: [
                    { paymentMethod: "OV", paymentName: "OVO", totalFee: "0" },
                  ],
                }
              : {
                  statusCode: "00",
                  reference: "REF-1",
                  paymentUrl: "https://passport.duitku.com/pay/REF-1",
                  amount: String(body.paymentAmount),
                },
          ),
          { status: 200 },
        );
      }) as typeof fetch,
      callbackBaseUrl: "https://api.example.test",
      returnUrl: "https://app.example.test/bayar/kembali",
      loadCredentials: async () => ({
        integration: {
          id: randomUUID(),
          outletId: null,
          config: {
            environment: "production",
            notificationEmail: "owner@example.test",
          },
        },
        credentials: { merchantCode: "DS1234", apiKey: "key" },
      }),
    });
    const saved = env.DUITKU_ENABLED_METHODS;
    env.DUITKU_ENABLED_METHODS = ["ewallet"];
    try {
      for (const amountIdr of [50_000, 75_000])
        await port.createIntent({
          context: fx.context as ScopedTenantContext,
          provider: "duitku",
          intentId: randomUUID(),
          method: "ewallet",
          channelCode: "OV",
          amountIdr,
          idempotencyKey: randomUUID(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
    } finally {
      env.DUITKU_ENABLED_METHODS = saved;
    }
    expect(bodies.map((body) => body.returnUrl)).toEqual([
      "https://app.example.test/bayar/kembali",
      "https://app.example.test/bayar/kembali",
    ]);
  });
});
