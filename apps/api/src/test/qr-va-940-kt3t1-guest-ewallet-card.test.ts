// legend-kt3t1 (brief kt3t1, founder Q15): a QR guest can also pay with an
// e-wallet (Duitku OVO, DANA, ...) or a card, next to QRIS and VA. These
// methods hand the guest a hosted payment page (a redirect URL), not a code.
//
// Written from brief-kt3t1.md, the shared payment contract
// (paymentMethodSchema: "ewallet" | "card"; guestPaymentSchema already has
// `redirectUrl`; Duitku channel codes OV/DA/VC as in the adapter test double
// data) and the 9vmit tests, not from the implementation. Every case goes
// through HTTP (guest table-session payments + payment-options); the only
// internals touched are confirmPayment / pollPendingGatewayIntents (the same
// entry points the 9vmit late-payment test uses for a provider callback and
// the poller) and SQL reads.
//
// Rules under test (money, founder Q15)
// - Only the methods the tenant's gateway reports ENABLED from methods() are
//   offered by payment-options and accepted by createIntent. Not enabled, or a
//   channel the gateway does not list: refused, no provider request, no intent.
// - One live intent per bill. A swap between VA / e-wallet / card voids the old
//   code through the 9vmit path (release row kind guest_method_change, old
//   intent `expired`), then issues the new one. No second path.
// - Money that still lands on a voided code is parked (unallocated funds),
//   never pays the bill. A callback + a poll arriving together pay the bill
//   once.
// - The amount is the server's bill amount; the guest cannot change it.
// - A guest cannot open an intent for a bill of another session or tenant.
//
// Assumptions (also in the report)
// - Wire shape: method "ewallet" | "card" in the guest body; the e-wallet
//   channel travels in the existing `bankCode` field ("OV", "DA"); a card takes
//   no channel (field omitted). An e-wallet without a channel is refused.
// - Response: the existing guestPayment shape with method ewallet/card,
//   `redirectUrl` = the provider's pay URL, qrisPayload / vaNumber / bankCode
//   null. (bankCode may carry the e-wallet channel; only vaNumber and
//   qrisPayload being null are pinned.) The DTO PaymentInstructions redirect
//   variant is exercised only through the double (redirectUrl on the
//   instructions), the HTTP answer is what is asserted.
// - Refusals (method off, unknown channel, no channel, foreign bill) are any
//   4xx that is not a created intent; the exact code is not pinned. A foreign
//   bill is 4xx and creates no intent in either tenant.
// - Tampered amount: the body field `amountIdr` is either refused (4xx, no
//   intent) or ignored (201 with the bill amount). Never a different amount.
// - QRIS -> e-wallet/card stays refused 409 (a guest never voids a QRIS hold,
//   9vmit); "when in doubt, refuse".
// - Same e-wallet + same channel again (new key) returns the pending intent
//   (same rule as VA on the guest session path).
// - A pending code answered "pending" by the provider's status read is what
//   lets a swap void the old code (9vmit pre-void read).
// - e-wallet / card disabled: payment-options either leaves the method out or
//   lists it with enabled=false; both count as "not offered".
// - Provider cancel of an e-wallet / card code is not asserted (not every
//   provider can cancel a hosted page).
// - Review fixes F1/F2/F4a (fixes-kt3t1.md): a code that is not `pending`
//   (voided, expired, paid) never exposes its pay link: GET
//   /table-sessions/:id/payments/:paymentId answers 200 with the intent and
//   `redirectUrl: null`; a replay of its old idempotency key either is refused
//   (4xx) or also carries null, and the pay URL appears nowhere in the body.
//   The gateway is asked methods(context, outletId, amountIdr) with the
//   server-read bill amount BEFORE any old code is voided; a method over its
//   limit is refused 4xx and the old code stays live, untouched. issue_charge
//   payments take qris|va only: ewallet/card are 422 at validation.
// - Paid e-wallet / card booking: the verified settlement books the QR order
//   like QRIS/VA; the order.paid payload carries one gateway tender whose
//   method is the intent's method ("ewallet" / "card"), both valid POS tender
//   methods (posTenderMethodSchema).
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-940-kt3t1-guest-ewallet-card.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import {
  orderPaidPayloadSchema,
  posTenderMethodSchema,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { agent, originHeader } from "./helpers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { intentCount, intentRow } from "./qr-va-912-3p1-helpers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  confirmPayment,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import {
  holdFixture,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type Offered = {
  method: GatewayPaymentMethod;
  enabled: boolean;
  channels: { code: string; name: string }[];
};

const ALL_ON = (): Offered[] => [
  { method: "qris", enabled: true, channels: [] },
  {
    method: "va",
    enabled: true,
    channels: [
      { code: "BC", name: "BCA Virtual Account" },
      { code: "I1", name: "BNI Virtual Account" },
    ],
  },
  { method: "bank_transfer", enabled: false, channels: [] },
  {
    method: "ewallet",
    enabled: true,
    channels: [
      { code: "OV", name: "OVO" },
      { code: "DA", name: "DANA" },
    ],
  },
  {
    method: "card",
    enabled: true,
    channels: [{ code: "VC", name: "Credit Card" }],
  },
];

/** Duitku-like double: reports methods() from a table the test edits. */
class DuitkuLikeGateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  offered: Offered[] = ALL_ON();
  readonly created: { providerRef: string; request: GatewayIntentRequest }[] =
    [];
  /** providerRef -> "paid" answer (amount) for the poller. */
  private readonly paid = new Map<string, number>();
  /** Per-method top limit: methods(amount) reports the method NOT enabled above it. */
  private readonly limits = new Map<GatewayPaymentMethod, number>();
  /** The amount each methods() call was asked for (undefined = none given). */
  readonly methodAmounts: (number | undefined)[] = [];
  private sequence = 0;
  reset() {
    this.offered = ALL_ON();
    this.created.length = 0;
    this.paid.clear();
    this.limits.clear();
    this.methodAmounts.length = 0;
  }
  setLimit(method: GatewayPaymentMethod, maxAmountIdr: number) {
    this.limits.set(method, maxAmountIdr);
  }
  setEnabled(method: GatewayPaymentMethod, enabled: boolean) {
    this.offered = this.offered.map((entry) =>
      entry.method === method ? { ...entry, enabled } : entry,
    );
  }
  markPaid(providerRef: string, amountIdr: number) {
    this.paid.set(providerRef, amountIdr);
  }
  async health() {
    return { status: "available" as const };
  }
  // Third argument (legend-kt3t1 F2): the real bill amount. Without it the
  // full table is returned (payment-options probe, as the adapter does).
  async methods(_context?: unknown, _outletId?: string, amountIdr?: number) {
    this.methodAmounts.push(amountIdr);
    if (amountIdr === undefined) return this.offered;
    return this.offered.map((entry) => {
      const limit = this.limits.get(entry.method);
      return limit !== undefined && amountIdr > limit
        ? { ...entry, enabled: false }
        : entry;
    });
  }
  async channels(_context: unknown, method?: GatewayPaymentMethod) {
    const entry = this.offered.find(
      (candidate) => candidate.method === method && candidate.enabled,
    );
    return entry ? entry.channels : [];
  }
  async createIntent(input: GatewayIntentRequest) {
    this.sequence += 1;
    const n = String(this.sequence).padStart(8, "0");
    const providerRef = `KT3-${randomUUID()}`;
    this.created.push({ providerRef, request: input });
    const channels =
      this.offered.find((entry) => entry.method === input.method)?.channels ??
      [];
    const channel = channels.find((c) => c.code === input.channelCode);
    let instructions: unknown;
    if (input.method === "va")
      instructions = {
        method: "va",
        channelCode: input.channelCode ?? "BC",
        channelName: channel?.name ?? "BCA Virtual Account",
        virtualAccountNumber: `8808${n}`,
      };
    else if (input.method === "ewallet" || input.method === "card")
      // Redirect variant of PaymentInstructions (brief item 3).
      instructions = {
        method: input.method,
        channelCode: input.channelCode ?? "VC",
        channelName: channel?.name ?? "Credit Card",
        paymentUrl: `https://pay.example.test/${providerRef}`,
      };
    else
      instructions = {
        method: "qris",
        qrPayload: `00020101021226KT3${n}`,
        issuer: null,
      };
    return {
      providerRef,
      instructions: instructions as PaymentInstructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    const amount = this.paid.get(input.providerRef);
    return amount === undefined
      ? {
          status: "pending" as const,
          providerRef: input.providerRef,
          amountIdr: null,
        }
      : {
          status: "paid" as const,
          providerRef: input.providerRef,
          amountIdr: amount,
        };
  }
}

let fx: HoldFixture;
let other: HoldFixture; // a second, isolated tenant
const gw = new DuitkuLikeGateway();

beforeAll(async () => {
  other = await holdFixture("qr-va-940-kt3t1-other");
  fx = await holdFixture("qr-va-940-kt3t1");
  // E-wallet and card have no PRD default route (fail closed): a tenant must
  // switch them on. Seed that tenant-wide rule for both isolated tenants.
  for (const tenantId of [fx.tenant.tenantId, other.tenant.tenantId]) {
    for (const method of ["ewallet", "card"]) {
      await owner.query(
        `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
         VALUES ($1, NULL, $2, 'duitku', NULL, true, 'system:test')
         ON CONFLICT DO NOTHING`,
        [tenantId, method],
      );
    }
  }
  setPaymentGateway(gw); // after both fixtures: each installs its own gateway
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

// ------------------------------------------------------------------- helpers

const payOrder = (
  guest: Guest,
  orderId: string,
  method: "qris" | "va" | "ewallet" | "card",
  channel?: string,
  idempotencyKey: string = randomUUID(),
  extra: Record<string, unknown> = {},
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(channel === undefined ? {} : { bankCode: channel }),
    idempotencyKey,
    ...extra,
  });

const options = (guest: Guest) =>
  agent(fx.app)
    .get(`/api/table-sessions/${guest.sessionId}/payment-options`)
    .set(fx.headers)
    .set(originHeader)
    .set("Authorization", `Bearer ${guest.token}`);

const readPayment = (guest: Guest, paymentId: string) =>
  agent(fx.app)
    .get(`/api/table-sessions/${guest.sessionId}/payments/${paymentId}`)
    .set(fx.headers)
    .set(originHeader)
    .set("Authorization", `Bearer ${guest.token}`);

async function wholeOrder() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  return { guest, order };
}

async function linkIdOf(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ payment_link_id: string }>(
    "SELECT payment_link_id::text AS payment_link_id FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, intentId],
  );
  expect(rows, "setup: the intent exists").toHaveLength(1);
  return rows[0]!.payment_link_id;
}

async function pendingOn(linkId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id::text AS id FROM payment_intents
      WHERE tenant_id = $1 AND payment_link_id = $2 AND status = 'pending'
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, linkId],
  );
  return rows.map((row) => row.id);
}

