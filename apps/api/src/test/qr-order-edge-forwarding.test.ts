// WS-02 cloud -> edge QR order forwarding (bead legend-0835, brief 90 section
// B; PRD docs/PRD.md:516 "Pesanan Pelanggan dari Cloud"). Written from the
// brief, independent of the implementation: failing imports are expected
// until the sections merge.
//
// Assumed contracts (see the report):
//   edge/qr-order-forwarding.ts
//     getOutletEdgeLinkState(tx, ctx, outletId, now?) -> { hasEdge, linkUp, edgeNodeId }
//   edge/qr-order-applier.ts
//     registerQrOrderEdgeApplier(): installs (composes with any existing) the
//       cloud_to_edge applier through setEdgeEventApplier; handles `qr_order.placed`.
//   Cloud order placement = POST /api/table-sessions/:id/orders (checkout). With an
//   active edge node and a stale link: HTTP 409 or 503, error.code EDGE_LINK_DOWN,
//   message "Silakan pesan melalui waiter.". The guest page's view
//   (GET /api/table-sessions/:id) carries `orderingAvailable`.
//   The queued envelope name is `qr_order.placed` and its payload mentions the
//   order id and the ordered menu item ids.
//
// Fresh isolated tenant: price list, tax and counters are this file's own.
// Phases run in file order (no edge, edge up, edge stale, rollback, revoked).
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema, type EventEnvelope } from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { getOutletEdgeLinkState } from "../edge/qr-order-forwarding.ts";
import { registerQrOrderEdgeApplier } from "../edge/qr-order-applier.ts";
import {
  edgeEventApplier,
  setEdgeEventApplier,
  type EdgeEventApplier,
} from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { registerEdgeNode, revokeEdgeNode } from "../services/edge-node.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
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

const WAITER_MESSAGE = "Silakan pesan melalui waiter.";
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  roti: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const actor = randomUUID();

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };
let edgeNodeId = "";

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
      providerRef: `QRF-${randomBytes(6).toString("hex")}-${this.created}`,
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

// ---- helpers ------------------------------------------------------------------

const outletContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

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

/** Heartbeat age in seconds, written by the database clock. null = never. */
const setHeartbeat = (ageSeconds: number | null) =>
  asOwnerTenant((client) =>
    client.query(
      ageSeconds === null
        ? "UPDATE edge_nodes SET last_heartbeat_at = NULL WHERE id = $1"
        : "UPDATE edge_nodes SET last_heartbeat_at = now() - make_interval(secs => $2) WHERE id = $1",
      ageSeconds === null ? [edgeNodeId] : [edgeNodeId, ageSeconds],
    ),
  );

async function count(table: "orders" | "order_items" | "edge_outbound_queue") {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenant.tenantId],
  );
  return rows[0]!.n;
}

type QueueRow = {
  edge_node_id: string;
  direction: string;
  kind: string;
  status: string;
  event: unknown;
};
async function queueRows(): Promise<QueueRow[]> {
  const { rows } = await owner.query<QueueRow>(
    `SELECT edge_node_id, direction, kind, status, event
       FROM edge_outbound_queue WHERE tenant_id = $1 ORDER BY link_seq`,
    [tenant.tenantId],
  );
  return rows;
}

const mentions = (value: unknown, id: string) => {
  const text = JSON.stringify(value).toLowerCase();
  return text.includes(id.toLowerCase()) || text.includes(ulidToUuid(id));
};

async function newTable() {
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  return (await issueQr(staff.client, table.id, headers)).token;
}

type Guest = { token: string; sessionId: string };
async function seat(): Promise<Guest> {
  const response = await scan(app, {
    token: await newTable(),
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
    view: () => auth(client.get(base)),
    add: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        ...body,
      }),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
  };
}

/** A seated guest with Kopi x2 and Roti x1 in the cart. */
async function guestWithCart() {
  const guest = await seat();
  const first = await as(guest).add({
    menuItemId: ids.kopi,
    quantity: 2,
    expectedCartVersion: 0,
  });
  expect(first.status).toBe(201);
  const second = await as(guest).add({
    menuItemId: ids.roti,
    quantity: 1,
    expectedCartVersion: first.body.data.cart.version,
  });
  expect(second.status).toBe(201);
  return { guest, version: second.body.data.cart.version as number };
}

async function placeOrder() {
  const { guest, version } = await guestWithCart();
  const body = { expectedCartVersion: version, idempotencyKey: randomUUID() };
  return { guest, body, response: await as(guest).checkout(body) };
}

