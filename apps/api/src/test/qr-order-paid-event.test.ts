// legend-9pz9 (G1): a QR pay-first order emits exactly one `order.paid` when
// its money is verified and the order fires (docs/design/auto-journals.md).
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant (same setup as qr-order-late-payment.test.ts). The QR
// consumer is delivered the `payment.paid` event as the worker does.
//
// Assumptions (the design fixes the contract):
// - The `order.paid` aggregate is the order; it is found in the outbox by the
//   payload `orderId` (a ULID string).
// - A QR sale is the `orders` row (channel qr, pay_first, fired_at set,
//   payment_intent_id pinned to the intent that paid) with no pos_orders row;
//   the payload carries the split of that row, one gateway tender of the
//   amount due (method = the intent's method, qris or va), and no cash, EDC,
//   points, shift, cashier or device. paidAt is the instant of fired_at.
// - A guest pays by QRIS or VA only (GUEST_PAYMENT_METHODS); both map to a
//   valid POS tender method.
// - A superseded code is an intent that expired before a fresh code was opened;
//   a late verified settlement of the old code still fires the order and the
//   old intent is the one pinned.

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
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
import {
  orderPaidPayloadSchema,
  posTenderMethodSchema,
} from "@starter/shared/pos";
import { GUEST_PAYMENT_METHODS } from "@starter/shared/qr-order";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { orders } from "../db/schema/qr-order.ts";
import {
  fireQrOrder,
  qrOrderSettlementLookup,
} from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
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
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

/** QRIS + VA gateway double. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions =
      input.method === "va"
        ? {
            method: "va",
            channelCode: VA_BANK.code,
            channelName: VA_BANK.name,
            virtualAccountNumber: "8808123456789012",
          }
        : {
            method: "qris",
            qrPayload: "00020101021226FAKEQRPAID",
            issuer: null,
          };
    return {
      providerRef: `QPD-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
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
  async channels() {
    return [VA_BANK];
  }
}
const VA_BANK = { code: "BCA", name: "BCA Virtual Account" };
const gateway = new FakeGateway();

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
    pay: (orderId: string, method: "qris" | "va" = "qris") =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method,
        ...(method === "va" ? { bankCode: VA_BANK.code } : {}),
        idempotencyKey: randomUUID(),
      }),
  };
}

async function placeOrder(guest: Guest) {
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status).toBe(201);
  expect(placed.body.data.order.status).toBe("awaiting_payment");
  return {
    orderId: placed.body.data.order.id as string,
    totalIdr: placed.body.data.order.totalIdr as number,
  };
}

async function openPayment(
  guest: Guest,
  orderId: string,
  method: "qris" | "va" = "qris",
): Promise<string> {
  const paid = await as(guest).pay(orderId, method);
  expect(paid.status).toBe(201);
  expect(paid.body.data.status).toBe("pending");
  return paid.body.data.id as string;
}

/** A verified webhook settlement (the trusted source). */
async function settle(
  intentId: string,
  amountIdr: number,
  providerRef: string,
  method: "qris" | "va" = "qris",
) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method,
    amountIdr,
    providerRef,
    at: new Date().toISOString(),
  });
}

async function outboxEvents(
  name: string,
  intentId: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'intentId' = $3
     ORDER BY created_at, id`,
    [tenant.tenantId, name, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function onlyEvent(name: string, intentId: string) {
  const events = await outboxEvents(name, intentId);
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

type OrderRowSnapshot = {
  status: string;
  channel: string;
  payment_mode: string;
  payment_intent_id: string | null;
  payment_link_id: string | null;
  fired_at: Date | null;
  subtotal_idr: string;
  discount_idr: string;
  service_charge_idr: string;
  tax_idr: string;
  rounding_idr: string;
  total_idr: string;
  deposit_applied_idr: string;
  prices_include_tax: boolean;
};

async function orderRow(orderId: string): Promise<OrderRowSnapshot> {
  const { rows } = await owner.query<OrderRowSnapshot>(
    `SELECT status, channel, payment_mode, payment_intent_id, payment_link_id, fired_at,
            subtotal_idr::text, discount_idr::text, service_charge_idr::text, tax_idr::text,
            rounding_idr::text, total_idr::text, deposit_applied_idr::text, prices_include_tax
       FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

async function posOrderRowCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]!.n);
}

