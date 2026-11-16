// Order payment consumers (bead legend-x4qy; PRD v1.7 §3 F10 "Mode Bayar",
// §4 Alur A, §3.13 "Siklus Pembayaran" / "QRIS Dinamis"). Acceptance: ORD-02
// (no item reaches the kitchen before a verified payment), plus the bead
// note: an expired code or link never strands an order in awaiting_payment,
// and a void releases the promotion and the daily limit exactly once.
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS, in a fresh
// isolated tenant (same setup as qr-order-api.test.ts). `payment.paid` /
// `payment.expired` are produced by the real WS-05 service and routed by the
// real dispatcher `deliverOrderPaymentEvent`; the gateway and the promo engine
// are test doubles installed through their ports.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  idr,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import type { OrderPromoPort } from "../services/order-promo-port.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  decideUnpaidQrOrder,
  LATE_PAYMENT_GRACE_MS,
  MAX_QR_PAYMENT_ATTEMPTS,
  sweepUnpaidQrOrders,
  UNPAID_ORDER_ABANDON_MS,
  type UnpaidQrOrderState,
} from "../services/qr-order-consumers.ts";
import { getGuestPayment } from "../services/qr-order-payment.ts";
import { setQrOrderPromoPort } from "../services/qr-order-ports.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { runPosQrisHoldCheckJob } from "../worker/pos-qris-hold-check.job.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededTenantId,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  terbatas: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const MINUTE = 60_000;

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  /** DOIT got our `expires_in`: once a code lapses it answers `expired`. */
  lapsed = false;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEORDERPAY",
      issuer: null,
    };
    return {
      providerRef: `OPC-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: this.lapsed ? ("expired" as const) : ("pending" as const),
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

/** Records every redeem/release per order; release answers like the engine. */
function countingPromoPort() {
  const redeemed: string[] = [];
  const released: string[] = [];
  const port: OrderPromoPort = {
    async quote() {
      return {
        result: { evaluations: [], totalDiscountIdr: idr(0) },
        totalDiscountIdr: idr(0),
      };
    },
    async redeem(tx, ctx, input) {
      redeemed.push(input.orderId);
      return port.quote(tx, ctx, input);
    },
    async release(_tx, _ctx, input) {
      const first = !released.includes(input.orderId);
      released.push(input.orderId);
      return { released: first, releasedDiscountIdr: idr(0) };
    },
  };
  return { port, redeemed, released };
}

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

type Guest = { token: string; sessionId: string };

async function seatAtNewTable(): Promise<Guest> {
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const response = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

function as(guest: Guest) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    view: () => auth(client.get(base)),
    add: (menuItemId: string, expectedCartVersion: number) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        menuItemId,
        quantity: 1,
        expectedCartVersion,
      }),
    checkout: (expectedCartVersion: number) =>
      auth(client.post(`${base}/orders`)).send({
        expectedCartVersion,
        idempotencyKey: randomUUID(),
      }),
    pay: (orderId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
  };
}

/** One item in the shared cart, placed as a pay-first order. */
async function placeOrder(guest: Guest, menuItemId = ids.kopi) {
  const added = await as(guest).add(menuItemId, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status).toBe(201);
  expect(placed.body.data.order.status).toBe("awaiting_payment");
  return {
    orderId: placed.body.data.order.id as string,
    totalIdr: placed.body.data.order.totalIdr as number,
  };
}

async function openPayment(guest: Guest, orderId: string): Promise<string> {
  const paid = await as(guest).pay(orderId);
  expect(paid.status).toBe(201);
  expect(paid.body.data.status).toBe("pending");
  return paid.body.data.id as string;
}

async function settle(intentId: string, amountIdr: number) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
}

async function outboxEvents(
  name: string,
  field: string,
  value: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>$3 = $4
     ORDER BY created_at, id`,
    [tenant.tenantId, name, field, value],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function onlyEvent(name: string, field: string, value: string) {
  const events = await outboxEvents(name, field, value);
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(
  event: EventEnvelope,
  now = new Date(),
  context = contextOf(tenant.tenantId),
) {
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, now),
  );
}

