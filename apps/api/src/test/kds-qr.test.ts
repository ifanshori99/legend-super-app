// QR orders reach the KDS (bead legend-4d5; PRD v1.7 §3 F9 "Kitchen Display
// System" + F10 QR ordering; KDS-01). An item of a QR order that becomes
// `fired` is routed to its station exactly like a POS fire: one ticket per
// station, an unmapped item gets none, the station feed advances, and a
// second fire never doubles a ticket. Covers the open-bill checkout insert
// path and the pay-first `fireQrOrder` path (verified payment consumer).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in a fresh isolated tenant. Fixtures follow
// qr-order-api.test.ts.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { routeFiredItemsToKitchen } from "../services/kds.service.ts";
import { notifyQrKitchenVoid } from "../services/kds-staff-alerts.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader, setRole, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededOutletA,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };

const ids = {
  category: randomUUID(),
  kopi: randomUUID(), // mapped to the hot kitchen station
  roti: randomUUID(), // mapped to the pastry station
  air: randomUUID(), // no station: not a kitchen item
  salad: randomUUID(), // cold_kitchen type, no such station in the outlet
  hot: randomUUID(),
  pastry: randomUUID(),
  priceList: randomUUID(),
  group: randomUUID(),
  extraShot: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const PRICES = {
  kopi: 25_000,
  roti: 18_000,
  air: 5_000,
  salad: 22_000,
  extraShot: 5_000,
};
/** Full-day window for every weekday: ordering is open whenever tests run. */
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRORDER",
      issuer: null,
    };
    return {
      providerRef: `QRO-${randomBytes(6).toString("hex")}-${this.created}`,
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
    return [];
  }
}
const gateway = new FakeGateway();

/** Owner-side writes set the tenant local, because RLS is FORCED. */
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

async function newTable(paymentMode: "pay_first" | "open_bill" = "pay_first") {
  const zone = await createZone(
    staff.client,
    { paymentMode, serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  return { zone, table, qrToken: qr.token };
}

async function seat(qrToken: string, deviceHash?: string): Promise<Guest> {
  const response = await scan(app, {
    token: qrToken,
    hostname: tenant.hostname,
    deviceHash,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

function as(guest: Guest, host = tenant.hostname) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", host)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    view: () => auth(client.get(base)),
    add: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        ...body,
      }),
    patch: (lineId: string, body: Record<string, unknown>) =>
      auth(client.patch(`${base}/cart/lines/${lineId}`)).send({
        idempotencyKey: randomUUID(),
        ...body,
      }),
    remove: (lineId: string, version: number) =>
      auth(
        client.delete(
          `${base}/cart/lines/${lineId}?expectedCartVersion=${version}`,
        ),
      ),
    quote: (body: Record<string, unknown> = {}) =>
      auth(client.post(`${base}/quote`)).send(body),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
    bill: () => auth(client.get(`${base}/bill`)),
    pay: (orderId: string, key = randomUUID()) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "qris",
        idempotencyKey: key,
      }),
    payment: (paymentId: string) =>
      auth(client.get(`${base}/payments/${paymentId}`)),
  };
}

/** Kopi x2 with an extra shot + Roti x1 + Air x1 (no station). */
async function fillStandardCart(guest: Guest): Promise<number> {
  const first = await as(guest).add({
    menuItemId: ids.kopi,
    quantity: 2,
    modifierIds: [ids.extraShot],
    expectedCartVersion: 0,
  });
  expect(first.status).toBe(201);
  const second = await as(guest).add({
    menuItemId: ids.roti,
    quantity: 1,
    expectedCartVersion: first.body.data.cart.version,
  });
  expect(second.status).toBe(201);
  const third = await as(guest).add({
    menuItemId: ids.air,
    quantity: 1,
    expectedCartVersion: second.body.data.cart.version,
  });
  expect(third.status).toBe(201);
  return third.body.data.cart.version as number;
}

