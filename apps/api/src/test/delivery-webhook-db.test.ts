// Delivery platform webhook (bead legend-5bn3, slice D3; PRD v1.7 §3.23, Alur
// G): signature, tenant resolution from the platform store id, idempotent
// import, injection into the POS, auto-accept through the adapter, refusal on a
// closed channel, needs_review for an unmapped line, platform cancel and
// tenant isolation. Real Express route, real PostgreSQL with RLS, two fresh
// isolated tenants. Orders are financial history the app role cannot delete, so
// the isolated tenants stay in the disposable database (as in D6).
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signDeliveryWebhook } from "@starter/shared/adapters";
import type { DeliveryOrderLine } from "@starter/shared/delivery";
import { errorHandler } from "../middleware/error-handler";
import { createDeliveryWebhookRouter } from "../routes/delivery-webhook.routes";
import { deliveryLinesChanged } from "../services/delivery-ingest.service.ts";
import {
  clearRecordedDeliveryCalls,
  recordedDeliveryCalls,
  setDeliveryChannelAdapter,
} from "../services/delivery-ports.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const SECRET = "gofood-test-secret-0123456789";
const GRAB_SECRET = "grabfood-test-secret-0123456789";

type Seeded = {
  tenant: IsolatedTenant;
  kopiId: string;
  goStore: string;
  grabStore: string;
};

let app: Express;
let a: Seeded;
let b: Seeded;

/** Owner-side access sets the tenant local, because RLS is FORCED. */
async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedTenant(label: string): Promise<Seeded> {
  const tenant = await createIsolatedTenant(
    `dwh-${label}-${randomUUID().slice(0, 6)}`,
  );
  const categoryId = randomUUID();
  const kopiId = randomUUID();
  const priceListId = randomUUID();
  const goStore = `go-${label}-${randomUUID().slice(0, 8)}`;
  const grabStore = `grab-${label}-${randomUUID().slice(0, 8)}`;
  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Webhook Uji', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_type)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5, 'coffee_bar')`,
      [kopiId, tenant.tenantId, tenant.brandId, categoryId, randomUUID()],
    );
    // Kopi Susu is routed to the outlet's coffee bar (KDS-01).
    await db.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Bar Kopi', 'coffee_bar')`,
      [randomUUID(), tenant.tenantId, tenant.outletId],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'gofood', '2026-01-01')`,
      [priceListId, tenant.tenantId, tenant.outletId],
    );
    await db.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, kopiId, KOPI_IDR],
    );
    // GoFood is open; GrabFood is closed (paused), both linked to a store id.
    await db.query(
      `INSERT INTO delivery_channels
         (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
       VALUES ($1, $2, 'gofood', $3, 2000, true),
              ($1, $2, 'grabfood', $4, 1500, false)`,
      [tenant.tenantId, tenant.outletId, goStore, grabStore],
    );
  });
  return { tenant, kopiId, goStore, grabStore };
}

function payloadOf(
  s: Seeded,
  overrides: Record<string, unknown> = {},
  itemId: string = s.kopiId,
) {
  return {
    storeId: s.goStore,
    orderId: `GF-${randomUUID().slice(0, 8)}`,
    grossIdr: KOPI_IDR * 2,
    items: [
      {
        itemId,
        name: "Kopi Susu",
        quantity: 2,
        unitPriceIdr: KOPI_IDR,
        modifiers: [],
      },
    ],
    ...overrides,
  };
}

/** Sends a signed webhook; `body` is serialised once so the bytes are the signed bytes. */
async function send(
  platform: string,
  body: unknown,
  options: { secret?: string; signature?: string | null; at?: number } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = request(app)
    .post(`/api/webhooks/delivery/${platform}`)
    .set("Content-Type", "application/json");
  const signature =
    options.signature === undefined
      ? await signDeliveryWebhook({
          rawBody: raw,
          secret: options.secret ?? SECRET,
          timestamp: options.at,
        })
      : options.signature;
  if (signature !== null) req.set("X-Delivery-Signature", signature);
  return req.send(raw);
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

async function count(
  s: Seeded,
  table: "orders" | "delivery_channel_orders",
  where = "",
  params: unknown[] = [],
): Promise<number> {
  const { rows } = await asOwnerTenant(s.tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1 ${where}`,
      [s.tenant.tenantId, ...params],
    ),
  );
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  app = express();
  app.use(
    "/api/webhooks/delivery",
    createDeliveryWebhookRouter({
      // ShopeeFood has no secret: that platform is disabled.
      secrets: { gofood: [SECRET], grabfood: [GRAB_SECRET] },
    }),
  );
  app.use(errorHandler);
  a = await seedTenant("a");
  b = await seedTenant("b");
});