async function orderRow(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    void_reason: string | null;
    payment_link_id: string | null;
  }>(
    "SELECT status, void_reason, payment_link_id FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

async function placedStatuses(orderId: string): Promise<unknown[]> {
  return (await outboxEvents("order.placed", "orderId", orderId)).map(
    (event) => event.payload.status,
  );
}

async function usageOf(menuItemId: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT coalesce(sum(quantity), 0)::text AS quantity
     FROM menu_item_daily_usage WHERE tenant_id = $1 AND menu_item_id = $2`,
    [tenant.tenantId, menuItemId],
  );
  return Number(rows[0]?.quantity ?? 0);
}

/** WS-05 marks the code expired when the guest polls after its expiry. */
async function expireCode(guest: Guest, intentId: string, at: Date) {
  fakeGateway.lapsed = true;
  const status = await getGuestPayment(
    contextOf(tenant.tenantId),
    guest.token,
    guest.sessionId,
    intentId,
    at,
  ).finally(() => {
    fakeGateway.lapsed = false;
  });
  expect(status.status).toBe("expired");
  return onlyEvent("payment.expired", "intentId", intentId);
}

const fakeGateway = new FakeGateway();

/**
 * legend-kf104: a guest QR holds its bill until the hold check job has the
 * provider's own proof that the code is dead (answer `expired` at or after the
 * code's expiry + 60 s). A fresh code waits for it, so a test that reaches one
 * first lets the job run, at `now`, with the provider answering `expired`.
 */
async function proveDead(now: Date) {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
  fakeGateway.lapsed = true;
  try {
    await runPosQrisHoldCheckJob(context, now, { force: true });
  } finally {
    fakeGateway.lapsed = false;
  }
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(fakeGateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`opc-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Order Payment Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu"],
      [ids.terbatas, "Kue Terbatas"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, randomUUID()],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [itemId, price] of [
      [ids.kopi, 25_000],
      [ids.terbatas, 12_000],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, itemId, price],
      );
    // One unit of Kue Terbatas per business day (ORD-05 daily limit).
    await client.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', 1, 'available')`,
      [randomUUID(), tenant.tenantId, tenant.outletId, ids.terbatas],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxSettings, tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-OPC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setQrOrderPromoPort(null);
  // Audit rows are append-only, so the isolated tenant stays; give it a
  // valid creator so the platform tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("ORD-02 decideUnpaidQrOrder (legend-x4qy, PRD silent: safest rule)", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");
  const open: UnpaidQrOrderState = {
    sessionActive: true,
    linkExpiresAt: new Date(now.getTime() + 60 * MINUTE),
    linkFullyPaid: false,
    attempts: 1,
    hasOpenIntent: false,
    hasActiveHold: false,
    netCapturedZero: false,
    anyRefundOpen: false,
    windowClosedAt: new Date(now.getTime() - MINUTE),
  };

  it("ORD-02 keeps a payable order for a fresh code while the session is open", () => {
    expect(decideUnpaidQrOrder(open, now)).toEqual({
      action: "keep",
      why: "retry_allowed",
    });
    expect(
      decideUnpaidQrOrder({ ...open, linkFullyPaid: true }, now).action,
    ).toBe("keep");
    expect(
      decideUnpaidQrOrder({ ...open, hasOpenIntent: true }, now).action,
    ).toBe("keep");
  });

  it("SO-879 a fully paid link is voided only when all its money is refunded, no refund is open and every code is dead", () => {
    const later = new Date(now.getTime() + LATE_PAYMENT_GRACE_MS);
    const refunded = {
      ...open,
      linkFullyPaid: true,
      netCapturedZero: true,
    };
    expect(decideUnpaidQrOrder(refunded, later)).toEqual({
      action: "void",
      reason: "payment_refunded_codes_dead",
    });
    // Inside the late grace the gateway has not said the codes are final.
    expect(decideUnpaidQrOrder(refunded, now)).toEqual({
      action: "keep",
      why: "awaiting_grace",
    });
    for (const doubt of [
      { netCapturedZero: false },
      { anyRefundOpen: true },
      { hasOpenIntent: true },
      { hasActiveHold: true },
    ])
      expect(decideUnpaidQrOrder({ ...refunded, ...doubt }, later).action).toBe(
        "keep",
      );
  });

  it("ORD-02 voids after the attempt cap, but only once the late-payment grace passed", () => {
    const capped = { ...open, attempts: MAX_QR_PAYMENT_ATTEMPTS };
    expect(decideUnpaidQrOrder(capped, now)).toEqual({
      action: "keep",
      why: "awaiting_grace",
    });
    // The gateway itself said the code is final: no late payment can follow.
    expect(decideUnpaidQrOrder(capped, now, true)).toEqual({
      action: "void",
      reason: "payment_attempts_exhausted",
    });
    const later = new Date(
      open.windowClosedAt.getTime() + LATE_PAYMENT_GRACE_MS,
    );
    expect(decideUnpaidQrOrder(capped, later)).toEqual({
      action: "void",
      reason: "payment_attempts_exhausted",
    });
  });

  it("ORD-02 voids when the session closed, the link expired or the guests walked away", () => {
    const late = new Date(now.getTime() + LATE_PAYMENT_GRACE_MS);
    expect(
      decideUnpaidQrOrder({ ...open, sessionActive: false }, late),
    ).toEqual({ action: "void", reason: "payment_unpaid_session_closed" });
    expect(
      decideUnpaidQrOrder(
        { ...open, linkExpiresAt: new Date(now.getTime() - MINUTE) },
        late,
      ),
    ).toEqual({ action: "void", reason: "payment_link_expired" });
    const abandoned = new Date(
      open.windowClosedAt.getTime() + UNPAID_ORDER_ABANDON_MS,
    );
    expect(decideUnpaidQrOrder(open, abandoned)).toEqual({
      action: "void",
      reason: "payment_abandoned",
    });
  });
});

