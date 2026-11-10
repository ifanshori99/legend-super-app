// KDS-05 on delivery channels (CTO decision D3): a menu line the kitchen paused
// for a delivery platform (kitchen_channel_pauses, channels naming the
// platform) is honoured by both delivery entry points.
// - Manual order (POST .../delivery-orders/manual): the cashier records the
//   order, so the whole order is refused 409 CONFLICT "KDS-05: ..." when one
//   line is paused for that platform. Other platforms and unpaused lines are
//   unaffected.
// - Webhook: the platform already took the customer's money, so a paid order is
//   never held or refused. A paused line is injected and auto-accepted exactly
//   like an unpaused one (mapping stays `matched`, platform_sync_state
//   untouched) and ONE audit entry `delivery_order.paused_line_accepted` is
//   recorded on the delivery order (none when nothing is paused).
// Pauses are inserted directly (reason `manual`, no expiry), as in
// kds-pacing.test.ts. Real Express apps, Better Auth, RBAC, PostgreSQL with RLS,
// two fresh isolated tenants.
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signDeliveryWebhook } from "@starter/shared/adapters";
import {
  PERMISSION_CODES,
  tenantPermissionCodeSchema,
} from "@starter/shared/access";
import { createApp } from "../app.ts";
import { errorHandler } from "../middleware/error-handler";
import { createDeliveryWebhookRouter } from "../routes/delivery-webhook.routes";
import {
  clearRecordedDeliveryCalls,
  recordedDeliveryCalls,
} from "../services/delivery-ports.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const TEH_IDR = 12_000;
const GO_SECRET = "gofood-pacing-secret-0123456789";
const GRAB_SECRET = "grabfood-pacing-secret-0123456789";

type World = {
  tenant: IsolatedTenant;
  kopiId: string;
  tehId: string;
  goStore: string;
  grabStore: string;
  client: ReturnType<typeof agent>;
};

let api: Express;
let webhook: Express;
let a: World;
let b: World;

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

async function seedWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `dpc-${label}-${randomUUID().slice(0, 6)}`,
  );
  const categoryId = randomUUID();
  const kopiId = randomUUID();
  const tehId = randomUUID();
  const goStore = `go-${label}-${randomUUID().slice(0, 8)}`;
  const grabStore = `grab-${label}-${randomUUID().slice(0, 8)}`;
  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Pacing Delivery', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [kopiId, "Kopi Susu"],
      [tehId, "Es Teh"],
    ] as const)
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_type)
         VALUES ($1, $2, $3, $4, $5, true, $6, 'coffee_bar')`,
        [id, tenant.tenantId, tenant.brandId, categoryId, name, randomUUID()],
      );
    await db.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Bar Kopi', 'coffee_bar')`,
      [randomUUID(), tenant.tenantId, tenant.outletId],
    );
    for (const channel of ["gofood", "grabfood"]) {
      const priceListId = randomUUID();
      await db.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [priceListId, tenant.tenantId, tenant.outletId, channel],
      );
      for (const [itemId, price] of [
        [kopiId, KOPI_IDR],
        [tehId, TEH_IDR],
      ] as const)
        await db.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenant.tenantId, priceListId, itemId, price],
        );
    }
    // Both platforms are open and linked to a store id.
    await db.query(
      `INSERT INTO delivery_channels
         (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
       VALUES ($1, $2, 'gofood', $3, 2000, true),
              ($1, $2, 'grabfood', $4, 1500, true)`,
      [tenant.tenantId, tenant.outletId, goStore, grabStore],
    );
  });

  // A cashier-like user with every tenant permission, for the manual endpoint.
  const roleId = randomUUID();
  const permissions = PERMISSION_CODES.filter(
    (code) => tenantPermissionCodeSchema.safeParse(code).success,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Delivery Pacing Uji', false, NULL, $3, false, '["tenant"]')`,
    [roleId, tenant.tenantId, JSON.stringify(permissions)],
  );
  const client = agent(api);
  await signUp(client, `Delivery Pacing ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { tenant, kopiId, tehId, goStore, grabStore, client };
}

/** A manual pause (no expiry) of one menu item for the named channels. */
async function pause(w: World, menuItemId: string, channels: string[]) {
  await asOwnerTenant(w.tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO kitchen_channel_pauses
         (id, tenant_id, outlet_id, menu_item_id, variant_id, channels, reason, paused_until)
       VALUES ($1, $2, $3, $4, NULL, $5::jsonb, 'manual', NULL)`,
      [
        randomUUID(),
        w.tenant.tenantId,
        w.tenant.outletId,
        menuItemId,
        JSON.stringify(channels),
      ],
    ),
  );
}