async function releaseRows(intentId: string) {
  const { rows } = await owner.query<{
    kind: string;
    status: string;
    approved_by: string | null;
    override_id: string | null;
  }>(
    `SELECT kind, status, approved_by, override_id FROM payment_va_releases
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows;
}

/** The old code is voided by the guest through the 9vmit path. */
async function expectVoided(intentId: string) {
  const rows = await releaseRows(intentId);
  expect(rows, "one void row for the old code").toHaveLength(1);
  expect(rows[0]!.kind).toBe("guest_method_change");
  expect(rows[0]!.status).toBe("open");
  expect(rows[0]!.approved_by, "no staff approval").toBeNull();
  expect(rows[0]!.override_id, "no supervisor override").toBeNull();
  expect((await intentRow(fx.tenant.tenantId, intentId)).status).toBe(
    "expired",
  );
}

async function link(linkId: string) {
  const { rows } = await owner.query<{ paid: number; total: number }>(
    "SELECT paid_idr::int AS paid, total_idr::int AS total FROM payment_links WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, linkId],
  );
  return rows[0]!;
}

async function intentMeta(intentId: string) {
  const { rows } = await owner.query<{
    method: string;
    channel_code: string | null;
    amount: number;
    provider_ref: string;
  }>(
    `SELECT method, channel_code, amount_idr::int AS amount, provider_ref
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

/** A verified provider callback "paid". Refusals on a dead code are swallowed:
 * the caller asserts the effect (as in the 9vmit late-payment test). */
async function callback(
  intentId: string,
  method: string,
  providerRef: string,
  amountIdr: number,
) {
  try {
    await confirmPayment(
      fx.context,
      intentId,
      {
        source: "verified_webhook",
        method,
        amountIdr,
        providerRef,
        at: new Date().toISOString(),
      } as Parameters<typeof confirmPayment>[2],
      { type: "system" },
      new Date(),
    );
  } catch {
    /* refused on a voided code: parked, asserted by the caller */
  }
}

/** A refused request created nothing, at the provider or in the database. */
async function expectNothingCreated(
  response: { status: number; body: unknown },
  intentsBefore: number,
  providerBefore: number,
) {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
    400,
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
  expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
    intentsBefore,
  );
  expect(gw.created.length, "no request to the provider").toBe(providerBefore);
}

// -------------------------------------------------------------- payment-options

describe("legend-kt3t1 payment-options reads the tenant's gateway", () => {
  it("legend-kt3t1 e-wallet and card the gateway reports enabled are offered, with their channels; QRIS and VA stay", async () => {
    gw.reset();
    const { guest } = await wholeOrder();

    const res = await options(guest);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const offered = res.body.data.methods as {
      method: string;
      enabled: boolean;
      unavailableReason: string | null;
      banks: { code: string; name: string }[];
    }[];
    const by = (method: string) => offered.find((m) => m.method === method);
    expect(by("qris")?.enabled).toBe(true);
    expect(by("va")?.enabled).toBe(true);
    expect(by("ewallet")?.enabled, JSON.stringify(offered)).toBe(true);
    expect(
      by("ewallet")
        ?.banks.map((c) => c.code)
        .sort(),
    ).toEqual(["DA", "OV"]);
    expect(by("card")?.enabled, JSON.stringify(offered)).toBe(true);
    // bank_transfer is off at the gateway and is not a guest-session method.
    expect(by("bank_transfer")?.enabled ?? false).toBe(false);
  });

  it("legend-kt3t1 e-wallet and card the gateway reports NOT enabled are not offered", async () => {
    gw.reset();
    gw.setEnabled("ewallet", false);
    gw.setEnabled("card", false);
    const { guest } = await wholeOrder();

    const res = await options(guest);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const offered = res.body.data.methods as {
      method: string;
      enabled: boolean;
    }[];
    for (const method of ["ewallet", "card"])
      expect(
        offered.find((m) => m.method === method)?.enabled ?? false,
        `${method} not offered`,
      ).toBe(false);
    expect(offered.find((m) => m.method === "qris")?.enabled).toBe(true);
    expect(offered.find((m) => m.method === "va")?.enabled).toBe(true);
  });

  it("legend-kt3t1 one method off does not switch off the other: only card disabled, e-wallet stays offered", async () => {
    gw.reset();
    gw.setEnabled("card", false);
    const { guest } = await wholeOrder();

    const res = await options(guest);

    const offered = res.body.data.methods as {
      method: string;
      enabled: boolean;
    }[];
    expect(offered.find((m) => m.method === "ewallet")?.enabled).toBe(true);
    expect(offered.find((m) => m.method === "card")?.enabled ?? false).toBe(
      false,
    );
  });
});

// ------------------------------------------------------------ createIntent

describe("legend-kt3t1 createIntent: e-wallet and card give a redirect", () => {
  it("legend-kt3t1 e-wallet OVO: 201, redirect URL of the provider, no QR and no VA number, amount = the order total, provider asked for method ewallet / channel OV", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();

    const res = await payOrder(guest, order.id, "ewallet", "OV");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      target: { kind: "order", orderId: order.id },
      method: "ewallet",
      status: "pending",
      amountIdr: order.totalIdr,
      qrisPayload: null,
      vaNumber: null,
    });
    expect(gw.created, "one request to the provider").toHaveLength(1);
    const asked = gw.created[0]!;
    expect(asked.request.method).toBe("ewallet");
    expect(asked.request.channelCode).toBe("OV");
    expect(asked.request.amountIdr).toBe(order.totalIdr);
    expect(res.body.data.redirectUrl).toBe(
      `https://pay.example.test/${asked.providerRef}`,
    );
    const meta = await intentMeta(res.body.data.id);
    expect(meta.method).toBe("ewallet");
    expect(meta.channel_code).toBe("OV");
    expect(meta.amount).toBe(order.totalIdr);
  });

  it("legend-kt3t1 card: 201, redirect URL, amount = the order total, provider asked for method card", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();

    const res = await payOrder(guest, order.id, "card");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      method: "card",
      status: "pending",
      amountIdr: order.totalIdr,
      qrisPayload: null,
      vaNumber: null,
    });
    expect(gw.created[0]!.request.method).toBe("card");
    expect(gw.created[0]!.request.amountIdr).toBe(order.totalIdr);
    expect(res.body.data.redirectUrl).toBe(
      `https://pay.example.test/${gw.created[0]!.providerRef}`,
    );
  });

  it("legend-kt3t1 the same key twice returns the same e-wallet intent: one provider request, one intent", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const key = randomUUID();
    const first = await payOrder(guest, order.id, "ewallet", "OV", key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const intents = await intentCount(fx.tenant.tenantId);

    const again = await payOrder(guest, order.id, "ewallet", "OV", key);

    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.redirectUrl).toBe(first.body.data.redirectUrl);
    expect(gw.created, "no second provider request").toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
  });

  it("legend-kt3t1 the same e-wallet and channel with a new key returns the pending intent: no second code, no void", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "ewallet", "OV");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const id = first.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);

    const again = await payOrder(guest, order.id, "ewallet", "OV");

    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data.id).toBe(id);
    expect(gw.created, "no second provider request").toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(await releaseRows(id)).toHaveLength(0);
    expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("pending");
  });
});