beforeEach(() => {
  clearRecordedDeliveryCalls();
});

afterAll(async () => {
  for (const s of [a, b])
    if (s)
      await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
        s.tenant.tenantId,
        randomUUID(),
      ]);
  await owner.end();
});

describe("signature and routing", () => {
  it("a wrong, missing or stale signature is 401 and creates nothing", async () => {
    const body = payloadOf(a);
    const before = await count(a, "delivery_channel_orders");
    for (const response of [
      await send("gofood", body, { secret: "not-the-secret-0123456789" }),
      await send("gofood", body, { signature: null }),
      await send("gofood", body, { signature: "t=abc,v1=zz" }),
      await send("gofood", body, {
        at: Math.floor(Date.now() / 1000) - 3600,
      }),
    ]) {
      expect(response.status).toBe(401);
      expect(errorCode(response.body)).toBe("UNAUTHORIZED");
    }
    expect(await count(a, "delivery_channel_orders")).toBe(before);
  });

  it("a platform with no configured secret is disabled (503)", async () => {
    const response = await send("shopeefood", payloadOf(a));
    expect(response.status).toBe(503);
  });

  it("an unknown platform is 404", async () => {
    const response = await send("tokopedia", payloadOf(a));
    expect(response.status).toBe(404);
  });

  it("an unknown store id is 404 DELIVERY_CHANNEL_UNKNOWN", async () => {
    const response = await send(
      "gofood",
      payloadOf(a, { storeId: "no-such-store" }),
    );
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe("DELIVERY_CHANNEL_UNKNOWN");
  });

  it("the store index is reachable only through app.resolve_delivery_store", async () => {
    const { rows } = await owner.query<{
      select: boolean;
      resolve: boolean;
      sync: boolean;
      public_resolve: boolean;
    }>(
      `SELECT has_table_privilege('legend_app', 'public.delivery_store_index', 'SELECT') AS select,
              has_function_privilege('legend_app', 'app.resolve_delivery_store(varchar, varchar)', 'EXECUTE') AS resolve,
              has_function_privilege('legend_app', 'app.sync_delivery_store_index()', 'EXECUTE') AS sync,
              has_function_privilege('public', 'app.resolve_delivery_store(varchar, varchar)', 'EXECUTE') AS public_resolve`,
    );
    expect(rows[0]).toEqual({
      select: false,
      resolve: true,
      sync: false,
      public_resolve: false,
    });
  });

  it("a store id of another platform does not resolve (the key is platform + store)", async () => {
    // a.grabStore exists, but only on grabfood.
    const response = await send(
      "gofood",
      payloadOf(a, { storeId: a.grabStore }),
    );
    expect(response.status).toBe(404);
  });
});

