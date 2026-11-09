// WS-03 inclusive-price QR orders (legend-zmc2; follow-up of legend-49pw).
//
// Real Express app + PostgreSQL (disposable server from `pnpm test`). Kopi has
// an item rule with prices that include service and tax (harga nett); every
// other item keeps the exclusive class rule. Cases: an inclusive order stores
// the gross subtotal with the backed-out parts (orders_total_check, flag on),
// an exclusive order is unchanged, a mixed cart is refused, the pay-first
// payment asks exactly the order total, and the PBJT snapshot that feeds the
// tax report holds the backed-out tax, not tax on top of the gross price.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { ulidToUuid } from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
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
  classRule: randomUUID(),
  kopiRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

/**
 * Kopi Rp25.000 all-in, PB1 10% on (base + service 5%), half up:
 * base = 25.000 / (1,05 x 1,10) = 21.645, service = 5% x 21.645 = 1.082,
 * tax = 25.000 - 21.645 - 1.082 = 2.273 (tax base 21.645 + 1.082 = 22.727).
 */
const KOPI = {
  gross: 25_000,
  service: 1_082,
  tax: 2_273,
  taxBase: 22_727,
};

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEINCLUSIVE",
      issuer: null,
    };
    return {
      providerRef: `INC-${randomBytes(6).toString("hex")}`,
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
    quote: () => auth(client.post(`${base}/quote`)).send({}),
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
    bill: () => auth(client.get(`${base}/bill`)),
  };
}

/** Adds the items in order; returns the cart version after the last one. */
async function fill(guest: Guest, items: readonly string[]): Promise<number> {
  let version = 0;
  for (const item of items) {
    const added = await as(guest).add(item, version);
    expect(added.status).toBe(201);
    version = added.body.data.cart.version as number;
  }
  return version;
}

