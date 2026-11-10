// legend-bjy6: QR checkout writes tax_snapshots EXACTLY ONCE per
// (source_type, source_id, tax_rule_id), and the snapshot amounts add up to
// the order's stored totals.
//
// Real Express app + PostgreSQL (disposable server from `pnpm test`), fresh
// isolated tenant with two published tax rules: PBJT 10% on Kopi and "other"
// 2% on Roti (one rule per item; two rules on one item is TAX_RULE_AMBIGUOUS).
// Each order holds both items, so it uses both rules. Each test seats a new
// table and inspects the tax_snapshots rows of its own order.
//
// Assumptions (no spec text states them; derived from the brief):
// - Orders hold one item of each rule; Kopi taxes under PBJT, Roti under the
//   other rule.
// - A QR order is the snapshot source: source_type 'order', source_id = the
//   order uuid. One row per applied rule, so 2 rows here.
// - Sum of snapshot tax_idr over the order's rows = orders.tax_idr.
// - Pay-first: the guest pays by QRIS; the verified webhook settlement and the
//   QR consumer (payment.paid event) fire the order, as in
//   qr-order-paid-event.test.ts.
// - Open bill: the order is created at checkout (snapshots exist then). Paying
//   an open-bill order or the bill through the guest API is refused today
//   ("belum tersedia" / "tidak menunggu pembayaran"), so "later" is a second
//   order in the same session plus reading the bill; rows must stay one per
//   rule per order.

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
import type { PaymentInstructions } from "@starter/shared/payment";
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
  roti: randomUUID(),
  priceList: randomUUID(),
  pbjtRule: randomUUID(),
  otherRule: randomUUID(),
  taxSettings: randomUUID(),
};
const RULE_COUNT = 2;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKETAXSNAP",
      issuer: null,
    };
    return {
      providerRef: `TSN-${randomBytes(6).toString("hex")}`,
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

async function asOwnerTenant<T>(
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

async function seat(paymentMode: "pay_first" | "open_bill"): Promise<Guest> {
  const zone = await createZone(
    staff.client,
    { paymentMode, serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(scanned.status).toBe(201);
  return {
    token: scanned.body.data.sessionToken,
    sessionId: scanned.body.data.session.id,
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
    payOrder: (orderId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
    view: () => auth(client.get(base)),
    bill: () => auth(client.get(`${base}/bill`)),
  };
}

async function confirmSession(guest: Guest) {
  const confirmed = await staff.client
    .post(`/api/table-sessions/${guest.sessionId}/confirm`)
    .set(headers)
    .set(originHeader);
  expect(confirmed.status).toBe(200);
}

async function checkoutCart(guest: Guest, fromVersion = 0) {
  const first = await as(guest).add(ids.kopi, fromVersion);
  expect(first.status).toBe(201);
  const second = await as(guest).add(ids.roti, first.body.data.cart.version);
  expect(second.status).toBe(201);
  const placed = await as(guest).checkout(second.body.data.cart.version);
  expect(placed.status).toBe(201);
  return {
    orderId: placed.body.data.order.id as string,
    totalIdr: placed.body.data.order.totalIdr as number,
  };
}

/** A verified webhook settlement (the trusted source). */
async function settle(intentId: string, amountIdr: number) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
}

async function paidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
        AND event->'payload'->>'intentId' = $2
      ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(event: EventEnvelope) {
  const context = contextOf(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
}

type SnapshotRow = {
  id: string;
  created_at: string;
  tax_rule_id: string;
  tax_base_idr: string;
  service_charge_idr: string;
  tax_idr: string;
};

async function snapshots(orderId: string): Promise<SnapshotRow[]> {
  const { rows } = await owner.query<SnapshotRow>(
    `SELECT id::text, created_at::text, tax_rule_id::text, tax_base_idr::text,
            service_charge_idr::text, tax_idr::text
       FROM tax_snapshots
      WHERE tenant_id = $1 AND source_id = $2
      ORDER BY tax_rule_id`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows;
}

async function storedOrder(orderId: string) {
  const { rows } = await owner.query<{
    tax_idr: string;
    service_charge_idr: string;
    status: string;
  }>(
    `SELECT tax_idr::text, service_charge_idr::text, status
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return {
    tax: Number(rows[0]!.tax_idr),
    service: Number(rows[0]!.service_charge_idr),
    status: rows[0]!.status,
  };
}

const sum = (rows: SnapshotRow[], key: keyof SnapshotRow) =>
  rows.reduce((total, row) => total + Number(row[key]), 0);

/** One row per published rule, none twice, and the tax adds up to the order. */
async function expectSnapshotsMatchOrder(orderId: string) {
  const rows = await snapshots(orderId);
  expect(rows).toHaveLength(RULE_COUNT);
  expect(new Set(rows.map((row) => row.tax_rule_id))).toEqual(
    new Set([ids.pbjtRule, ids.otherRule]),
  );
  const order = await storedOrder(orderId);
  expect(order.tax).toBeGreaterThan(0);
  expect(sum(rows, "tax_idr")).toBe(order.tax);
  // Assumption: each row carries the service charge of its own lines.
  expect(order.service).toBeGreaterThan(0);
  expect(sum(rows, "service_charge_idr")).toBe(order.service);
  // Per rule: Kopi 25.000 + 5% service 1.250 = base 26.250, PBJT 10% = 2.625;
  // Roti 18.000 + service 900 = base 18.900, other 2% = 378.
  for (const [ruleId, base, service, tax] of [
    [ids.pbjtRule, 26_250, 1_250, 2_625],
    [ids.otherRule, 18_900, 900, 378],
  ] as const) {
    const row = rows.find((candidate) => candidate.tax_rule_id === ruleId);
    expect(Number(row?.tax_base_idr)).toBe(base);
    expect(Number(row?.service_charge_idr)).toBe(service);
    expect(Number(row?.tax_idr)).toBe(tax);
  }
  return rows;
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(new FakeGateway());
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`tsn-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Snapshot Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu"],
      [ids.roti, "Roti Bakar"],
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
      [ids.roti, 18_000],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, itemId, price],
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
    for (const [id, code, type, rateBp, itemId] of [
      [ids.pbjtRule, "PBJT-TSN", "pbjt", 1000, ids.kopi],
      [ids.otherRule, "OTH-TSN", "other", 200, ids.roti],
    ] as const)
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, $3, $3, $4, $5, NULL, '[]',
                 $7, false, true, true, 1, '2026-01-01', 'published', now(), $6)`,
        [
          id,
          tenant.tenantId,
          code,
          type,
          rateBp,
          staff.userId,
          JSON.stringify({
            itemClasses: [],
            categoryIds: [],
            itemIds: [itemId],
          }),
        ],
      );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("QR checkout tax snapshots (legend-bjy6)", () => {
  it("QR-TAXSNAP-01 pay-first order, once paid: one snapshot per rule, tax sums to the order", async () => {
    const guest = await seat("pay_first");
    const { orderId, totalIdr } = await checkoutCart(guest);
    expect(await snapshots(orderId)).toEqual([]);
    const paid = await as(guest).payOrder(orderId);
    expect(paid.status).toBe(201);
    // Nothing is written before the payment settles.
    expect(await snapshots(orderId)).toEqual([]);
    const intentId = paid.body.data.id as string;
    await settle(intentId, totalIdr);
    const event = await paidEvent(intentId);
    await deliver(event);
    expect((await storedOrder(orderId)).status).not.toBe("awaiting_payment");
    const rows = await expectSnapshotsMatchOrder(orderId);
    // A repeated payment.paid delivery keeps the same rows (same ids).
    await deliver(event);
    expect(await snapshots(orderId)).toEqual(rows);
  });

  it("QR-TAXSNAP-02 open bill: one snapshot per rule when the order is created, and a later order in the same session adds its own without touching the first", async () => {
    const guest = await seat("open_bill");
    await confirmSession(guest);
    const first = await checkoutCart(guest);
    const firstRows = await expectSnapshotsMatchOrder(first.orderId);

    // Reading the session (cart, bill) never writes snapshots.
    const view = await as(guest).view();
    expect(view.status).toBe(200);
    expect((await as(guest).bill()).status).toBe(200);
    expect(await snapshots(first.orderId)).toEqual(firstRows);

    const second = await checkoutCart(
      guest,
      view.body.data.cart.version as number,
    );
    expect(second.orderId).not.toBe(first.orderId);
    await expectSnapshotsMatchOrder(second.orderId);
    expect(await snapshots(first.orderId)).toEqual(firstRows);
  });
});