describe("injection (open channel)", () => {
  it("creates the POS order with channel tag, external ref, pickup number and auto-accepts on the platform", async () => {
    const body = payloadOf(a);
    const response = await send("gofood", body);
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.result).toBe("injected");
    expect(data.status).toBe("accepted");
    expect(data.pickupNumber).toMatch(/^GF-\d{3}$/);
    expect(data.orderId).toEqual(expect.any(String));

    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `SELECT o.channel, o.external_ref, o.status, o.service_type, o.total_idr,
                (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.fire_status = 'fired') AS fired,
                d.status AS d_status, d.source, d.gross_idr, d.commission_idr, d.pickup_number
           FROM orders o
           JOIN delivery_channel_orders d ON d.order_id = o.id AND d.tenant_id = o.tenant_id
          WHERE o.tenant_id = $1 AND o.external_ref = $2`,
        [a.tenant.tenantId, body.orderId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "gofood",
      external_ref: body.orderId,
      status: "sent",
      service_type: "delivery",
      d_status: "accepted",
      source: "platform",
      pickup_number: data.pickupNumber,
    });
    expect(Number(rows[0].fired)).toBe(1);
    // Prices come from the platform payload; commission from the channel rate.
    expect(Number(rows[0].total_idr)).toBe(KOPI_IDR * 2);
    expect(Number(rows[0].gross_idr)).toBe(KOPI_IDR * 2);
    expect(Number(rows[0].commission_idr)).toBe(KOPI_IDR * 2 * 0.2);

    expect(
      recordedDeliveryCalls().filter(
        (call) =>
          call.action === "accept_order" &&
          call.payload &&
          (call.payload as { externalOrderId?: string }).externalOrderId ===
            body.orderId,
      ),
    ).toHaveLength(1);

    const events = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query<{ name: string }>(
        `SELECT event->>'name' AS name FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->'payload'->>'externalOrderId' = $2`,
        [a.tenant.tenantId, body.orderId],
      ),
    );
    expect(events.rows.map((row) => row.name).sort()).toEqual([
      "delivery_order.received",
      "delivery_order.status_changed",
    ]);
  });

  it("pickup numbers count up per outlet and platform", async () => {
    const first = await send("gofood", payloadOf(a));
    const second = await send("gofood", payloadOf(a));
    const n = (r: { body: { data: { pickupNumber: string } } }) =>
      Number(r.body.data.pickupNumber.slice(3));
    expect(n(second)).toBe(n(first) + 1);
  });

  it.todo(
    "a KDS ticket exists for the injected order and a platform cancel voids its queued lines (needs milestone/m1: wire routeFiredItemsToKitchen / cancelKitchenItemsForVoidedLines)",
  );
});

describe("idempotent import", () => {
  it("the same delivery twice is one order and the same answer", async () => {
    const body = payloadOf(a);
    const first = await send("gofood", body);
    const second = await send("gofood", body);
    expect(first.body.data.result).toBe("injected");
    expect(second.status).toBe(200);
    expect(second.body.data.result).toBe("duplicate");
    expect(second.body.data.deliveryOrderId).toBe(
      first.body.data.deliveryOrderId,
    );
    expect(second.body.data.orderId).toBe(first.body.data.orderId);
    expect(second.body.data.pickupNumber).toBe(first.body.data.pickupNumber);
    expect(
      await count(a, "delivery_channel_orders", "AND external_order_id = $2", [
        body.orderId,
      ]),
    ).toBe(1);
    expect(
      await count(a, "orders", "AND external_ref = $2", [body.orderId]),
    ).toBe(1);
  });

  it("a changed payload for the same order id updates it, never a second order", async () => {
    const body = payloadOf(a);
    const first = await send("gofood", body);
    const changed = await send("gofood", {
      ...body,
      grossIdr: KOPI_IDR * 2 + 5_000,
      commissionIdr: 11_000,
      customerNote: "Tanpa gula",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data.result).toBe("updated");
    expect(changed.body.data.deliveryOrderId).toBe(
      first.body.data.deliveryOrderId,
    );
    expect(
      await count(a, "delivery_channel_orders", "AND external_order_id = $2", [
        body.orderId,
      ]),
    ).toBe(1);
    expect(
      await count(a, "orders", "AND external_ref = $2", [body.orderId]),
    ).toBe(1);
    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `SELECT gross_idr, commission_idr, customer_note, status, version
           FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, body.orderId],
      ),
    );
    expect(rows[0]).toMatchObject({
      gross_idr: String(KOPI_IDR * 2 + 5_000),
      commission_idr: "11000",
      customer_note: "Tanpa gula",
      status: "accepted",
    });
    // Replaying the changed payload is now a duplicate of the updated state.
    const replay = await send("gofood", {
      ...body,
      grossIdr: KOPI_IDR * 2 + 5_000,
      commissionIdr: 11_000,
      customerNote: "Tanpa gula",
    });
    expect(replay.body.data.result).toBe("duplicate");
  });
});

describe("needs_review (unmapped line)", () => {
  it("is stored without a POS order or auto-accept, and injected once the platform corrects the line", async () => {
    const orderId = `GF-${randomUUID().slice(0, 8)}`;
    const unknown = payloadOf(a, { orderId }, randomUUID());
    const first = await send("gofood", unknown);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      result: "needs_review",
      orderId: null,
      pickupNumber: null,
      status: "received",
    });
    expect(await count(a, "orders", "AND external_ref = $2", [orderId])).toBe(
      0,
    );
    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `SELECT lines FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, orderId],
      ),
    );
    expect(rows[0].lines[0]).toMatchObject({
      mapping: "unmatched",
      menuItemId: null,
      externalItemName: "Kopi Susu",
    });
    expect(
      recordedDeliveryCalls().filter((call) => call.action === "accept_order"),
    ).toHaveLength(0);

    // The platform sends the corrected order (our item id): the same row is
    // injected, not a second order.
    const fixed = await send("gofood", payloadOf(a, { orderId }));
    expect(fixed.body.data.result).toBe("injected");
    expect(fixed.body.data.deliveryOrderId).toBe(
      first.body.data.deliveryOrderId,
    );
    expect(
      await count(a, "delivery_channel_orders", "AND external_order_id = $2", [
        orderId,
      ]),
    ).toBe(1);
    expect(await count(a, "orders", "AND external_ref = $2", [orderId])).toBe(
      1,
    );
  });

  it("a price differing from the channel price list still injects (price_mismatch)", async () => {
    const orderId = `GF-${randomUUID().slice(0, 8)}`;
    const response = await send("gofood", {
      ...payloadOf(a, { orderId, grossIdr: 60_000 }),
      items: [
        {
          itemId: a.kopiId,
          name: "Kopi Susu",
          quantity: 2,
          unitPriceIdr: 30_000,
          modifiers: [],
        },
      ],
    });
    expect(response.body.data.result).toBe("injected");
    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `SELECT lines FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, orderId],
      ),
    );
    expect(rows[0].lines[0]).toMatchObject({
      mapping: "price_mismatch",
      unitPriceIdr: 30_000,
      channelPriceIdr: KOPI_IDR,
    });
  });
});

describe("closed or paused channel", () => {
  it("rejects the order: recorded as rejected, no POS order, the platform is told", async () => {
    const orderId = `GR-${randomUUID().slice(0, 8)}`;
    const response = await send(
      "grabfood",
      payloadOf(a, { orderId, storeId: a.grabStore }),
      { secret: GRAB_SECRET },
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      result: "rejected",
      status: "rejected",
      orderId: null,
    });
    expect(await count(a, "orders", "AND external_ref = $2", [orderId])).toBe(
      0,
    );
    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `SELECT status, closed_at, close_reason FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, orderId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].closed_at).not.toBeNull();
    expect(
      recordedDeliveryCalls().filter((call) => call.action === "cancel_order"),
    ).toHaveLength(1);
    // A replay is the same answer, not a second row.
    const replay = await send(
      "grabfood",
      payloadOf(a, { orderId, storeId: a.grabStore }),
      { secret: GRAB_SECRET },
    );
    expect(replay.status).toBe(200);
  });
});