async function storedOrder(orderId: string) {
  const { rows } = await owner.query<{
    prices_include_tax: boolean;
    subtotal_idr: string;
    service_charge_idr: string;
    tax_idr: string;
    total_idr: string;
  }>(
    `SELECT prices_include_tax, subtotal_idr::text, service_charge_idr::text,
            tax_idr::text, total_idr::text
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  const row = rows[0];
  if (!row) throw new Error("order row missing");
  return {
    inclusive: row.prices_include_tax,
    subtotal: Number(row.subtotal_idr),
    service: Number(row.service_charge_idr),
    tax: Number(row.tax_idr),
    total: Number(row.total_idr),
  };
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(new FakeGateway());
  tenant = await createIsolatedTenant(`inc-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Inklusif Uji', 0)`,
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
    // Exclusive class rule for every item; an inclusive item rule for Kopi
    // beats it (the more specific rule wins), as in qr-order-api.test.ts.
    for (const [id, code, inclusive, appliesTo] of [
      [
        ids.classRule,
        "PBJT-INC-X",
        false,
        { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
      ],
      [
        ids.kopiRule,
        "PBJT-INC-K",
        true,
        { itemClasses: [], categoryIds: [], itemIds: [ids.kopi] },
      ],
    ] as const)
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, $3, 'PB1 10%', 'pbjt', 1000, NULL, '[]', $4,
                 $5, true, true, 1, '2026-01-01', 'published', now(), $6)`,
        [
          id,
          tenant.tenantId,
          code,
          JSON.stringify(appliesTo),
          inclusive,
          staff.userId,
        ],
      );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  // The isolated tenant stays in the disposable test database (append-only
  // audit rows); give it a valid creator so the tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("inclusive-price QR orders (legend-zmc2)", () => {
  it("stores an inclusive single line: gross subtotal, backed-out PB1 10% and service 5%", async () => {
    const guest = await seat("pay_first");
    const version = await fill(guest, [ids.kopi]);
    const placed = await as(guest).checkout(version);
    expect(placed.status).toBe(201);
    const order = placed.body.data.order;
    expect(order).toMatchObject({
      pricesIncludeTaxAndService: true,
      subtotalIdr: KOPI.gross,
      discountIdr: 0,
      serviceChargeIdr: KOPI.service,
      taxIdr: KOPI.tax,
      roundingIdr: 0,
      totalIdr: KOPI.gross,
    });
    expect(placed.body.data.quote.pricesIncludeTaxAndService).toBe(true);
    expect(await storedOrder(order.id)).toEqual({
      inclusive: true,
      subtotal: KOPI.gross,
      service: KOPI.service,
      tax: KOPI.tax,
      total: KOPI.gross,
    });
  });

  it("keeps an exclusive order unchanged (service and tax on top)", async () => {
    const guest = await seat("pay_first");
    const version = await fill(guest, [ids.roti]);
    const placed = await as(guest).checkout(version);
    expect(placed.status).toBe(201);
    const order = placed.body.data.order;
    // 18.000 + 5% service 900 + 10% x (18.000 + 900) = 1.890.
    expect(order).toMatchObject({
      pricesIncludeTaxAndService: false,
      subtotalIdr: 18_000,
      serviceChargeIdr: 900,
      taxIdr: 1_890,
      totalIdr: 20_790,
    });
    expect((await storedOrder(order.id)).inclusive).toBe(false);
  });

  it("refuses a cart that mixes an inclusive and an exclusive item", async () => {
    const guest = await seat("pay_first");
    const version = await fill(guest, [ids.kopi, ids.roti]);
    const quote = await as(guest).quote();
    expect(quote.status).toBe(422);
    expect(quote.body.error.code).toBe("QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED");
    const placed = await as(guest).checkout(version);
    expect(placed.status).toBe(422);
    expect(placed.body.error.code).toBe("QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED");
  });

  it("pay-first: the payment asks exactly the order total; the bill adds nothing", async () => {
    const guest = await seat("pay_first");
    const version = await fill(guest, [ids.kopi]);
    const placed = await as(guest).checkout(version);
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.order.id as string;
    const paid = await as(guest).pay(orderId);
    expect(paid.status).toBe(201);
    expect(paid.body.data.amountIdr).toBe(KOPI.gross);

    // The WS-05 bill gets the subtotal without the included parts, so its
    // own total formula (subtotal - discount + service + tax) still lands on
    // the same total.
    const { rows } = await owner.query<{
      subtotal_idr: string;
      service_charge_idr: string;
      tax_idr: string;
      total_idr: string;
    }>(
      `SELECT l.subtotal_idr::text, l.service_charge_idr::text, l.tax_idr::text, l.total_idr::text
         FROM payment_links l
         JOIN orders o ON o.tenant_id = l.tenant_id AND o.payment_link_id = l.id
        WHERE o.tenant_id = $1 AND o.id = $2`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(rows[0]).toEqual({
      subtotal_idr: String(KOPI.gross - KOPI.service - KOPI.tax),
      service_charge_idr: String(KOPI.service),
      tax_idr: String(KOPI.tax),
      total_idr: String(KOPI.gross),
    });

    const bill = await as(guest).bill();
    expect(bill.status).toBe(200);
    expect(bill.body.data.totals.totalIdr).toBe(KOPI.gross);
    expect(bill.body.data.totals.outstandingIdr).toBe(KOPI.gross);
  });

  it("open bill: the PBJT snapshot (tax report source) holds the backed-out tax", async () => {
    const guest = await seat("open_bill");
    const confirmed = await staff.client
      .post(`/api/table-sessions/${guest.sessionId}/confirm`)
      .set(headers)
      .set(originHeader);
    expect(confirmed.status).toBe(200);
    const version = await fill(guest, [ids.kopi]);
    const placed = await as(guest).checkout(version);
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.order.id as string;
    const { rows } = await owner.query<{
      tax_base_idr: string;
      service_charge_idr: string;
      tax_idr: string;
    }>(
      `SELECT tax_base_idr::text, service_charge_idr::text, tax_idr::text
         FROM tax_snapshots
        WHERE tenant_id = $1 AND source_type = 'order' AND source_id = $2`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(rows).toEqual([
      {
        tax_base_idr: String(KOPI.taxBase),
        service_charge_idr: String(KOPI.service),
        tax_idr: String(KOPI.tax),
      },
    ]);
    // Net revenue = subtotal - discount - service - tax = the backed-out base.
    const stored = await storedOrder(orderId);
    expect(stored.subtotal - stored.service - stored.tax).toBe(21_645);
  });
});