describe("ORD-02 payment.paid consumer for QR orders (legend-x4qy)", () => {
  it("ORD-02 a verified payment fires the order once; replaying payment.paid twice changes nothing", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const intentId = await openPayment(guest, orderId);
    expect(await placedStatuses(orderId)).toEqual(["awaiting_payment"]);

    await settle(intentId, totalIdr);
    const event = await onlyEvent("payment.paid", "intentId", intentId);
    expect(await deliver(event)).toEqual({ route: "qr", outcome: "fired" });
    // Replay: in the consumption transaction, then on its own transaction.
    expect(await deliver(event)).toEqual({
      route: "qr",
      outcome: "unchanged",
    });
    expect(
      await deliverOrderPaymentEvent(contextOf(tenant.tenantId), event),
    ).toEqual({ route: "qr", outcome: "unchanged" });

    expect((await orderRow(orderId)).status).toBe("sent");
    expect(await placedStatuses(orderId)).toEqual(["awaiting_payment", "sent"]);
    const view = await as(guest).view();
    expect(
      view.body.data.orders[0].items.every(
        (item: { fireStatus: string }) => item.fireStatus === "fired",
      ),
    ).toBe(true);
  });

  it("ORD-02 a payment whose bill differs from the order quote, or in another currency, fires nothing", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const intentId = await openPayment(guest, orderId);
    await settle(intentId, totalIdr);
    const event = await onlyEvent("payment.paid", "intentId", intentId);

    const foreign = eventEnvelopeSchema.parse({
      ...event,
      payload: { ...event.payload, currency: "USD" },
    });
    expect(await deliver(foreign)).toEqual({
      route: "qr",
      outcome: "currency_mismatch",
    });

    // The order's amount due no longer matches what the link collected.
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE orders SET deposit_applied_idr = 1000 WHERE tenant_id = $1 AND id = $2::uuid",
        [tenant.tenantId, ulidToUuid(orderId)],
      ),
    );
    expect(await deliver(event)).toEqual({
      route: "qr",
      outcome: "amount_mismatch",
    });
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");
    expect(await placedStatuses(orderId)).toEqual(["awaiting_payment"]);

    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE orders SET deposit_applied_idr = 0 WHERE tenant_id = $1 AND id = $2::uuid",
        [tenant.tenantId, ulidToUuid(orderId)],
      ),
    );
    expect(await deliver(event)).toEqual({ route: "qr", outcome: "fired" });
  });

  it("ORD-02 TEN-01 another tenant's context cannot consume or forge this tenant's payment events", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const intentId = await openPayment(guest, orderId);
    await settle(intentId, totalIdr);
    const event = await onlyEvent("payment.paid", "intentId", intentId);
    const seeded = contextOf(seededTenantId);

    // The event belongs to another tenant than the worker's context.
    expect(await deliver(event, new Date(), seeded)).toEqual({
      route: "ignored",
    });
    // Forged as the seeded tenant: RLS hides this tenant's intent and order.
    const forged = eventEnvelopeSchema.parse({
      ...event,
      tenantId: seededTenantId,
      outletId: null,
      name: "payment.expired",
      payloadSchemaRef: "payment.expired.v1",
      payload: { intentId, reason: "timeout" },
    });
    expect(await deliver(forged, new Date(), seeded)).toEqual({
      route: "ignored",
    });
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");

    expect(await deliver(event)).toEqual({ route: "qr", outcome: "fired" });
  });
});