describe("platform cancel", () => {
  it("moves a known order to cancelled through the machine; an unknown order is 404", async () => {
    const body = payloadOf(a);
    const created = await send("gofood", body);
    const cancel = await send("gofood", {
      storeId: a.goStore,
      orderId: body.orderId,
      event: "order.cancelled",
      reason: "Pelanggan membatalkan",
      grossIdr: 0,
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({
      result: "cancelled",
      status: "cancelled",
      deliveryOrderId: created.body.data.deliveryOrderId,
    });
    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `SELECT status, closed_at, close_reason FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, body.orderId],
      ),
    );
    expect(rows[0].status).toBe("cancelled");
    expect(rows[0].close_reason).toBe("Pelanggan membatalkan");

    // Cancelled is final: a different cancel payload is recorded and answered
    // as cancelled (no 409 the platform would retry forever), nothing moves.
    const again = await send("gofood", {
      storeId: a.goStore,
      orderId: body.orderId,
      event: "order.cancelled",
      reason: "Lagi",
      grossIdr: 0,
    });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({
      result: "cancelled",
      status: "cancelled",
      deliveryOrderId: created.body.data.deliveryOrderId,
    });
    const after = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `SELECT close_reason FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, body.orderId],
      ),
    );
    expect(after.rows[0].close_reason).toBe("Pelanggan membatalkan");

    const unknown = await send("gofood", {
      storeId: a.goStore,
      orderId: `GF-${randomUUID().slice(0, 8)}`,
      event: "order.cancelled",
      grossIdr: 0,
    });
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown.body)).toBe("DELIVERY_ORDER_NOT_FOUND");
  });
});