/** Every `order.paid` of the order, as the outbox holds them. */
async function orderPaidEvents(orderId: string): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
        AND event->'payload'->>'orderId' = $2
      ORDER BY created_at, id`,
    [tenant.tenantId, orderId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

/** Guest pays `method`, the verified settlement arrives and the QR consumer fires the order. */
async function payAndFire(method: "qris" | "va") {
  const guest = await seatAtNewTable();
  const { orderId, totalIdr } = await placeOrder(guest);
  const intentId = await openPayment(guest, orderId, method);
  expect(await orderPaidEvents(orderId)).toHaveLength(0);
  await settle(
    intentId,
    totalIdr,
    `WEBHOOK-${randomBytes(6).toString("hex")}`,
    method,
  );
  const paid = await onlyEvent("payment.paid", intentId);
  await deliver(paid);
  return { guest, orderId, totalIdr, intentId, paid };
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`qlp-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Late Payment Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
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
       VALUES ($1, $2, NULL, 'PBJT-QLP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  // Audit rows are append-only, so the isolated tenant stays; give it a
  // valid creator so the platform tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("QR pay-first sale emits order.paid (legend-9pz9)", () => {
  for (const method of GUEST_PAYMENT_METHODS) {
    it(`QR-PAID-01 (${method}) a verified payment fires the order and emits one order.paid with the order's split and one ${method} gateway tender`, async () => {
      const { orderId, totalIdr, intentId } = await payAndFire(method);

      const order = await orderRow(orderId);
      expect(order).toMatchObject({
        status: "sent",
        channel: "qr",
        payment_mode: "pay_first",
        payment_intent_id: intentId,
      });
      expect(order.fired_at).not.toBeNull();
      // A QR sale has no pos_orders row: WS-07 books it from the orders row.
      expect(await posOrderRowCount(orderId)).toBe(0);

      const events = await orderPaidEvents(orderId);
      expect(events).toHaveLength(1);
      const payload = orderPaidPayloadSchema.parse(events[0]!.payload);
      expect(payload).toMatchObject({
        orderId,
        channel: "qr",
        grossSalesIdr: Number(order.subtotal_idr),
        discountIdr: Number(order.discount_idr),
        serviceChargeIdr: Number(order.service_charge_idr),
        pbjtIdr: Number(order.tax_idr),
        roundingIdr: Number(order.rounding_idr),
        totalIdr,
        paidCashIdr: 0,
        paidGatewayIdr: totalIdr,
        paidEdcIdr: 0,
        paidPointsIdr: 0,
        paidDepositIdr: 0,
        shiftId: null,
        cashierId: null,
        deviceId: null,
      });
      expect(payload.tenders).toHaveLength(1);
      expect(payload.tenders[0]).toEqual({ method, amountIdr: totalIdr });
      expect(
        posTenderMethodSchema.safeParse(payload.tenders[0]!.method).success,
      ).toBe(true);
      // The sale instant is the instant the order fired.
      expect(new Date(payload.paidAt).getTime()).toBe(
        order.fired_at!.getTime(),
      );
    });
  }

  it("QR-PAID-02 a replayed or concurrent delivery of the same payment fires and emits once", async () => {
    const { orderId, paid } = await payAndFire("qris");
    const firedAt = (await orderRow(orderId)).fired_at!.getTime();

    await deliver(paid);
    await Promise.all([deliver(paid), deliver(paid)]);

    expect(await orderPaidEvents(orderId)).toHaveLength(1);
    expect((await orderRow(orderId)).fired_at!.getTime()).toBe(firedAt);
  });

  it("QR-PAID-03 a superseded payment code that pays pins the paying intent, not the current one", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    // The old code is a VA: a QR old code would hold the bill and refuse the
    // fresh code until the provider proves it dead (legend-kf104). It lapsed
    // past the late-payment grace, so a replacement is allowed.
    const oldIntent = await openPayment(guest, orderId, "va");
    // The first code lapses; the guest opens a fresh one.
    await owner.query(
      `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, oldIntent],
    );
    const newIntent = await openPayment(guest, orderId);
    expect(newIntent).not.toBe(oldIntent);

    // The guest still pays the old code: a verified late settlement.
    await settle(
      oldIntent,
      totalIdr,
      `WEBHOOK-${randomBytes(6).toString("hex")}`,
      "va",
    );
    await deliver(await onlyEvent("payment.paid", oldIntent));

    expect(await orderRow(orderId)).toMatchObject({
      status: "sent",
      payment_intent_id: oldIntent,
    });
    const events = await orderPaidEvents(orderId);
    expect(events).toHaveLength(1);
    expect(orderPaidPayloadSchema.parse(events[0]!.payload)).toMatchObject({
      paidGatewayIdr: totalIdr,
      totalIdr,
    });
  });

  it("QR-PAID-04 an order that is still awaiting payment has emitted no order.paid", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest);
    await openPayment(guest, orderId);

    expect(await orderPaidEvents(orderId)).toHaveLength(0);
    expect((await orderRow(orderId)).fired_at).toBeNull();
  });

  it("QR-PAID-05 firing an order that is already sent throws and leaves one order.paid", async () => {
    const { orderId } = await payAndFire("qris");
    const firedAt = (await orderRow(orderId)).fired_at!.getTime();
    const context = contextOf(tenant.tenantId);

    await expect(
      withTenant(db, context, async (tx) => {
        const [row] = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, context.tenant.tenantId),
              eq(orders.id, orderId),
            ),
          );
        return fireQrOrder(tx, context, row!, {
          now: new Date(),
          reason: "verified_payment",
        });
      }),
    ).rejects.toThrow("Order is not awaiting payment; not fired again");

    expect(await orderPaidEvents(orderId)).toHaveLength(1);
    expect((await orderRow(orderId)).fired_at!.getTime()).toBe(firedAt);
  });
});
