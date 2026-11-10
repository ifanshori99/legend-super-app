// Delivery channel acceptance (bead legend-5bn3, slice D6; PRD v1.7 §3.23
// "Integrasi Ojek Online", Alur G): the behaviour a cafe owner relies on,
// written from the PRD and the contract in @starter/shared/delivery, not from
// the D2-D5 implementations.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`), in two fresh isolated tenants. Covered:
//   - a manual delivery order reaches the KDS with its channel tag and a
//     pickup number (the webhook shares the same injection path),
//   - the same platform order id is never a second order (manual path and
//     webhook replay: one order, one KDS fire),
//   - a changed webhook payload updates the order, never a second order,
//   - a sold-out item is pushed to every open channel's adapter, not closed ones,
//   - tenant A cannot see tenant B delivery orders or channels,
//   - commission reconciliation matches gross - commission.
// The webhook cases call the ingest service with the parsed payload and its
// raw bytes (the signature is the route's job, see delivery-webhook-db.test.ts).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { itemSoldOutEvent } from "@starter/shared/menu";
import { tenantPermissionCodeSchema } from "@starter/shared/access";
import { deliveryWebhookPayloadSchema } from "@starter/shared/adapters";
import { PERMISSION_CODES } from "@starter/shared/access";
import {
  deliveryChannelOrderSchema,
  deliveryChannelSchema,
  deliveryReconciliationSchema,
} from "@starter/shared/delivery";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { ingestDeliveryWebhook } from "../services/delivery-ingest.service.ts";
import {
  clearRecordedDeliveryCalls,
  recordedDeliveryCalls,
} from "../services/delivery-ports.ts";
import { deliverDeliveryChannelEvent } from "../services/delivery-sync-consumer.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const PERIOD = { start: "2026-10-01", end: "2026-10-31" } as const;

type Member = { client: ReturnType<typeof agent>; userId: string };
type Seeded = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  staff: Member;
  categoryId: string;
  kopiId: string;
};

let app: Express;
let a: Seeded;
let b: Seeded;
let storeA: string;

// ---- Fixtures ---------------------------------------------------------------------

/** Owner-side writes set the tenant local, because RLS is FORCED. */
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

/** A staff account holding every tenant permission: RBAC is not under test here. */
async function seedTenant(label: string): Promise<Seeded> {
  const tenant = await createIsolatedTenant(
    `dlv-${label}-${randomUUID().slice(0, 6)}`,
  );
  const roleId = randomUUID();
  const permissions = PERMISSION_CODES.filter(
    (code) => tenantPermissionCodeSchema.safeParse(code).success,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Delivery Uji', false, NULL, $3, false, '["tenant"]')`,
    [roleId, tenant.tenantId, JSON.stringify(permissions)],
  );
  const client = agent(app);
  await signUp(client, `Delivery ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  const categoryId = randomUUID();
  const kopiId = randomUUID();
  const priceListId = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Delivery Uji', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_type)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5, 'coffee_bar')`,
      [kopiId, tenant.tenantId, tenant.brandId, categoryId, randomUUID()],
    );
    // The outlet's coffee bar: Kopi Susu is routed there (KDS-01).
    await db.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Bar Kopi', 'coffee_bar')`,
      [randomUUID(), tenant.tenantId, tenant.outletId],
    );
    // The platform price list: the server prices manual orders from it.
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
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await db.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-DLV', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    staff: { client, userId },
    categoryId,
    kopiId,
  };
}