async function outboxRows(name: string, field: string, value: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>$3 = $4
     ORDER BY created_at, id`,
    [tenant.tenantId, name, field, value],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

/** WS-05 settles the intent from verified evidence; the consumer fires. */
async function payVerified(intentId: string, amountIdr: number) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const [event] = await outboxRows("payment.paid", "intentId", intentId);
  expect(event).toBeDefined();
  const context = contextOf(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, event!, event!.id, tx),
  );
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`qkd-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    // The station rows come first: menu_items.station_id references them.
    for (const [id, name, type] of [
      [ids.hot, "Dapur Panas", "hot_kitchen"],
      [ids.pastry, "Pastry", "pastry"],
    ] as const)
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, tenant.outletId, name, type],
      );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR KDS Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name, stationId, stationType] of [
      [ids.kopi, "Kopi Susu", ids.hot, "hot_kitchen"],
      [ids.roti, "Roti Bakar", ids.pastry, "pastry"],
      [ids.air, "Air Mineral", null, null],
      [ids.salad, "Salad Dingin", null, "cold_kitchen"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          randomUUID(),
          stationId,
          stationType,
        ],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [itemId, price] of [
      [ids.kopi, PRICES.kopi],
      [ids.roti, PRICES.roti],
      [ids.air, PRICES.air],
      [ids.salad, PRICES.salad],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, itemId, price],
      );
    await client.query(
      `INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select)
       VALUES ($1, $2, 'Ekstra', 0, 1)`,
      [ids.group, tenant.tenantId],
    );
    await client.query(
      `INSERT INTO modifiers (id, tenant_id, group_id, name, price_idr)
       VALUES ($1, $2, $3, 'Extra shot', $4)`,
      [ids.extraShot, tenant.tenantId, ids.group, PRICES.extraShot],
    );
    await client.query(
      `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [tenant.tenantId, ids.kopi, ids.group],
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
       VALUES ($1, $2, NULL, 'PBJT-QKD', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  // The isolated tenant stays in the disposable test database: its audit
  // rows are append-only, so the tenant cannot be deleted.
  // Give it a valid creator so the platform tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

type Ticket = { id: string; station_id: string };
type TicketItem = { ticket_id: string; order_item_id: string; name: string };

async function ownerRows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query<T>(sql, params);
    return result.rows;
  });
}

async function ticketsOf(orderId: string): Promise<Ticket[]> {
  return ownerRows<Ticket>(
    `SELECT id::text AS id, station_id::text AS station_id FROM kitchen_tickets
     WHERE order_id = $1::uuid ORDER BY station_id`,
    [ulidToUuid(orderId)],
  );
}

async function ticketItemsOf(orderId: string): Promise<TicketItem[]> {
  return ownerRows<TicketItem>(
    `SELECT ticket_id::text AS ticket_id, order_item_id::text AS order_item_id, name
     FROM kitchen_ticket_items WHERE order_id = $1::uuid ORDER BY name`,
    [ulidToUuid(orderId)],
  );
}

async function orderItemIds(orderId: string): Promise<Map<string, string>> {
  const found = await ownerRows<{ id: string; menu_item_id: string }>(
    `SELECT id::text AS id, menu_item_id::text AS menu_item_id FROM order_items
     WHERE order_id = $1::uuid`,
    [ulidToUuid(orderId)],
  );
  return new Map(found.map((row) => [row.menu_item_id, row.id]));
}

async function cursorOf(stationId: string): Promise<number> {
  const [cursor] = await ownerRows<{ last_sequence: number }>(
    `SELECT last_sequence::int AS last_sequence FROM kitchen_station_cursors
     WHERE station_id = $1`,
    [stationId],
  );
  return cursor?.last_sequence ?? 0;
}

/** The fired order produced exactly one ticket per mapped station. */
async function expectRoutedOnce(
  orderId: string,
  cursorsBefore: { hot: number; pastry: number },
) {
  const items = await orderItemIds(orderId);
  const tickets = await ticketsOf(orderId);
  expect(tickets.map((ticket) => ticket.station_id).sort()).toEqual(
    [ids.hot, ids.pastry].sort(),
  );
  const hotTicket = tickets.find((ticket) => ticket.station_id === ids.hot);
  const pastryTicket = tickets.find(
    (ticket) => ticket.station_id === ids.pastry,
  );
  const lines = await ticketItemsOf(orderId);
  // Ticket items match the order items; the unmapped Air has no line.
  expect(lines).toHaveLength(2);
  expect(lines.find((line) => line.name === "Kopi Susu")).toMatchObject({
    ticket_id: hotTicket?.id,
    order_item_id: items.get(ids.kopi),
  });
  expect(lines.find((line) => line.name === "Roti Bakar")).toMatchObject({
    ticket_id: pastryTicket?.id,
    order_item_id: items.get(ids.roti),
  });
  expect(lines.some((line) => line.order_item_id === items.get(ids.air))).toBe(
    false,
  );
  // The station feed moved by this order's ticket.
  expect(await cursorOf(ids.hot)).toBeGreaterThan(cursorsBefore.hot);
  expect(await cursorOf(ids.pastry)).toBeGreaterThan(cursorsBefore.pastry);
}

async function cursors() {
  return { hot: await cursorOf(ids.hot), pastry: await cursorOf(ids.pastry) };
}

/** Routing the same fired lines again is a no-op: no ticket or feed entry. */
async function expectReRouteIsNoop(orderId: string, outletId: string) {
  const before = await cursors();
  const ticketsBefore = await ticketsOf(orderId);
  const itemIds = [...(await orderItemIds(orderId)).values()].map(uuidToUlid);
  const context = contextOf(tenant.tenantId);
  const routed = await withTenant(db, context, (tx) =>
    routeFiredItemsToKitchen(tx, context, {
      outletId,
      orderId,
      itemIds,
      actor: null,
      now: new Date(),
    }),
  );
  expect(routed.ticketIds).toEqual([]);
  expect(await ticketsOf(orderId)).toEqual(ticketsBefore);
  expect(await ticketItemsOf(orderId)).toHaveLength(2);
  expect(await cursors()).toEqual(before);
}

// The outlet has no cold_kitchen station: a QR line of that type must not
// fail the order (the guest may already have paid), it stays unrouted and
// is audited instead (`onUnresolved: "skip"`).
async function fillUnresolvableCart(guest: Guest): Promise<number> {
  const first = await as(guest).add({
    menuItemId: ids.kopi,
    quantity: 1,
    expectedCartVersion: 0,
  });
  expect(first.status).toBe(201);
  const second = await as(guest).add({
    menuItemId: ids.salad,
    quantity: 1,
    expectedCartVersion: first.body.data.cart.version,
  });
  expect(second.status).toBe(201);
  return second.body.data.cart.version as number;
}

describe("QR orders reach the KDS (legend-4d5)", () => {
  it("KDS-01 open bill: items inserted fired are routed to their stations at checkout", async () => {
    const guest = await seat((await newTable("open_bill")).qrToken);
    const version = await fillStandardCart(guest);
    const confirmed = await staff.client
      .post(`/api/table-sessions/${guest.sessionId}/confirm`)
      .set(headers)
      .set(originHeader);
    expect(confirmed.status).toBe(200);

    const before = await cursors();
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.kitchenFire).toBe("fired");
    const orderId = placed.body.data.order.id as string;

    await expectRoutedOnce(orderId, before);
    await expectReRouteIsNoop(orderId, tenant.outletId);
  });

  it("KDS-01 pay-first: nothing is routed while held; the verified payment fires and routes once", async () => {
    const guest = await seat((await newTable()).qrToken);
    const version = await fillStandardCart(guest);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.kitchenFire).toBe("held_for_payment");
    const orderId = placed.body.data.order.id as string;
    // Held items are not kitchen items yet.
    expect(await ticketsOf(orderId)).toEqual([]);

    const paid = await as(guest).pay(orderId);
    expect(paid.status).toBe(201);
    const before = await cursors();
    expect(await ticketsOf(orderId)).toEqual([]);

    expect(await payVerified(paid.body.data.id, paid.body.data.amountIdr)).toBe(
      true,
    );
    await expectRoutedOnce(orderId, before);

    // A replayed payment.paid fires nothing and never doubles a ticket.
    const [event] = await outboxRows(
      "payment.paid",
      "intentId",
      paid.body.data.id,
    );
    const context = contextOf(tenant.tenantId);
    expect(
      await withTenant(db, context, (tx) =>
        deliverQrOrderPaymentEvent(context, event!, event!.id, tx),
      ),
    ).toBe(false);
    expect(await ticketsOf(orderId)).toHaveLength(2);
    expect(await ticketItemsOf(orderId)).toHaveLength(2);
    await expectReRouteIsNoop(orderId, tenant.outletId);
  });

  async function unroutedAudits(orderId: string) {
    return owner.query<{ event: { objectType: string; objectId: string } }>(
      `SELECT event FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = 'kitchen_ticket.unrouted'
         AND event->>'objectId' = ANY($2::text[])`,
      [tenant.tenantId, [orderId, ulidToUuid(orderId)]],
    );
  }

  async function expectOnlyKopiRouted(orderId: string) {
    const items = await orderItemIds(orderId);
    const tickets = await ticketsOf(orderId);
    expect(tickets.map((ticket) => ticket.station_id)).toEqual([ids.hot]);
    const lines = await ticketItemsOf(orderId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ticket_id: tickets[0]?.id,
      order_item_id: items.get(ids.kopi),
    });
    expect(
      lines.some((line) => line.order_item_id === items.get(ids.salad)),
    ).toBe(false);
    const audits = await unroutedAudits(orderId);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.event).toMatchObject({ objectType: "order" });
  }

  it("KDS-01 open bill: a line with no station in the outlet is left unrouted and audited, the order still succeeds", async () => {
    const guest = await seat((await newTable("open_bill")).qrToken);
    const version = await fillUnresolvableCart(guest);
    const confirmed = await staff.client
      .post(`/api/table-sessions/${guest.sessionId}/confirm`)
      .set(headers)
      .set(originHeader);
    expect(confirmed.status).toBe(200);

    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.kitchenFire).toBe("fired");
    await expectOnlyKopiRouted(placed.body.data.order.id as string);
  });

  it("KDS-01 pay-first: a verified payment still fires the order when a line has no station", async () => {
    const guest = await seat((await newTable()).qrToken);
    const version = await fillUnresolvableCart(guest);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.kitchenFire).toBe("held_for_payment");
    const orderId = placed.body.data.order.id as string;

    const paid = await as(guest).pay(orderId);
    expect(paid.status).toBe(201);
    expect(await payVerified(paid.body.data.id, paid.body.data.amountIdr)).toBe(
      true,
    );

    const [order] = await ownerRows<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1::uuid`,
      [ulidToUuid(orderId)],
    );
    expect(order?.status).not.toBe("awaiting_payment");
    const fired = await ownerRows<{ fire_status: string }>(
      `SELECT fire_status FROM order_items WHERE order_id = $1::uuid`,
      [ulidToUuid(orderId)],
    );
    expect(fired).toHaveLength(2);
    expect(fired.every((row) => row.fire_status === "fired")).toBe(true);
    await expectOnlyKopiRouted(orderId);
  });
});

