// legend-5d76: staff map the unmatched lines of a needs_review delivery order
// and inject it into the KDS (contract: packages/shared/src/delivery/endpoints.ts
// `mapDeliveryOrderLines`, POST /api/outlets/:outletId/delivery-orders/:id/map-lines,
// body {mappings:[{lineNo, menuItemId, variantId?}]}, gate `delivery.order.handle`
// at that outlet). Real Express app, Better Auth, RBAC and PostgreSQL with RLS
// (disposable server from `pnpm test`); one fresh isolated tenant per test.
//
// Assumptions (contract ambiguities):
// - A needs_review row is produced the real way: a signed webhook whose item id
//   is not a menu item (result needs_review, status received, order_id null).
// - lineNo is read back from the stored `lines` (matched by platform item name),
//   not assumed to be 1-based.
// - After a successful map the order is auto-accepted like the webhook path
//   (open channel): response status `accepted`, one accept_order platform call.
// - Every rejection of the mapping (line left unmatched, unknown lineNo, already
//   matched line, unknown / other-tenant / inactive / unpriced / sold-out item,
//   wrong variant) is 422 DELIVERY_MAPPING_INCOMPLETE and leaves the row as it was.
// - A row of another outlet answers 404 DELIVERY_ORDER_NOT_FOUND on this outlet's
//   path; a caller without the gate at the path outlet gets 403.
// - The audit entry is found as any audit_logs row on the delivery order whose
//   actorId is the staff user (the action name is not specified).
// - Parallel and repeated calls both answer 200 with the same order (idempotent).
// - Round 2: a line the webhook stored as `sold_out` (item matched but sold out
//   at the outlet) must be remapped together with the `unmatched` lines (every
//   non-injectable line has to be covered); matched / price_mismatch lines may
//   not be mapped (422). A variant item needs its variantId; the line then
//   carries it. A sold-out line is produced by sending the sold-out menu
//   item's id in the webhook (needs_review, status received, order_id null).
// - Round 3: every mapping carries `externalItemId` = the platform item id of
//   that line as staff saw it. The `mapLines` helper fills it from the stored
//   line (what the staff screen shows) unless a test overrides it (null for a
//   lineNo that does not exist). A mapped line whose stored externalItemId
//   differs answers 409 DELIVERY_ORDER_CHANGED, injects nothing and changes
//   no data. The webhook changing the order is simulated by rewriting the
//   stored lines' externalItemId/name in the DB (a repeated webhook's update
//   behavior is not specified). The check runs after the idempotency check: an
//   already injected order still answers 200 even with a stale id.
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signDeliveryWebhook } from "@starter/shared/adapters";
import { deliveryChannelOrderSchema } from "@starter/shared/delivery";
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
  seedTenantOutlets,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const SECRET = "gofood-test-secret-0123456789";
const KOPI_IDR = 25_000;
const TEH_IDR = 18_000;

type Client = ReturnType<typeof agent>;
type Setup = Awaited<ReturnType<typeof setup>>;

let app: Express;
let hook: Express;

beforeAll(() => {
  app = createApp();
  hook = express();
  hook.use(
    "/api/webhooks/delivery",
    createDeliveryWebhookRouter({ secrets: { gofood: [SECRET] } }),
  );
  hook.use(errorHandler);
});
beforeEach(() => clearRecordedDeliveryCalls());
afterAll(async () => {
  await owner.end();
});

async function asOwnerTenant<T>(
  tenantId: string,
  run: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function staffUser(
  tenant: IsolatedTenant,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletId: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [
      roleId,
      tenant.tenantId,
      `Role ${roleId.slice(0, 6)}`,
      JSON.stringify(permissions),
    ],
  );
  const client = agent(app);
  await signUp(client, "Delivery Staff");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
  return { client, userId };
}

type ItemOptions = {
  price?: number | null;
  active?: boolean;
  soldOut?: boolean;
};

