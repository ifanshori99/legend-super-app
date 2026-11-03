// QR order API (bead legend-e2x; PRD v1.7 §3 F10 "Menu & Keranjang", "Mode
// Bayar", "Estimasi Waktu Saji"; §4 Alur A and B). Acceptance: ORD-01,
// ORD-02, ORD-03, ORD-05, ORD-11, plus TEN-01/TEN-02 isolation of the new
// tables and the checkout / payment concurrency guarantees.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`). Everything runs in a fresh isolated tenant so the
// price list, tax configuration and daily counters are this file's own. The
// payment gateway, promo engine and reservation deposit are test doubles
// installed through their ports; `payment.paid` is produced by the real
// WS-05 `confirmPayment` and consumed by the real QR order consumer.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  CoreError,
  idr,
  tenantIdSchema,
  ulidToUuid,
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
import { cartLines, orders } from "../db/schema/qr-order.ts";
import { withTenant } from "../db/tenant.ts";
import type { OrderPromoPort } from "../services/order-promo-port.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import {
  setQrOrderDepositCreditLookup,
  setQrOrderPromoPort,
} from "../services/qr-order-ports.ts";
import {
  qrOrderSettlementLookup,
  voidUnpaidQrOrder,
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
  seededHostname,
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
  roti: randomUUID(),
  habis: randomUUID(),
  terbatas: randomUUID(),
  berubah: randomUUID(),
  priceList: randomUUID(),
  group: randomUUID(),
  extraShot: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const PRICES = { kopi: 25_000, roti: 18_000, extraShot: 5_000 } as const;
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

/** Kopi x2 with an extra shot + Roti x1 = Rp78.000 before service and tax. */
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
  return second.body.data.cart.version as number;
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

async function usageOf(menuItemId: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT coalesce(sum(quantity), 0)::text AS quantity
     FROM menu_item_daily_usage WHERE tenant_id = $1 AND menu_item_id = $2`,
    [tenant.tenantId, menuItemId],
  );
  return Number(rows[0]?.quantity ?? 0);
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
  tenant = await createIsolatedTenant(`qro-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Order Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu"],
      [ids.roti, "Roti Bakar"],
      [ids.habis, "Kue Habis"],
      [ids.terbatas, "Kue Terbatas"],
      [ids.berubah, "Teh Musiman"],
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
      [ids.kopi, PRICES.kopi],
      [ids.roti, PRICES.roti],
      [ids.habis, 15_000],
      [ids.terbatas, 12_000],
      [ids.berubah, 20_000],
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
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', NULL, 'sold_out'),
              ($5, $2, $3, $6, '[]', 1, 'available'),
              ($7, $2, $3, $8, '[]', NULL, 'available')`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        ids.habis,
        randomUUID(),
        ids.terbatas,
        randomUUID(),
        ids.berubah,
      ],
    );
    // PBJT 10% on F&B with the service charge in its base; menu prices
    // exclude tax and service (owner decision 2026-11-01).
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
       VALUES ($1, $2, NULL, 'PBJT-QRO', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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
  setQrOrderDepositCreditLookup(null);
  // The isolated tenant stays in the disposable test database: its audit
  // rows are append-only, so the tenant cannot be deleted.
  await owner.end();
});

describe("QR order cart, quote and checkout (legend-e2x)", () => {
  it("ORD-01 a guest without login shares one cart with every device of the session", async () => {
    const { qrToken } = await newTable();
    const first = await seat(qrToken);
    // A second phone joins the same session and receives the same credential.
    const second = await seat(qrToken);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.token).toBe(first.token);

    const added = await as(first).add({
      menuItemId: ids.roti,
      quantity: 1,
      note: "tanpa mentega",
      expectedCartVersion: 0,
    });
    expect(added.status).toBe(201);
    expect(added.body.data.cart.version).toBe(1);
    expect(added.body.data.line.unitPriceIdr).toBe(PRICES.roti);

    const seen = await as(second).view();
    expect(seen.status).toBe(200);
    expect(seen.body.data.cart.version).toBe(1);
    expect(seen.body.data.cart.lines).toHaveLength(1);
    expect(seen.body.data.cart.lines[0].note).toBe("tanpa mentega");
    expect(seen.body.data.quote).not.toBeNull();

    // A write from a stale view never overwrites the other guest's change.
    const stale = await as(second).add({
      menuItemId: ids.kopi,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(stale.status).toBe(412);

    const lineId = added.body.data.line.id as string;
    const patched = await as(second).patch(lineId, {
      quantity: 3,
      expectedCartVersion: 1,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.line.quantity).toBe(3);
    expect(patched.body.data.line.lineTotalIdr).toBe(PRICES.roti * 3);

    const removed = await as(first).remove(lineId, 2);
    expect(removed.status).toBe(200);
    expect(removed.body.data.cart.lines).toHaveLength(0);
    expect(removed.body.data.cart.version).toBe(3);

    // Realtime push: one cart.updated outbox event per change.
    const events = await outboxRows(
      "cart.updated",
      "sessionId",
      first.sessionId,
    );
    expect(events.map((event) => event.payload.change)).toEqual([
      "line_added",
      "line_updated",
      "line_removed",
    ]);
  });

  it("ORD-03 prices, service charge, tax and total are computed by the server; client prices are refused", async () => {
    const { qrToken } = await newTable();
    const guest = await seat(qrToken);

    // The strict contract refuses any client-sent price.
    const forged = await as(guest).add({
      menuItemId: ids.kopi,
      quantity: 1,
      expectedCartVersion: 0,
      unitPriceIdr: 1,
    });
    expect(forged.status).toBe(422);

    await fillStandardCart(guest);
    const quote = await as(guest).quote();
    expect(quote.status).toBe(200);
    const data = quote.body.data;
    // (25.000 + 5.000) x 2 + 18.000 = 78.000; service 5% = 3.900;
    // PBJT 10% of (78.000 + 3.900) = 8.190; total 90.090.
    expect(data.subtotalIdr).toBe(78_000);
    expect(data.discountIdr).toBe(0);
    expect(data.serviceCharge).toEqual({
      rateBp: 500,
      baseIdr: 78_000,
      amountIdr: 3_900,
    });
    expect(data.taxIdr).toBe(8_190);
    expect(data.taxLines).toEqual([
      {
        taxRuleId: ids.taxRule,
        name: "PBJT 10%",
        rateBp: 1000,
        baseIdr: 81_900,
        amountIdr: 8_190,
      },
    ]);
    expect(data.totalIdr).toBe(90_090);
    const kopi = data.lines.find(
      (line: { menuItemId: string }) => line.menuItemId === ids.kopi,
    );
    expect(kopi).toMatchObject({
      unitPriceIdr: PRICES.kopi,
      modifiersTotalIdr: PRICES.extraShot,
      lineSubtotalIdr: 60_000,
    });

    // A price list change after the line was added is reported and applied.
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE price_list_items SET price_idr = 20000, updated_at = now() WHERE tenant_id = $1 AND item_id = $2",
        [tenant.tenantId, ids.roti],
      ),
    );
    try {
      const repriced = await as(guest).quote();
      expect(repriced.status).toBe(200);
      expect(repriced.body.data.subtotalIdr).toBe(80_000);
      expect(repriced.body.data.priceChanges).toEqual([
        expect.objectContaining({
          previousUnitPriceIdr: PRICES.roti,
          unitPriceIdr: 20_000,
        }),
      ]);
    } finally {
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE price_list_items SET price_idr = $3, updated_at = now() WHERE tenant_id = $1 AND item_id = $2",
          [tenant.tenantId, ids.roti, PRICES.roti],
        ),
      );
    }
  });

  it("ORD-03 the promo port prices the discount before service charge and tax", async () => {
    const redeemed: string[] = [];
    const tenPercent: OrderPromoPort = {
      async quote(_tx, _ctx, input) {
        if (input.voucherCode !== null && input.voucherCode !== "HEMAT10")
          throw new CoreError("VALIDATION_ERROR", "Kode promo tidak dikenal.");
        const total = input.lines.reduce(
          (sum, line) => sum + line.lineTotalIdr,
          0,
        );
        const discount =
          input.voucherCode === "HEMAT10" ? Math.floor(total / 10) : 0;
        return {
          result: { evaluations: [], totalDiscountIdr: idr(discount) },
          totalDiscountIdr: idr(discount),
        };
      },
      async redeem(tx, ctx, input) {
        redeemed.push(input.orderId);
        return tenPercent.quote(tx, ctx, input);
      },
      async release() {
        return { released: true, releasedDiscountIdr: idr(0) };
      },
    };
    setQrOrderPromoPort(tenPercent);
    try {
      const { qrToken } = await newTable();
      const guest = await seat(qrToken);
      const added = await as(guest).add({
        menuItemId: ids.roti,
        quantity: 5,
        expectedCartVersion: 0,
      });
      const quote = await as(guest).quote({ promoCode: "HEMAT10" });
      expect(quote.status).toBe(200);
      // 90.000 - 9.000 = 81.000; service 5% = 4.050; PBJT 10% of 85.050 = 8.505.
      expect(quote.body.data).toMatchObject({
        subtotalIdr: 90_000,
        discountIdr: 9_000,
        serviceCharge: { baseIdr: 81_000, amountIdr: 4_050 },
        taxIdr: 8_505,
        totalIdr: 93_555,
      });
      expect(quote.body.data.discountLines).toEqual([
        { label: "Promo HEMAT10", source: "voucher", amountIdr: 9_000 },
      ]);

      const placed = await as(guest).checkout({
        expectedCartVersion: added.body.data.cart.version,
        idempotencyKey: randomUUID(),
      });
      expect(placed.status).toBe(201);
      expect(placed.body.data.order.discountIdr).toBe(9_000);
      expect(placed.body.data.order.totalIdr).toBe(93_555);
      expect(redeemed).toEqual([placed.body.data.order.id]);
    } finally {
      setQrOrderPromoPort(null);
    }
  });

  it("ORD-05 a sold-out item cannot be added", async () => {
    const { qrToken } = await newTable();
    const guest = await seat(qrToken);
    const refused = await as(guest).add({
      menuItemId: ids.habis,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/ORD-05/);
    const view = await as(guest).view();
    expect(view.body.data.cart.lines).toHaveLength(0);
  });

  it("ORD-05 an item that sells out before checkout leaves the order with a clear notice", async () => {
    const { qrToken } = await newTable();
    const guest = await seat(qrToken);
    const kopi = await as(guest).add({
      menuItemId: ids.kopi,
      quantity: 1,
      expectedCartVersion: 0,
    });
    const teh = await as(guest).add({
      menuItemId: ids.berubah,
      quantity: 1,
      expectedCartVersion: kopi.body.data.cart.version,
    });
    expect(teh.status).toBe(201);
    // The kitchen 86'd the tea while the guests were still choosing.
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE item_availability SET status = 'sold_out', updated_at = now() WHERE tenant_id = $1 AND menu_item_id = $2",
        [tenant.tenantId, ids.berubah],
      ),
    );
    const usageBefore = await usageOf(ids.kopi);
    const placed = await as(guest).checkout({
      expectedCartVersion: teh.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.order.items).toHaveLength(1);
    expect(placed.body.data.order.items[0].menuItemId).toBe(ids.kopi);
    expect(placed.body.data.quote.removedLines).toEqual([
      {
        cartLineId: teh.body.data.line.id,
        menuItemId: ids.berubah,
        name: "Teh Musiman",
        reason: "sold_out",
      },
    ]);
    // The ordered line reserved its daily stock in the order transaction.
    expect(await usageOf(ids.kopi)).toBe(usageBefore + 1);
    const view = await as(guest).view();
    expect(view.body.data.cart.lines).toHaveLength(0);

    // A cart with only sold-out lines places nothing and is cleaned up.
    const again = await as(guest).add({
      menuItemId: ids.terbatas,
      quantity: 1,
      expectedCartVersion: view.body.data.cart.version,
    });
    expect(again.status).toBe(201);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE item_availability SET status = 'sold_out', updated_at = now() WHERE tenant_id = $1 AND menu_item_id = $2",
        [tenant.tenantId, ids.terbatas],
      ),
    );
    try {
      const refused = await as(guest).checkout({
        expectedCartVersion: again.body.data.cart.version,
        idempotencyKey: randomUUID(),
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/ORD-05/);
      expect(refused.body.error.message).toMatch(/Kue Terbatas/);
      const cleaned = await as(guest).view();
      expect(cleaned.body.data.cart.lines).toHaveLength(0);
    } finally {
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE item_availability SET status = 'available', updated_at = now() WHERE tenant_id = $1 AND menu_item_id = $2",
          [tenant.tenantId, ids.terbatas],
        ),
      );
    }
  });

  it("ORD-05 the daily limit is reserved at checkout and a void releases it exactly once", async () => {
    const first = await seat((await newTable()).qrToken);
    const added = await as(first).add({
      menuItemId: ids.terbatas,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(added.status).toBe(201);
    const usageBefore = await usageOf(ids.terbatas);
    const placed = await as(first).checkout({
      expectedCartVersion: added.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(await usageOf(ids.terbatas)).toBe(usageBefore + 1);

    // The single unit of the day is held by that order.
    const second = await seat((await newTable()).qrToken);
    const refused = await as(second).add({
      menuItemId: ids.terbatas,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(refused.status).toBe(409);

    // The unpaid order is voided (payment expired): the unit returns once.
    const orderId = placed.body.data.order.id as string;
    const context = contextOf(tenant.tenantId);
    const voided = await voidUnpaidQrOrder(context, orderId, {
      reason: "payment expired",
      actorUserId: null,
    });
    expect(voided.status).toBe("voided");
    expect(voided.items.every((item) => item.status === "voided")).toBe(true);
    expect(await usageOf(ids.terbatas)).toBe(usageBefore);
    // A second void is a no-op: nothing is released twice.
    await voidUnpaidQrOrder(context, orderId, {
      reason: "payment expired",
      actorUserId: null,
    });
    expect(await usageOf(ids.terbatas)).toBe(usageBefore);

    const retry = await as(second).add({
      menuItemId: ids.terbatas,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(retry.status).toBe(201);
  });

  it("ORD-11 the quote and the placed order carry a serving estimate before checkout", async () => {
    const guest = await seat((await newTable()).qrToken);
    const version = await fillStandardCart(guest);
    const quote = await as(guest).quote();
    expect(quote.status).toBe(200);
    const estimate = quote.body.data.servingEstimate;
    expect(estimate).not.toBeNull();
    expect(estimate.minMinutes).toBeGreaterThan(0);
    expect(estimate.maxMinutes).toBeGreaterThanOrEqual(estimate.minMinutes);
    const view = await as(guest).view();
    expect(view.body.data.quote.servingEstimate).not.toBeNull();
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.quote.servingEstimate).not.toBeNull();
  });
});

describe("QR order pay-first and open-bill gates (legend-e2x)", () => {
  it("ORD-02 a pay-first order reaches the kitchen only after a verified payment", async () => {
    const guest = await seat((await newTable()).qrToken);
    const version = await fillStandardCart(guest);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    const order = placed.body.data.order;
    expect(placed.body.data.kitchenFire).toBe("held_for_payment");
    expect(order.status).toBe("awaiting_payment");
    expect(
      order.items.every(
        (item: { fireStatus: string }) => item.fireStatus === "held",
      ),
    ).toBe(true);
    const placedEvents = await outboxRows("order.placed", "orderId", order.id);
    expect(placedEvents.map((event) => event.payload.status)).toEqual([
      "awaiting_payment",
    ]);

    const paid = await as(guest).pay(order.id);
    expect(paid.status).toBe(201);
    expect(paid.body.data).toMatchObject({
      target: { kind: "order", orderId: order.id },
      method: "qris",
      amountIdr: 90_090,
      status: "pending",
    });

    // A forged `payment.paid` for this bill fires nothing: the consumer
    // re-reads the locked rows and the link is not paid yet.
    const [{ payment_link_id: linkId }] = (
      await owner.query<{ payment_link_id: string }>(
        "SELECT payment_link_id FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
        [tenant.tenantId, orderUuid(order.id)],
      )
    ).rows;
    const context = contextOf(tenant.tenantId);
    const forged = eventEnvelopeSchema.parse({
      ...(await outboxRows("order.placed", "orderId", order.id))[0],
      name: "payment.paid",
      aggregateType: "payment",
      payloadSchemaRef: "payment.paid.v1",
      payload: { paymentLinkId: linkId, intentId: paid.body.data.id },
    });
    expect(
      await withTenant(db, context, (tx) =>
        deliverQrOrderPaymentEvent(context, forged, forged.id, tx),
      ),
    ).toBe(false);
    const stillHeld = await as(guest).view();
    expect(stillHeld.body.data.orders[0].status).toBe("awaiting_payment");

    // The verified webhook settles the intent; its payment.paid fires.
    expect(await payVerified(paid.body.data.id, 90_090)).toBe(true);
    const fired = await as(guest).view();
    const firedOrder = fired.body.data.orders[0];
    expect(firedOrder.status).toBe("sent");
    expect(
      firedOrder.items.every(
        (item: { fireStatus: string }) => item.fireStatus === "fired",
      ),
    ).toBe(true);
    expect(
      (await outboxRows("order.placed", "orderId", order.id)).map(
        (event) => event.payload.status,
      ),
    ).toEqual(["awaiting_payment", "sent"]);
    const status = await as(guest).payment(paid.body.data.id);
    expect(status.body.data.status).toBe("paid");

    // A replayed payment.paid changes nothing.
    const [event] = await outboxRows(
      "payment.paid",
      "intentId",
      paid.body.data.id,
    );
    expect(
      await withTenant(db, context, (tx) =>
        deliverQrOrderPaymentEvent(context, event!, event!.id, tx),
      ),
    ).toBe(false);

    // ORD-10 through the settlement port: the paid table can be closed.
    const bill = await as(guest).bill();
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: 90_090,
      paidIdr: 90_090,
      outstandingIdr: 0,
    });
    const closed = await staff.client
      .post(`/api/table-sessions/${guest.sessionId}/close`)
      .set(headers)
      .set(originHeader)
      .send({ tableCleaned: true });
    expect(closed.status).toBe(200);
    expect(closed.body.data.closedReason).toBe("paid_and_cleaned");
    // ORD-04: the closed session's credential cannot order any more.
    expect((await as(guest).view()).status).toBe(401);
  });

  it("ORD-02 open bill: the first order waits for a waiter, then fires immediately", async () => {
    const guest = await seat((await newTable("open_bill")).qrToken);
    const version = await fillStandardCart(guest);
    const early = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(early.status).toBe(409);

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
    expect(placed.body.data.order.status).toBe("sent");
    expect(
      placed.body.data.order.items.every(
        (item: { fireStatus: string }) => item.fireStatus === "fired",
      ),
    ).toBe(true);
    const bill = await as(guest).bill();
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: 90_090,
      outstandingIdr: 90_090,
    });
  });

  it("ORD-02 a reservation deposit is subtracted at checkout and never below zero", async () => {
    setQrOrderDepositCreditLookup(async () => 20_000);
    try {
      const guest = await seat((await newTable()).qrToken);
      const version = await fillStandardCart(guest);
      const placed = await as(guest).checkout({
        expectedCartVersion: version,
        idempotencyKey: randomUUID(),
      });
      expect(placed.status).toBe(201);
      expect(placed.body.data.order.totalIdr).toBe(90_090);
      const bill = await as(guest).bill();
      expect(bill.body.data.totals).toMatchObject({
        totalIdr: 90_090,
        paidIdr: 20_000,
        outstandingIdr: 70_090,
      });
      const paid = await as(guest).pay(placed.body.data.order.id);
      expect(paid.status).toBe(201);
      expect(paid.body.data.amountIdr).toBe(70_090);
    } finally {
      setQrOrderDepositCreditLookup(null);
    }

    setQrOrderDepositCreditLookup(async () => -5_000);
    try {
      const guest = await seat((await newTable()).qrToken);
      const version = await fillStandardCart(guest);
      const placed = await as(guest).checkout({
        expectedCartVersion: version,
        idempotencyKey: randomUUID(),
      });
      const paid = await as(guest).pay(placed.body.data.order.id);
      expect(paid.body.data.amountIdr).toBe(90_090);
    } finally {
      setQrOrderDepositCreditLookup(null);
    }
  });
});

describe("QR order concurrency and isolation (legend-e2x)", () => {
  it("ORD-03 checkout double-submit: one key places one order; another payload with that key is refused", async () => {
    const guest = await seat((await newTable()).qrToken);
    const version = await fillStandardCart(guest);
    const key = randomUUID();
    const body = { expectedCartVersion: version, idempotencyKey: key };
    const [a, b] = await Promise.all([
      as(guest)
        .checkout(body)
        .then((res) => res),
      as(guest)
        .checkout(body)
        .then((res) => res),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.order.id).toBe(b.body.data.order.id);
    const { rows } = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM orders WHERE tenant_id = $1 AND table_session_id = $2",
      [tenant.tenantId, guest.sessionId],
    );
    expect(rows[0]?.count).toBe(1);

    const reused = await as(guest).checkout({
      ...body,
      note: "beda permintaan",
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("ORD-02 two guests paying the same cart: one checkout wins and only one payment intent exists", async () => {
    const { qrToken } = await newTable();
    const first = await seat(qrToken);
    const second = await seat(qrToken);
    const version = await fillStandardCart(first);
    const results = await Promise.all([
      as(first)
        .checkout({
          expectedCartVersion: version,
          idempotencyKey: randomUUID(),
        })
        .then((res) => res),
      as(second)
        .checkout({
          expectedCartVersion: version,
          idempotencyKey: randomUUID(),
        })
        .then((res) => res),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 412]);
    const winner = results.find((res) => res.status === 201)!;
    const orderId = winner.body.data.order.id as string;

    const created = gateway.created;
    const [payA, payB] = await Promise.all([
      as(first)
        .pay(orderId)
        .then((res) => res),
      as(second)
        .pay(orderId)
        .then((res) => res),
    ]);
    expect([payA.status, payB.status]).toEqual([201, 201]);
    expect(payA.body.data.id).toBe(payB.body.data.id);
    expect(gateway.created).toBe(created + 1);
    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_intents
       WHERE tenant_id = $1
         AND payment_link_id = (SELECT payment_link_id FROM orders WHERE tenant_id = $1 AND id = $2::uuid)`,
      [tenant.tenantId, orderUuid(orderId)],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("TEN-01/TEN-02 denies other tenants, other sessions and missing or closed credentials", async () => {
    const { qrToken } = await newTable();
    const guest = await seat(qrToken);
    const version = await fillStandardCart(guest);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.order.id as string;

    // The credential is resolved inside the host's tenant only.
    expect((await as(guest, seededHostname).view()).status).toBe(401);
    // Another session's id with this credential is not found (no oracle).
    const other = await seat((await newTable()).qrToken);
    expect(
      (await as({ token: guest.token, sessionId: other.sessionId }).view())
        .status,
    ).toBe(404);
    // No credential at all.
    const anonymous = await agent(app)
      .get(`/api/table-sessions/${guest.sessionId}`)
      .set("Host", tenant.hostname);
    expect(anonymous.status).toBe(401);
    // A guest mutation from an untrusted origin is refused.
    const crossSite = await agent(app)
      .post(`/api/table-sessions/${guest.sessionId}/quote`)
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set("Origin", "https://evil.example")
      .send({});
    expect(crossSite.status).toBe(403);

    // RLS: the seeded tenant's context sees none of this tenant's rows.
    const seeded = contextOf(seededTenantId);
    const leaked = await withTenant(db, seeded, async (tx) => ({
      orders: await tx.select().from(orders).where(eq(orders.id, orderId)),
      lines: await tx
        .select()
        .from(cartLines)
        .where(
          and(
            eq(cartLines.tenantId, tenantIdSchema.parse(tenant.tenantId)),
            eq(cartLines.tableSessionId, guest.sessionId),
          ),
        ),
    }));
    expect(leaked.orders).toHaveLength(0);
    expect(leaked.lines).toHaveLength(0);
    await expect(
      voidUnpaidQrOrder(seeded, orderId, {
        reason: "cross tenant",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

/** orders.id is a ULID stored as UUID bytes (D-CORE-1). */
function orderUuid(orderId: string): string {
  return ulidToUuid(orderId);
}