async function releaseAllPauses(w: World) {
  await asOwnerTenant(w.tenant.tenantId, (db) =>
    db.query(`DELETE FROM kitchen_channel_pauses WHERE tenant_id = $1`, [
      w.tenant.tenantId,
    ]),
  );
}

function manual(
  w: World,
  platform: "gofood" | "grabfood",
  menuItemIds: string[],
) {
  return w.client
    .post(
      `/api/outlets/${encodeURIComponent(w.tenant.outletId)}/delivery-orders/manual`,
    )
    .set({ Host: w.tenant.hostname })
    .set(originHeader)
    .set("Idempotency-Key", randomUUID())
    .send({
      platform,
      externalOrderId: `M-${randomUUID().slice(0, 8)}`,
      lines: menuItemIds.map((menuItemId) => ({ menuItemId, quantity: 1 })),
    });
}

function expectPausedRefusal(res: {
  status: number;
  body: { error?: { code?: string; message?: string } };
}) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error?.code).toBe("CONFLICT");
  expect(res.body.error?.message).toMatch(/KDS-05/);
}

const deliveryOrderCount = async (w: World) => {
  const { rows } = await asOwnerTenant(w.tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM delivery_channel_orders WHERE tenant_id = $1",
      [w.tenant.tenantId],
    ),
  );
  return Number(rows[0]!.n);
};

function payload(
  w: World,
  platform: "gofood" | "grabfood",
  itemIds: string[],
  orderId = `${platform === "gofood" ? "GF" : "GR"}-${randomUUID().slice(0, 8)}`,
) {
  const price = (id: string) => (id === w.kopiId ? KOPI_IDR : TEH_IDR);
  return {
    storeId: platform === "gofood" ? w.goStore : w.grabStore,
    orderId,
    grossIdr: itemIds.reduce((sum, id) => sum + price(id), 0),
    items: itemIds.map((itemId) => ({
      itemId,
      name: itemId === w.kopiId ? "Kopi Susu" : "Es Teh",
      quantity: 1,
      unitPriceIdr: price(itemId),
      modifiers: [],
    })),
  };
}

async function send(platform: "gofood" | "grabfood", body: unknown) {
  const raw = JSON.stringify(body);
  const signature = await signDeliveryWebhook({
    rawBody: raw,
    secret: platform === "gofood" ? GO_SECRET : GRAB_SECRET,
  });
  return request(webhook)
    .post(`/api/webhooks/delivery/${platform}`)
    .set("Content-Type", "application/json")
    .set("X-Delivery-Signature", signature)
    .send(raw);
}

type StoredOrder = {
  order_id: string | null;
  status: string;
  lines: { menuItemId: string | null; mapping: string }[];
  platform_sync_state: string;
  platform_sync_action: string | null;
  platform_sync_status: string | null;
  platform_sync_attempts: number;
  platform_sync_next_at: Date | null;
};

