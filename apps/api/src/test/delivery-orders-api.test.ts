// Delivery channel orders API (bead legend-5bn3, slice D4): list paging,
// detail, manual order, status steps through the contract machine, KDS void
// on an early cancel, adapter push for platform orders (a stored intent pushed
// by the outbox consumer after the commit, legend-bk99), needs_review orders
// only turned down, and Idempotency-Key.
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`), one fresh isolated tenant.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import {
  PERMISSION_CODES,
  tenantPermissionCodeSchema,
} from "@starter/shared/access";
import {
  deliveryChannelOrderSchema,
  listDeliveryOrdersQuerySchema,
} from "@starter/shared/delivery";
import { createApp } from "../app.ts";
import { db as appDb } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setDeliveryChannelAdapter } from "../services/delivery-ports.ts";
import { listDeliveryOrders } from "../services/delivery-orders.service.ts";
import { deliverDeliveryChannelEvent } from "../services/delivery-sync-consumer.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;

let app: Express;
let tenant: Awaited<ReturnType<typeof createIsolatedTenant>>;
let client: ReturnType<typeof agent>;
let kopiId: string;

async function asOwnerTenant<T>(
  run: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    const result = await run(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`dlo-${randomUUID().slice(0, 6)}`);
  const roleId = randomUUID();
  const permissions = PERMISSION_CODES.filter(
    (code) => tenantPermissionCodeSchema.safeParse(code).success,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Delivery Uji', false, NULL, $3, false, '["tenant"]')`,
    [roleId, tenant.tenantId, JSON.stringify(permissions)],
  );
  client = agent(app);
  await signUp(client, "Delivery Orders");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  const categoryId = randomUUID();
  kopiId = randomUUID();
  const priceListId = randomUUID();
  await asOwnerTenant(async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Delivery Uji', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [kopiId, tenant.tenantId, tenant.brandId, categoryId, randomUUID()],
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
    await db.query(
      `INSERT INTO delivery_channels
         (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
       VALUES ($1, $2, 'gofood', $3, 2000, true)`,
      [tenant.tenantId, tenant.outletId, `store-${randomUUID().slice(0, 8)}`],
    );
  });
});

afterAll(async () => {
  setDeliveryChannelAdapter("gofood", null);
  await owner.end();
});

afterEach(() => setDeliveryChannelAdapter("gofood", null));

const base = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}`;
const headers = () => ({ Host: tenant.hostname });

function post(path: string, body: Record<string, unknown>, key?: string) {
  const req = client
    .post(`${base()}${path}`)
    .set(headers())
    .set(originHeader)
    .set("Idempotency-Key", key ?? randomUUID());
  return req.send(body);
}

const get = (path: string) =>
  client.get(`${base()}${path}`).set(headers()).set(originHeader);

async function manualOrder(quantity = 2) {
  const res = await post("/delivery-orders/manual", {
    platform: "gofood",
    externalOrderId: `M-${randomUUID().slice(0, 8)}`,
    lines: [{ menuItemId: kopiId, quantity }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return deliveryChannelOrderSchema.parse(res.body.data);
}

/** A platform order that was imported by the webhook: no KDS order needed here. */
async function seedPlatformOrder(status = "received"): Promise<string> {
  const line = {
    lineNo: 1,
    externalItemId: "ext-kopi",
    externalItemName: "Kopi Susu",
    menuItemId: kopiId,
    variantId: null,
    quantity: 1,
    unitPriceIdr: KOPI_IDR,
    lineTotalIdr: KOPI_IDR,
    modifiers: [],
    note: null,
    mapping: "matched",
    channelPriceIdr: KOPI_IDR,
  };
  return asOwnerTenant(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO delivery_channel_orders
         (tenant_id, outlet_id, platform, external_order_id, status, source,
          gross_idr, commission_idr, payload_hash, lines, received_at)
       VALUES ($1, $2, 'gofood', $3, $4, 'platform', $5, 5000, $6, $7, now())
       RETURNING id`,
      [
        tenant.tenantId,
        tenant.outletId,
        `P-${randomUUID().slice(0, 8)}`,
        status,
        KOPI_IDR,
        "a".repeat(64),
        JSON.stringify([line]),
      ],
    );
    return rows[0]!.id;
  });
}