// ------------------------------------------------ method not active is refused

describe("legend-kt3t1 a method the gateway does not report enabled is refused", () => {
  it("legend-kt3t1 e-wallet disabled at the gateway: refused (4xx), no provider request, no intent", async () => {
    gw.reset();
    gw.setEnabled("ewallet", false);
    const { guest, order } = await wholeOrder();
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(guest, order.id, "ewallet", "OV");

    await expectNothingCreated(res, intents, asked);
  });

  it("legend-kt3t1 card disabled at the gateway: refused (4xx), no provider request, no intent", async () => {
    gw.reset();
    gw.setEnabled("card", false);
    const { guest, order } = await wholeOrder();
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(guest, order.id, "card");

    await expectNothingCreated(res, intents, asked);
  });

  it("legend-kt3t1 an e-wallet channel the gateway does not list (XX): refused, no intent", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(guest, order.id, "ewallet", "XX");

    await expectNothingCreated(res, intents, asked);
  });

  it("legend-kt3t1 an e-wallet without a channel: refused, no intent (the guest must say which wallet)", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(guest, order.id, "ewallet");

    await expectNothingCreated(res, intents, asked);
  });

  it("legend-kt3t1 a disabled method does not block the ones that are on: card off, e-wallet still 201", async () => {
    gw.reset();
    gw.setEnabled("card", false);
    const { guest, order } = await wholeOrder();

    const res = await payOrder(guest, order.id, "ewallet", "DA");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.method).toBe("ewallet");
  });
});

