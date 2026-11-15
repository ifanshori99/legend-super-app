// DOIT has no documented cancel call (see payment-supersede-doit.test.ts), so
// a VA the guest abandoned by switching bank stays payable at DOIT for its
// whole 180 minute life. The poll window must cover that life, and a late
// payment on the abandoned VA must cost the outlet nothing: one system refund
// request for the abandoned VA, no second one on replay, and the new VA's
// intent and order are untouched.
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
  type GatewayCancelRequest,
  type GatewayIntentRequest,
  type OnlinePaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  confirmPayment,
  GATEWAY_POLL_WINDOW_MS,
} from "../services/payment.service.ts";
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

/** DOIT VA life: 180 minutes. */
const DOIT_VA_LIFE_MS = 180 * 60_000;

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
  readonly cancelled: GatewayCancelRequest[] = [];
  /** Outlets the guest flow asked channels for (the port takes an outlet). */
  readonly channelOutlets: (string | undefined)[] = [];
  banks: PaymentChannel[] = BANKS;
  /** Set to make the provider report every code expired (early expiry). */
  providerStatus: "pending" | "expired" = "pending";
  async health() {
    return { status: "available" as const };
  }
  async cancel(_context: ScopedTenantContext, intent: GatewayCancelRequest) {
    this.cancelled.push(intent);
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
      status: this.providerStatus,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  // The outlet is recorded, never used: this double has one account.
  async channels(
    _context: ScopedTenantContext,
    method: OnlinePaymentMethod,
    outletId?: string,
  ) {
    this.channelOutlets.push(outletId);
    return method === "va" ? [...this.banks] : [];
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

async function orderStatusOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.status;
}

async function refundsOf(intentId: string) {
  const { rows } = await owner.query<{
    amount_idr: string;
    status: string;
    requested_by: string;
    unallocated_fund_id: string | null;
  }>(
    `SELECT amount_idr::text AS amount_idr, status, requested_by, unallocated_fund_id
     FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

/** Confirms a verified webhook payment and delivers its `payment.paid`. */
async function payAndDeliver(intentId: string, amountIdr: number) {
  const context = contextOf(tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "va",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const [paid] = await outboxEvents("payment.paid", intentId);
  expect(paid).toBeDefined();
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, paid!, tx, new Date()),
  );
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

describe("GATEWAY_POLL_WINDOW_MS covers the DOIT VA life", () => {
  it("is at least 180 minutes", () => {
    expect(GATEWAY_POLL_WINDOW_MS).toBeGreaterThanOrEqual(DOIT_VA_LIFE_MS);
  });
});

describe("a VA paid late after the guest switched bank", () => {
  async function switchedBank() {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const first = await as(guest).pay(orderId, "va", "bmri");
    const second = await as(guest).pay(orderId, "va", "bnia");
    expect(second.status).toBe(201);
    const oldId = first.body.data.id as string;
    const newId = second.body.data.id as string;
    // Supersede only expires the old code in our database.
    expect((await intentRow(oldId)).status).toBe("expired");
    expect((await intentRow(newId)).status).toBe("pending");
    return { orderId, totalIdr, oldId, newId };
  }

  it("books one system refund for the old VA; replay adds none; the new intent is untouched", async () => {
    const { orderId, totalIdr, oldId, newId } = await switchedBank();

    // The guest pays the new VA, then the old one DOIT never cancelled.
    expect(await payAndDeliver(newId, totalIdr)).toMatchObject({
      outcome: "fired",
    });
    expect(await payAndDeliver(oldId, totalIdr)).toMatchObject({
      outcome: "double_payment_refund_requested",
    });

    const refunds = await refundsOf(oldId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount_idr: String(totalIdr),
      status: "pending",
      requested_by: "system:qr",
    });
    expect(refunds[0]!.unallocated_fund_id).not.toBeNull();

    // Replays of the old VA's payment (event delivery and confirmation) never
    // add a second refund request.
    const [paid] = await outboxEvents("payment.paid", oldId);
    const context = contextOf(tenant.tenantId);
    for (let i = 0; i < 2; i += 1) {
      expect(
        await withTenant(db, context, (tx) =>
          deliverOrderPaymentEvent(context, paid!, tx, new Date()),
        ),
      ).toMatchObject({ outcome: "unchanged" });
    }
    await confirmPayment(context, oldId, {
      source: "verified_webhook",
      method: "va",
      amountIdr: totalIdr,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    });
    expect(await refundsOf(oldId)).toHaveLength(1);

    // The new intent and the order stay as they were: paid once, no refund.
    expect((await intentRow(newId)).status).toBe("paid");
    expect(await refundsOf(newId)).toEqual([]);
    expect(await orderStatusOf(orderId)).toBe("sent");
  });
});