async function stored(w: World, externalOrderId: string): Promise<StoredOrder> {
  const { rows } = await asOwnerTenant(w.tenant.tenantId, (db) =>
    db.query<StoredOrder>(
      `SELECT order_id, status, lines, platform_sync_state, platform_sync_action,
              platform_sync_status, platform_sync_attempts, platform_sync_next_at
         FROM delivery_channel_orders
        WHERE tenant_id = $1 AND external_order_id = $2`,
      [w.tenant.tenantId, externalOrderId],
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const posOrderCount = async (w: World, externalRef: string) => {
  const { rows } = await asOwnerTenant(w.tenant.tenantId, (db) =>
    db.query<{ orders: string; tickets: string }>(
      `SELECT (SELECT count(*) FROM orders o
                WHERE o.tenant_id = $1 AND o.external_ref = $2)::text AS orders,
              (SELECT count(*) FROM kitchen_tickets t
                 JOIN orders o ON o.id = t.order_id AND o.tenant_id = t.tenant_id
                WHERE t.tenant_id = $1 AND o.external_ref = $2)::text AS tickets`,
      [w.tenant.tenantId, externalRef],
    ),
  );
  return {
    orders: Number(rows[0]!.orders),
    tickets: Number(rows[0]!.tickets),
  };
};

/** Audit entries `delivery_order.paused_line_accepted` of one delivery order. */
async function pausedLineAudits(w: World, deliveryOrderId: string) {
  const { rows } = await asOwnerTenant(w.tenant.tenantId, (db) =>
    db.query<{ event: Record<string, unknown> }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1
          AND event->>'action' = 'delivery_order.paused_line_accepted'
          AND event->>'objectId' = $2`,
      [w.tenant.tenantId, deliveryOrderId],
    ),
  );
  return rows.map((row) => row.event);
}

const mappingOf = (row: StoredOrder, menuItemId: string) =>
  row.lines.find((line) => line.menuItemId === menuItemId)?.mapping;

const acceptCalls = (externalOrderId: string) =>
  recordedDeliveryCalls().filter(
    (call) =>
      call.action === "accept_order" &&
      (call.payload as { externalOrderId?: string } | undefined)
        ?.externalOrderId === externalOrderId,
  );

beforeAll(async () => {
  api = createApp();
  webhook = express();
  webhook.use(
    "/api/webhooks/delivery",
    createDeliveryWebhookRouter({
      secrets: { gofood: [GO_SECRET], grabfood: [GRAB_SECRET] },
    }),
  );
  webhook.use(errorHandler);
  a = await seedWorld("a");
  b = await seedWorld("b");
});

beforeEach(async () => {
  clearRecordedDeliveryCalls();
  // Every test starts without any pause in either tenant.
  await releaseAllPauses(a);
  await releaseAllPauses(b);
});

afterAll(async () => {
  for (const w of [a, b])
    if (w)
      await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
        w.tenant.tenantId,
        randomUUID(),
      ]);
  await owner.end();
});

describe("KDS-05 manual delivery order honours channel pauses", () => {
  it("refuses the whole order when a line is paused for that platform, creating nothing", async () => {
    await pause(a, a.kopiId, ["gofood"]);
    const before = await deliveryOrderCount(a);
    // Teh is not paused, but one paused line refuses the whole order.
    const res = await manual(a, "gofood", [a.tehId, a.kopiId]);
    expectPausedRefusal(res);
    // The message names the line number (line 2 = Kopi Susu).
    expect(res.body.error?.message).toMatch(/2/);
    expect(res.body.error?.message).toMatch(/gofood/);
    expect(await deliveryOrderCount(a)).toBe(before);
  });

  it("accepts the same line on another platform that is not paused", async () => {
    await pause(a, a.kopiId, ["gofood"]);
    const res = await manual(a, "grabfood", [a.kopiId]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      platform: "grabfood",
      source: "manual_pos",
      status: "accepted",
    });
  });

  it("accepts an order whose lines are not paused, even when another line is paused", async () => {
    await pause(a, a.kopiId, ["gofood"]);
    const res = await manual(a, "gofood", [a.tehId]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      platform: "gofood",
      status: "accepted",
      grossIdr: TEH_IDR,
    });
  });

  it("accepts the line again once the pause is gone", async () => {
    await pause(a, a.kopiId, ["gofood"]);
    expectPausedRefusal(await manual(a, "gofood", [a.kopiId]));
    await releaseAllPauses(a);
    const res = await manual(a, "gofood", [a.kopiId]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe("KDS-05 webhook delivery order is never held for a pause", () => {
  it("injects and auto-accepts like an unpaused order, both lines matched, one audit entry", async () => {
    await pause(a, a.kopiId, ["gofood"]);
    const body = payload(a, "gofood", [a.kopiId, a.tehId]);
    const response = await send("gofood", body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      result: "injected",
      status: "accepted",
    });
    expect(response.body.data.orderId).toEqual(expect.any(String));
    expect(response.body.data.pickupNumber).toMatch(/^GF-\d{3}$/);

    const row = await stored(a, body.orderId);
    expect(row.status).toBe("accepted");
    expect(row.order_id).not.toBeNull();
    // No sold_out marking: the pause does not change the mapping.
    expect(mappingOf(row, a.kopiId)).toBe("matched");
    expect(mappingOf(row, a.tehId)).toBe("matched");
    // POS order and KDS ticket exist; the platform was told to accept.
    const created = await posOrderCount(a, body.orderId);
    expect(created.orders).toBe(1);
    expect(created.tickets).toBeGreaterThan(0);
    expect(acceptCalls(body.orderId)).toHaveLength(1);

    // One audit entry naming the paused line, on the delivery order row.
    const audits = await pausedLineAudits(
      a,
      response.body.data.deliveryOrderId,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "delivery_order.paused_line_accepted",
      objectType: "delivery_channel_order",
      objectId: response.body.data.deliveryOrderId,
      // `after` is stored under `maskedChanges` by the audit writer.
      maskedChanges: {
        after: {
          platform: "gofood",
          pausedLines: [{ menuItemId: a.kopiId, variantId: null }],
        },
      },
    });
    // Only the paused line is listed, never the unpaused one.
    expect(JSON.stringify(audits[0])).not.toContain(a.tehId);
  });

  it("records no audit entry when nothing is paused (control)", async () => {
    const body = payload(a, "gofood", [a.kopiId]);
    const response = await send("gofood", body);
    expect(response.body.data.result).toBe("injected");
    expect(mappingOf(await stored(a, body.orderId), a.kopiId)).toBe("matched");
    expect(
      await pausedLineAudits(a, response.body.data.deliveryOrderId),
    ).toEqual([]);
  });

  it("does not audit a line paused only for another platform", async () => {
    await pause(a, a.kopiId, ["gofood"]);
    const body = payload(a, "grabfood", [a.kopiId]);
    const response = await send("grabfood", body);
    expect(response.body.data.result).toBe("injected");
    expect(mappingOf(await stored(a, body.orderId), a.kopiId)).toBe("matched");
    expect(
      await pausedLineAudits(a, response.body.data.deliveryOrderId),
    ).toEqual([]);
  });

  it("leaves platform_sync_state untouched, the same as an unpaused order", async () => {
    const control = payload(a, "gofood", [a.kopiId]);
    expect((await send("gofood", control)).body.data.result).toBe("injected");
    const controlRow = await stored(a, control.orderId);

    await pause(a, a.kopiId, ["gofood"]);
    const body = payload(a, "gofood", [a.kopiId]);
    const response = await send("gofood", body);
    expect(response.body.data.result).toBe("injected");
    const row = await stored(a, body.orderId);

    expect(row.platform_sync_state).toBe("ok");
    expect(row.platform_sync_action).toBeNull();
    expect(row.platform_sync_status).toBeNull();
    expect(row.platform_sync_next_at).toBeNull();
    expect({
      state: row.platform_sync_state,
      action: row.platform_sync_action,
      status: row.platform_sync_status,
      attempts: row.platform_sync_attempts,
      order: row.status,
    }).toEqual({
      state: controlRow.platform_sync_state,
      action: controlRow.platform_sync_action,
      status: controlRow.platform_sync_status,
      attempts: controlRow.platform_sync_attempts,
      order: controlRow.status,
    });
    expect(acceptCalls(body.orderId)).toHaveLength(1);
  });
});

describe("KDS-05 delivery pauses never cross tenants", () => {
  it("tenant A's pause does not refuse tenant B's manual order nor audit B's webhook order", async () => {
    await pause(a, a.kopiId, ["gofood", "grabfood"]);
    // Tenant B has no pause: its manual order is accepted ...
    const res = await manual(b, "gofood", [b.kopiId]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // ... and its webhook order is injected with no paused-line audit.
    const body = payload(b, "gofood", [b.kopiId]);
    const response = await send("gofood", body);
    expect(response.body.data.result).toBe("injected");
    expect(mappingOf(await stored(b, body.orderId), b.kopiId)).toBe("matched");
    expect(
      await pausedLineAudits(b, response.body.data.deliveryOrderId),
    ).toEqual([]);
  });

  it("each tenant sees only its own pause on both entry points", async () => {
    await pause(b, b.kopiId, ["gofood"]);
    // Manual: B is refused; A (no pause) is accepted.
    expectPausedRefusal(await manual(b, "gofood", [b.kopiId]));
    const accepted = await manual(a, "gofood", [a.kopiId]);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    // Webhook: both injected; only B's order carries the paused-line audit.
    const bBody = payload(b, "gofood", [b.kopiId]);
    const aBody = payload(a, "gofood", [a.kopiId]);
    const bRes = await send("gofood", bBody);
    const aRes = await send("gofood", aBody);
    expect(bRes.body.data.result).toBe("injected");
    expect(aRes.body.data.result).toBe("injected");
    expect(
      await pausedLineAudits(b, bRes.body.data.deliveryOrderId),
    ).toHaveLength(1);
    expect(await pausedLineAudits(a, aRes.body.data.deliveryOrderId)).toEqual(
      [],
    );
  });
});