describe("platform cancel voids the POS order", () => {
  it("voids the queued lines and the KDS lines, releases the daily limit and voids the order", async () => {
    const body = payloadOf(a);
    const created = await send("gofood", body);
    expect(created.body.data.result).toBe("injected");
    const orderUuid = await asOwnerTenant(a.tenant.tenantId, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM orders WHERE tenant_id = $1 AND external_ref = $2`,
        [a.tenant.tenantId, body.orderId],
      );
      return rows[0]!.id;
    });
    const usage = async () =>
      asOwnerTenant(a.tenant.tenantId, async (db) => {
        const { rows } = await db.query<{ quantity: number }>(
          `SELECT u.quantity FROM menu_item_daily_usage u
             JOIN orders o ON o.tenant_id = u.tenant_id AND o.business_date = u.business_date
            WHERE u.tenant_id = $1 AND u.outlet_id = $2 AND u.menu_item_id = $3
              AND o.id = $4::uuid`,
          [a.tenant.tenantId, a.tenant.outletId, a.kopiId, orderUuid],
        );
        return rows[0]?.quantity ?? 0;
      });
    const reserved = await usage();
    expect(reserved).toBeGreaterThanOrEqual(2);

    const cancel = await send("gofood", {
      storeId: a.goStore,
      orderId: body.orderId,
      event: "order.cancelled",
      reason: "Driver tidak ditemukan",
      grossIdr: 0,
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe("cancelled");

    await asOwnerTenant(a.tenant.tenantId, async (db) => {
      const order = await db.query<{ status: string }>(
        `SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(order.rows[0]?.status).toBe("voided");
      const items = await db.query<{
        status: string;
        voided_by: string | null;
      }>(
        `SELECT status, voided_by FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(items.rows.length).toBeGreaterThan(0);
      for (const item of items.rows)
        expect(item).toEqual({ status: "voided", voided_by: null });
      const kitchen = await db.query<{ status: string }>(
        `SELECT status FROM kitchen_ticket_items WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(kitchen.rows.length).toBeGreaterThan(0);
      for (const line of kitchen.rows) expect(line.status).toBe("voided");
      const tickets = await db.query<{ status: string }>(
        `SELECT status FROM kitchen_tickets WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(tickets.rows.map((row) => row.status)).toEqual(["cancelled"]);
      // Same order event and audit as a POS void, by the system.
      const events = await db.query<{
        actor_id: string | null;
        payload: { reason: string; reasonNote: string };
      }>(
        `SELECT actor_id, payload FROM order_events
          WHERE tenant_id = $1 AND order_id = $2::uuid AND type = 'order.voided'`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({
        actor_id: null,
        payload: {
          reason: "customer_cancelled",
          reasonNote: "Driver tidak ditemukan",
        },
      });
      // The POS outbox carries the void too, so cloud sync and reports drop
      // the sale; a platform cancel has no approver.
      const outbox = await db.query<{ approved_by: string | null }>(
        `SELECT event->'payload'->>'approvedBy' AS approved_by
           FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'order.voided'
            AND event->'payload'->>'orderId' = $2`,
        [a.tenant.tenantId, created.body.data.orderId],
      );
      expect(outbox.rows).toEqual([{ approved_by: null }]);
      const audit = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'pos_order.voided'
            AND event->>'objectId' = $2`,
        [a.tenant.tenantId, created.body.data.orderId],
      );
      expect(Number(audit.rows[0]?.n)).toBe(1);
    });
    expect(await usage()).toBe(reserved - 2);
  });

  it("an order with captured money is not voided: needs_review and an audit entry", async () => {
    const body = payloadOf(a);
    const created = await send("gofood", body);
    expect(created.body.data.result).toBe("injected");
    const orderUuid = await asOwnerTenant(a.tenant.tenantId, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM orders WHERE tenant_id = $1 AND external_ref = $2`,
        [a.tenant.tenantId, body.orderId],
      );
      const id = rows[0]!.id;
      // A manual POS twin the cashier already took payment for (EDC card).
      await db.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, amount_idr,
            status, requested_at, resolved_at)
         VALUES ($1, $2, $3, 'edc_card', 'edc', $4, 'captured', now(), now())`,
        [a.tenant.tenantId, a.tenant.outletId, id, KOPI_IDR * 2],
      );
      return id;
    });
    const cancel = await send("gofood", {
      storeId: a.goStore,
      orderId: body.orderId,
      event: "order.cancelled",
      reason: "Pelanggan batal",
      grossIdr: 0,
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data).toMatchObject({
      result: "needs_review",
      status: "cancelled",
    });
    await asOwnerTenant(a.tenant.tenantId, async (db) => {
      const order = await db.query<{ status: string }>(
        `SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(order.rows[0]?.status).not.toBe("voided");
      const items = await db.query<{ status: string }>(
        `SELECT status FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      for (const item of items.rows) expect(item.status).not.toBe("voided");
      const audit = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_logs
          WHERE tenant_id = $1
            AND event->>'action' = 'pos_order.delivery_cancel_needs_review'
            AND event->>'objectId' = $2`,
        [a.tenant.tenantId, created.body.data.orderId],
      );
      expect(Number(audit.rows[0]?.n)).toBe(1);
    });
  });
});

describe("deliveryLinesChanged", () => {
  it("compares the variant id as stored (lower-cased), not as sent", () => {
    const variantId = randomUUID();
    const stored = [
      {
        lineNo: 1,
        externalItemId: "kopi-1",
        externalItemName: "Kopi Susu",
        menuItemId: randomUUID(),
        variantId,
        quantity: 1,
        unitPriceIdr: KOPI_IDR,
        lineTotalIdr: KOPI_IDR,
        modifiers: [],
        note: null,
        mapping: "matched",
        channelPriceIdr: KOPI_IDR,
      },
    ] as unknown as DeliveryOrderLine[];
    const item = {
      itemId: "kopi-1",
      name: "Kopi Susu",
      quantity: 1,
      unitPriceIdr: KOPI_IDR,
      modifiers: [],
    };
    expect(
      deliveryLinesChanged(stored, [
        { ...item, variantId: variantId.toUpperCase() },
      ]),
    ).toBe(false);
    expect(
      deliveryLinesChanged(stored, [{ ...item, variantId: randomUUID() }]),
    ).toBe(true);
  });
});

describe("replays, ordering and final orders", () => {
  const moneyOf = async (orderId: string) => {
    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query<{ gross_idr: string; status: string }>(
        `SELECT gross_idr, status FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, orderId],
      ),
    );
    return rows[0];
  };

  it("any payload already applied is a duplicate, never a rollback of the money", async () => {
    const first = payloadOf(a);
    await send("gofood", first);
    const changed = { ...first, grossIdr: KOPI_IDR * 2 + 7_000 };
    expect((await send("gofood", changed)).body.data.result).toBe("updated");
    // The first payload again (an older hash, not the stored one).
    const replay = await send("gofood", first);
    expect(replay.status).toBe(200);
    expect(replay.body.data.result).toBe("duplicate");
    expect((await moneyOf(first.orderId))?.gross_idr).toBe(
      String(KOPI_IDR * 2 + 7_000),
    );
  });

  it("a payload signed before the newest applied one is ignored", async () => {
    const now = Math.floor(Date.now() / 1000);
    const first = payloadOf(a);
    await send("gofood", first, { at: now });
    const stale = await send(
      "gofood",
      { ...first, grossIdr: KOPI_IDR * 2 + 9_000 },
      { at: now - 60 },
    );
    expect(stale.status).toBe(200);
    expect(stale.body.data.result).toBe("duplicate");
    expect((await moneyOf(first.orderId))?.gross_idr).toBe(
      String(KOPI_IDR * 2),
    );
  });

  it("a changed payload never touches the money of a final order", async () => {
    for (const status of ["cancelled", "picked_up", "delivered"] as const) {
      const body = payloadOf(a);
      await send("gofood", body);
      await asOwnerTenant(a.tenant.tenantId, (db) =>
        db.query(
          `UPDATE delivery_channel_orders
              SET status = $3::varchar,
                  picked_up_at = CASE WHEN $3::varchar = 'cancelled' THEN NULL ELSE now() END,
                  delivered_at = CASE WHEN $3::varchar = 'delivered' THEN now() ELSE NULL END,
                  closed_at = CASE WHEN $3::varchar = 'cancelled' THEN now() ELSE NULL END
            WHERE tenant_id = $1 AND external_order_id = $2`,
          [a.tenant.tenantId, body.orderId, status],
        ),
      );
      const late = { ...body, grossIdr: KOPI_IDR * 2 + 3_000 };
      const response = await send("gofood", late);
      expect(response.status).toBe(200);
      expect(response.body.data.result).toBe("duplicate");
      expect(await moneyOf(body.orderId)).toMatchObject({
        gross_idr: String(KOPI_IDR * 2),
        status,
      });
      // Its retry is a plain duplicate as well.
      expect((await send("gofood", late)).body.data.result).toBe("duplicate");
    }
  });

  it("an exact replay of an injected order whose auto-accept failed retries the accept", async () => {
    const body = payloadOf(a);
    setDeliveryChannelAdapter("gofood", {
      async execute() {
        throw new Error("platform down");
      },
    });
    let first;
    try {
      first = await send("gofood", body);
    } finally {
      setDeliveryChannelAdapter("gofood", null);
    }
    expect(first.body.data).toMatchObject({
      result: "injected",
      status: "received",
    });
    const replay = await send("gofood", body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      result: "duplicate",
      status: "accepted",
      orderId: first.body.data.orderId,
    });
    expect(
      recordedDeliveryCalls().filter(
        (call) =>
          call.action === "accept_order" &&
          (call.payload as { externalOrderId?: string }).externalOrderId ===
            body.orderId,
      ),
    ).toHaveLength(1);
  });

  it("a webhook for an order the cashier already rang up at the POS links to it", async () => {
    const body = payloadOf(a);
    const injected = await send("gofood", body);
    const posOrderId = injected.body.data.orderId as string;
    // Leaves only the POS order carrying the platform number (as manual ojol
    // entry at the POS does): no delivery row yet.
    await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `DELETE FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, body.orderId],
      ),
    );
    const response = await send("gofood", {
      ...body,
      customerNote: "Dari platform",
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      result: "injected",
      orderId: posOrderId,
    });
    expect(
      await count(a, "orders", "AND external_ref = $2", [body.orderId]),
    ).toBe(1);
    // One delivery row again, linked (the order id above is the POS order's).
    expect(
      await count(
        a,
        "delivery_channel_orders",
        "AND external_order_id = $2 AND order_id IS NOT NULL",
        [body.orderId],
      ),
    ).toBe(1);
  });
});

describe("voided POS twin", () => {
  it("a webhook for an order the cashier rang up and voided is kept for review, never auto-accepted", async () => {
    const body = payloadOf(a);
    const injected = await send("gofood", body);
    expect(injected.body.data.result).toBe("injected");
    clearRecordedDeliveryCalls();
    // Only the POS order with the platform number is left, and it is voided.
    await asOwnerTenant(a.tenant.tenantId, async (db) => {
      await db.query(
        `DELETE FROM delivery_channel_orders
          WHERE tenant_id = $1 AND external_order_id = $2`,
        [a.tenant.tenantId, body.orderId],
      );
      await db.query(
        `UPDATE orders SET status = 'voided', voided_at = now(), void_reason = 'Batal di kasir'
          WHERE tenant_id = $1 AND external_ref = $2`,
        [a.tenant.tenantId, body.orderId],
      );
    });
    const response = await send("gofood", { ...body, customerNote: "Lagi" });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      result: "needs_review",
      orderId: null,
      status: "received",
    });
    expect(
      recordedDeliveryCalls().filter((call) => call.action === "accept_order"),
    ).toEqual([]);
    expect(
      await count(a, "orders", "AND external_ref = $2", [body.orderId]),
    ).toBe(1);
  });
});

// E3b (CTO 26 Nov): the edge's kitchen never sees a cloud order, so for an
// outlet its edge serves the webhook neither injects nor accepts the order
// (the platform cancels it on its own); it is recorded, logged and alerted.
describe("outlet served by its edge (E3b)", () => {
  async function addEdge(s: Seeded): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, last_heartbeat_at)
       VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, now())`,
      [id, s.tenant.tenantId, s.tenant.outletId, "c".repeat(64)],
    );
    return id;
  }
  async function revoke(id: string): Promise<void> {
    await owner.query(
      "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [id],
    );
  }
  const acceptCalls = (externalOrderId: string) =>
    recordedDeliveryCalls().filter(
      (call) =>
        call.action === "accept_order" &&
        (call.payload as { externalOrderId?: string }).externalOrderId ===
          externalOrderId,
    );
  async function alertsOf(deliveryOrderId: string): Promise<number> {
    const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query<{ n: string }>(
        `SELECT count(*) AS n FROM notification_outbox
          WHERE tenant_id = $1 AND source_event_id = $2::uuid`,
        [a.tenant.tenantId, deliveryOrderId],
      ),
    );
    return Number(rows[0]?.n ?? 0);
  }

  it("a new order is stored, not injected, not accepted, and the outlet is alerted once", async () => {
    const edge = await addEdge(a);
    try {
      const body = payloadOf(a);
      const response = await send("gofood", body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toMatchObject({
        result: "needs_review",
        status: "received",
        orderId: null,
      });
      expect(
        await count(a, "orders", "AND external_ref = $2", [body.orderId]),
      ).toBe(0);
      expect(acceptCalls(body.orderId)).toHaveLength(0);
      const { rows } = await asOwnerTenant(a.tenant.tenantId, (db) =>
        db.query<{ id: string }>(
          `SELECT id FROM delivery_channel_orders
            WHERE tenant_id = $1 AND external_order_id = $2`,
          [a.tenant.tenantId, body.orderId],
        ),
      );
      expect(rows).toHaveLength(1);
      expect(await alertsOf(rows[0]!.id)).toBeGreaterThan(0);
      const alerts = await alertsOf(rows[0]!.id);

      const replay = await send("gofood", body);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({
        result: "duplicate",
        status: "received",
        orderId: null,
      });
      expect(
        await count(a, "orders", "AND external_ref = $2", [body.orderId]),
      ).toBe(0);
      expect(acceptCalls(body.orderId)).toHaveLength(0);
      expect(await alertsOf(rows[0]!.id)).toBe(alerts);
    } finally {
      await revoke(edge);
    }
  });

  it("an order injected before the edge whose accept failed is not accepted on a replay", async () => {
    const body = payloadOf(a);
    setDeliveryChannelAdapter("gofood", {
      async execute() {
        throw new Error("platform down");
      },
    });
    let first;
    try {
      first = await send("gofood", body);
    } finally {
      setDeliveryChannelAdapter("gofood", null);
    }
    expect(first.body.data).toMatchObject({
      result: "injected",
      status: "received",
    });
    const edge = await addEdge(a);
    try {
      const replay = await send("gofood", body);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({
        result: "duplicate",
        status: "received",
      });
      expect(acceptCalls(body.orderId)).toHaveLength(0);
    } finally {
      await revoke(edge);
    }
  });
});