/** A tenant with priced menu items, a coffee-bar station and GoFood at outlets A and B. */
async function setup() {
  const tenant = await createIsolatedTenant(`5d76-${randomUUID().slice(0, 6)}`);
  const [outletB] = await seedTenantOutlets(tenant.tenantId, 1);
  const outletA = tenant.outletId;
  const categoryId = randomUUID();
  const priceListId = randomUUID();
  const storeA = `go-a-${randomUUID().slice(0, 8)}`;
  const storeB = `go-b-${randomUUID().slice(0, 8)}`;

  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Petakan Uji', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    for (const outletId of [outletA, outletB!])
      await db.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
         VALUES ($1, $2, $3, 'Bar Kopi', 'coffee_bar')`,
        [randomUUID(), tenant.tenantId, outletId],
      );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'gofood', '2026-01-01')`,
      [priceListId, tenant.tenantId, outletA],
    );
    await db.query(
      `INSERT INTO delivery_channels
         (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
       VALUES ($1, $2, 'gofood', $3, 2000, true),
              ($1, $4, 'gofood', $5, 2000, true)`,
      [tenant.tenantId, outletA, storeA, outletB, storeB],
    );
  });

  const addItem = (name: string, options: ItemOptions = {}) =>
    asOwnerTenant(tenant.tenantId, async (db) => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'coffee_bar')`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          categoryId,
          name,
          options.active ?? true,
          randomUUID(),
        ],
      );
      if (options.price !== null)
        await db.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenant.tenantId, priceListId, id, options.price ?? 0],
        );
      if (options.soldOut)
        await db.query(
          `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
           VALUES ($1, $2, $3, $4, '[]', NULL, 'sold_out')`,
          [randomUUID(), tenant.tenantId, outletA, id],
        );
      return id;
    });

  /** A menu item with priced variants (no base price): returns item and variant ids. */
  const addVariantItem = (
    name: string,
    variants: Array<{ name: string; price: number }>,
  ) =>
    asOwnerTenant(tenant.tenantId, async (db) => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_type)
         VALUES ($1, $2, $3, $4, $5, true, $6, 'coffee_bar')`,
        [id, tenant.tenantId, tenant.brandId, categoryId, name, randomUUID()],
      );
      const variantIds: string[] = [];
      for (const variant of variants) {
        const variantId = randomUUID();
        variantIds.push(variantId);
        await db.query(
          `INSERT INTO item_variants (id, tenant_id, menu_item_id, name) VALUES ($1, $2, $3, $4)`,
          [variantId, tenant.tenantId, id, variant.name],
        );
        await db.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            tenant.tenantId,
            priceListId,
            id,
            variantId,
            variant.price,
          ],
        );
      }
      return { itemId: id, variantIds };
    });

  const kopi = await addItem("Kopi Susu", { price: KOPI_IDR });
  const teh = await addItem("Teh Tarik", { price: TEH_IDR });

  const handlerA = await staffUser(tenant, ["delivery.order.handle"], {
    type: "outlet",
    outletId: outletA,
  });
  const noGate = await staffUser(tenant, ["floor.table.view"], {
    type: "tenant",
  });

  type Item = { itemId: string; name: string; qty: number; price: number };
  /** Sends a signed GoFood webhook; unknown item ids make the line unmatched. */
  const ingest = async (items: Item[], outlet: "A" | "B" = "A") => {
    const orderId = `GF-${randomUUID().slice(0, 8)}`;
    const body = {
      storeId: outlet === "A" ? storeA : storeB,
      orderId,
      grossIdr: items.reduce((sum, i) => sum + i.qty * i.price, 0),
      items: items.map((i) => ({
        itemId: i.itemId,
        name: i.name,
        quantity: i.qty,
        unitPriceIdr: i.price,
        modifiers: [],
      })),
    };
    const raw = JSON.stringify(body);
    const signature = await signDeliveryWebhook({
      rawBody: raw,
      secret: SECRET,
    });
    const res = await request(hook)
      .post("/api/webhooks/delivery/gofood")
      .set("Content-Type", "application/json")
      .set("X-Delivery-Signature", signature)
      .send(raw);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      result: "needs_review",
      orderId: null,
      status: "received",
    });
    return {
      externalOrderId: orderId,
      deliveryOrderId: res.body.data.deliveryOrderId as string,
    };
  };

  const readRow = (deliveryOrderId: string) =>
    asOwnerTenant(tenant.tenantId, async (db) => {
      const { rows } = await db.query<{
        order_id: string | null;
        status: string;
        gross_idr: string;
        commission_idr: string;
        lines: Array<{
          lineNo: number;
          externalItemId?: string | null;
          externalItemName: string;
          menuItemId: string | null;
          variantId?: string | null;
          mapping: string;
          unitPriceIdr: number;
          lineTotalIdr: number;
          channelPriceIdr: number | null;
        }>;
      }>(
        `SELECT order_id, status, gross_idr, commission_idr, lines
           FROM delivery_channel_orders WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, deliveryOrderId],
      );
      return rows[0]!;
    });

  const count = (
    table: "orders" | "kitchen_tickets",
    externalOrderId: string,
  ) =>
    asOwnerTenant(tenant.tenantId, async (db) => {
      const sql =
        table === "orders"
          ? `SELECT count(*) AS n FROM orders WHERE tenant_id = $1 AND external_ref = $2`
          : `SELECT count(*) AS n FROM kitchen_tickets t
               JOIN orders o ON o.id = t.order_id AND o.tenant_id = t.tenant_id
              WHERE t.tenant_id = $1 AND o.external_ref = $2`;
      const { rows } = await db.query<{ n: string }>(sql, [
        tenant.tenantId,
        externalOrderId,
      ]);
      return Number(rows[0]!.n);
    });

  const orderTotal = (externalOrderId: string) =>
    asOwnerTenant(tenant.tenantId, async (db) => {
      const { rows } = await db.query<{ total_idr: string }>(
        `SELECT total_idr FROM orders WHERE tenant_id = $1 AND external_ref = $2`,
        [tenant.tenantId, externalOrderId],
      );
      return rows.map((row) => Number(row.total_idr));
    });

  const auditBy = (deliveryOrderId: string, userId: string) =>
    asOwnerTenant(tenant.tenantId, async (db) => {
      const { rows } = await db.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'actorId' = $3`,
        [tenant.tenantId, deliveryOrderId, userId],
      );
      return rows.map((row) => row.event);
    });

  const acceptCalls = (externalOrderId: string) =>
    recordedDeliveryCalls().filter(
      (call) =>
        call.action === "accept_order" &&
        (call.payload as { externalOrderId?: string } | undefined)
          ?.externalOrderId === externalOrderId,
    ).length;

  /** Simulates the platform changing the order: every stored line gets another item. */
  const changeStoredItems = (deliveryOrderId: string) =>
    asOwnerTenant(tenant.tenantId, async (db) => {
      await db.query(
        `UPDATE delivery_channel_orders
            SET lines = (
              SELECT jsonb_agg(
                       jsonb_set(
                         jsonb_set(l, '{externalItemId}', '"GF-CHANGED-ITEM"'),
                         '{externalItemName}', '"Item Lain"'))
                FROM jsonb_array_elements(lines) AS l)
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, deliveryOrderId],
      );
    });

  type MappingInput = {
    lineNo: number;
    menuItemId: string;
    variantId?: string | null;
    externalItemId?: string | null;
  };

  const mapLines = async (
    client: Client,
    deliveryOrderId: string,
    mappings: MappingInput[],
    options: { outletId?: string } = {},
  ) => {
    // The platform item id staff saw per line: read it from the stored row.
    const stored = await readRow(deliveryOrderId);
    const body = mappings.map((mapping) => ({
      ...mapping,
      externalItemId:
        mapping.externalItemId !== undefined
          ? mapping.externalItemId
          : (stored?.lines.find((line) => line.lineNo === mapping.lineNo)
              ?.externalItemId ?? null),
    }));
    return client
      .post(
        `/api/outlets/${encodeURIComponent(options.outletId ?? outletA)}/delivery-orders/${encodeURIComponent(deliveryOrderId)}/map-lines`,
      )
      .set({ Host: tenant.hostname })
      .set(originHeader)
      .set("Idempotency-Key", randomUUID())
      .send({ mappings: body });
  };

  return {
    tenant,
    outletA,
    outletB: outletB!,
    kopi,
    teh,
    addItem,
    addVariantItem,
    handlerA,
    noGate,
    ingest,
    readRow,
    count,
    orderTotal,
    auditBy,
    acceptCalls,
    mapLines,
    changeStoredItems,
  };
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

/** lineNo of the stored line with this platform item name. */
const lineNoOf = (row: Awaited<ReturnType<Setup["readRow"]>>, name: string) =>
  row.lines.find((line) => line.externalItemName === name)!.lineNo;

const unknownKopi = (qty = 2, price = KOPI_IDR) => ({
  itemId: randomUUID(),
  name: "Kopi Susu",
  qty,
  price,
});

describe("legend-5d76 map lines of a needs_review order", () => {
  it("legend-5d76 maps the unmatched line, injects the order into the KDS and audits who mapped it", async () => {
    const s = await setup();
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      unknownKopi(),
    ]);
    const before = await s.readRow(deliveryOrderId);
    expect(before.lines[0]).toMatchObject({ mapping: "unmatched" });
    expect(await s.count("orders", externalOrderId)).toBe(0);

    const res = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo: lineNoOf(before, "Kopi Susu"), menuItemId: s.kopi },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const order = deliveryChannelOrderSchema.parse(res.body.data);
    expect(order.id).toBe(deliveryOrderId);
    expect(order.orderId).toEqual(expect.any(String));
    expect(order.status).toBe("accepted");

    const after = await s.readRow(deliveryOrderId);
    // The API encodes ids (ULID); the column holds the raw uuid: only check it is set.
    expect(after.order_id).not.toBeNull();
    expect(after.lines[0]).toMatchObject({
      mapping: "matched",
      menuItemId: s.kopi,
      channelPriceIdr: KOPI_IDR,
    });
    expect(await s.count("orders", externalOrderId)).toBe(1);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(1);
    expect(s.acceptCalls(externalOrderId)).toBe(1);
    expect(
      (await s.auditBy(deliveryOrderId, s.handlerA.userId)).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("legend-5d76 is idempotent: a second call returns the current order without a second KDS order", async () => {
    const s = await setup();
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      unknownKopi(),
    ]);
    const row = await s.readRow(deliveryOrderId);
    const mappings = [
      { lineNo: lineNoOf(row, "Kopi Susu"), menuItemId: s.kopi },
    ];

    const first = await s.mapLines(
      s.handlerA.client,
      deliveryOrderId,
      mappings,
    );
    const second = await s.mapLines(
      s.handlerA.client,
      deliveryOrderId,
      mappings,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.orderId).toBe(first.body.data.orderId);
    expect(await s.count("orders", externalOrderId)).toBe(1);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(1);
    expect(s.acceptCalls(externalOrderId)).toBe(1);
  });

  it("legend-5d76 two parallel requests create one order", async () => {
    const s = await setup();
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      unknownKopi(),
    ]);
    const row = await s.readRow(deliveryOrderId);
    const mappings = [
      { lineNo: lineNoOf(row, "Kopi Susu"), menuItemId: s.kopi },
    ];

    const [one, two] = await Promise.all([
      s.mapLines(s.handlerA.client, deliveryOrderId, mappings),
      s.mapLines(s.handlerA.client, deliveryOrderId, mappings),
    ]);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(one.body.data.orderId).toEqual(expect.any(String));
    expect(two.body.data.orderId).toBe(one.body.data.orderId);
    expect(await s.count("orders", externalOrderId)).toBe(1);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(1);
    expect(s.acceptCalls(externalOrderId)).toBe(1);
  });

  it("legend-5d76 refuses callers without the gate or from another outlet, and a row of another outlet is not found", async () => {
    const s = await setup();
    const rowA = await s.ingest([unknownKopi()], "A");
    const rowB = await s.ingest([unknownKopi()], "B");
    const stored = await s.readRow(rowA.deliveryOrderId);
    const mappings = [
      { lineNo: lineNoOf(stored, "Kopi Susu"), menuItemId: s.kopi },
    ];

    // No `delivery.order.handle` at all.
    const noGate = await s.mapLines(
      s.noGate.client,
      rowA.deliveryOrderId,
      mappings,
    );
    expect(noGate.status).toBe(403);

    // Handler of outlet A only: outlet B's path is forbidden.
    const otherOutletPath = await s.mapLines(
      s.handlerA.client,
      rowB.deliveryOrderId,
      mappings,
      { outletId: s.outletB },
    );
    expect(otherOutletPath.status).toBe(403);

    // Outlet B's row through outlet A's path: not found.
    const crossRow = await s.mapLines(
      s.handlerA.client,
      rowB.deliveryOrderId,
      mappings,
    );
    expect(crossRow.status).toBe(404);
    expect(errorCode(crossRow.body)).toBe("DELIVERY_ORDER_NOT_FOUND");

    // Unknown row.
    const missing = await s.mapLines(s.handlerA.client, randomUUID(), mappings);
    expect(missing.status).toBe(404);
    expect(errorCode(missing.body)).toBe("DELIVERY_ORDER_NOT_FOUND");

    for (const row of [rowA, rowB]) {
      expect((await s.readRow(row.deliveryOrderId)).order_id).toBeNull();
      expect(await s.count("orders", row.externalOrderId)).toBe(0);
    }
  });

  it("legend-5d76 rejects an incomplete or invalid mapping with 422 and creates no order", async () => {
    const s = await setup();
    const other = await setup();
    const soldOut = await s.addItem("Es Habis", {
      price: 20_000,
      soldOut: true,
    });
    const inactive = await s.addItem("Menu Mati", {
      price: 20_000,
      active: false,
    });
    const unpriced = await s.addItem("Tanpa Harga", { price: null });
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      { itemId: s.kopi, name: "Kopi Susu", qty: 1, price: KOPI_IDR },
      { itemId: randomUUID(), name: "Es Apa", qty: 1, price: 20_000 },
      { itemId: randomUUID(), name: "Roti Apa", qty: 1, price: 15_000 },
    ]);
    const row = await s.readRow(deliveryOrderId);
    const matchedNo = lineNoOf(row, "Kopi Susu");
    const esNo = lineNoOf(row, "Es Apa");
    const rotiNo = lineNoOf(row, "Roti Apa");
    expect(row.lines.find((l) => l.lineNo === matchedNo)!.mapping).toBe(
      "matched",
    );

    const bad: Array<[string, Parameters<Setup["mapLines"]>[2]]> = [
      ["a line left unmatched", [{ lineNo: esNo, menuItemId: s.teh }]],
      [
        "an unknown lineNo",
        [
          { lineNo: esNo, menuItemId: s.teh },
          { lineNo: rotiNo, menuItemId: s.kopi },
          { lineNo: 99, menuItemId: s.kopi },
        ],
      ],
      [
        "an already matched line",
        [
          { lineNo: matchedNo, menuItemId: s.teh },
          { lineNo: esNo, menuItemId: s.teh },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
      [
        "a sold out item",
        [
          { lineNo: esNo, menuItemId: soldOut },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
      [
        "an inactive item",
        [
          { lineNo: esNo, menuItemId: inactive },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
      [
        "an item without a channel price",
        [
          { lineNo: esNo, menuItemId: unpriced },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
      [
        "an unknown item",
        [
          { lineNo: esNo, menuItemId: randomUUID() },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
      [
        "an item of another tenant",
        [
          { lineNo: esNo, menuItemId: other.kopi },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
      [
        "a variant the item does not have",
        [
          { lineNo: esNo, menuItemId: s.teh, variantId: randomUUID() },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
    ];
    for (const [label, mappings] of bad) {
      const res = await s.mapLines(
        s.handlerA.client,
        deliveryOrderId,
        mappings,
      );
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(errorCode(res.body), label).toBe("DELIVERY_MAPPING_INCOMPLETE");
    }

    const after = await s.readRow(deliveryOrderId);
    expect(after.order_id).toBeNull();
    expect(after.status).toBe("received");
    expect(after.lines.map((l) => l.mapping)).toEqual(
      row.lines.map((l) => l.mapping),
    );
    expect(await s.count("orders", externalOrderId)).toBe(0);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(0);
    expect(s.acceptCalls(externalOrderId)).toBe(0);
  });

  it("legend-5d76 keeps the platform price: a price_mismatch line still totals what the platform pays", async () => {
    const s = await setup();
    // The platform charged 30,000 per cup, the menu channel price is 25,000.
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      unknownKopi(2, 30_000),
    ]);
    const before = await s.readRow(deliveryOrderId);
    expect(before.gross_idr).toBe("60000");

    const res = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo: lineNoOf(before, "Kopi Susu"), menuItemId: s.kopi },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await s.readRow(deliveryOrderId);
    expect(after.lines[0]).toMatchObject({
      mapping: "price_mismatch",
      menuItemId: s.kopi,
      unitPriceIdr: 30_000,
      lineTotalIdr: 60_000,
      channelPriceIdr: KOPI_IDR,
    });
    expect(after.gross_idr).toBe(before.gross_idr);
    expect(after.commission_idr).toBe(before.commission_idr);
    // Never pay more: the POS order total is the platform total, not menu price x qty.
    expect(await s.orderTotal(externalOrderId)).toEqual([60_000]);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(1);
  });

  it("legend-5d76 remaps a sold_out line together with an unmatched line, injects it and keeps the platform total", async () => {
    const s = await setup();
    const soldOut = await s.addItem("Es Habis", {
      price: 20_000,
      soldOut: true,
    });
    // Platform: sold-out item 1 x 20,000 and unknown coffee 2 x 25,000 = 70,000.
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      { itemId: soldOut, name: "Es Habis", qty: 1, price: 20_000 },
      unknownKopi(),
    ]);
    const before = await s.readRow(deliveryOrderId);
    const soldOutNo = lineNoOf(before, "Es Habis");
    const kopiNo = lineNoOf(before, "Kopi Susu");
    expect(before.lines.find((l) => l.lineNo === soldOutNo)!.mapping).toBe(
      "sold_out",
    );
    expect(before.lines.find((l) => l.lineNo === kopiNo)!.mapping).toBe(
      "unmatched",
    );
    expect(before.gross_idr).toBe("70000");

    // The sold_out line also has to be covered: mapping only the unmatched line fails.
    const partial = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo: kopiNo, menuItemId: s.kopi },
    ]);
    expect(partial.status, JSON.stringify(partial.body)).toBe(422);
    expect(errorCode(partial.body)).toBe("DELIVERY_MAPPING_INCOMPLETE");
    expect((await s.readRow(deliveryOrderId)).order_id).toBeNull();
    expect(await s.count("orders", externalOrderId)).toBe(0);

    // Remap the sold_out line to a sellable item (Teh Tarik, menu price 18,000).
    const res = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo: soldOutNo, menuItemId: s.teh },
      { lineNo: kopiNo, menuItemId: s.kopi },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.orderId).toEqual(expect.any(String));

    const after = await s.readRow(deliveryOrderId);
    expect(after.order_id).not.toBeNull();
    expect(after.lines.find((l) => l.lineNo === soldOutNo)).toMatchObject({
      mapping: "price_mismatch",
      menuItemId: s.teh,
      unitPriceIdr: 20_000,
      lineTotalIdr: 20_000,
      channelPriceIdr: TEH_IDR,
    });
    expect(after.lines.find((l) => l.lineNo === kopiNo)).toMatchObject({
      mapping: "matched",
      menuItemId: s.kopi,
    });
    // Never pay more or less: gross and POS total stay the platform's 70,000.
    expect(after.gross_idr).toBe("70000");
    expect(after.commission_idr).toBe(before.commission_idr);
    expect(await s.orderTotal(externalOrderId)).toEqual([70_000]);
    expect(await s.count("orders", externalOrderId)).toBe(1);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(1);
  });

  it("legend-5d76 maps a variant item when the variantId is sent and rejects it without one", async () => {
    const s = await setup();
    const latte = await s.addVariantItem("Latte", [
      { name: "Kecil", price: 22_000 },
      { name: "Besar", price: 30_000 },
    ]);
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      { itemId: randomUUID(), name: "Latte Besar", qty: 2, price: 30_000 },
    ]);
    const before = await s.readRow(deliveryOrderId);
    const lineNo = lineNoOf(before, "Latte Besar");

    // A variant item without a variantId is refused (server stays strict).
    const without = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo, menuItemId: latte.itemId },
    ]);
    expect(without.status, JSON.stringify(without.body)).toBe(422);
    expect(errorCode(without.body)).toBe("DELIVERY_MAPPING_INCOMPLETE");
    expect(await s.count("orders", externalOrderId)).toBe(0);

    const res = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo, menuItemId: latte.itemId, variantId: latte.variantIds[1]! },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.orderId).toEqual(expect.any(String));

    const after = await s.readRow(deliveryOrderId);
    expect(after.lines[0]).toMatchObject({
      mapping: "matched",
      menuItemId: latte.itemId,
      variantId: latte.variantIds[1],
      unitPriceIdr: 30_000,
      lineTotalIdr: 60_000,
      channelPriceIdr: 30_000,
    });
    expect(await s.orderTotal(externalOrderId)).toEqual([60_000]);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(1);
  });

  it("legend-5d76 refuses to remap a matched or price_mismatch line", async () => {
    const s = await setup();
    // Kopi Susu matches (25,000); Teh Tarik matches the item but the platform charged 20,000.
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      { itemId: s.kopi, name: "Kopi Susu", qty: 1, price: KOPI_IDR },
      { itemId: s.teh, name: "Teh Tarik", qty: 1, price: 20_000 },
      { itemId: randomUUID(), name: "Roti Apa", qty: 1, price: 15_000 },
    ]);
    const row = await s.readRow(deliveryOrderId);
    const kopiNo = lineNoOf(row, "Kopi Susu");
    const tehNo = lineNoOf(row, "Teh Tarik");
    const rotiNo = lineNoOf(row, "Roti Apa");
    expect(row.lines.find((l) => l.lineNo === kopiNo)!.mapping).toBe("matched");
    expect(row.lines.find((l) => l.lineNo === tehNo)!.mapping).toBe(
      "price_mismatch",
    );

    for (const [label, mappings] of [
      [
        "a matched line",
        [
          { lineNo: kopiNo, menuItemId: s.teh },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
      [
        "a price_mismatch line",
        [
          { lineNo: tehNo, menuItemId: s.kopi },
          { lineNo: rotiNo, menuItemId: s.kopi },
        ],
      ],
    ] as Array<[string, Parameters<Setup["mapLines"]>[2]]>) {
      const res = await s.mapLines(
        s.handlerA.client,
        deliveryOrderId,
        mappings,
      );
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(errorCode(res.body), label).toBe("DELIVERY_MAPPING_INCOMPLETE");
    }

    const after = await s.readRow(deliveryOrderId);
    expect(after.order_id).toBeNull();
    expect(after.lines.map((l) => l.mapping)).toEqual(
      row.lines.map((l) => l.mapping),
    );
    expect(await s.count("orders", externalOrderId)).toBe(0);
  });

  it("legend-5d76 answers 409 DELIVERY_ORDER_CHANGED when the platform item of a mapped line differs, and injects nothing", async () => {
    const s = await setup();
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      unknownKopi(),
    ]);
    const before = await s.readRow(deliveryOrderId);
    const lineNo = lineNoOf(before, "Kopi Susu");
    expect(before.lines[0]!.externalItemId).toEqual(expect.any(String));

    // Staff saw another platform item at this line than the one stored now.
    const res = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo, menuItemId: s.kopi, externalItemId: "GF-ITEM-YANG-DILIHAT" },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(errorCode(res.body)).toBe("DELIVERY_ORDER_CHANGED");

    const after = await s.readRow(deliveryOrderId);
    expect(after.order_id).toBeNull();
    expect(after.status).toBe("received");
    expect(after.lines).toEqual(before.lines);
    expect(after.gross_idr).toBe(before.gross_idr);
    expect(await s.count("orders", externalOrderId)).toBe(0);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(0);
    expect(s.acceptCalls(externalOrderId)).toBe(0);
  });

  it("legend-5d76 answers 409 DELIVERY_ORDER_CHANGED when the order changed after staff looked, and mapping the fresh lines then works", async () => {
    const s = await setup();
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      unknownKopi(),
    ]);
    const seen = await s.readRow(deliveryOrderId);
    const lineNo = lineNoOf(seen, "Kopi Susu");
    const seenItemId = seen.lines[0]!.externalItemId!;

    // The webhook replaces the item at the same lineNo after staff opened the order.
    await s.changeStoredItems(deliveryOrderId);
    const changed = await s.readRow(deliveryOrderId);
    expect(changed.lines[0]!.externalItemId).not.toBe(seenItemId);

    const stale = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo, menuItemId: s.kopi, externalItemId: seenItemId },
    ]);
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(errorCode(stale.body)).toBe("DELIVERY_ORDER_CHANGED");
    const afterStale = await s.readRow(deliveryOrderId);
    expect(afterStale.order_id).toBeNull();
    expect(afterStale.lines).toEqual(changed.lines);
    expect(await s.count("orders", externalOrderId)).toBe(0);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(0);
    expect(s.acceptCalls(externalOrderId)).toBe(0);

    // After staff reload and see the new line, mapping it works.
    const fresh = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo, menuItemId: s.kopi, externalItemId: "GF-CHANGED-ITEM" },
    ]);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.data.orderId).toEqual(expect.any(String));
    expect(await s.count("orders", externalOrderId)).toBe(1);
  });

  it("legend-5d76 stays idempotent: an already injected order answers 200 even with a stale externalItemId", async () => {
    const s = await setup();
    const { externalOrderId, deliveryOrderId } = await s.ingest([
      unknownKopi(),
    ]);
    const row = await s.readRow(deliveryOrderId);
    const lineNo = lineNoOf(row, "Kopi Susu");

    const first = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo, menuItemId: s.kopi },
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const again = await s.mapLines(s.handlerA.client, deliveryOrderId, [
      { lineNo, menuItemId: s.kopi, externalItemId: "GF-ITEM-USANG" },
    ]);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.orderId).toBe(first.body.data.orderId);
    expect(await s.count("orders", externalOrderId)).toBe(1);
    expect(await s.count("kitchen_tickets", externalOrderId)).toBe(1);
    expect(s.acceptCalls(externalOrderId)).toBe(1);
  });
});