// Staff alerts for QR orders (bead legend-078b): an unrouted line and a KDS
// void reach staff through the existing notification tables, once per event.
describe("KDS staff alerts for QR orders (legend-078b)", () => {
  let manager: Staff;
  let otherOutletManager: Staff;
  let otherTenantManager: Staff;
  let kdsRoleId: string;
  let waiterRoleId: string;

  async function newUser(label: string): Promise<Staff> {
    const client = agent(app);
    const email = await signUp(client, label);
    await setRole(email, null);
    const session = await client.get("/api/auth/get-session");
    return { client, userId: session.body.user.id as string, email };
  }

  async function grant(user: Staff, scopeType: "outlet", scopeId: string) {
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [tenant.tenantId, user.userId, kdsRoleId, scopeType, scopeId],
    );
  }

  /** Floor access that makes a zone waiter reachable (floor.table.operate). */
  async function grantFloor(user: Staff, validUntil = "NULL") {
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 minutes', ${validUntil}, $2)`,
      [tenant.tenantId, user.userId, waiterRoleId, tenant.outletId],
    );
  }

  async function assignWaiter(zoneId: string, userId: string) {
    await owner.query(
      `INSERT INTO zone_waiter_assignments (tenant_id, outlet_id, zone_id, user_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenant.tenantId, tenant.outletId, zoneId, userId],
    );
  }

  beforeAll(async () => {
    kdsRoleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'KDS Manager', false, NULL, $3, false, '["tenant","outlet"]')`,
      [
        kdsRoleId,
        tenant.tenantId,
        JSON.stringify(["kds.ticket.process", "kds.station.manage"]),
      ],
    );
    waiterRoleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Zone Waiter', false, NULL, $3, false, '["tenant","outlet"]')`,
      [waiterRoleId, tenant.tenantId, JSON.stringify(["floor.table.operate"])],
    );
    manager = await newUser("KDS Manager");
    await grant(manager, "outlet", tenant.outletId);
    otherOutletManager = await newUser("Other Outlet Manager");
    await grant(otherOutletManager, "outlet", randomUUID());
    otherTenantManager = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: seededOutletA,
    });
  });

  /** Notifications of one event type about one order, with its recipients. */
  async function alertsOf(eventType: string, orderId: string) {
    return ownerRows<{ user_id: string; category: string; title: string }>(
      `SELECT n.user_id::text AS user_id, n.category, n.title
       FROM notifications n
       JOIN notification_outbox o
         ON o.tenant_id = n.tenant_id AND o.source_event_id = n.source_event_id
       WHERE n.tenant_id = $1 AND o.event_type = $2 AND o.payload->>'orderId' = $3`,
      [tenant.tenantId, eventType, orderId],
    );
  }

  async function placeOpenBill(
    fill: (guest: Guest) => Promise<number>,
    ...zoneWaiters: string[]
  ) {
    const { zone, qrToken } = await newTable("open_bill");
    for (const waiter of zoneWaiters) await assignWaiter(zone.id, waiter);
    const guest = await seat(qrToken);
    const version = await fill(guest);
    const confirmed = await staff.client
      .post(`/api/table-sessions/${guest.sessionId}/confirm`)
      .set(headers)
      .set(originHeader);
    expect(confirmed.status).toBe(200);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    return { orderId: placed.body.data.order.id as string, zone };
  }

  async function rerouteAll(orderId: string) {
    const itemIds = [...(await orderItemIds(orderId)).values()].map(uuidToUlid);
    const context = contextOf(tenant.tenantId);
    return withTenant(db, context, (tx) =>
      routeFiredItemsToKitchen(tx, context, {
        outletId: tenant.outletId,
        orderId,
        itemIds,
        actor: null,
        now: new Date(),
        onUnresolved: "skip",
      }),
    );
  }

  it("an unrouted QR line alerts the outlet's KDS managers once, even when routing is called again", async () => {
    const { orderId } = await placeOpenBill(fillUnresolvableCart);
    const first = await alertsOf("kitchen_ticket.unrouted", orderId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      user_id: manager.userId,
      category: "kitchen_alert",
    });
    await rerouteAll(orderId);
    await rerouteAll(orderId);
    expect(await alertsOf("kitchen_ticket.unrouted", orderId)).toHaveLength(1);
    const everyone = await ownerRows<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM notifications WHERE tenant_id = $1 AND category = 'kitchen_alert'`,
      [tenant.tenantId],
    );
    for (const row of everyone) {
      expect(row.user_id).not.toBe(otherOutletManager.userId);
      expect(row.user_id).not.toBe(otherTenantManager.userId);
    }
  });

  it("a KDS ticket void on a QR order alerts the table's zone waiter once, not another zone's", async () => {
    const waiter = await newUser("Zone Waiter");
    await grantFloor(waiter);
    const otherZoneWaiter = await newUser("Other Zone Waiter");
    await grantFloor(otherZoneWaiter);
    await assignWaiter((await newTable()).zone.id, otherZoneWaiter.userId);
    const { orderId } = await placeOpenBill(fillStandardCart, waiter.userId);
    const [kopiTicket] = (await ticketsOf(orderId)).filter(
      (ticket) => ticket.station_id === ids.hot,
    );
    const voided = await manager.client
      .post(
        `/api/outlets/${tenant.outletId}/kitchen/tickets/${uuidToUlid(kopiTicket!.id)}/void`,
      )
      .set(headers)
      .set(originHeader)
      .send({ reason: "Bahan habis" });
    expect(voided.status).toBe(200);
    const alerts = await alertsOf("order.kitchen_voided", orderId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      user_id: waiter.userId,
      category: "kitchen_alert",
    });
    // A void line on the other ticket is its own event.
    const [pastryTicket] = (await ticketsOf(orderId)).filter(
      (ticket) => ticket.station_id === ids.pastry,
    );
    const second = await manager.client
      .post(
        `/api/outlets/${tenant.outletId}/kitchen/tickets/${uuidToUlid(pastryTicket!.id)}/void`,
      )
      .set(headers)
      .set(originHeader)
      .send({ reason: "Oven rusak" });
    expect(second.status).toBe(200);
    expect(await alertsOf("order.kitchen_voided", orderId)).toHaveLength(2);
  });

  it("a QR void with no zone waiter falls back to the outlet's KDS managers", async () => {
    const { orderId } = await placeOpenBill(fillStandardCart);
    const [kopiTicket] = (await ticketsOf(orderId)).filter(
      (ticket) => ticket.station_id === ids.hot,
    );
    const voided = await manager.client
      .post(
        `/api/outlets/${tenant.outletId}/kitchen/tickets/${uuidToUlid(kopiTicket!.id)}/void`,
      )
      .set(headers)
      .set(originHeader)
      .send({ reason: "Bahan habis" });
    expect(voided.status).toBe(200);
    const alerts = await alertsOf("order.kitchen_voided", orderId);
    expect(alerts.map((row) => row.user_id)).toEqual([manager.userId]);
  });

  async function voidKopiTicket(orderId: string) {
    const [kopiTicket] = (await ticketsOf(orderId)).filter(
      (ticket) => ticket.station_id === ids.hot,
    );
    const voided = await manager.client
      .post(
        `/api/outlets/${tenant.outletId}/kitchen/tickets/${uuidToUlid(kopiTicket!.id)}/void`,
      )
      .set(headers)
      .set(originHeader)
      .send({ reason: "Bahan habis" });
    expect(voided.status).toBe(200);
  }

  it("a zone waiter who is banned or whose access expired is skipped at send time; the KDS managers get the void", async () => {
    const expired = await newUser("Expired Waiter");
    await grantFloor(expired, "now() - interval '1 minute'");
    const banned = await newUser("Banned Waiter");
    await grantFloor(banned);
    await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      banned.userId,
    ]);
    const { orderId } = await placeOpenBill(
      fillStandardCart,
      expired.userId,
      banned.userId,
    );
    await voidKopiTicket(orderId);
    const alerts = await alertsOf("order.kitchen_voided", orderId);
    expect(alerts.map((row) => row.user_id)).toEqual([manager.userId]);
  });

  it("a ticket void with no lines raises no alert", async () => {
    const { orderId } = await placeOpenBill(fillStandardCart);
    const context = contextOf(tenant.tenantId);
    await withTenant(db, context, (tx) =>
      notifyQrKitchenVoid(tx, context, {
        order: { id: orderId, outletId: tenant.outletId },
        ticketId: uuidToUlid(randomUUID()),
        stationId: ids.hot,
        orderItemIds: [],
        ticketCancelled: true,
        reason: null,
        now: new Date(),
      }),
    );
    expect(await alertsOf("order.kitchen_voided", orderId)).toHaveLength(0);
  });

  it("pay-first: the verified payment routes an unrouted line and the alert row survives the guest checkout context (RLS)", async () => {
    const guest = await seat((await newTable()).qrToken);
    const version = await fillUnresolvableCart(guest);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.order.id as string;
    expect(await alertsOf("kitchen_ticket.unrouted", orderId)).toHaveLength(0);
    const paid = await as(guest).pay(orderId);
    expect(paid.status).toBe(201);
    expect(await payVerified(paid.body.data.id, paid.body.data.amountIdr)).toBe(
      true,
    );
    const alerts = await alertsOf("kitchen_ticket.unrouted", orderId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      user_id: manager.userId,
      category: "kitchen_alert",
    });
  });

  it("a non-QR order raises no staff alert for a kitchen void or an unrouted line", async () => {
    const waiter = await newUser("Zone Waiter Two");
    await grantFloor(waiter);
    const voidOrder = await placeOpenBill(fillStandardCart, waiter.userId);
    await ownerRows(`UPDATE orders SET channel = 'pos' WHERE id = $1::uuid`, [
      ulidToUuid(voidOrder.orderId),
    ]);
    const [ticket] = await ticketsOf(voidOrder.orderId);
    const voided = await manager.client
      .post(
        `/api/outlets/${tenant.outletId}/kitchen/tickets/${uuidToUlid(ticket!.id)}/void`,
      )
      .set(headers)
      .set(originHeader)
      .send({ reason: "Salah input" });
    expect(voided.status).toBe(200);
    expect(
      await alertsOf("order.kitchen_voided", voidOrder.orderId),
    ).toHaveLength(0);

    const unrouted = await placeOpenBill(fillUnresolvableCart);
    await ownerRows(
      `DELETE FROM delivery_attempts WHERE tenant_id = $1 AND notification_id IN (
         SELECT n.id FROM notifications n
         JOIN notification_outbox o
           ON o.tenant_id = n.tenant_id AND o.source_event_id = n.source_event_id
         WHERE n.tenant_id = $1 AND o.payload->>'orderId' = $2)`,
      [tenant.tenantId, unrouted.orderId],
    );
    await ownerRows(
      `DELETE FROM notifications WHERE tenant_id = $1 AND source_event_id IN (
         SELECT source_event_id FROM notification_outbox
         WHERE tenant_id = $1 AND payload->>'orderId' = $2)`,
      [tenant.tenantId, unrouted.orderId],
    );
    await ownerRows(
      `DELETE FROM notification_outbox WHERE tenant_id = $1 AND payload->>'orderId' = $2`,
      [tenant.tenantId, unrouted.orderId],
    );
    await ownerRows(`UPDATE orders SET channel = 'pos' WHERE id = $1::uuid`, [
      ulidToUuid(unrouted.orderId),
    ]);
    await rerouteAll(unrouted.orderId);
    expect(
      await alertsOf("kitchen_ticket.unrouted", unrouted.orderId),
    ).toHaveLength(0);
  });
});