describe("tenant isolation", () => {
  it("the same platform order id in two tenants is two independent orders", async () => {
    const orderId = `GF-SHARED-${randomUUID().slice(0, 6)}`;
    const forA = await send("gofood", payloadOf(a, { orderId }));
    const forB = await send("gofood", payloadOf(b, { orderId }));
    expect(forA.body.data.result).toBe("injected");
    expect(forB.body.data.result).toBe("injected");
    expect(forA.body.data.deliveryOrderId).not.toBe(
      forB.body.data.deliveryOrderId,
    );
    expect(
      await count(a, "delivery_channel_orders", "AND external_order_id = $2", [
        orderId,
      ]),
    ).toBe(1);
    expect(
      await count(b, "delivery_channel_orders", "AND external_order_id = $2", [
        orderId,
      ]),
    ).toBe(1);
  });

  it("a payload naming another tenant's menu item never maps to it", async () => {
    // Tenant A's store, tenant B's menu item id: unknown to A, so it needs review.
    const orderId = `GF-${randomUUID().slice(0, 8)}`;
    const response = await send("gofood", payloadOf(a, { orderId }, b.kopiId));
    expect(response.body.data.result).toBe("needs_review");
    expect(await count(a, "orders", "AND external_ref = $2", [orderId])).toBe(
      0,
    );
    expect(
      await count(b, "delivery_channel_orders", "AND external_order_id = $2", [
        orderId,
      ]),
    ).toBe(0);
  });

  it("a store id resolves only its own tenant: tenant A's store never writes into tenant B", async () => {
    const orderId = `GF-${randomUUID().slice(0, 8)}`;
    await send("gofood", payloadOf(a, { orderId }));
    expect(
      await count(b, "delivery_channel_orders", "AND external_order_id = $2", [
        orderId,
      ]),
    ).toBe(0);
  });
});