describe("ORD-02 payment.expired / payment.failed for QR orders (legend-x4qy)", () => {
  it("ORD-02 an expired QRIS code keeps the order payable with a fresh code while the session is open", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest);
    const first = await openPayment(guest, orderId);
    const createdAfterFirst = fakeGateway.created;
    const expiredAt = new Date(Date.now() + 11 * MINUTE);
    const expired = await expireCode(guest, first, expiredAt);
    expect(expired.payload.reason).toBe("timeout");

    expect(await deliver(expired, expiredAt)).toEqual({
      route: "qr",
      outcome: "retry_allowed",
    });
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");

    // PRD "QRIS Dinamis": the guest gets a fresh code for the same bill, once
    // the provider has proved the first one dead (legend-kf104). Before that
    // proof the hold refuses it and no second code exists.
    const refused = await as(guest).pay(orderId);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("QRIS_HOLD_ACTIVE");
    expect(fakeGateway.created).toBe(createdAfterFirst);
    await proveDead(new Date(expiredAt.getTime() + MINUTE));
    const second = await openPayment(guest, orderId);
    expect(second).not.toBe(first);
    // The stale expiry is no longer about the live code.
    expect(await deliver(expired, expiredAt)).toEqual({
      route: "qr",
      outcome: "unchanged",
    });
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");
  });

  it("ORD-02 an expired payment link voids the unpaid order; replays release promo and daily limit exactly once", async () => {
    const promo = countingPromoPort();
    setQrOrderPromoPort(promo.port);
    try {
      const guest = await seatAtNewTable();
      const usageBefore = await usageOf(ids.terbatas);
      const { orderId, totalIdr } = await placeOrder(guest, ids.terbatas);
      // The checkout redeems only a positive quoted discount (legend-souz);
      // this port quotes none, so the void's release is what is counted.
      expect(promo.redeemed).toEqual([]);
      expect(await usageOf(ids.terbatas)).toBe(usageBefore + 1);
      const intentId = await openPayment(guest, orderId);

      const expiredAt = new Date(Date.now() + 11 * MINUTE);
      const expired = await expireCode(guest, intentId, expiredAt);
      // The WS-05 bill itself lapsed: no fresh code can be opened any more.
      const { payment_link_id: linkId } = await orderRow(orderId);
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, linkId],
        ),
      );
      const afterGrace = new Date(
        expiredAt.getTime() + LATE_PAYMENT_GRACE_MS + MINUTE,
      );
      // legend-kf104: the QR hold keeps the bill until the provider proves the
      // code dead; only then can the void go through.
      expect(await deliver(expired, afterGrace)).toEqual({
        route: "qr",
        outcome: "unchanged",
      });
      expect((await orderRow(orderId)).status).toBe("awaiting_payment");
      await proveDead(afterGrace);
      expect(await deliver(expired, afterGrace)).toEqual({
        route: "qr",
        outcome: "voided",
      });
      // Replayed twice: one void, one release of each.
      expect(await deliver(expired, afterGrace)).toEqual({
        route: "qr",
        outcome: "unchanged",
      });
      expect(await deliver(expired, afterGrace)).toEqual({
        route: "qr",
        outcome: "unchanged",
      });
      expect(await orderRow(orderId)).toMatchObject({
        status: "voided",
        void_reason: "payment_link_expired",
      });
      expect(promo.released).toEqual([orderId]);
      expect(await usageOf(ids.terbatas)).toBe(usageBefore);
      // The unit is back on sale for the next table.
      const next = await seatAtNewTable();
      expect((await as(next).add(ids.terbatas, 0)).status).toBe(201);

      // A late payment never revives it. legend-kf104: the provider proved the
      // QR dead, so the hold closed the bill and a later settlement is refused
      // at the gateway (BILL_CLOSED, parked as unallocated funds) instead of
      // reaching the order consumer; the replay of `late_payment_on_voided_order`
      // is covered with a VA in qr-order-late-payment.test.ts. Nothing is placed.
      await expect(settle(intentId, totalIdr)).rejects.toMatchObject({
        status: 409,
        decisionCode: "BILL_CLOSED",
      });
      expect(await outboxEvents("payment.paid", "intentId", intentId)).toEqual(
        [],
      );
      // The refused money is parked, not lost: one unresolved fund row of the
      // whole amount waits for a refund decision.
      const { rows: parked } = await owner.query<{
        amount_idr: number;
        resolution: string | null;
      }>(
        `SELECT amount_idr::int AS amount_idr, resolution
           FROM payment_unallocated_funds
          WHERE tenant_id = $1 AND payment_intent_id = $2`,
        [tenant.tenantId, intentId],
      );
      expect(parked).toEqual([{ amount_idr: totalIdr, resolution: null }]);
      expect((await orderRow(orderId)).status).toBe("voided");
      expect(await placedStatuses(orderId)).toEqual(["awaiting_payment"]);
      expect(promo.released).toEqual([orderId]);
      expect(await usageOf(ids.terbatas)).toBe(usageBefore);
    } finally {
      setQrOrderPromoPort(null);
    }
  });

  it("ORD-02 the sweep voids an order the guests abandoned and never releases twice", async () => {
    const promo = countingPromoPort();
    setQrOrderPromoPort(promo.port);
    try {
      const guest = await seatAtNewTable();
      const { orderId } = await placeOrder(guest);
      const context = contextOf(tenant.tenantId);

      await sweepUnpaidQrOrders(context, new Date(Date.now() + 5 * MINUTE));
      expect((await orderRow(orderId)).status).toBe("awaiting_payment");

      const abandoned = new Date(Date.now() + UNPAID_ORDER_ABANDON_MS + MINUTE);
      await sweepUnpaidQrOrders(context, abandoned);
      expect(await orderRow(orderId)).toMatchObject({
        status: "voided",
        void_reason: "payment_abandoned",
      });
      await sweepUnpaidQrOrders(context, abandoned);
      expect(promo.released.filter((id) => id === orderId)).toEqual([orderId]);
    } finally {
      setQrOrderPromoPort(null);
    }
  });
});