/**
 * A platform order already on the KDS (`order_id` set), waiting in `received`:
 * a manual order turned into a platform one, so the KDS order exists.
 */
async function seedInjectedPlatformOrder(): Promise<string> {
  const order = await manualOrder(1);
  await asOwnerTenant((db) =>
    db.query(
      `UPDATE delivery_channel_orders
          SET source = 'platform', status = 'received', accepted_at = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, order.id],
    ),
  );
  return order.id;
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

describe("delivery orders: manual order, list and detail", () => {
  it("records a manual order priced by the server, accepted, with commission", async () => {
    const order = await manualOrder(2);
    expect(order).toMatchObject({
      source: "manual_pos",
      status: "accepted",
      grossIdr: KOPI_IDR * 2,
      commissionIdr: KOPI_IDR * 2 * 0.2,
    });
    const read = await get(`/delivery-orders/${order.id}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(deliveryChannelOrderSchema.parse(read.body.data).id).toBe(order.id);
  });

  it("replays a manual order with the same Idempotency-Key as the same answer", async () => {
    const key = randomUUID();
    const body = {
      platform: "gofood",
      externalOrderId: `IDEM-${randomUUID().slice(0, 8)}`,
      lines: [{ menuItemId: kopiId, quantity: 1 }],
    };
    const first = await post("/delivery-orders/manual", body, key);
    const second = await post("/delivery-orders/manual", body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it("pages newest first with an opaque cursor and filters by status", async () => {
    await manualOrder();
    await manualOrder();
    const first = await get("/delivery-orders?limit=1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));
    const second = await get(
      `/delivery-orders?limit=1&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect(
      new Date(second.body.data[0].receivedAt).getTime(),
    ).toBeLessThanOrEqual(new Date(first.body.data[0].receivedAt).getTime());
    const filtered = await get("/delivery-orders?status=rejected");
    expect(filtered.body.data).toEqual([]);
    const badCursor = await get("/delivery-orders?cursor=not-a-cursor");
    expect(badCursor.status).toBe(400);
  });

  it("answers 404 for an unknown order", async () => {
    const res = await get(`/delivery-orders/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(errorCode(res.body)).toBe("DELIVERY_ORDER_NOT_FOUND");
  });

  it("legend-5v8sm filters attention before pagination and keeps the existing review predicate", async () => {
    const sync = await seedPlatformOrder();
    const unmatched = await seedPlatformOrder();
    const soldOut = await seedPlatformOrder();
    const terminalUnmatched = await seedPlatformOrder("cancelled");
    const priceMismatch = await seedPlatformOrder();
    const retrying = await seedPlatformOrder();
    const ordinary = await seedPlatformOrder();
    const injected = await manualOrder(1);
    const ids = [
      sync,
      unmatched,
      soldOut,
      terminalUnmatched,
      priceMismatch,
      retrying,
      ordinary,
      injected.id,
    ];
    await asOwnerTenant(async (db) => {
      for (const [index, id] of ids.entries()) {
        await db.query(
          "UPDATE delivery_channel_orders SET received_at = '2090-01-01'::timestamptz + $3 * interval '1 minute' WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, id, index],
        );
      }
      await db.query(
        "UPDATE delivery_channel_orders SET platform_sync_state = 'needs_action' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, sync],
      );
      await db.query(
        "UPDATE delivery_channel_orders SET platform_sync_state = 'retrying', platform_sync_action = 'accept_order', platform_sync_status = 'accepted', platform_sync_next_at = now() WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, retrying],
      );
      for (const id of [unmatched, terminalUnmatched]) {
        await db.query(
          `UPDATE delivery_channel_orders
           SET lines = jsonb_set(jsonb_set(jsonb_set(lines, '{0,mapping}', '"unmatched"'), '{0,menuItemId}', 'null'), '{0,channelPriceIdr}', 'null')
           WHERE tenant_id = $1 AND id = $2`,
          [tenant.tenantId, id],
        );
      }
      await db.query(
        "UPDATE delivery_channel_orders SET status = 'received' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, injected.id],
      );
      await db.query(
        `UPDATE delivery_channel_orders SET lines = jsonb_set(lines, '{0,mapping}', '"sold_out"') WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenant.tenantId, [soldOut, injected.id]],
      );
      await db.query(
        "UPDATE delivery_channel_orders SET closed_at = now() WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, terminalUnmatched],
      );
      await db.query(
        `UPDATE delivery_channel_orders SET lines = jsonb_set(jsonb_set(lines, '{0,mapping}', '"price_mismatch"'), '{0,channelPriceIdr}', '24000') WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, priceMismatch],
      );
    });

    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const attentionQuery = {
      ...listDeliveryOrdersQuerySchema.parse({ limit: 1 }),
      attention: true,
    };
    const servicePage = await listDeliveryOrders(
      context,
      outletIdSchema.parse(tenant.outletId),
      attentionQuery,
    );
    expect(servicePage.data.map((order) => order.id)).toEqual([soldOut]);

    const found: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const response = await get(
        `/delivery-orders?attention=true&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toHaveLength(1);
      found.push(response.body.data[0].id);
      cursor = response.body.meta.nextCursor;
    }
    expect(found).toEqual([soldOut, unmatched, sync]);
    expect(cursor).toBeNull();
    const unfiltered = await get("/delivery-orders?attention=false&limit=1");
    expect(unfiltered.status, JSON.stringify(unfiltered.body)).toBe(200);
    expect(unfiltered.body.data[0].id).toBe(injected.id);
    const invalid = await get("/delivery-orders?attention=yes");
    expect([400, 422]).toContain(invalid.status);
  });
});

describe("delivery orders: status steps", () => {
  it("walks accepted to picked_up through the machine and refuses a skipped step", async () => {
    const order = await manualOrder();
    const skip = await post(`/delivery-orders/${order.id}/status`, {
      status: "picked_up",
    });
    expect(skip.status).toBe(409);
    expect(errorCode(skip.body)).toBe("DELIVERY_TRANSITION_INVALID");
    for (const status of ["preparing", "ready", "picked_up"]) {
      const step = await post(`/delivery-orders/${order.id}/status`, {
        status,
      });
      expect(step.status, JSON.stringify(step.body)).toBe(200);
      expect(step.body.data.status).toBe(status);
    }
    const done = await get(`/delivery-orders/${order.id}`);
    expect(done.body.data.readyAt).not.toBeNull();
    expect(done.body.data.pickedUpAt).not.toBeNull();
  });

  it("needs a reason to cancel and voids the queued KDS lines", async () => {
    const order = await manualOrder();
    const noReason = await post(`/delivery-orders/${order.id}/status`, {
      status: "cancelled",
    });
    expect(noReason.status).toBe(422);
    const cancelled = await post(`/delivery-orders/${order.id}/status`, {
      status: "cancelled",
      reason: "Pelanggan membatalkan",
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      status: "cancelled",
      closeReason: "Pelanggan membatalkan",
    });
    expect(cancelled.body.data.closedAt).not.toBeNull();
    const orderUuid = ulidToUuid(order.orderId!);
    await asOwnerTenant(async (db) => {
      const row = await db.query<{ status: string }>(
        `SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
        [tenant.tenantId, orderUuid],
      );
      expect(row.rows[0]?.status).toBe("voided");
      const items = await db.query<{ status: string }>(
        `SELECT status FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [tenant.tenantId, orderUuid],
      );
      expect(items.rows.length).toBeGreaterThan(0);
      for (const item of items.rows) expect(item.status).toBe("voided");
    });
    const again = await post(`/delivery-orders/${order.id}/status`, {
      status: "cancelled",
      reason: "Lagi",
    });
    expect(again.status).toBe(409);
  });

  it("replays a status step with the same Idempotency-Key", async () => {
    const order = await manualOrder();
    const key = randomUUID();
    const first = await post(
      `/delivery-orders/${order.id}/status`,
      { status: "preparing" },
      key,
    );
    const second = await post(
      `/delivery-orders/${order.id}/status`,
      { status: "preparing" },
      key,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe("preparing");
  });
});

/**
 * Runs the outbox consumer (worker-main.ts) over the status events of one
 * order, in sequence, each in its own consumption transaction. `edit` lets a
 * test change the stored envelope first.
 */
async function consumeStatusEvents(
  id: string,
  edit?: (event: EventEnvelope) => EventEnvelope,
): Promise<void> {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  const events = await asOwnerTenant(async (db) => {
    const { rows } = await db.query<{ event: EventEnvelope }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'delivery_order.status_changed'
          AND event->>'aggregateId' = $2
        ORDER BY sequence`,
      [tenant.tenantId, id],
    );
    return rows.map((row) => row.event);
  });
  for (const event of events)
    await withTenant(appDb, context, (tx) =>
      deliverDeliveryChannelEvent(context, edit ? edit(event) : event, tx),
    );
}

const desyncOutcomes = (id: string) =>
  asOwnerTenant(async (db) => {
    const audit = await db.query<{ outcome: string }>(
      `SELECT event->'maskedChanges'->'after'->>'outcome' AS outcome FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
          AND event->>'action' = 'delivery_order.platform_desync'`,
      [tenant.tenantId, id],
    );
    return audit.rows.map((row) => row.outcome);
  });

describe("delivery orders: platform orders push the adapter action after the commit", () => {
  it("stores the step as an intent and pushes accept_order from the outbox consumer", async () => {
    const calls: { action: string; reference: string }[] = [];
    setDeliveryChannelAdapter("gofood", {
      execute: async (_context, input) => {
        calls.push({ action: input.action, reference: input.reference });
        return { reference: input.reference, accepted: true };
      },
    });
    const id = await seedInjectedPlatformOrder();
    const res = await post(`/delivery-orders/${id}/status`, {
      status: "accepted",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.acceptedAt).not.toBeNull();
    // Nothing reached the platform inside the request transaction.
    expect(calls).toEqual([]);
    await consumeStatusEvents(id);
    expect(calls).toEqual([
      { action: "accept_order", reference: `${id}:accepted` },
    ]);
  });

  it("commits the step when the platform is down and records an unknown desync without stalling the order's outbox", async () => {
    const references: string[] = [];
    setDeliveryChannelAdapter("gofood", {
      execute: async (_context, input) => {
        references.push(input.reference);
        throw new Error("platform down");
      },
    });
    const id = await seedInjectedPlatformOrder();
    const res = await post(`/delivery-orders/${id}/status`, {
      status: "accepted",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // A throwing adapter must not fail the consumption (dead-letter would
    // park every later event of this order): audited as unknown instead.
    await expect(consumeStatusEvents(id)).resolves.toBeUndefined();
    const read = await get(`/delivery-orders/${id}`);
    expect(read.body.data.status).toBe("accepted");
    expect(references).toEqual([`${id}:accepted`]);
    expect(await desyncOutcomes(id)).toEqual(["unknown"]);
  });

  it("records a refused push as a desync and settles the event", async () => {
    setDeliveryChannelAdapter("gofood", {
      execute: async (_context, input) => ({
        reference: input.reference,
        accepted: false,
      }),
    });
    const id = await seedInjectedPlatformOrder();
    const res = await post(`/delivery-orders/${id}/status`, {
      status: "accepted",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await consumeStatusEvents(id);
    expect(await desyncOutcomes(id)).toEqual(["refused"]);
  });

  it("a replay with the same Idempotency-Key stores one intent", async () => {
    const calls: string[] = [];
    setDeliveryChannelAdapter("gofood", {
      execute: async (_context, input) => {
        calls.push(input.action);
        return { reference: input.reference, accepted: true };
      },
    });
    const id = await seedInjectedPlatformOrder();
    const key = randomUUID();
    const first = await post(
      `/delivery-orders/${id}/status`,
      { status: "accepted" },
      key,
    );
    const replay = await post(
      `/delivery-orders/${id}/status`,
      { status: "accepted" },
      key,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(replay.status).toBe(200);
    await consumeStatusEvents(id);
    expect(calls).toEqual(["accept_order"]);
  });

  it("does not push a step the platform itself started (system actor)", async () => {
    const calls: string[] = [];
    setDeliveryChannelAdapter("gofood", {
      execute: async (_context, input) => {
        calls.push(input.action);
        return { reference: input.reference, accepted: true };
      },
    });
    const id = await seedInjectedPlatformOrder();
    await post(`/delivery-orders/${id}/status`, { status: "accepted" });
    await consumeStatusEvents(id, (event) => ({
      ...event,
      actor: { type: "system" },
    }));
    expect(calls).toEqual([]);
  });

  it("refuses to accept while the store is closed but still allows reject", async () => {
    const calls: string[] = [];
    setDeliveryChannelAdapter("gofood", {
      execute: async (_context, input) => {
        calls.push(input.action);
        return { reference: input.reference, accepted: true };
      },
    });
    const id = await seedInjectedPlatformOrder();
    await asOwnerTenant((db) =>
      db.query(
        `UPDATE delivery_channels SET is_open = false
          WHERE tenant_id = $1 AND outlet_id = $2 AND platform = 'gofood'`,
        [tenant.tenantId, tenant.outletId],
      ),
    );
    try {
      const accept = await post(`/delivery-orders/${id}/status`, {
        status: "accepted",
      });
      expect(accept.status).toBe(409);
      expect(errorCode(accept.body)).toBe("DELIVERY_CHANNEL_CLOSED");
      const reject = await post(`/delivery-orders/${id}/status`, {
        status: "rejected",
        reason: "Toko tutup",
      });
      expect(reject.status, JSON.stringify(reject.body)).toBe(200);
      await consumeStatusEvents(id);
      expect(calls).toEqual(["cancel_order"]);
    } finally {
      await asOwnerTenant((db) =>
        db.query(
          `UPDATE delivery_channels SET is_open = true
            WHERE tenant_id = $1 AND outlet_id = $2 AND platform = 'gofood'`,
          [tenant.tenantId, tenant.outletId],
        ),
      );
    }
  });
});

describe("delivery orders: an order kept for review", () => {
  it("refuses to move a needs_review order forward but allows a reject", async () => {
    const calls: string[] = [];
    setDeliveryChannelAdapter("gofood", {
      execute: async (_context, input) => {
        calls.push(input.action);
        return { reference: input.reference, accepted: true };
      },
    });
    const id = await seedPlatformOrder();
    const accept = await post(`/delivery-orders/${id}/status`, {
      status: "accepted",
    });
    expect(accept.status).toBe(422);
    expect(errorCode(accept.body)).toBe("DELIVERY_MAPPING_INCOMPLETE");
    expect(calls).toEqual([]);
    const read = await get(`/delivery-orders/${id}`);
    expect(read.body.data.status).toBe("received");
    const reject = await post(`/delivery-orders/${id}/status`, {
      status: "rejected",
      reason: "Menu belum dipetakan",
    });
    expect(reject.status, JSON.stringify(reject.body)).toBe(200);
    expect(reject.body.data.status).toBe("rejected");
    await consumeStatusEvents(id);
    expect(calls).toEqual(["cancel_order"]);
  });
});