async function seedChannel(
  s: Seeded,
  platform: "gofood" | "grabfood" | "shopeefood",
  storeExternalId: string,
) {
  await asOwnerTenant(s.tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO delivery_channels
         (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
       VALUES ($1, $2, $3, $4, 2000, true)`,
      [s.tenant.tenantId, s.tenant.outletId, platform, storeExternalId],
    ),
  );
}

const lineOf = (s: Seeded, quantity: number) => ({
  lineNo: 1,
  externalItemId: "ext-kopi",
  externalItemName: "Kopi Susu",
  menuItemId: s.kopiId,
  variantId: null,
  quantity,
  unitPriceIdr: KOPI_IDR,
  lineTotalIdr: KOPI_IDR * quantity,
  modifiers: [],
  note: null,
  mapping: "matched",
  channelPriceIdr: KOPI_IDR,
});

/** A platform order history row, written by the owner (no API involved). */
async function seedDeliveryOrder(
  s: Seeded,
  input: {
    platform: "gofood" | "grabfood" | "shopeefood";
    externalOrderId: string;
    grossIdr: number;
    commissionIdr: number;
    receivedAt: string;
    settledNetIdr?: number;
  },
): Promise<string> {
  const settled = input.settledNetIdr ?? null;
  const { rows } = await asOwnerTenant(s.tenant.tenantId, (db) =>
    db.query<{ id: string }>(
      `INSERT INTO delivery_channel_orders
         (tenant_id, outlet_id, platform, external_order_id, status, source,
          gross_idr, commission_idr, payload_hash, lines, received_at,
          accepted_at, picked_up_at, delivered_at, settled_at, settled_net_idr)
       VALUES ($1, $2, $3, $4, 'delivered', 'platform', $5, $6, $7, $8::jsonb, $9,
               $9, $9, $9, $10, $11)
       RETURNING id`,
      [
        s.tenant.tenantId,
        s.tenant.outletId,
        input.platform,
        input.externalOrderId,
        input.grossIdr,
        input.commissionIdr,
        "a".repeat(64),
        JSON.stringify([lineOf(s, 1)]),
        input.receivedAt,
        settled === null ? null : input.receivedAt,
        settled,
      ],
    ),
  );
  return rows[0]!.id;
}

async function seedSettlementLine(
  s: Seeded,
  input: {
    platform: "gofood" | "grabfood" | "shopeefood";
    externalOrderId: string;
    grossIdr: number;
    commissionIdr: number;
    settledNetIdr: number;
    deliveryChannelOrderId: string | null;
    status: "matched" | "variance" | "unknown_order";
    varianceIdr: number;
    settledOn: string;
  },
) {
  await asOwnerTenant(s.tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO delivery_settlement_lines
         (tenant_id, outlet_id, platform, external_order_id, gross_idr, commission_idr,
          settled_net_idr, delivery_channel_order_id, status, variance_idr, settled_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        s.tenant.tenantId,
        s.tenant.outletId,
        input.platform,
        input.externalOrderId,
        input.grossIdr,
        input.commissionIdr,
        input.settledNetIdr,
        input.deliveryChannelOrderId,
        input.status,
        input.varianceIdr,
        input.settledOn,
      ],
    ),
  );
}

function api(s: Seeded, outletId = s.tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}`;
  const get = (path: string) =>
    s.staff.client.get(`${base}${path}`).set(s.headers).set(originHeader);
  return {
    channels: () => get("/delivery-channels"),
    orders: () => get("/delivery-orders"),
    order: (id: string) => get(`/delivery-orders/${id}`),
    reconciliation: (platform: string, start: string, end: string) =>
      get(
        `/delivery-reconciliation?platform=${platform}&periodStart=${start}&periodEnd=${end}`,
      ),
    manual: (body: Record<string, unknown>) =>
      s.staff.client
        .post(`${base}/delivery-orders/manual`)
        .set(s.headers)
        .set(originHeader)
        .set("Idempotency-Key", randomUUID())
        .send(body),
  };
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

/** A platform webhook payload for one Kopi Susu line (quantity 2). */
function webhookPayload(s: Seeded, storeId: string) {
  return deliveryWebhookPayloadSchema.parse({
    storeId,
    orderId: `WH-${randomUUID().slice(0, 8)}`,
    grossIdr: KOPI_IDR * 2,
    items: [
      {
        itemId: s.kopiId,
        name: "Kopi Susu",
        quantity: 2,
        unitPriceIdr: KOPI_IDR,
        modifiers: [],
      },
    ],
  });
}

const rawOf = (payload: unknown) =>
  new TextEncoder().encode(JSON.stringify(payload));

/** Kitchen tickets and ticket lines of one order (KDS fires). */
async function kitchenFires(db: PoolClient, s: Seeded, orderId: string) {
  const { rows } = await db.query<{ tickets: number; items: number }>(
    `SELECT (SELECT count(*)::int FROM kitchen_tickets
              WHERE tenant_id = $1 AND order_id = $2::uuid) AS tickets,
            (SELECT count(*)::int FROM kitchen_ticket_items
              WHERE tenant_id = $1 AND order_id = $2::uuid) AS items`,
    [s.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0];
}

beforeAll(async () => {
  app = createApp();
  a = await seedTenant("a");
  b = await seedTenant("b");
  storeA = `store-a-${randomUUID().slice(0, 8)}`;
  await seedChannel(a, "gofood", storeA);
  // Reconciliation needs a connected channel (DELIVERY_CHANNEL_UNKNOWN).
  await seedChannel(
    a,
    "shopeefood",
    `store-a-shopee-${randomUUID().slice(0, 8)}`,
  );
  await seedChannel(b, "grabfood", `store-b-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  // Orders and settlement lines are financial history the app role cannot
  // delete, so the isolated tenants stay in the disposable database; give them
  // a valid creator so the platform tenant list still parses them.
  for (const s of [a, b])
    if (s)
      await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
        s.tenant.tenantId,
        randomUUID(),
      ]);
  await owner.end();
});

// ---- Alur G: a platform order reaches the KDS -----------------------------------

describe("delivery order reaches the KDS (PRD Alur G)", () => {
  it("a manual order is injected and fired with its channel tag and a pickup number", async () => {
    const externalOrderId = `MAN-${randomUUID().slice(0, 8)}`;
    const created = await api(a).manual({
      platform: "gofood",
      externalOrderId,
      lines: [{ menuItemId: a.kopiId, quantity: 2 }],
    });
    expect([200, 201], JSON.stringify(created.body)).toContain(created.status);
    const order = deliveryChannelOrderSchema.parse(created.body.data);
    expect(order).toMatchObject({
      platform: "gofood",
      externalOrderId,
      source: "manual_pos",
    });
    expect(order.orderId).not.toBeNull();
    expect(order.number).toMatch(/\S/);

    const orderUuid = ulidToUuid(order.orderId!);
    await asOwnerTenant(a.tenant.tenantId, async (db) => {
      // The pos order carries the channel tag and the external reference.
      const orderRow = await db.query<{
        channel: string;
        status: string;
        fired_at: Date | null;
      }>(
        `SELECT channel, status, fired_at FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(orderRow.rows[0]).toMatchObject({
        channel: "gofood",
        status: "sent",
      });
      expect(orderRow.rows[0]?.fired_at).not.toBeNull();
      const posRow = await db.query<{ channel: string; external_ref: string }>(
        `SELECT channel, external_ref FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(posRow.rows[0]).toEqual({
        channel: "gofood",
        external_ref: externalOrderId,
      });

      // Every line is fired to the kitchen, exactly like a QR fire.
      const items = await db.query<{ fire_status: string }>(
        `SELECT fire_status FROM order_items
          WHERE tenant_id = $1 AND order_id = $2::uuid AND status <> 'voided'`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(items.rows.length).toBeGreaterThan(0);
      for (const item of items.rows) expect(item.fire_status).toBe("fired");

      // The order is announced like a POS submit (`order.submitted`; the
      // QR-only `order.placed` cannot carry a platform channel), with the
      // channel tag.
      const outbox = await db.query<{ channel: string }>(
        `SELECT event->'payload'->>'channel' AS channel FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'order.submitted'
            AND event->'payload'->>'orderId' = $2`,
        [a.tenant.tenantId, order.orderId],
      );
      expect(outbox.rows.map((row) => row.channel)).toEqual(["gofood"]);

      // The kitchen has the ticket, built in the same transaction.
      const tickets = await db.query<{ items: string }>(
        `SELECT (SELECT count(*) FROM kitchen_ticket_items i
                  WHERE i.tenant_id = t.tenant_id AND i.ticket_id = t.id)::text AS items
           FROM kitchen_tickets t
          WHERE t.tenant_id = $1 AND t.order_id = $2::uuid`,
        [a.tenant.tenantId, orderUuid],
      );
      expect(tickets.rows).toEqual([{ items: "1" }]);

      // The pickup display number is stored on the delivery order.
      const stored = await db.query<{ pickup_number: string | null }>(
        `SELECT pickup_number FROM delivery_channel_orders WHERE tenant_id = $1 AND id = $2`,
        [a.tenant.tenantId, order.id],
      );
      expect(stored.rows[0]?.pickup_number).toBe(order.number);
    });

    // The ops screen reads it back with the same number.
    const read = await api(a).order(order.id);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(deliveryChannelOrderSchema.parse(read.body.data).number).toBe(
      order.number,
    );
  });

  it("two orders on the same outlet get different pickup numbers", async () => {
    const numbers: string[] = [];
    for (const suffix of ["P1", "P2"]) {
      const created = await api(a).manual({
        platform: "gofood",
        externalOrderId: `PICK-${suffix}-${randomUUID().slice(0, 6)}`,
        lines: [{ menuItemId: a.kopiId, quantity: 1 }],
      });
      expect([200, 201], JSON.stringify(created.body)).toContain(
        created.status,
      );
      numbers.push(deliveryChannelOrderSchema.parse(created.body.data).number!);
    }
    expect(new Set(numbers).size).toBe(2);
  });

  it("a platform order id is never recorded twice: the repeat is a 409 and no second order exists", async () => {
    const externalOrderId = `DUP-${randomUUID().slice(0, 8)}`;
    const body = {
      platform: "gofood",
      externalOrderId,
      lines: [{ menuItemId: a.kopiId, quantity: 1 }],
    };
    const first = await api(a).manual(body);
    expect([200, 201], JSON.stringify(first.body)).toContain(first.status);

    // A fresh Idempotency-Key: this is a different request for the same order.
    const second = await api(a).manual(body);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(errorCode(second.body)).toBe("DELIVERY_ORDER_DUPLICATE");

    await asOwnerTenant(a.tenant.tenantId, async (db) => {
      const delivery = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM delivery_channel_orders
          WHERE tenant_id = $1 AND platform = 'gofood' AND external_order_id = $2`,
        [a.tenant.tenantId, externalOrderId],
      );
      expect(delivery.rows[0]?.count).toBe("1");
      const pos = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pos_orders
          WHERE tenant_id = $1 AND external_ref = $2`,
        [a.tenant.tenantId, externalOrderId],
      );
      expect(pos.rows[0]?.count).toBe("1");
    });
  });

  it("webhook: the same platform order delivered twice (same payload hash) is one order and one KDS fire", async () => {
    const payload = webhookPayload(a, storeA);
    const raw = rawOf(payload);
    const first = await ingestDeliveryWebhook("gofood", payload, raw);
    const second = await ingestDeliveryWebhook("gofood", payload, raw);
    expect(first.result).toBe("injected");
    expect(second).toMatchObject({
      result: "duplicate",
      deliveryOrderId: first.deliveryOrderId,
      orderId: first.orderId,
    });
    await asOwnerTenant(a.tenant.tenantId, async (db) => {
      const orders = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM orders
          WHERE tenant_id = $1 AND external_ref = $2`,
        [a.tenant.tenantId, payload.orderId],
      );
      expect(orders.rows[0]?.count).toBe("1");
      expect(await kitchenFires(db, a, first.orderId!)).toEqual({
        tickets: 1,
        items: 1,
      });
    });
  });

  it("webhook: the same external id with a changed payload updates the order via the state machine, never a second order", async () => {
    const payload = webhookPayload(a, storeA);
    const first = await ingestDeliveryWebhook(
      "gofood",
      payload,
      rawOf(payload),
    );
    expect(first.result).toBe("injected");
    const changed = { ...payload, grossIdr: KOPI_IDR * 2 + 4_000 };
    const updated = await ingestDeliveryWebhook(
      "gofood",
      changed,
      rawOf(changed),
    );
    expect(updated).toMatchObject({
      result: "updated",
      deliveryOrderId: first.deliveryOrderId,
      orderId: first.orderId,
      status: first.status,
    });
    // Changed lines are not applied to a cooked order: kept for review.
    const relined = {
      ...changed,
      items: [{ ...changed.items[0]!, quantity: 3 }],
    };
    const review = await ingestDeliveryWebhook(
      "gofood",
      relined,
      rawOf(relined),
    );
    expect(review).toMatchObject({
      result: "needs_review",
      deliveryOrderId: first.deliveryOrderId,
      orderId: first.orderId,
    });
    await asOwnerTenant(a.tenant.tenantId, async (db) => {
      const delivery = await db.query<{ gross_idr: string; lines: unknown[] }>(
        `SELECT gross_idr, lines FROM delivery_channel_orders
          WHERE tenant_id = $1 AND platform = 'gofood' AND external_order_id = $2`,
        [a.tenant.tenantId, payload.orderId],
      );
      expect(delivery.rows).toHaveLength(1);
      expect(delivery.rows[0]?.gross_idr).toBe(String(KOPI_IDR * 2 + 4_000));
      expect(delivery.rows[0]?.lines).toMatchObject([{ quantity: 2 }]);
      const orders = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM orders
          WHERE tenant_id = $1 AND external_ref = $2`,
        [a.tenant.tenantId, payload.orderId],
      );
      expect(orders.rows[0]?.count).toBe("1");
      expect(await kitchenFires(db, a, first.orderId!)).toEqual({
        tickets: 1,
        items: 1,
      });
      // Each change is an event and an audit entry with the money before/after.
      const events = await db.query<{
        before: string;
        after: string;
        lines: boolean;
      }>(
        `SELECT event->'payload'->>'grossBeforeIdr' AS before,
                event->'payload'->>'grossIdr' AS after,
                (event->'payload'->>'linesChanged')::boolean AS lines
           FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'delivery_order.updated'
            AND event->>'aggregateId' = $2
          ORDER BY sequence`,
        [a.tenant.tenantId, first.deliveryOrderId],
      );
      expect(events.rows).toEqual([
        {
          before: String(KOPI_IDR * 2),
          after: String(KOPI_IDR * 2 + 4_000),
          lines: false,
        },
        {
          before: String(KOPI_IDR * 2 + 4_000),
          after: String(KOPI_IDR * 2 + 4_000),
          lines: true,
        },
      ]);
      const audit = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'delivery_order.updated'
            AND event->>'objectId' = $2`,
        [a.tenant.tenantId, first.deliveryOrderId],
      );
      expect(audit.rows[0]?.count).toBe("2");
    });
  });

  it("adapter: a sold-out menu item calls `sold_out` on the fake delivery adapter for every open channel, not for closed ones", async () => {
    // GoFood and ShopeeFood are open; a paused GrabFood channel must not be called.
    await seedChannel(
      a,
      "grabfood",
      `store-a-grab-${randomUUID().slice(0, 8)}`,
    );
    await asOwnerTenant(a.tenant.tenantId, (db) =>
      db.query(
        `UPDATE delivery_channels SET is_open = false
          WHERE tenant_id = $1 AND outlet_id = $2 AND platform = 'grabfood'`,
        [a.tenant.tenantId, a.tenant.outletId],
      ),
    );
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(a.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const event = itemSoldOutEvent.envelopeSchema.parse({
      id: createUlid(),
      tenantId: a.tenant.tenantId,
      outletId: a.tenant.outletId,
      name: itemSoldOutEvent.name,
      version: itemSoldOutEvent.version,
      aggregateType: itemSoldOutEvent.entry.aggregateType,
      aggregateId: randomUUID(),
      sequence: 1,
      occurredAt: new Date().toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: createUlid(),
      payloadSchemaRef: itemSoldOutEvent.payloadSchemaRef,
      payload: {
        itemId: a.kopiId,
        availabilityId: randomUUID(),
        outletId: a.tenant.outletId,
        soldOutUntil: null,
      },
    });
    clearRecordedDeliveryCalls();
    await withTenant(db, context, (tx) =>
      deliverDeliveryChannelEvent(context, event, tx),
    );
    const soldOut = recordedDeliveryCalls().filter(
      (call) => call.action === "sold_out",
    );
    expect(soldOut.map((call) => call.channel).sort()).toEqual([
      "gofood",
      "shopeefood",
    ]);
    for (const call of soldOut)
      expect(call.payload).toMatchObject({ itemId: a.kopiId, soldOut: true });
  });
});

