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
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PaymentInstructions } from "@starter/shared/payment";
import { env } from "../config/env.ts";
import { resetGatewayHealthCache } from "../services/payment-failover.service.ts";
import { createDuitkuGateway } from "../services/payment-duitku.ts";
import { receiveDuitkuCallback } from "../services/payment-duitku-webhook.service.ts";
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
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service.ts";
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
  va: [
    { code: "BC", name: "BCA Virtual Account" },
    { code: "I1", name: "BNI Virtual Account" },
  ],
  ewallet: [{ code: "OV", name: "OVO" }],
};
const ALL: GatewayPaymentMethod[] = ["qris", "va", "ewallet", "card"];

/** Duitku-like double: `listed` is what `methods()` reports enabled. */
class Gateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  listed = new Set<GatewayPaymentMethod>(ALL);
  maxQrisIdr = Number.POSITIVE_INFINITY;
  failMethods = false;
  down = false;
  /** Channel code -> the largest amount `methods(amount)` still lists it for.
   * `channels()` reads the probe amount, so it ignores this. */
  readonly channelLimits = new Map<string, number>();
  readonly created: GatewayIntentRequest[] = [];
  private sequence = 0;
  reset() {
    this.listed = new Set(ALL);
    this.maxQrisIdr = Number.POSITIVE_INFINITY;
    this.failMethods = false;
    this.down = false;
    this.channelLimits.clear();
    this.created.length = 0;
  }
  async health() {
    return { status: this.down ? ("down" as const) : ("available" as const) };
  }
  async methods(_context?: unknown, _outletId?: string, amountIdr?: number) {
    if (this.failMethods) throw new Error("methods down");
    return (["qris", "va", "bank_transfer", "ewallet", "card"] as const).map(
      (method) => ({
        method,
        enabled:
          this.listed.has(method) &&
          (method !== "qris" || (amountIdr ?? 0) <= this.maxQrisIdr),
        channels: (CHANNELS[method] ?? []).filter(
          (channel) =>
            (amountIdr ?? 0) <=
            (this.channelLimits.get(channel.code) ?? Number.POSITIVE_INFINITY),
        ),
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
const openBill = (totalIdr = 100_000, expiresInMinutes?: number) =>
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
      ...(expiresInMinutes === undefined ? {} : { expiresInMinutes }),
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

/** Failover marks written for this bill's link (one per link and incident). */
async function failoverMarks(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs a
       JOIN payment_intents i ON i.payment_link_id::text = a.event->>'objectId'
      WHERE a.tenant_id = $1 AND i.id = $2
        AND a.event->>'action' = 'payment.link_failover_to_cashier'`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

/** The provider said the code is dead (so the guard lets a new one in) ... */
const markFinal = (intentId: string) =>
  owner.query(
    "UPDATE payment_intents SET status = 'expired', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, intentId],
  );
/** ... then it turns out the code can still be paid (the race both-paid tests
 * need: two collectible codes of one link). */
const revive = (intentId: string) =>
  owner.query(
    "UPDATE payment_intents SET status = 'pending', provider_final_at = NULL WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, intentId],
  );

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
    "%s: issues the bill amount; a lapsed code is refreshed only after the provider says it is final",
    async (method, channelCode) => {
      const { token } = await openBill();
      const intent = await pay(token, method, channelCode);
      expect(intent).toMatchObject({ method, amountIdr: 100_000 });
      const later = new Date(Date.parse(intent.expiresAt) + 1_000);
      // The provider has not said the code is dead: it may still be paid.
      await expect(
        refreshIntent(fx.context, token, intent.id, later),
      ).rejects.toMatchObject({ status: 409, code: "ORDER_CODE_ACTIVE" });
      expect(gw.created).toHaveLength(1);
      await owner.query(
        "UPDATE payment_intents SET status = 'expired', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
        [fx.tenant.tenantId, intent.id],
      );
      const fresh = await refreshIntent(fx.context, token, intent.id, later);
      expect(fresh.id).not.toBe(intent.id);
      expect(fresh).toMatchObject({ method, amountIdr: 100_000 });
    },
  );

  it("QRIS then e-wallet, both paid: the strict settlement refuses the second (the callback parks it, below)", async () => {
    const { token, linkId } = await openBill();
    const qris = await pay(token, "qris", null);
    await markFinal(qris.id);
    const wallet = await pay(token, "ewallet", "OV");
    await revive(qris.id);
    const settle = async (id: string, method: "qris" | "ewallet") => {
      const row = await owner.query<{ provider_ref: string }>(
        "SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND id = $2",
        [fx.tenant.tenantId, id],
      );
      return confirmPayment(
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
        new Date(),
        { closedIntentNeedsOpenBill: true },
      );
    };
    await settle(qris.id, "qris");
    for (let delivery = 0; delivery < 2; delivery += 1)
      await expect(settle(wallet.id, "ewallet")).rejects.toMatchObject({
        decisionCode: "BILL_CLOSED",
      });
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, linkId],
    );
    expect(rows[0]!.paid).toBe(100_000);
  });
});

describe("real Duitku adapter and callback", () => {
  const merchantCode = "DSC2A";
  const apiKey = `key-${randomBytes(12).toString("hex")}`;
  /** merchantOrderId (intent id) -> reference Duitku answered at inquiry. */
  const references = new Map<string, string>();
  const duitku = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      merchantOrderId: string;
      paymentAmount: number;
    };
    const path = String(url);
    let answer: Record<string, unknown>;
    if (path.endsWith("getpaymentmethod"))
      answer = {
        responseCode: "00",
        paymentFee: ["SP", "OV"].map((paymentMethod) => ({
          paymentMethod,
          paymentName: paymentMethod,
          totalFee: "0",
        })),
      };
    else if (path.endsWith("inquiry")) {
      const reference = `REF-${randomUUID()}`;
      references.set(body.merchantOrderId, reference);
      answer = {
        statusCode: "00",
        reference,
        paymentUrl: `https://sandbox.duitku.com/pay/${reference}`,
        qrString: "00020101021226C2A",
        amount: String(body.paymentAmount),
      };
    } else
      answer = {
        merchantOrderId: body.merchantOrderId,
        statusCode: "00",
        reference: references.get(body.merchantOrderId),
        amount: "100000",
      };
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as typeof fetch;

  const paidCallback = (intentId: string, now?: Date) =>
    receiveDuitkuCallback({
      ...(now ? { now } : {}),
      tenantId: fx.tenant.tenantId,
      rawBody: Buffer.from(
        new URLSearchParams({
          merchantCode,
          amount: "100000",
          merchantOrderId: intentId,
          resultCode: "00",
          reference: references.get(intentId)!,
          signature: createHmac("sha256", apiKey)
            .update(`${merchantCode}100000${intentId}`)
            .digest("hex"),
        }).toString(),
      ),
      fetch: duitku,
    });

  beforeAll(async () => {
    await owner.query(
      `UPDATE tenants SET feature_flags = jsonb_set(feature_flags, '{integrationProviders}',
         COALESCE(feature_flags->'integrationProviders', '[]'::jsonb) || '"duitku"'::jsonb)
        WHERE id = $1`,
      [fx.tenant.tenantId],
    );
    const scope = establishScopedTenantContext(
      establishTenantContext({
        tenantId: fx.tenant.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const created = await upsertIntegration(
      scope,
      {
        outletId: null,
        provider: "duitku",
        config: {
          environment: "sandbox",
          notificationEmail: "owner@example.test",
        },
        credentials: { merchantCode, apiKey },
      },
      randomUUID(),
    );
    await setIntegrationStatus(
      scope,
      created.id,
      { status: "active" },
      randomUUID(),
    );
  });
  beforeEach(() =>
    setPaymentGateway(
      createDuitkuGateway({
        fetch: duitku,
        callbackBaseUrl: "https://api.example.test",
        returnUrl: "https://app.example.test/bayar/kembali",
      }),
    ),
  );
  afterAll(() => setPaymentGateway(gw));

  it.each([
    ["the new e-wallet first", ["ewallet", "qris"]],
    ["the replaced QRIS first", ["qris", "ewallet"]],
  ] as const)(
    "both codes paid, %s: the bill is paid once, the second payment is parked",
    async (_name, order) => {
      const { token, linkId } = await openBill();
      const qrisId = (await pay(token, "qris", null)).id;
      await markFinal(qrisId);
      const ids = {
        qris: qrisId,
        ewallet: (await pay(token, "ewallet", "OV")).id,
      };
      await revive(qrisId);
      // A repeat of a delivery, a minute later, changes nothing.
      const retry = new Date(Date.now() + 61_000);
      for (const method of order) await paidCallback(ids[method]);
      for (const method of order) await paidCallback(ids[method], retry);
      const { rows } = await owner.query<{ paid: number }>(
        "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id = $1 AND id = $2",
        [fx.tenant.tenantId, linkId],
      );
      expect(rows[0]!.paid).toBe(100_000);
      expect((await intentRow(fx.tenant.tenantId, ids[order[0]])).status).toBe(
        "paid",
      );
      expect(await unallocatedFunds(fx, ids[order[0]])).toEqual([]);
      expect(
        (await unallocatedFunds(fx, ids[order[1]])).map((f) => f.amountIdr),
      ).toEqual([100_000]);
    },
  );
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
    const toVa = (bankCode: string) =>
      fx.guestPost(guest, "/payments", {
        target: { kind: "order", orderId: order.id },
        method: "va",
        bankCode,
        idempotencyKey: randomUUID(),
      });
    return {
      vaId: va.body.data.id as string,
      toQris,
      toVa,
    };
  }

  async function linkVa() {
    const order = await newSubmittedOrder(fx, 0);
    const { token } = await bindLinkToOrder(fx, order);
    const post = (method: string, channelCode: string | null) =>
      agent(fx.app)
        .post(`/api/payments/links/${token}/intents`)
        .send({ method, channelCode, idempotencyKey: randomUUID() });
    const va = await post("va", "BC");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    return { vaId: va.body.data.id as string, post };
  }

  it("QR guest: a bank listed at the probe amount but not at the bill amount keeps the old VA", async () => {
    const { vaId, toVa } = await guestVa();
    gw.channelLimits.set("I1", 10_000);
    const refused = await toVa("I1");
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    await expectStillLive(vaId);
    expect(gw.created).toHaveLength(1);
  });

  it("public link: a bank listed at the probe amount but not at the bill amount keeps the old VA", async () => {
    const { vaId, post } = await linkVa();
    gw.channelLimits.set("I1", 10_000);
    const refused = await post("va", "I1");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    await expectStillLive(vaId);
    expect(gw.created).toHaveLength(1);
  });

  it.each([
    ["QRIS is unlisted", () => void gw.listed.delete("qris")],
    ["the method list cannot be read", () => void (gw.failMethods = true)],
  ])(
    "QR guest: a pending QRIS is shown again while %s",
    async (_n, arrange) => {
      const guest = await fx.newGuest();
      const order = await fx.qrOrder(guest);
      const qris = () =>
        fx.guestPost(guest, "/payments", {
          target: { kind: "order", orderId: order.id },
          method: "qris",
          idempotencyKey: randomUUID(),
        });
      const first = await qris();
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      arrange();
      const again = await qris();
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(gw.created).toHaveLength(1);
    },
  );

  it.each([
    ["the method list cannot be read", () => void (gw.failMethods = true), 503],
    // The link keeps the real refusal: the old code is still live (409).
    ["the gateway is down", () => void (gw.down = true), 409],
  ])(
    "a swap keeps the VA while %s (QR guest 503)",
    async (_n, arrange, linkStatus) => {
      const guest = await guestVa();
      const link = await linkVa();
      arrange();
      const swapped = await guest.toQris();
      expect(swapped.status, JSON.stringify(swapped.body)).toBe(503);
      expect(JSON.stringify(swapped.body)).not.toMatch(/kasir/i);
      const refused = await link.post("qris", null);
      expect(refused.status, JSON.stringify(refused.body)).toBe(linkStatus);
      if (linkStatus === 409)
        expect(refused.body.error.code).toBe("ORDER_CODE_ACTIVE");
      await expectStillLive(guest.vaId);
      await expectStillLive(link.vaId);
    },
  );

  it("QR guest: a 503 because the gateway is down records the incident on the bill", async () => {
    const { vaId, toQris } = await guestVa();
    resetGatewayHealthCache();
    expect(await failoverMarks(vaId)).toBe(0);
    gw.down = true;
    const swapped = await toQris();
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(503);
    expect(await failoverMarks(vaId)).toBe(1);
    await expectStillLive(vaId);
  });

  it("QR guest: the same pending VA is returned while the list cannot be read", async () => {
    const { vaId, toVa } = await guestVa();
    gw.failMethods = true;
    const again = await toVa("BC");
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.id).toBe(vaId);
    expect(gw.created).toHaveLength(1);
  });

  it.each([
    ["ewallet", "OV"],
    ["card", undefined],
  ] as const)(
    "QR guest: %s answers 503, not 400, while the list cannot be read; the pending one is still returned",
    async (method, bankCode) => {
      const guest = await fx.newGuest();
      const order = await fx.qrOrder(guest);
      const post = () =>
        fx.guestPost(guest, "/payments", {
          target: { kind: "order", orderId: order.id },
          method,
          ...(bankCode ? { bankCode } : {}),
          idempotencyKey: randomUUID(),
        });
      gw.failMethods = true;
      const refused = await post();
      expect(refused.status, JSON.stringify(refused.body)).toBe(503);
      gw.failMethods = false;
      const first = await post();
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      gw.failMethods = true;
      const again = await post();
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(gw.created).toHaveLength(1);
    },
  );

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

describe("a link with no order takes one live code (legend-osqou.41)", () => {
  it.each([
    ["qris", null, "va", "BC"],
    ["qris", null, "ewallet", "OV"],
    ["qris", null, "qris", null],
    ["va", "BC", "qris", null],
    ["va", "BC", "va", "I1"],
    ["va", "BC", "ewallet", "OV"],
    ["va", "BC", "card", null],
    ["ewallet", "OV", "card", null],
    ["card", null, "va", "BC"],
    ["ewallet", "OV", "qris", null],
  ] as const)(
    "%s live, then %s: 409 and nothing is issued",
    async (first, firstChannel, next, nextChannel) => {
      const { token } = await openBill();
      const live = await pay(token, first, firstChannel);
      await expect(pay(token, next, nextChannel)).rejects.toMatchObject({
        status: 409,
        code: "ORDER_CODE_ACTIVE",
      });
      expect(gw.created).toHaveLength(1);
      await expectStillLive(live.id);
    },
  );

  it("a live VA answers 409 while the gateway list cannot be read (never 503)", async () => {
    const { token } = await openBill();
    const live = await pay(token, "va", "BC");
    gw.failMethods = true;
    // The public route passes the guest swap, which reads the gateway first for
    // a link with an order; a link with no order must not.
    const refused = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: randomUUID(),
      });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("ORDER_CODE_ACTIVE");
    await expectStillLive(live.id);
  });

  it("a VA past its time that the provider has not finalised still blocks", async () => {
    const { token } = await openBill();
    const va = await pay(token, "va", "BC");
    await owner.query(
      "UPDATE payment_intents SET expires_at = now() - interval '1 hour' WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, va.id],
    );
    await expect(pay(token, "qris", null)).rejects.toMatchObject({
      status: 409,
    });
    expect(gw.created).toHaveLength(1);
    await markFinal(va.id);
    await expect(pay(token, "qris", null)).resolves.toMatchObject({
      method: "qris",
    });
  });

  it("two VAs in parallel with different keys: one stored, one 409, the loser kept as an orphan", async () => {
    const { token, linkId } = await openBill();
    const results = await Promise.allSettled([
      pay(token, "va", "BC"),
      pay(token, "va", "I1"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect(lost?.reason).toMatchObject({
      status: 409,
      code: "ORDER_CODE_ACTIVE",
    });
    // Both codes exist at the provider: the loser stays as a known orphan.
    expect(gw.created).toHaveLength(2);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2 ORDER BY created_at",
      [fx.tenant.tenantId, linkId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
  });
});

describe("VA lifetime follows the link (legend-osqou.41)", () => {
  const minutes = (intent: { expiresAt: string }) =>
    (Date.parse(intent.expiresAt) - Date.now()) / 60_000;

  it.each([
    ["a link of 60 minutes: the VA ends with the link", 60, 59, 60],
    ["a link of 3 minutes: the VA keeps 10 minutes", 3, 9, 10],
    ["a long link: the method default of 180 minutes", 600, 179, 180],
  ])("%s", async (_name, linkMinutes, low, high) => {
    const { token } = await openBill(100_000, linkMinutes);
    const va = await pay(token, "va", "BC");
    expect(minutes(va)).toBeGreaterThan(low);
    expect(minutes(va)).toBeLessThanOrEqual(high);
    expect(Date.parse(gw.created[0]!.expiresAt)).toBe(Date.parse(va.expiresAt));
  });

  it.each([
    ["ewallet", "OV"],
    ["card", null],
  ] as const)("%s is never shortened by a short link", async (method, ch) => {
    const { token } = await openBill(100_000, 5);
    const intent = await pay(token, method, ch);
    expect(minutes(intent)).toBeGreaterThan(29);
  });
});

describe("return URL", () => {
  it("is the same for every Duitku payment and carries no token; the expiry is rounded down", async () => {
    const base = new Date();
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
      now: () => base,
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
          // 10 minutes and 59 seconds: Duitku must not keep it past that.
          expiresAt: new Date(base.getTime() + 659_000).toISOString(),
        });
    } finally {
      env.DUITKU_ENABLED_METHODS = saved;
    }
    expect(bodies.map((body) => body.expiryPeriod)).toEqual([10, 10]);
    expect(bodies.map((body) => body.returnUrl)).toEqual([
      "https://app.example.test/bayar/kembali",
      "https://app.example.test/bayar/kembali",
    ]);
  });
});