// ---- setup ----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPaymentGateway(new FakeGateway());
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`qrf-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Edge Uji', 0)`,
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
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-QRF', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterEach(() => {
  setEdgeEventApplier("cloud_to_edge", null);
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  await owner.query("DROP FUNCTION IF EXISTS qr_forwarding_test_fail() CASCADE");
  // Orders, edge rows and audit rows are append-only: the isolated tenant
  // stays; give it a valid creator so the platform tenant list parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- phase 1: no edge ---------------------------------------------------------------

describe("legend-0835 outlet without an edge node", () => {
  it("the QR flow is unchanged: ordering is available, the order is placed and nothing is enqueued", async () => {
    const state = await withTenant(db, outletContext(), (tx) =>
      getOutletEdgeLinkState(tx, outletContext(), outletIdSchema.parse(tenant.outletId)),
    );
    expect(state.hasEdge).toBe(false);
    expect(state.edgeNodeId ?? null).toBeNull();

    const { guest, version } = await guestWithCart();
    const view = await as(guest).view();
    expect(view.status).toBe(200);
    expect(view.body.data.orderingAvailable).toBe(true);

    const ordersBefore = await count("orders");
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(await count("orders")).toBe(ordersBefore + 1);
    expect(await count("edge_outbound_queue")).toBe(0);
  });
});

// ---- phase 2: edge, link up ---------------------------------------------------------

describe("legend-0835 edge node with a live link", () => {
  beforeAll(async () => {
    const registered = await registerEdgeNode(outletContext(), actor, {
      outletId: tenant.outletId,
      role: "primary",
      label: "Utama QR",
    });
    edgeNodeId = registered.edgeNode.id;
    await setHeartbeat(5);
  });

  it("reports hasEdge and linkUp from the node's last heartbeat", async () => {
    const stateAt = (now: Date) =>
      withTenant(db, outletContext(), (tx) =>
        getOutletEdgeLinkState(tx, outletContext(), outletIdSchema.parse(tenant.outletId), now),
      );
    await setHeartbeat(5);
    expect(await stateAt(new Date())).toMatchObject({
      hasEdge: true,
      linkUp: true,
      edgeNodeId,
    });
    await setHeartbeat(300);
    expect(await stateAt(new Date())).toMatchObject({
      hasEdge: true,
      linkUp: false,
      edgeNodeId,
    });
    await setHeartbeat(null);
    expect(await stateAt(new Date())).toMatchObject({
      hasEdge: true,
      linkUp: false,
      edgeNodeId,
    });
    await setHeartbeat(5);
  });

  it("orderingAvailable stays true and the order is queued once for the edge in the same transaction", async () => {
    await setHeartbeat(5);
    const { guest, body } = await guestWithCart().then(({ guest, version }) => ({
      guest,
      body: { expectedCartVersion: version, idempotencyKey: randomUUID() },
    }));
    const view = await as(guest).view();
    expect(view.body.data.orderingAvailable).toBe(true);

    const queueBefore = await queueRows();
    const placed = await as(guest).checkout(body);
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.order.id as string;

    const rows = await queueRows();
    expect(rows).toHaveLength(queueBefore.length + 1);
    const row = rows[rows.length - 1]!;
    expect(row).toMatchObject({
      edge_node_id: edgeNodeId,
      direction: "cloud_to_edge",
      kind: "transaction_event",
      status: "pending",
    });
    const event = eventEnvelopeSchema.parse(row.event);
    expect(event.name).toBe("qr_order.placed");
    expect(event.tenantId).toBe(tenant.tenantId);
    expect(event.outletId).toBe(tenant.outletId);
    // The edge needs the order and its lines to show and cook them.
    expect(mentions(event, orderId)).toBe(true);
    expect(mentions(event.payload, ids.kopi)).toBe(true);
    expect(mentions(event.payload, ids.roti)).toBe(true);
    // The guest-facing response is unchanged.
    expect(placed.body.data.order.items).toHaveLength(2);
  });

  it("a retried checkout with the same key neither duplicates the order nor the queue row", async () => {
    await setHeartbeat(5);
    const { guest, version } = await guestWithCart();
    const body = { expectedCartVersion: version, idempotencyKey: randomUUID() };
    const first = await as(guest).checkout(body);
    expect(first.status).toBe(201);
    const ordersAfterFirst = await count("orders");
    const queueAfterFirst = await count("edge_outbound_queue");
    const again = await as(guest).checkout(body);
    expect(again.status).toBe(201);
    expect(again.body.data.order.id).toBe(first.body.data.order.id);
    expect(await count("orders")).toBe(ordersAfterFirst);
    expect(await count("edge_outbound_queue")).toBe(queueAfterFirst);
  });

  it("two orders queue two distinct events", async () => {
    await setHeartbeat(5);
    const before = await queueRows();
    const a = await placeOrder();
    const b = await placeOrder();
    expect(a.response.status).toBe(201);
    expect(b.response.status).toBe(201);
    const rows = await queueRows();
    expect(rows).toHaveLength(before.length + 2);
    const ids = rows.slice(-2).map((row) => eventEnvelopeSchema.parse(row.event).id);
    expect(new Set(ids).size).toBe(2);
  });
});