// ---- Tenant isolation (TEN-01 / TEN-03) -----------------------------------------

describe("delivery tenant isolation", () => {
  let bOrderId: string;
  const bExternalId = `B-ORDER-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    bOrderId = await seedDeliveryOrder(b, {
      platform: "grabfood",
      externalOrderId: bExternalId,
      grossIdr: 90_000,
      commissionIdr: 18_000,
      receivedAt: "2026-10-05T03:00:00.000Z",
    });
    await seedDeliveryOrder(a, {
      platform: "gofood",
      externalOrderId: `A-ORDER-${randomUUID().slice(0, 8)}`,
      grossIdr: 40_000,
      commissionIdr: 8_000,
      receivedAt: "2026-10-05T03:00:00.000Z",
    });
  });

  it("tenant A lists only its own delivery orders and channels", async () => {
    const orders = await api(a).orders();
    expect(orders.status, JSON.stringify(orders.body)).toBe(200);
    const rows = orders.body.data as { id: string; externalOrderId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.externalOrderId)).not.toContain(bExternalId);
    expect(rows.map((row) => row.id)).not.toContain(bOrderId);

    const channels = await api(a).channels();
    expect(channels.status, JSON.stringify(channels.body)).toBe(200);
    const list = (channels.body.data as unknown[]).map((row) =>
      deliveryChannelSchema.parse(row),
    );
    expect(list.length).toBeGreaterThan(0);
    for (const channel of list) {
      expect(channel.tenantId).toBe(a.tenant.tenantId);
      expect(channel.outletId).toBe(a.tenant.outletId);
    }
  });

  it("tenant A cannot read tenant B's delivery order by id", async () => {
    const read = await api(a).order(bOrderId);
    expect(read.status).toBe(404);
    // And not through B's outlet path either.
    const viaOutletB = await api(a, b.tenant.outletId).order(bOrderId);
    expect([403, 404]).toContain(viaOutletB.status);
  });

  it("tenant A cannot list tenant B's outlet", async () => {
    const orders = await api(a, b.tenant.outletId).orders();
    expect([403, 404]).toContain(orders.status);
    const channels = await api(a, b.tenant.outletId).channels();
    expect([403, 404]).toContain(channels.status);
  });

  it("under RLS the app role sees no row of the other tenant in any delivery table", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [a.tenant.tenantId],
      );
      for (const table of [
        "delivery_channels",
        "delivery_channel_orders",
        "delivery_settlement_lines",
      ]) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
          [b.tenant.tenantId],
        );
        expect(rows[0]?.count, table).toBe("0");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ---- Commission reconciliation (§3.23 "Rekonsiliasi Komisi") ----------------------

describe("delivery commission reconciliation", () => {
  it("expected net is gross - commission per order and the summary agrees with the statement lines", async () => {
    const tag = randomUUID().slice(0, 6);
    const matchedExt = `REC-M-${tag}`;
    const varianceExt = `REC-V-${tag}`;
    const unknownExt = `REC-U-${tag}`;
    // Platform reported net: 100.000 - 20.000 = 80.000 (paid in full) and
    // 50.000 - 10.000 = 40.000 (paid 36.000).
    const matchedOrder = await seedDeliveryOrder(a, {
      platform: "shopeefood",
      externalOrderId: matchedExt,
      grossIdr: 100_000,
      commissionIdr: 20_000,
      receivedAt: "2026-10-10T03:00:00.000Z",
      settledNetIdr: 80_000,
    });
    const varianceOrder = await seedDeliveryOrder(a, {
      platform: "shopeefood",
      externalOrderId: varianceExt,
      grossIdr: 50_000,
      commissionIdr: 10_000,
      receivedAt: "2026-10-11T03:00:00.000Z",
      settledNetIdr: 36_000,
    });
    await seedSettlementLine(a, {
      platform: "shopeefood",
      externalOrderId: matchedExt,
      grossIdr: 100_000,
      commissionIdr: 20_000,
      settledNetIdr: 80_000,
      deliveryChannelOrderId: matchedOrder,
      status: "matched",
      varianceIdr: 0,
      settledOn: "2026-10-12",
    });
    await seedSettlementLine(a, {
      platform: "shopeefood",
      externalOrderId: varianceExt,
      grossIdr: 50_000,
      commissionIdr: 10_000,
      settledNetIdr: 36_000,
      deliveryChannelOrderId: varianceOrder,
      status: "variance",
      varianceIdr: 4_000,
      settledOn: "2026-10-12",
    });
    await seedSettlementLine(a, {
      platform: "shopeefood",
      externalOrderId: unknownExt,
      grossIdr: 30_000,
      commissionIdr: 6_000,
      settledNetIdr: 24_000,
      deliveryChannelOrderId: null,
      status: "unknown_order",
      varianceIdr: 0,
      settledOn: "2026-10-12",
    });
    // Another tenant's statement for the same platform and period must not
    // leak into A's totals.
    await seedSettlementLine(b, {
      platform: "shopeefood",
      externalOrderId: `REC-B-${tag}`,
      grossIdr: 999_000,
      commissionIdr: 99_000,
      settledNetIdr: 900_000,
      deliveryChannelOrderId: null,
      status: "unknown_order",
      varianceIdr: 0,
      settledOn: "2026-10-12",
    });

    const response = await api(a).reconciliation(
      "shopeefood",
      PERIOD.start,
      PERIOD.end,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const report = deliveryReconciliationSchema.parse(response.body.data);
    expect(report).toMatchObject({
      tenantId: a.tenant.tenantId,
      outletId: a.tenant.outletId,
      platform: "shopeefood",
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });

    const byExternal = new Map(
      report.lines.map((line) => [line.externalOrderId, line]),
    );
    expect(report.lines).toHaveLength(3);
    expect(byExternal.get(matchedExt)).toMatchObject({
      status: "matched",
      deliveryChannelOrderId: matchedOrder,
      settledNetIdr: 80_000,
    });
    expect(byExternal.get(varianceExt)?.status).toBe("variance");
    expect(byExternal.get(varianceExt)?.varianceIdr).not.toBe(0);
    expect(byExternal.get(unknownExt)).toMatchObject({
      status: "unknown_order",
      deliveryChannelOrderId: null,
    });

    // A matched line is exactly gross - commission.
    for (const line of report.lines)
      if (line.status === "matched")
        expect(line.settledNetIdr).toBe(line.grossIdr - line.commissionIdr);

    expect(report.summary).toMatchObject({
      lineCount: 3,
      matchedCount: 1,
      varianceCount: 1,
      unknownOrderCount: 1,
      grossIdr: 180_000,
      commissionIdr: 36_000,
      settledNetIdr: 140_000,
    });
    // Expected net (gross - commission) vs what the platform paid.
    expect(report.summary.grossIdr - report.summary.commissionIdr).toBe(
      144_000,
    );
  });

  it("a period with no statement lines reconciles to zero", async () => {
    const response = await api(a).reconciliation(
      "shopeefood",
      "2025-01-01",
      "2025-01-31",
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const report = deliveryReconciliationSchema.parse(response.body.data);
    expect(report.lines).toHaveLength(0);
    expect(report.summary).toMatchObject({
      lineCount: 0,
      grossIdr: 0,
      commissionIdr: 0,
      settledNetIdr: 0,
      varianceIdr: 0,
    });
  });
});
