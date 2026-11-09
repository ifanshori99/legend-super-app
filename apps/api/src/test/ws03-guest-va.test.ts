// WS-03 P4 (legend-3160, VA only; CTO decision 9 Nov): a QR guest pays a
// pay-first order by QRIS or by a virtual account of a bank the gateway
// lists. The VA goes through the same WS-05 link and intent path as QRIS, so
// switching bank supersedes the pending code and the verified `payment.paid`
// fires the order through the same consumer (`handleQrOrderPaymentPaid`).
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS, in a fresh
// isolated tenant; the gateway is a test double behind the port.

import { randomBytes, randomUUID } from "node:crypto";
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
import type {
  PaymentChannel,
  PaymentInstructions,
} from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type OnlinePaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
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
/** DOIT VA bank codes (m1 payment-doit-wire.ts DOIT_VA_BANKS subset). */
const BANKS: PaymentChannel[] = [
  { code: "bmri", name: "Mandiri" },
  { code: "bnia", name: "CIMB Niaga" },
];

/** Gateway double offering QRIS and VA; records each create request. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly requests: GatewayIntentRequest[] = [];
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.requests.push(input);
    const n = this.requests.length;
    const bank = BANKS.find((entry) => entry.code === input.channelCode);
    const instructions: PaymentInstructions =
      input.method === "va" && bank
        ? {
            method: "va",
            channelCode: bank.code,
            channelName: bank.name,
            virtualAccountNumber: `8808${String(n).padStart(8, "0")}`,
          }
        : { method: "qris", qrPayload: "00020101021226FAKEVA", issuer: null };
    return {
      providerRef: `VA-${randomBytes(6).toString("hex")}-${n}`,
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
  async channels(_context: ScopedTenantContext, method: OnlinePaymentMethod) {
    return method === "va" ? [...BANKS] : [];
  }
}
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
    options: () => auth(client.get(`${base}/payment-options`)),
    pay: (
      orderId: string,
      method: "qris" | "va",
      bankCode?: string,
      idempotencyKey: string = randomUUID(),
    ) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method,
        ...(bankCode === undefined ? {} : { bankCode }),
        idempotencyKey,
      }),
    payment: (paymentId: string) =>
      auth(client.get(`${base}/payments/${paymentId}`)),
    view: () => auth(client.get(base)),
    bill: () => auth(client.get(`${base}/bill`)),
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

async function totalIdrOf(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ total_idr: string }>(
    "SELECT total_idr::text AS total_idr FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]!.total_idr);
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    method: string;
    channel_code: string | null;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT status, method, channel_code, expires_at, created_at
     FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, intentId],
  );
  return rows[0]!;
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

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`qva-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR VA Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-QVA', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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

describe("QR guest virtual account (legend-3160)", () => {
  it("lists QRIS and VA with the gateway's banks", async () => {
    const guest = await seatAtNewTable();
    const options = await as(guest).options();
    expect(options.status).toBe(200);
    expect(options.body.data.methods).toEqual([
      { method: "qris", enabled: true, unavailableReason: null, banks: [] },
      { method: "va", enabled: true, unavailableReason: null, banks: BANKS },
    ]);
  });

  it("opens a VA for a listed bank at the order total and refuses others", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    expect(totalIdr).toBe(await totalIdrOf(orderId));

    const unlisted = await as(guest).pay(orderId, "va", "bca");
    expect(unlisted.status).toBeGreaterThanOrEqual(400);
    expect(unlisted.body.error.code).toBe("VALIDATION_ERROR");
    const noBank = await as(guest).pay(orderId, "va");
    expect(noBank.body.error.code).toBe("VALIDATION_ERROR");
    const qrisWithBank = await as(guest).pay(orderId, "qris", "bmri");
    expect(qrisWithBank.body.error.code).toBe("VALIDATION_ERROR");
    const ewallet = await agent(app)
      .post(`/api/table-sessions/${guest.sessionId}/payments`)
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader)
      .send({
        target: { kind: "order", orderId },
        method: "ewallet",
        idempotencyKey: randomUUID(),
      });
    expect(ewallet.body.error.code).toBe("VALIDATION_ERROR");

    const before = gateway.requests.length;
    const opened = await as(guest).pay(orderId, "va", "bmri");
    expect(opened.status).toBe(201);
    expect(opened.body.data).toMatchObject({
      target: { kind: "order", orderId },
      method: "va",
      amountIdr: totalIdr,
      status: "pending",
      qrisPayload: null,
      redirectUrl: null,
      bankCode: "bmri",
      bankName: "Mandiri",
      paidAt: null,
    });
    expect(opened.body.data.vaNumber).toMatch(/^\d{8,20}$/);
    expect(gateway.requests.length).toBe(before + 1);
    expect(gateway.requests.at(-1)).toMatchObject({
      method: "va",
      channelCode: "bmri",
      amountIdr: totalIdr,
    });
    // VA default lifetime: 180 minutes from creation.
    const row = await intentRow(opened.body.data.id);
    expect(row).toMatchObject({ method: "va", channel_code: "bmri" });
    const lifetimeMin =
      (row.expires_at.getTime() - row.created_at.getTime()) / 60_000;
    expect(lifetimeMin).toBeGreaterThan(179);
    expect(lifetimeMin).toBeLessThanOrEqual(181);

    const polled = await as(guest).payment(opened.body.data.id);
    expect(polled.status).toBe(200);
    expect(polled.body.data).toMatchObject({
      id: opened.body.data.id,
      method: "va",
      vaNumber: opened.body.data.vaNumber,
      bankCode: "bmri",
    });
  });

  it("is idempotent per order, method and bank; another bank supersedes", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest);
    const key = randomUUID();
    const first = await as(guest).pay(orderId, "va", "bmri", key);
    expect(first.status).toBe(201);
    const created = gateway.requests.length;

    // Retry with the same key, and a second payer with a fresh key.
    const retry = await as(guest).pay(orderId, "va", "bmri", key);
    expect(retry.body.data.id).toBe(first.body.data.id);
    const again = await as(guest).pay(orderId, "va", "bmri");
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.vaNumber).toBe(first.body.data.vaNumber);
    expect(gateway.requests.length).toBe(created);

    // Another bank opens a new VA and supersedes the first one.
    const switched = await as(guest).pay(orderId, "va", "bnia");
    expect(switched.status).toBe(201);
    expect(switched.body.data.id).not.toBe(first.body.data.id);
    expect(switched.body.data).toMatchObject({
      method: "va",
      bankCode: "bnia",
      bankName: "CIMB Niaga",
    });
    expect((await intentRow(first.body.data.id)).status).toBe("expired");
    const superseded = await outboxEvents(
      "payment.expired",
      first.body.data.id,
    );
    expect(superseded.map((event) => event.payload.reason)).toEqual([
      "superseded",
    ]);

    // Back to QRIS supersedes the VA the same way.
    const qris = await as(guest).pay(orderId, "qris");
    expect(qris.status).toBe(201);
    expect(qris.body.data).toMatchObject({
      method: "qris",
      vaNumber: null,
      bankCode: null,
      bankName: null,
    });
    expect((await intentRow(switched.body.data.id)).status).toBe("expired");
  });

  it("a verified VA payment fires the order and settles the floor bill", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const opened = await as(guest).pay(orderId, "va", "bmri");
    expect(opened.status).toBe(201);
    const intentId = opened.body.data.id as string;

    const context = contextOf(tenant.tenantId);
    await confirmPayment(context, intentId, {
      source: "verified_webhook",
      method: "va",
      amountIdr: totalIdr,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    });
    const [paid] = await outboxEvents("payment.paid", intentId);
    expect(paid).toBeDefined();
    await withTenant(db, context, (tx) =>
      deliverOrderPaymentEvent(context, paid!, tx, new Date()),
    );

    const view = await as(guest).view();
    expect(view.body.data.orders[0].status).toBe("sent");
    const status = await as(guest).payment(intentId);
    expect(status.body.data).toMatchObject({ status: "paid", method: "va" });
    expect(status.body.data.paidAt).not.toBeNull();
    const bill = await as(guest).bill();
    expect(bill.body.data.totals).toMatchObject({
      totalIdr,
      paidIdr: totalIdr,
      outstandingIdr: 0,
    });

    // A paid order answers the paid intent, whatever the guest picks next.
    const later = await as(guest).pay(orderId, "va", "bnia");
    expect(later.status).toBeGreaterThanOrEqual(400);
  });

  it("another session's order answers 404", async () => {
    const first = await seatAtNewTable();
    const { orderId } = await placeOrder(first);
    const stranger = await seatAtNewTable();
    const response = await as(stranger).pay(orderId, "va", "bmri");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