// ---- phase 3: link down -------------------------------------------------------------

describe("legend-0835 edge node whose link is down", () => {
  it("hides ordering, refuses the order with EDGE_LINK_DOWN and inserts nothing", async () => {
    await setHeartbeat(5);
    const { guest, version } = await guestWithCart();
    await setHeartbeat(300);

    const view = await as(guest).view();
    expect(view.status).toBe(200);
    expect(view.body.data.orderingAvailable).toBe(false);

    const before = {
      orders: await count("orders"),
      items: await count("order_items"),
      queue: await count("edge_outbound_queue"),
    };
    const refused = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect([409, 503]).toContain(refused.status);
    expect(refused.body.error.code).toBe("EDGE_LINK_DOWN");
    expect(refused.body.error.message).toBe(WAITER_MESSAGE);
    expect({
      orders: await count("orders"),
      items: await count("order_items"),
      queue: await count("edge_outbound_queue"),
    }).toEqual(before);
  });

  it("a node that never sent a heartbeat counts as down", async () => {
    await setHeartbeat(5);
    const { guest, version } = await guestWithCart();
    await setHeartbeat(null);
    expect((await as(guest).view()).body.data.orderingAvailable).toBe(false);
    const refused = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(refused.body.error.code).toBe("EDGE_LINK_DOWN");
  });

  it("ordering comes back as soon as the link is up again", async () => {
    await setHeartbeat(5);
    const { guest, version } = await guestWithCart();
    await setHeartbeat(300);
    const body = { expectedCartVersion: version, idempotencyKey: randomUUID() };
    expect((await as(guest).checkout(body)).status).not.toBe(201);

    await setHeartbeat(5);
    expect((await as(guest).view()).body.data.orderingAvailable).toBe(true);
    const queueBefore = await count("edge_outbound_queue");
    const placed = await as(guest).checkout(body);
    expect(placed.status).toBe(201);
    expect(await count("edge_outbound_queue")).toBe(queueBefore + 1);
  });
});

// ---- phase 4: atomicity -------------------------------------------------------------