// ------------------------------------------------------- one live intent: swaps

describe("legend-kt3t1 changing method: the old code is voided first (9vmit path), one live intent", () => {
  it("legend-kt3t1 VA -> e-wallet: 201 with a redirect, the VA is voided, exactly one live intent, bill amount unchanged", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const va = await payOrder(guest, order.id, "va", "BC");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    const oldId = va.body.data.id as string;
    const linkId = await linkIdOf(oldId);

    const swapped = await payOrder(guest, order.id, "ewallet", "OV");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    expect(newId).not.toBe(oldId);
    expect(swapped.body.data).toMatchObject({
      method: "ewallet",
      amountIdr: order.totalIdr,
    });
    expect(typeof swapped.body.data.redirectUrl).toBe("string");
    await expectVoided(oldId);
    expect(await releaseRows(newId), "the new code is not voided").toHaveLength(
      0,
    );
    expect(await pendingOn(linkId), "exactly one live intent").toEqual([newId]);
  });

  it("legend-kt3t1 e-wallet -> VA: the e-wallet intent is voided, exactly one live intent", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const wallet = await payOrder(guest, order.id, "ewallet", "OV");
    expect(wallet.status, JSON.stringify(wallet.body)).toBe(201);
    const oldId = wallet.body.data.id as string;
    const linkId = await linkIdOf(oldId);

    const swapped = await payOrder(guest, order.id, "va", "BC");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(swapped.body.data.method).toBe("va");
    expect(swapped.body.data.amountIdr).toBe(order.totalIdr);
    await expectVoided(oldId);
    expect(await pendingOn(linkId)).toEqual([swapped.body.data.id]);
  });

  it("legend-kt3t1 VA -> card, then card -> e-wallet DANA, then e-wallet DANA -> e-wallet OVO: each old code has exactly one void row, the last is the only live one", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const one = await payOrder(guest, order.id, "va", "BC");
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await payOrder(guest, order.id, "card");
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    const three = await payOrder(guest, order.id, "ewallet", "DA");
    expect(three.status, JSON.stringify(three.body)).toBe(201);
    const four = await payOrder(guest, order.id, "ewallet", "OV");
    expect(four.status, JSON.stringify(four.body)).toBe(201);

    const ids = [one, two, three, four].map((r) => r.body.data.id as string);
    expect(new Set(ids).size, "four different intents").toBe(4);
    for (const id of ids.slice(0, 3)) await expectVoided(id);
    expect(await releaseRows(ids[3]!)).toHaveLength(0);
    expect(await pendingOn(await linkIdOf(ids[0]!))).toEqual([ids[3]]);
    for (const response of [one, two, three, four])
      expect(response.body.data.amountIdr).toBe(order.totalIdr);
  });

  it("legend-kt3t1 QRIS -> e-wallet is refused 409 (a guest never voids a QRIS hold): QR stays pending, no new intent, no provider request, no void row", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const qris = await payOrder(guest, order.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
    const qrId = qris.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    for (const refused of [
      await payOrder(guest, order.id, "ewallet", "OV"),
      await payOrder(guest, order.id, "card"),
    ]) {
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      const code = (refused.body as { error?: { code?: string } }).error?.code;
      expect(["QRIS_HOLD_ACTIVE", "ORDER_CODE_ACTIVE"]).toContain(code);
    }
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(gw.created.length, "no provider request").toBe(asked);
    expect((await intentRow(fx.tenant.tenantId, qrId)).status).toBe("pending");
    expect(await releaseRows(qrId)).toHaveLength(0);
  });

  it("legend-kt3t1 two methods asked at the same time (e-wallet and VA, different keys): at most one intent stays live, every other one is voided, nothing is left unexplained", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const seed = await payOrder(guest, order.id, "card");
    expect(seed.status, JSON.stringify(seed.body)).toBe(201);
    const linkId = await linkIdOf(seed.body.data.id as string);

    const results = await Promise.all([
      payOrder(guest, order.id, "ewallet", "OV"),
      payOrder(guest, order.id, "va", "BC"),
    ]);

    for (const res of results)
      expect([201, 409], JSON.stringify(res.body)).toContain(res.status);
    expect(
      results.some((res) => res.status === 201),
      "at least one request wins",
    ).toBe(true);
    const live = await pendingOn(linkId);
    expect(live.length, "exactly one live intent").toBe(1);
    const { rows } = await owner.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM payment_intents
        WHERE tenant_id = $1 AND payment_link_id = $2`,
      [fx.tenant.tenantId, linkId],
    );
    for (const row of rows) {
      if (row.id === live[0]) continue;
      expect(row.status, "a dead intent is expired, never paid").toBe(
        "expired",
      );
      expect(
        (await releaseRows(row.id)).map((r) => r.kind),
        "each dead intent was voided through the guest path",
      ).toEqual(["guest_method_change"]);
    }
  });
});

// ------------------------------------------------------------ late callbacks

describe("legend-kt3t1 money on a voided code never pays the bill", () => {
  it("legend-kt3t1 e-wallet voided by a swap to VA, the e-wallet callback comes late: parked once (also when delivered twice), the bill is not paid by it", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const wallet = await payOrder(guest, order.id, "ewallet", "OV");
    expect(wallet.status, JSON.stringify(wallet.body)).toBe(201);
    const oldId = wallet.body.data.id as string;
    const old = await intentMeta(oldId);
    const linkId = await linkIdOf(oldId);
    const swapped = await payOrder(guest, order.id, "va", "BC");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    await expectVoided(oldId);

    await callback(oldId, "ewallet", old.provider_ref, old.amount);
    await callback(oldId, "ewallet", old.provider_ref, old.amount);

    expect(
      (await unallocatedFunds(fx, oldId)).map((f) => f.amountIdr),
      "parked exactly once",
    ).toEqual([order.totalIdr]);
    expect((await unallocatedFunds(fx, oldId))[0]!.resolution).toBeNull();
    expect((await link(linkId)).paid, "the bill is not paid by it").toBe(0);
    expect(await pendingOn(linkId)).toEqual([swapped.body.data.id]);
  });

  it("legend-kt3t1 old e-wallet money lands, then the new VA is paid: the bill is paid once, the old amount is parked once, booked + parked = received", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const wallet = await payOrder(guest, order.id, "ewallet", "OV");
    const oldId = wallet.body.data.id as string;
    const old = await intentMeta(oldId);
    const linkId = await linkIdOf(oldId);
    const swapped = await payOrder(guest, order.id, "va", "BC");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    const fresh = await intentMeta(newId);

    await callback(oldId, "ewallet", old.provider_ref, old.amount);
    await callback(newId, "va", fresh.provider_ref, fresh.amount);

    const booked = await link(linkId);
    expect(booked.paid, "the bill is paid exactly once").toBe(booked.total);
    expect(booked.total).toBe(order.totalIdr);
    const parked = (await unallocatedFunds(fx, oldId)).reduce(
      (sum, f) => sum + f.amountIdr,
      0,
    );
    expect(parked, "the old money is parked once").toBe(old.amount);
    expect(booked.paid + parked, "booked + parked = received").toBe(
      old.amount + fresh.amount,
    );
    expect(
      await unallocatedFunds(fx, newId),
      "nothing of the new code parked",
    ).toEqual([]);
  });

  it("legend-kt3t1 callback and poller on the same e-wallet intent at the same time: the bill is paid once, nothing parked", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const wallet = await payOrder(guest, order.id, "ewallet", "OV");
    expect(wallet.status, JSON.stringify(wallet.body)).toBe(201);
    const id = wallet.body.data.id as string;
    const meta = await intentMeta(id);
    const linkId = await linkIdOf(id);
    gw.markPaid(meta.provider_ref, meta.amount);

    await Promise.all([
      callback(id, "ewallet", meta.provider_ref, meta.amount),
      pollPendingGatewayIntents(
        fx.context as ScopedTenantContext,
        new Date(),
        200,
      ).catch(() => undefined),
      callback(id, "ewallet", meta.provider_ref, meta.amount),
    ]);

    const booked = await link(linkId);
    expect(booked.paid, "paid once, not twice").toBe(order.totalIdr);
    expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("paid");
    expect(await unallocatedFunds(fx, id), "no double payment parked").toEqual(
      [],
    );
  });
});

// -------------------------------------------------------------------- amount

describe("legend-kt3t1 the guest cannot set the amount", () => {
  it("legend-kt3t1 a body with amountIdr: 1 on e-wallet and card: refused, or ignored; the provider is never asked for another amount", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const intents = await intentCount(fx.tenant.tenantId);

    const wallet = await payOrder(guest, order.id, "ewallet", "OV", undefined, {
      amountIdr: 1,
    });
    const card = await payOrder(guest, order.id, "card", undefined, undefined, {
      amountIdr: 1,
    });

    for (const res of [wallet, card]) {
      if (res.status === 201)
        expect(res.body.data.amountIdr, "the bill amount").toBe(order.totalIdr);
      else {
        expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(
          400,
        );
        expect(res.status).toBeLessThan(500);
      }
    }
    for (const created of gw.created)
      expect(created.request.amountIdr, "server amount to the provider").toBe(
        order.totalIdr,
      );
    expect(
      (await intentCount(fx.tenant.tenantId)) - intents,
      "never more than the one live intent per bill",
    ).toBeLessThanOrEqual(2);
    const linkId = wallet.body.data?.id
      ? await linkIdOf(wallet.body.data.id as string)
      : card.body.data?.id
        ? await linkIdOf(card.body.data.id as string)
        : null;
    if (linkId) expect((await pendingOn(linkId)).length).toBe(1);
  });
});

// ------------------------------------------------------------------ isolation

describe("legend-kt3t1 a guest cannot open an intent for someone else's bill", () => {
  it("legend-kt3t1 another table session of the same tenant: refused, no intent, no provider request", async () => {
    gw.reset();
    const a = await wholeOrder();
    const intruder = await fx.newGuest();
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(intruder, a.order.id, "ewallet", "OV");

    await expectNothingCreated(res, intents, asked);
    expect(res.status, JSON.stringify(res.body)).not.toBe(409);
  });

  it("legend-kt3t1 an order of another tenant (guest of tenant 1, order id of tenant 2): refused, no intent in either tenant, no provider request", async () => {
    gw.reset();
    const foreignGuest = await other.newGuest();
    const foreignOrder = await other.qrOrder(foreignGuest);
    const mine = await fx.newGuest();
    const intents = await intentCount(fx.tenant.tenantId);
    const foreignIntents = await intentCount(other.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(mine, foreignOrder.id, "ewallet", "OV");

    await expectNothingCreated(res, intents, asked);
    expect(await intentCount(other.tenant.tenantId)).toBe(foreignIntents);
  });
});

// ------------------------------------------------- F1: no pay link of a dead code

describe("legend-kt3t1 F1: only a pending e-wallet / card code exposes its pay link", () => {
  it("legend-kt3t1 F1 a pending e-wallet and a pending card intent read back with their pay URL", async () => {
    gw.reset();
    for (const [method, channel] of [
      ["ewallet", "OV"],
      ["card", undefined],
    ] as const) {
      const { guest, order } = await wholeOrder();
      const created = await payOrder(guest, order.id, method, channel);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const url = `https://pay.example.test/${gw.created.at(-1)!.providerRef}`;

      const read = await readPayment(guest, created.body.data.id as string);

      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body.data.status).toBe("pending");
      expect(read.body.data.redirectUrl, `${method} pending carries it`).toBe(
        url,
      );
    }
  });

  it("legend-kt3t1 F1 e-wallet swapped to VA: the old e-wallet intent reads back expired with redirectUrl null, the pay URL appears nowhere", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const wallet = await payOrder(guest, order.id, "ewallet", "OV");
    expect(wallet.status, JSON.stringify(wallet.body)).toBe(201);
    const oldId = wallet.body.data.id as string;
    const url = wallet.body.data.redirectUrl as string;
    const providerRef = gw.created[0]!.providerRef;
    const swapped = await payOrder(guest, order.id, "va", "BC");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    await expectVoided(oldId);

    const read = await readPayment(guest, oldId);

    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.status).not.toBe("pending");
    expect(read.body.data.redirectUrl).toBeNull();
    expect(JSON.stringify(read.body), "no pay URL in the body").not.toContain(
      providerRef,
    );
    expect(JSON.stringify(read.body)).not.toContain(url);
  });

  it("legend-kt3t1 F1 card swapped to e-wallet: the old card intent reads back with redirectUrl null; the new e-wallet one carries its URL", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const card = await payOrder(guest, order.id, "card");
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    const oldId = card.body.data.id as string;
    const swapped = await payOrder(guest, order.id, "ewallet", "DA");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    await expectVoided(oldId);

    const old = await readPayment(guest, oldId);
    const fresh = await readPayment(guest, swapped.body.data.id as string);

    expect(old.status, JSON.stringify(old.body)).toBe(200);
    expect(old.body.data.redirectUrl).toBeNull();
    expect(fresh.body.data.redirectUrl).toBe(swapped.body.data.redirectUrl);
    expect(typeof fresh.body.data.redirectUrl).toBe("string");
  });

  it("legend-kt3t1 F1 replaying the old e-wallet request key after the swap: refused, or the same intent with redirectUrl null; never the pay URL", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const key = randomUUID();
    const wallet = await payOrder(guest, order.id, "ewallet", "OV", key);
    expect(wallet.status, JSON.stringify(wallet.body)).toBe(201);
    const url = wallet.body.data.redirectUrl as string;
    const providerRef = gw.created[0]!.providerRef;
    const swapped = await payOrder(guest, order.id, "va", "BC");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);

    const replay = await payOrder(guest, order.id, "ewallet", "OV", key);

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(500);
    if (replay.status < 300) expect(replay.body.data.redirectUrl).toBeNull();
    expect(JSON.stringify(replay.body)).not.toContain(url);
    expect(JSON.stringify(replay.body)).not.toContain(providerRef);
  });

  it("legend-kt3t1 F1 an e-wallet and a card intent that lapsed (expired by the provider) read back with redirectUrl null", async () => {
    gw.reset();
    for (const [method, channel] of [
      ["ewallet", "OV"],
      ["card", undefined],
    ] as const) {
      const { guest, order } = await wholeOrder();
      const created = await payOrder(guest, order.id, method, channel);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.data.id as string;
      await owner.query(
        `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes',
                provider_final_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [fx.tenant.tenantId, id],
      );

      const read = await readPayment(guest, id);

      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body.data.status).toBe("expired");
      expect(read.body.data.redirectUrl, `${method} expired`).toBeNull();
    }
  });
});

// ------------------------------------- F2: limit checked at the real bill amount

describe("legend-kt3t1 F2: the method must be offered at the real bill amount before any old code is voided", () => {
  it("legend-kt3t1 F2 the gateway is asked methods() with the server's bill amount, never the guest's", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();

    const res = await payOrder(guest, order.id, "ewallet", "OV");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(
      gw.methodAmounts,
      "methods() was asked at the bill amount",
    ).toContain(order.totalIdr);
    expect(gw.methodAmounts, "never at the guest's amount").not.toContain(1);
  });

  it("legend-kt3t1 F2 a bill over the e-wallet limit while a VA is live: refused 4xx, the VA stays pending, no void row, no new intent, no provider request", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const va = await payOrder(guest, order.id, "va", "BC");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    const oldId = va.body.data.id as string;
    const linkId = await linkIdOf(oldId);
    gw.setLimit("ewallet", order.totalIdr - 1);
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(guest, order.id, "ewallet", "OV");

    await expectNothingCreated(res, intents, asked);
    expect(await releaseRows(oldId), "the VA is not voided").toHaveLength(0);
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("pending");
    expect(await pendingOn(linkId), "the VA is still the live code").toEqual([
      oldId,
    ]);
  });

  it("legend-kt3t1 F2 a bill over the card limit while a VA is live: refused 4xx, the VA stays pending, no void row", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const va = await payOrder(guest, order.id, "va", "BC");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    const oldId = va.body.data.id as string;
    gw.setLimit("card", order.totalIdr - 1);
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(guest, order.id, "card");

    await expectNothingCreated(res, intents, asked);
    expect(await releaseRows(oldId)).toHaveLength(0);
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("pending");
  });

  it("legend-kt3t1 F2 a bill over the e-wallet limit with no code yet: refused, nothing created", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    gw.setLimit("ewallet", order.totalIdr - 1);
    const intents = await intentCount(fx.tenant.tenantId);
    const asked = gw.created.length;

    const res = await payOrder(guest, order.id, "ewallet", "DA");

    await expectNothingCreated(res, intents, asked);
  });

  it("legend-kt3t1 F2 a bill exactly at the limit is allowed: the swap goes through and the VA is voided", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const va = await payOrder(guest, order.id, "va", "BC");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    gw.setLimit("ewallet", order.totalIdr);

    const res = await payOrder(guest, order.id, "ewallet", "OV");

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectVoided(va.body.data.id as string);
  });
});

// ---------------------------------------- a paid e-wallet / card books the order

describe("legend-kt3t1 a paid e-wallet / card intent books the order with a gateway tender of that method", () => {
  async function outbox(name: string, key: string, value: string) {
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>$3 = $4
        ORDER BY created_at, id`,
      [fx.tenant.tenantId, name, key, value],
    );
    return rows.map((row) => eventEnvelopeSchema.parse(row.event));
  }

  async function payAndFire(
    method: "ewallet" | "card",
    channel: string | undefined,
  ) {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const created = await payOrder(guest, order.id, method, channel);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const intentId = created.body.data.id as string;
    const meta = await intentMeta(intentId);
    // The verified provider callback, as the worker receives it: not swallowed.
    await confirmPayment(
      fx.context,
      intentId,
      {
        source: "verified_webhook",
        method,
        amountIdr: meta.amount,
        providerRef: meta.provider_ref,
        at: new Date().toISOString(),
      } as Parameters<typeof confirmPayment>[2],
      { type: "system" },
      new Date(),
    );
    const paidEvents: EventEnvelope[] = await outbox(
      "payment.paid",
      "intentId",
      intentId,
    );
    expect(paidEvents, "one payment.paid").toHaveLength(1);
    const context = fx.context as ScopedTenantContext;
    await withTenant(db, context, (tx) =>
      deliverOrderPaymentEvent(context, paidEvents[0]!, tx, new Date()),
    );
    return { guest, order, intentId, meta };
  }

  for (const [method, channel] of [
    ["ewallet", "OV"],
    ["card", undefined],
  ] as const) {
    it(`legend-kt3t1 paid ${method}: the intent is paid, the bill is paid once, the order fires with one ${method} gateway tender, and the pay link is gone`, async () => {
      const { guest, order, intentId, meta } = await payAndFire(
        method,
        channel,
      );

      expect((await intentRow(fx.tenant.tenantId, intentId)).status).toBe(
        "paid",
      );
      const booked = await link(await linkIdOf(intentId));
      expect(booked.paid, "the bill is paid exactly once").toBe(booked.total);
      expect(booked.total).toBe(order.totalIdr);
      const { rows } = await owner.query<{
        status: string;
        payment_intent_id: string | null;
        fired_at: Date | null;
      }>(
        "SELECT status, payment_intent_id::text AS payment_intent_id, fired_at FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
        [fx.tenant.tenantId, ulidToUuid(order.id)],
      );
      expect(rows[0]).toMatchObject({
        status: "sent",
        payment_intent_id: intentId,
      });
      expect(rows[0]!.fired_at).not.toBeNull();

      const events = await outbox("order.paid", "orderId", order.id);
      expect(events, "exactly one order.paid").toHaveLength(1);
      const payload = orderPaidPayloadSchema.parse(events[0]!.payload);
      expect(payload).toMatchObject({
        orderId: order.id,
        channel: "qr",
        totalIdr: order.totalIdr,
        paidCashIdr: 0,
        paidGatewayIdr: order.totalIdr,
        paidEdcIdr: 0,
        paidPointsIdr: 0,
      });
      expect(payload.tenders).toEqual([{ method, amountIdr: meta.amount }]);
      expect(
        posTenderMethodSchema.safeParse(payload.tenders[0]!.method).success,
      ).toBe(true);

      const read = await readPayment(guest, intentId);
      expect(read.body.data.status).toBe("paid");
      expect(
        read.body.data.redirectUrl,
        "a paid code has no pay link",
      ).toBeNull();
    });
  }

  it("legend-kt3t1 a paid e-wallet callback delivered twice books the order once and parks nothing", async () => {
    const { order, intentId, meta } = await payAndFire("ewallet", "OV");

    await callback(intentId, "ewallet", meta.provider_ref, meta.amount);

    expect(await outbox("order.paid", "orderId", order.id)).toHaveLength(1);
    expect((await link(await linkIdOf(intentId))).paid).toBe(order.totalIdr);
    expect(await unallocatedFunds(fx, intentId)).toEqual([]);
  });
});

// --------------------------------------------- F4a: issue_charge is qris | va

describe("legend-kt3t1 F4a: an issue-charge payment takes QRIS or VA only", () => {
  for (const [method, channel] of [
    ["ewallet", "OV"],
    ["card", undefined],
  ] as const) {
    it(`legend-kt3t1 F4a issue-charge payment with method ${method}: 422 validation, no intent, no provider request`, async () => {
      gw.reset();
      const guest = await fx.newGuest();
      const intents = await intentCount(fx.tenant.tenantId);

      const res = await fx.guestPost(
        guest,
        `/issue-charges/${randomUUID()}/payments`,
        {
          method,
          ...(channel === undefined ? {} : { bankCode: channel }),
          idempotencyKey: randomUUID(),
        },
      );

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
      expect(gw.created, "no request to the provider").toHaveLength(0);
    });
  }
});