describe("legend-0835 the queue row shares the order's transaction", () => {
  const trigger = `qr_forwarding_fail_${randomBytes(4).toString("hex")}`;

  it("when the queue write cannot commit, the order is rolled back with it", async () => {
    await setHeartbeat(5);
    const { guest, version } = await guestWithCart();
    const body = { expectedCartVersion: version, idempotencyKey: randomUUID() };
    // A deferred constraint trigger on this tenant's queue rows raises at
    // COMMIT: if the order had committed in its own transaction it would
    // survive; in the same transaction it must disappear.
    await owner.query(`
      CREATE OR REPLACE FUNCTION qr_forwarding_test_fail() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'qr forwarding test: commit refused'; END $$`);
    await owner.query(`
      CREATE CONSTRAINT TRIGGER ${trigger}
        AFTER INSERT ON edge_outbound_queue
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        WHEN (NEW.tenant_id = '${tenant.tenantId}')
        EXECUTE FUNCTION qr_forwarding_test_fail()`);
    const before = {
      orders: await count("orders"),
      items: await count("order_items"),
      queue: await count("edge_outbound_queue"),
    };
    try {
      const failed = await as(guest).checkout(body);
      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect({
        orders: await count("orders"),
        items: await count("order_items"),
        queue: await count("edge_outbound_queue"),
      }).toEqual(before);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${trigger} ON edge_outbound_queue`);
    }
    // Nothing was left half done: the same checkout now succeeds once.
    const retried = await as(guest).checkout(body);
    expect(retried.status).toBe(201);
    expect(await count("orders")).toBe(before.orders + 1);
    expect(await count("edge_outbound_queue")).toBe(before.queue + 1);
  });
});

// ---- edge side: applier --------------------------------------------------------------

describe("legend-0835 edge applier for qr_order.placed", () => {
  async function queuedEvent(): Promise<{ event: EventEnvelope; orderId: string }> {
    await setHeartbeat(5);
    const placed = await placeOrder();
    expect(placed.response.status).toBe(201);
    const orderId = placed.response.body.data.order.id as string;
    const rows = await queueRows();
    const event = eventEnvelopeSchema.parse(rows[rows.length - 1]!.event);
    return { event, orderId };
  }

  const apply = (event: EventEnvelope, applier: EdgeEventApplier) =>
    withTenant(db, outletContext(), (tx) =>
      applier.apply(tx, event, {
        edgeNodeId,
        direction: "cloud_to_edge",
        kind: "transaction_event",
        context: outletContext(),
      }),
    );

  async function orderShape(orderId: string) {
    const { rows } = await owner.query<{ orders: number; items: number }>(
      `SELECT (SELECT count(*)::int FROM orders WHERE tenant_id = $1 AND id = $2::uuid) AS orders,
              (SELECT count(*)::int FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid) AS items`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows[0]!;
  }

  it("applying the same event twice leaves one order with its lines", async () => {
    const { event, orderId } = await queuedEvent();
    registerQrOrderEdgeApplier();
    const applier = edgeEventApplier("cloud_to_edge");
    const before = await orderShape(orderId);
    expect(before).toEqual({ orders: 1, items: 2 });
    await apply(event, applier);
    await apply(event, applier);
    expect(await orderShape(orderId)).toEqual(before);
  });

  it("on an edge that does not hold the order yet, the first apply inserts it and the replay changes nothing", async () => {
    const { event, orderId } = await queuedEvent();
    // Simulate the edge's empty database: remove the cloud copy of this one
    // order (replica mode skips triggers and foreign keys; owner only).
    await asOwnerTenant(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid",
        [tenant.tenantId, ulidToUuid(orderId)],
      );
      await client.query("DELETE FROM orders WHERE tenant_id = $1 AND id = $2::uuid", [
        tenant.tenantId,
        ulidToUuid(orderId),
      ]);
    });
    expect(await orderShape(orderId)).toEqual({ orders: 0, items: 0 });
    registerQrOrderEdgeApplier();
    const applier = edgeEventApplier("cloud_to_edge");
    await apply(event, applier);
    expect(await orderShape(orderId)).toEqual({ orders: 1, items: 2 });
    await apply(event, applier);
    expect(await orderShape(orderId)).toEqual({ orders: 1, items: 2 });
  });

  it("keeps an applier that was already installed for other events", async () => {
    const seen: string[] = [];
    setEdgeEventApplier("cloud_to_edge", {
      async apply(_tx, event) {
        seen.push(event.name);
      },
    });
    registerQrOrderEdgeApplier();
    const other: EventEnvelope = {
      id: "01JBZ0000000000000000000AA" as EventEnvelope["id"],
      tenantId: tenant.tenantId as EventEnvelope["tenantId"],
      outletId: tenant.outletId as EventEnvelope["outletId"],
      name: "menu.item_updated",
      version: 1,
      aggregateType: "menu_item",
      aggregateId: randomUUID(),
      sequence: 1,
      occurredAt: new Date().toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `other-${randomUUID()}`,
      payloadSchemaRef: "menu.item_updated.v1",
      payload: {},
    };
    await apply(other, edgeEventApplier("cloud_to_edge"));
    expect(seen).toEqual(["menu.item_updated"]);

    // And qr_order.placed is still handled by the QR applier, not the old one.
    const { event } = await queuedEvent();
    await apply(event, edgeEventApplier("cloud_to_edge"));
    expect(seen).toEqual(["menu.item_updated"]);
  });
});

// ---- phase 5: node revoked ---------------------------------------------------------------

describe("legend-0835 outlet whose edge node was revoked", () => {
  it("is treated as an outlet without an edge: the QR flow is unchanged again", async () => {
    const { guest, version } = await guestWithCart();
    await revokeEdgeNode(outletContext(), actor, {
      edgeNodeId,
      reason: "Unit diganti",
    });
    const state = await withTenant(db, outletContext(), (tx) =>
      getOutletEdgeLinkState(tx, outletContext(), outletIdSchema.parse(tenant.outletId)),
    );
    expect(state.hasEdge).toBe(false);
    expect((await as(guest).view()).body.data.orderingAvailable).toBe(true);
    const queueBefore = await count("edge_outbound_queue");
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(await count("edge_outbound_queue")).toBe(queueBefore);
  });
});
