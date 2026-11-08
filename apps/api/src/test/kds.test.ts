// KDS routing and ticket lifecycle (bead legend-4d5; PRD v1.7 §3 F12 "KDS,
// Expo & Pickup Display"). Acceptance: KDS-01 (an item shows on the right
// station KDS within 2 s of firing), KDS-02 (no item lost or doubled across a
// disconnect/reconnect: gapless per-station feed + cursor), KDS-03 (an item
// cancelled after firing is marked cancelled on KDS immediately), KDS-04
// (every status change is recorded with time and user), plus the illegal
// transition and tenant / outlet / station isolation rules.
//
// The realtime WebSocket half is in kds-realtime.test.ts.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in fresh isolated tenants, so stations, menu and
// price list are this file's own. Written against the contracts in
// packages/shared/src/kitchen (never against the service code).
//
// Assumptions where the brief / spec is silent (each is also in the report):
//  - Placing a POS order fires its non-held lines at once or on submit; the
//    `placeOrder` helper submits a draft and fires any still-held line through
//    the fire endpoint, so a ticket exists either way.
//  - A fire that repeats already-routed lines is either accepted (idempotent)
//    or refused with 409; what must hold is "never a second ticket/line".
//  - A line void always goes through a PIN approval that names the order
//    (objectType "order", objectId = order id), like the order void.
//  - The station snapshot lists new / in_progress / recalled tickets (and
//    recent done ones), never a cancelled ticket; cancellation is visible to
//    the screen through the feed.
//  - The append-only trigger message contains "append-only" (as order_events).

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  kitchenStationFeedSchema,
  kitchenStationSnapshotSchema,
  kitchenTicketDetailSchema,
  kitchenTicketItemSchema,
  type KitchenStationFeed,
  type KitchenStationSnapshot,
  type KitchenTicketDetail,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { resolveKdsStaffConnection } from "../services/kds-realtime-auth.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import type { PosReceipt } from "@starter/shared/pos";

const PIN = "582914";

const ids = {
  category: randomUUID(),
  priceList: randomUUID(),
  // menu items
  kopi: randomUUID(), // -> bar A
  nasi: randomUUID(), // -> kitchen A
  air: randomUUID(), // no station: not a kitchen item
  teh: randomUUID(), // mapped to bar B (other outlet) -> falls back to bar A
  roti: randomUUID(), // mapped to a pastry station that exists only in outlet B
  // stations
  barA: randomUUID(),
  kitchenA: randomUUID(),
  barB: randomUUID(),
  pastryB: randomUUID(),
  // roles
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  kdsRole: randomUUID(),
  kdsRoleB: randomUUID(),
  outletB: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let cashier: Member;
let supervisor: Member;
let cook: Member; // kds.ticket.process, tenant scope
let barista: Member; // kds.ticket.process on station bar A only
let outletBStaff: Member; // kds.ticket.process on outlet B only
let noKds: Member; // POS cashier role without kds permission
let tenantBCook: Member; // kds.ticket.process in the other tenant

// ---- Receipt numbering double (same as pos-order.test.ts) ----------------------

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  const next = new Map<string, number>();
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      const sequenceNumber = (next.get(input.outletId) ?? 0) + 1;
      next.set(input.outletId, sequenceNumber);
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `KDS1-${String(sequenceNumber).padStart(6, "0")}`,
        sequenceNumber,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder() {
      return null;
    },
  };
}

// ---- Fixtures ---------------------------------------------------------------------

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

/** Read rows of this file's tenant with the tenant setting applied (RLS). */
async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  tenantId: string = tenant.tenantId,
): Promise<T[]> {
  return asOwnerTenant(tenantId, async (client) => {
    const result = await client.query<T>(sql, params);
    return result.rows;
  });
}

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`kds-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`kdsb-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    ids.cashierRole,
    "KDS Kasir Uji",
    [
      "order.view",
      "pos.sale.create",
      "pos.payment.accept",
      "pos.discount.apply",
      "pos.void.request",
    ],
    ["tenant"],
  );
  await insertRole(
    tenant.tenantId,
    ids.supervisorRole,
    "KDS Supervisor Uji",
    ["order.view", "pos.void.approve"],
    ["tenant"],
  );
  await insertRole(
    tenant.tenantId,
    ids.kdsRole,
    "KDS Dapur Uji",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.kdsRoleB,
    "KDS Dapur Tenant B",
    ["kds.ticket.process"],
    ["tenant"],
  );

  // Second outlet of the same tenant (outlet B), written as the owner.
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet KDS B', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        ids.outletB,
        `KB-${randomUUID().slice(0, 6)}`.toUpperCase(),
        tenant.tenantId,
        tenant.outletId,
      ],
    );
  });

  cashier = await member(
    tenant,
    ids.cashierRole,
    { type: "tenant", id: null },
    "KDS Kasir",
  );
  supervisor = await member(
    tenant,
    ids.supervisorRole,
    { type: "tenant", id: null },
    "KDS Supervisor",
  );
  noKds = await member(
    tenant,
    ids.cashierRole,
    { type: "tenant", id: null },
    "KDS Tanpa Akses",
  );
  cook = await member(
    tenant,
    ids.kdsRole,
    { type: "tenant", id: null },
    "KDS Koki",
  );
  barista = await member(
    tenant,
    ids.kdsRole,
    { type: "station", id: ids.barA },
    "KDS Barista",
  );
  outletBStaff = await member(
    tenant,
    ids.kdsRole,
    { type: "outlet", id: ids.outletB },
    "KDS Outlet B",
  );
  tenantBCook = await member(
    tenantB,
    ids.kdsRoleB,
    { type: "tenant", id: null },
    "KDS Tenant B",
  );

  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );

  await asOwnerTenant(tenant.tenantId, async (client) => {
    // The station rows come first: menu_items.station_id references them.
    // The role assignment of `barista` names bar A, so it must exist already
    // (assignment rows only store the id).
    const stations: [string, string, string, string][] = [
      [ids.barA, tenant.outletId, "Bar A", "beverage_bar"],
      [ids.kitchenA, tenant.outletId, "Dapur A", "hot_kitchen"],
      [ids.barB, ids.outletB, "Bar B", "beverage_bar"],
      [ids.pastryB, ids.outletB, "Pastry B", "pastry"],
    ];
    for (const [id, outletId, name, type] of stations)
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, outletId, name, type],
      );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'KDS Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    const items: [string, string, string | null][] = [
      [ids.kopi, "Kopi Susu", ids.barA],
      [ids.nasi, "Nasi Goreng", ids.kitchenA],
      [ids.air, "Air Mineral", null],
      [ids.teh, "Teh Tarik", ids.barB],
      [ids.roti, "Roti Bakar", ids.pastryB],
    ];
    for (const [id, name, stationId] of items)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          randomUUID(),
          stationId,
        ],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const id of [ids.kopi, ids.nasi, ids.air, ids.teh, ids.roti])
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 20000)`,
        [randomUUID(), tenant.tenantId, ids.priceList, id],
      );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-KDS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  // KDS history is append-only, so the isolated tenants stay in the disposable
  // database; give them a valid creator so the platform tenant list parses.
  for (const t of [tenant, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- HTTP helpers -------------------------------------------------------------------

type Line = { menuItemId: string; quantity?: number; note?: string };

function pos(who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (lines: Line[], extra: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: lines.map((line) => ({
          menuItemId: line.menuItemId,
          quantity: line.quantity ?? 1,
          modifierIds: [],
          ...(line.note ? { note: line.note } : {}),
        })),
        ...extra,
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    fire: (orderId: string, itemIds: string[], expectedStatus: string) =>
      send(`/${orderId}/fire`, { itemIds, expectedStatus }),
    voidItem: (
      orderId: string,
      itemId: string,
      body: Record<string, unknown>,
    ) => send(`/${orderId}/items/${itemId}/void`, body),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
  };
}

type PlacedLine = { id: string; menuItemId: string; fireStatus: string };
type Placed = { orderId: string; status: string; lines: PlacedLine[] };

function linesOf(body: { items: PlacedLine[] }): PlacedLine[] {
  return body.items.map((item) => ({
    id: item.id,
    menuItemId: item.menuItemId,
    fireStatus: item.fireStatus,
  }));
}

/** Create (+ submit) an order and make sure every non-held line is fired. */
async function placeOrder(
  lines: Line[],
  options: { hold?: boolean } = {},
): Promise<Placed> {
  const created = await pos().create(
    lines,
    options.hold ? { holdItems: true } : {},
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  let current = await pos().get(orderId);
  let placed = linesOf(current.body.data);
  if (!options.hold) {
    const held = placed.filter((line) => line.fireStatus === "held");
    if (held.length > 0) {
      const fired = await pos().fire(
        orderId,
        held.map((line) => line.id),
        status,
      );
      expect(fired.status, JSON.stringify(fired.body)).toBe(200);
      current = await pos().get(orderId);
      placed = linesOf(current.body.data);
    }
  }
  return {
    orderId,
    status: current.body.data.status as string,
    lines: placed,
  };
}

const lineOf = (placed: Placed, menuItemId: string): PlacedLine => {
  const line = placed.lines.find(
    (candidate) => candidate.menuItemId === menuItemId,
  );
  if (!line) throw new Error(`No line for ${menuItemId}`);
  return line;
};

function kds(who: Member = cook, outletId: string = tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/kitchen`;
  const get = (path: string) =>
    who.client.get(`${base}${path}`).set(headers).set(originHeader);
  const post = (path: string, body?: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .send(body ?? {});
  return {
    snapshot: (stationId: string) => get(`/stations/${stationId}/tickets`),
    feed: (stationId: string, after: number | string) =>
      get(`/stations/${stationId}/feed?after=${after}`),
    ticket: (ticketId: string) => get(`/tickets/${ticketId}`),
    start: (ticketId: string) => post(`/tickets/${ticketId}/start`),
    bump: (ticketId: string) => post(`/tickets/${ticketId}/bump`),
    recall: (ticketId: string, body: Record<string, unknown> = {}) =>
      post(`/tickets/${ticketId}/recall`, body),
    voidTicket: (ticketId: string, body: Record<string, unknown> = {}) =>
      post(`/tickets/${ticketId}/void`, body),
    priority: (ticketId: string, priority: number) =>
      who.client
        .patch(`${base}/tickets/${ticketId}/priority`)
        .set(headers)
        .set(originHeader)
        .send({ priority }),
    item: (itemId: string, action: string) =>
      post(`/ticket-items/${itemId}/status`, { action }),
  };
}

async function snapshot(stationId: string): Promise<KitchenStationSnapshot> {
  const response = await kds().snapshot(stationId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return kitchenStationSnapshotSchema.parse(response.body.data);
}

async function feed(
  stationId: string,
  after: number,
): Promise<KitchenStationFeed> {
  const response = await kds().feed(stationId, after);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return kitchenStationFeedSchema.parse(response.body.data);
}

async function ticketDetail(ticketId: string): Promise<KitchenTicketDetail> {
  const response = await kds().ticket(ticketId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return kitchenTicketDetailSchema.parse(response.body.data);
}

type TicketRow = { id: string; station_id: string; status: string };

/** Tickets of one order straight from the table, with ULID ids. */
async function ticketsOfOrder(
  orderId: string,
): Promise<{ id: string; stationId: string; status: string }[]> {
  const found = await rows<TicketRow>(
    `SELECT id::text AS id, station_id::text AS station_id, status
     FROM kitchen_tickets WHERE order_id = $1::uuid ORDER BY station_id`,
    [ulidToUuid(orderId)],
  );
  return found.map((row) => ({
    id: uuidToUlid(row.id),
    stationId: row.station_id,
    status: row.status,
  }));
}

async function ticketOn(orderId: string, stationId: string): Promise<string> {
  const found = (await ticketsOfOrder(orderId)).find(
    (ticket) => ticket.stationId === stationId,
  );
  if (!found) throw new Error(`No ticket of ${orderId} on ${stationId}`);
  return found.id;
}

async function cursorOf(stationId: string): Promise<number> {
  return (await snapshot(stationId)).sequence;
}

async function ticketCount(): Promise<number> {
  const [row] = await rows<{ count: string }>(
    "SELECT count(*)::text AS count FROM kitchen_tickets WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(row?.count ?? 0);
}

type ChangeRow = {
  from_status: string | null;
  to_status: string;
  item_to_status: string | null;
  order_item_id: string | null;
  source: string;
  actor_id: string | null;
  reason: string | null;
  occurred_at: Date | null;
};

async function changesOf(ticketId: string): Promise<ChangeRow[]> {
  return rows<ChangeRow>(
    `SELECT from_status, to_status, item_to_status, order_item_id::text AS order_item_id,
            source, actor_id::text AS actor_id, reason, occurred_at
     FROM kitchen_ticket_status_changes
     WHERE ticket_id = $1::uuid ORDER BY occurred_at, id`,
    [ulidToUuid(ticketId)],
  );
}

/** A fresh supervisor PIN approval for one line/order void (single use). */
async function approval(
  orderId: string,
  valueIdr: number,
  object: { objectType: "order" | "order_item"; objectId: string } = {
    objectType: "order",
    objectId: orderId,
  },
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: "void",
      valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: object.objectType,
      objectId: object.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisor.userId, approvalRequestId: randomUUID() };
}

async function voidLine(placed: Placed, menuItemId: string) {
  const itemId = lineOf(placed, menuItemId).id;
  return pos().voidItem(placed.orderId, itemId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    ...(await approval(placed.orderId, 200_000, {
      objectType: "order_item",
      objectId: itemId,
    })),
  });
}

async function voidWholeOrder(placed: Placed) {
  const current = await pos().get(placed.orderId);
  return pos().voidOrder(placed.orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    expectedStatus: current.body.data.status,
    ...(await approval(placed.orderId, 200_000)),
  });
}

// ===== KDS-01 =====================================================================

describe("KDS-01 routing: an item reaches the right station", () => {
  it("KDS-01 one ticket per station with exactly its own lines; an unmapped item gets no ticket", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi, quantity: 2, note: "Less sugar" },
      { menuItemId: ids.nasi },
      { menuItemId: ids.air },
    ]);
    const tickets = await ticketsOfOrder(placed.orderId);
    expect(tickets.map((t) => t.stationId).sort()).toEqual(
      [ids.barA, ids.kitchenA].sort(),
    );

    const bar = await ticketDetail(await ticketOn(placed.orderId, ids.barA));
    expect(bar).toMatchObject({
      stationId: ids.barA,
      outletId: tenant.outletId,
      status: "new",
    });
    expect(bar.items).toHaveLength(1);
    expect(bar.items[0]).toMatchObject({
      name: "Kopi Susu",
      quantity: 2,
      note: "Less sugar",
      status: "queued",
      orderItemId: lineOf(placed, ids.kopi).id,
    });

    const kitchen = await ticketDetail(
      await ticketOn(placed.orderId, ids.kitchenA),
    );
    expect(kitchen.status).toBe("new");
    expect(kitchen.items.map((item) => item.name)).toEqual(["Nasi Goreng"]);

    // The unmapped Air Mineral line is on no ticket at all.
    const allItems = [...bar.items, ...kitchen.items];
    expect(allItems.map((item) => item.menuItemId)).not.toContain(ids.air);
    const [count] = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM kitchen_ticket_items
       WHERE order_id = $1::uuid`,
      [ulidToUuid(placed.orderId)],
    );
    expect(count?.count).toBe("2");
  });

  it("KDS-01 the ticket shows on its own station screen and on no other, within 2 s of firing", async () => {
    const before = await Promise.all([
      snapshot(ids.barA),
      snapshot(ids.kitchenA),
    ]);
    // The clock starts at the fire ("setelah diteruskan"), not at order entry.
    const placed = await placeOrder([{ menuItemId: ids.kopi }], {
      hold: true,
    });
    const started = performance.now();
    const fired = await pos().fire(
      placed.orderId,
      placed.lines.map((line) => line.id),
      placed.status,
    );
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    const bar = await snapshot(ids.barA);
    const elapsed = performance.now() - started;
    // PRD KDS-01: "Item tampil di KDS stasiun benar ≤ 2 detik setelah fire".
    expect(elapsed).toBeLessThan(2_000);

    const ticketId = await ticketOn(placed.orderId, ids.barA);
    expect(bar.tickets.map((t) => t.id)).toContain(ticketId);
    expect(bar.sequence).toBeGreaterThan(before[0].sequence);
    const kitchen = await snapshot(ids.kitchenA);
    expect(kitchen.tickets.map((t) => t.id)).not.toContain(ticketId);
    expect(kitchen.sequence).toBe(before[1].sequence);
  });

  it("KDS-01 a held line gets a ticket only after it is fired, and only for the fired lines", async () => {
    const placed = await placeOrder(
      [{ menuItemId: ids.nasi }, { menuItemId: ids.kopi }],
      { hold: true },
    );
    expect(placed.lines.every((line) => line.fireStatus === "held")).toBe(true);
    expect(await ticketsOfOrder(placed.orderId)).toEqual([]);

    const fired = await pos().fire(
      placed.orderId,
      [lineOf(placed, ids.nasi).id],
      placed.status,
    );
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    const afterFirst = await ticketsOfOrder(placed.orderId);
    expect(afterFirst.map((t) => t.stationId)).toEqual([ids.kitchenA]);

    const current = await pos().get(placed.orderId);
    const second = await pos().fire(
      placed.orderId,
      [lineOf(placed, ids.kopi).id],
      current.body.data.status,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const afterSecond = await ticketsOfOrder(placed.orderId);
    expect(afterSecond.map((t) => t.stationId).sort()).toEqual(
      [ids.barA, ids.kitchenA].sort(),
    );
    // The first ticket is untouched by the second fire.
    expect(afterSecond.find((t) => t.stationId === ids.kitchenA)?.id).toBe(
      afterFirst[0]?.id,
    );
  });

  it("KDS-01 firing the same lines twice, even at once, never doubles a ticket or a line", async () => {
    const placed = await placeOrder(
      [{ menuItemId: ids.kopi }, { menuItemId: ids.nasi }],
      { hold: true },
    );
    const itemIds = placed.lines.map((line) => line.id);
    const [a, b] = await Promise.all([
      pos().fire(placed.orderId, itemIds, placed.status),
      pos().fire(placed.orderId, itemIds, placed.status),
    ]);
    // One fire wins; the other is accepted as a no-op or refused as stale
    // (409 nothing left to fire, 412 order version moved on).
    expect([a.status, b.status]).toContain(200);
    for (const response of [a, b])
      expect([200, 409, 412]).toContain(response.status);

    const current = await pos().get(placed.orderId);
    const again = await pos().fire(
      placed.orderId,
      itemIds,
      current.body.data.status,
    );
    expect([200, 409]).toContain(again.status);

    const tickets = await ticketsOfOrder(placed.orderId);
    expect(tickets).toHaveLength(2);
    const lines = await rows<{ order_item_id: string }>(
      `SELECT order_item_id::text AS order_item_id FROM kitchen_ticket_items
       WHERE order_id = $1::uuid`,
      [ulidToUuid(placed.orderId)],
    );
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.order_item_id)).size).toBe(2);
  });

  it("KDS-01 a menu item mapped to a station of another outlet is routed to the same-type station of the order's outlet", async () => {
    const placed = await placeOrder([{ menuItemId: ids.teh }]);
    const tickets = await ticketsOfOrder(placed.orderId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.stationId).toBe(ids.barA);
    const detail = await ticketDetail(tickets[0]!.id);
    expect(detail.outletId).toBe(tenant.outletId);
    expect(detail.items[0]?.name).toBe("Teh Tarik");
  });

  it("KDS-01 a station that cannot be resolved in the outlet rejects the whole fire and persists nothing", async () => {
    const placed = await placeOrder(
      [{ menuItemId: ids.nasi }, { menuItemId: ids.roti }],
      { hold: true },
    );
    const ticketsBefore = await ticketCount();
    const cursorBefore = await cursorOf(ids.kitchenA);

    const refused = await pos().fire(
      placed.orderId,
      placed.lines.map((line) => line.id),
      placed.status,
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);

    // Fail closed: not even the resolvable Nasi Goreng line was routed.
    expect(await ticketsOfOrder(placed.orderId)).toEqual([]);
    expect(await ticketCount()).toBe(ticketsBefore);
    expect(await cursorOf(ids.kitchenA)).toBe(cursorBefore);
    const order = await pos().get(placed.orderId);
    expect(
      order.body.data.items.every(
        (item: { fireStatus: string }) => item.fireStatus === "held",
      ),
    ).toBe(true);
  });
});

// ===== KDS-02 =====================================================================

describe("KDS-02 gapless feed and cursor resync", () => {
  it("KDS-02 the snapshot cursor plus feed(after) returns exactly the later changes, one entry per ticket", async () => {
    const cursor = await cursorOf(ids.barA);
    const first = await placeOrder([{ menuItemId: ids.kopi }]);
    const second = await placeOrder([{ menuItemId: ids.kopi }]);
    const ticket1 = await ticketOn(first.orderId, ids.barA);
    const ticket2 = await ticketOn(second.orderId, ids.barA);

    const created = await feed(ids.barA, cursor);
    expect(created.afterSequence).toBe(cursor);
    expect(created.hasMore).toBe(false);
    expect(created.entries.map((entry) => entry.ticket.id)).toEqual([
      ticket1,
      ticket2,
    ]);
    expect(created.entries.every((entry) => entry.sequence > cursor)).toBe(
      true,
    );
    expect(created.toSequence).toBe(created.entries.at(-1)?.sequence);
    expect(created.toSequence).toBe(await cursorOf(ids.barA));

    // Two changes on the same ticket collapse into its latest state.
    expect((await kds().start(ticket1)).status).toBe(200);
    expect((await kds().bump(ticket1)).status).toBe(200);
    const later = await feed(ids.barA, created.toSequence);
    expect(later.entries).toHaveLength(1);
    expect(later.entries[0]?.ticket).toMatchObject({
      id: ticket1,
      status: "done",
    });
    expect(later.toSequence).toBeGreaterThan(created.toSequence);

    // Nothing after the cursor: an empty page that does not move it.
    const none = await feed(ids.barA, later.toSequence);
    expect(none.entries).toEqual([]);
    expect(none.hasMore).toBe(false);
    expect(none.toSequence).toBe(later.toSequence);
    const beyond = await feed(ids.barA, later.toSequence + 1_000);
    expect(beyond.entries).toEqual([]);
    expect(beyond.toSequence).toBeGreaterThanOrEqual(later.toSequence + 1_000);

    // A station never sees another station's changes.
    const other = await feed(ids.kitchenA, await cursorOf(ids.kitchenA));
    expect(other.entries).toEqual([]);
  });

  it("KDS-02 the feed sequence of a station is gapless 1..n and equals its cursor", async () => {
    // Make sure both stations have history, including a no-op-free mix.
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.nasi },
    ]);
    await kds().start(await ticketOn(placed.orderId, ids.kitchenA));
    for (const stationId of [ids.barA, ids.kitchenA]) {
      const sequences = (
        await rows<{ sequence: number }>(
          `SELECT sequence::int AS sequence FROM kitchen_station_feed
           WHERE station_id = $1 ORDER BY sequence`,
          [stationId],
        )
      ).map((row) => row.sequence);
      expect(sequences.length).toBeGreaterThan(0);
      expect(sequences).toEqual(sequences.map((_, index) => index + 1));
      const [cursor] = await rows<{ last_sequence: number }>(
        `SELECT last_sequence::int AS last_sequence FROM kitchen_station_cursors
         WHERE station_id = $1`,
        [stationId],
      );
      expect(cursor?.last_sequence).toBe(sequences.length);
      expect(await cursorOf(stationId)).toBe(sequences.length);
    }
  });

  it("KDS-02 the snapshot is ordered by priority (highest first) and then by fire time", async () => {
    const early = await placeOrder([{ menuItemId: ids.nasi }]);
    const late = await placeOrder([{ menuItemId: ids.nasi }]);
    const earlyId = await ticketOn(early.orderId, ids.kitchenA);
    const lateId = await ticketOn(late.orderId, ids.kitchenA);
    const urgent = await kds().priority(lateId, 9);
    expect(urgent.status, JSON.stringify(urgent.body)).toBe(200);
    expect(urgent.body.data.priority).toBe(9);

    const { tickets } = await snapshot(ids.kitchenA);
    const order: string[] = tickets.map((ticket) => ticket.id);
    expect(order.indexOf(lateId)).toBeLessThan(order.indexOf(earlyId));
    for (let i = 1; i < tickets.length; i += 1) {
      const prev = tickets[i - 1]!;
      const next = tickets[i]!;
      expect(prev.priority).toBeGreaterThanOrEqual(next.priority);
      if (prev.priority === next.priority)
        expect(Date.parse(prev.firedAt)).toBeLessThanOrEqual(
          Date.parse(next.firedAt),
        );
    }
    // The priority change is a feed entry too.
    const cursor = await cursorOf(ids.kitchenA);
    expect((await kds().priority(earlyId, 3)).status).toBe(200);
    const changed = await feed(ids.kitchenA, cursor);
    expect(changed.entries.at(-1)?.ticket).toMatchObject({
      id: earlyId,
      priority: 3,
    });
  });
});

// ===== KDS-03 =====================================================================

describe("KDS-03 an item cancelled after firing is cancelled on the KDS", () => {
  it("KDS-03 voiding one fired line voids its ticket item; the ticket stays while another line is live", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.kopi, note: "Es banyak" },
    ]);
    const ticketId = await ticketOn(placed.orderId, ids.barA);
    const cursor = await cursorOf(ids.barA);
    const before = await ticketDetail(ticketId);
    expect(before.items).toHaveLength(2);

    const voidedLine = placed.lines[0]!;
    const response = await pos().voidItem(placed.orderId, voidedLine.id, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      ...(await approval(placed.orderId, 200_000, {
        objectType: "order_item",
        objectId: voidedLine.id,
      })),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const after = await ticketDetail(ticketId);
    expect(after.status).toBe("new");
    expect(
      after.items.find((i) => i.orderItemId === voidedLine.id)?.status,
    ).toBe("voided");
    expect(
      after.items.find((i) => i.orderItemId === placed.lines[1]!.id)?.status,
    ).toBe("queued");

    // Immediately visible to the screen through the feed.
    const changes = await feed(ids.barA, cursor);
    expect(changes.entries).toHaveLength(1);
    expect(
      changes.entries[0]?.ticket.items.find(
        (i) => i.orderItemId === voidedLine.id,
      )?.status,
    ).toBe("voided");

    // KDS-04: the per-item change is on record.
    const log = await changesOf(ticketId);
    const itemChange = log.find((row) => row.order_item_id !== null);
    expect(itemChange).toMatchObject({ item_to_status: "voided" });
    expect(itemChange?.occurred_at).toBeInstanceOf(Date);
  });

  it("KDS-03 voiding the last live line cancels the ticket, and the cancellation reaches the feed", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.nasi },
    ]);
    const barTicket = await ticketOn(placed.orderId, ids.barA);
    const kitchenTicket = await ticketOn(placed.orderId, ids.kitchenA);
    const cursor = await cursorOf(ids.barA);

    const response = await voidLine(placed, ids.kopi);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const bar = await ticketDetail(barTicket);
    expect(bar.status).toBe("cancelled");
    expect(bar.items.every((item) => item.status === "voided")).toBe(true);
    // The other station's ticket is untouched.
    expect((await ticketDetail(kitchenTicket)).status).toBe("new");

    const changes = await feed(ids.barA, cursor);
    expect(changes.entries.map((e) => [e.ticket.id, e.ticket.status])).toEqual([
      [barTicket, "cancelled"],
    ]);
    // The screen no longer lists it as an open ticket.
    expect((await snapshot(ids.barA)).tickets.map((t) => t.id)).not.toContain(
      barTicket,
    );

    const log = await changesOf(barTicket);
    const cancelled = log.find((row) => row.to_status === "cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled?.actor_id).not.toBeNull();
  });

  it("KDS-03 voiding the whole order cancels every ticket of it, including one already in progress", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.nasi },
    ]);
    const barTicket = await ticketOn(placed.orderId, ids.barA);
    const kitchenTicket = await ticketOn(placed.orderId, ids.kitchenA);
    expect((await kds().start(kitchenTicket)).status).toBe(200);
    const barCursor = await cursorOf(ids.barA);
    const kitchenCursor = await cursorOf(ids.kitchenA);

    const response = await voidWholeOrder(placed);
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    expect((await ticketDetail(barTicket)).status).toBe("cancelled");
    expect((await ticketDetail(kitchenTicket)).status).toBe("cancelled");
    for (const [stationId, cursor, ticketId] of [
      [ids.barA, barCursor, barTicket],
      [ids.kitchenA, kitchenCursor, kitchenTicket],
    ] as const) {
      const changes = await feed(stationId, cursor);
      expect(
        changes.entries.map((e) => [e.ticket.id, e.ticket.status]),
      ).toEqual([[ticketId, "cancelled"]]);
      expect(
        changes.entries[0]?.ticket.items.every((i) => i.status === "voided"),
      ).toBe(true);
    }
  });

  it("KDS-03 a ticket cancelled by voiding the order cannot be started again", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    expect((await voidWholeOrder(placed)).status).toBe(200);
    const restart = await kds().start(ticketId);
    expect(restart.status).toBe(409);
    expect((await ticketDetail(ticketId)).status).toBe("cancelled");
  });
});

// ===== KDS-04 and lifecycle =======================================================

describe("KDS-04 ticket lifecycle and audit trail", () => {
  it("KDS-04 start, bump, recall and restart each record time, user and reason", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi, quantity: 3 }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);

    const started = await kds().start(ticketId);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    let detail = kitchenTicketDetailSchema.parse(started.body.data);
    expect(detail.status).toBe("in_progress");
    expect(detail.startedAt).not.toBeNull();
    expect(detail.items.every((item) => item.status === "in_progress")).toBe(
      true,
    );

    const bumped = await kds().bump(ticketId);
    expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
    detail = kitchenTicketDetailSchema.parse(bumped.body.data);
    expect(detail.status).toBe("done");
    expect(detail.doneAt).not.toBeNull();
    expect(detail.items.every((item) => item.status === "ready")).toBe(true);
    expect(detail.items.every((item) => item.readyAt !== null)).toBe(true);

    const recalled = await kds().recall(ticketId, { reason: "Salah meja" });
    expect(recalled.status, JSON.stringify(recalled.body)).toBe(200);
    detail = kitchenTicketDetailSchema.parse(recalled.body.data);
    expect(detail.status).toBe("recalled");
    expect(detail.items.every((item) => item.status === "in_progress")).toBe(
      true,
    );
    expect(detail.items.every((item) => item.recalledCount === 1)).toBe(true);

    const restarted = await kds().start(ticketId);
    expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
    expect(restarted.body.data.status).toBe("in_progress");
    expect((await snapshot(ids.kitchenA)).tickets.map((t) => t.id)).toContain(
      ticketId,
    );

    const log = await changesOf(ticketId);
    expect(log.map((row) => [row.from_status, row.to_status])).toEqual([
      [null, "new"],
      ["new", "in_progress"],
      ["in_progress", "done"],
      ["done", "recalled"],
      ["recalled", "in_progress"],
    ]);
    for (const row of log) {
      expect(row.occurred_at).toBeInstanceOf(Date);
      expect(row.source).toBe("user");
      expect(row.actor_id).not.toBeNull();
    }
    // Who: the cashier fired it; the cook worked it.
    expect(log[0]?.actor_id).toBe(cashier.userId);
    for (const row of log.slice(1)) expect(row.actor_id).toBe(cook.userId);
    expect(log[3]?.reason).toBe("Salah meja");
    const times = log.map((row) => row.occurred_at!.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("KDS-04 voiding a ticket needs a reason and records it with the user", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const voided = await kds().voidTicket(ticketId, { reason: "Bahan habis" });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const detail = kitchenTicketDetailSchema.parse(voided.body.data);
    expect(detail.status).toBe("cancelled");
    expect(detail.items.every((item) => item.status === "voided")).toBe(true);
    const log = await changesOf(ticketId);
    expect(log.at(-1)).toMatchObject({
      from_status: "new",
      to_status: "cancelled",
      reason: "Bahan habis",
      actor_id: cook.userId,
    });
    // A cancelled ticket cannot have its priority changed either.
    expect((await kds().priority(ticketId, 5)).status).toBe(409);
  });

  it("KDS-04 a bumped ticket only serves or voids its lines; redoing a line needs the ticket recall", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    expect((await kds().start(ticketId)).status).toBe(200);
    expect((await kds().bump(ticketId)).status).toBe(200);
    const [line] = (await ticketDetail(ticketId)).items;
    expect(line?.status).toBe("ready");
    const before = await ticketDetail(ticketId);
    expect((await kds().item(line!.id, "recall")).status).toBe(409);
    expect((await kds().item(line!.id, "start")).status).toBe(409);
    expect(await ticketDetail(ticketId)).toEqual(before);
    const served = await kds().item(line!.id, "serve");
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    expect((await ticketDetail(ticketId)).status).toBe("done");
  });

  it("KDS-03 voiding the last live line on the KDS cancels its ticket", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.nasi },
      { menuItemId: ids.nasi, note: "Tanpa bawang" },
    ]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const [first, second] = (await ticketDetail(ticketId)).items;
    expect((await kds().item(first!.id, "void")).status).toBe(200);
    expect((await ticketDetail(ticketId)).status).toBe("new");
    expect((await kds().item(second!.id, "void")).status).toBe(200);
    const after = await ticketDetail(ticketId);
    expect(after.status).toBe("cancelled");
    expect(after.items.every((item) => item.status === "voided")).toBe(true);
    const log = await changesOf(ticketId);
    expect(
      log.filter((row) => row.order_item_id === null).map((r) => r.to_status),
    ).toEqual(["new", "cancelled"]);
  });

  it("KDS-04 item actions record per-item changes, and starting the first item starts a new ticket", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.nasi },
      { menuItemId: ids.nasi, note: "Pedas" },
    ]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const ticket = await ticketDetail(ticketId);
    const [first, second] = ticket.items;
    expect(first && second).toBeTruthy();

    const started = await kds().item(first!.id, "start");
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(kitchenTicketItemSchema.parse(started.body.data).status).toBe(
      "in_progress",
    );
    expect((await ticketDetail(ticketId)).status).toBe("in_progress");

    const ready = await kds().item(first!.id, "ready");
    expect(kitchenTicketItemSchema.parse(ready.body.data)).toMatchObject({
      status: "ready",
    });
    const served = await kds().item(first!.id, "serve");
    expect(kitchenTicketItemSchema.parse(served.body.data).status).toBe(
      "served",
    );
    // The other line was never touched.
    const after = await ticketDetail(ticketId);
    expect(after.items.find((i) => i.id === second!.id)?.status).toBe("queued");

    // A served item is terminal.
    const again = await kds().item(first!.id, "start");
    expect(again.status).toBe(409);

    const log = await changesOf(ticketId);
    const perItem = log.filter((row) => row.order_item_id !== null);
    expect(perItem.map((row) => row.item_to_status)).toEqual([
      "in_progress",
      "ready",
      "served",
    ]);
    for (const row of perItem) {
      expect(row.occurred_at).toBeInstanceOf(Date);
      expect(row.actor_id).toBe(cook.userId);
    }
  });

  it("KDS-04 status changes and the station feed are append-only, even for the database owner", async () => {
    const placed = await placeOrder([{ menuItemId: ids.kopi }]);
    const ticketId = await ticketOn(placed.orderId, ids.barA);
    const uuid = ulidToUuid(ticketId);
    const attempts: [string, unknown[]][] = [
      [
        "UPDATE kitchen_ticket_status_changes SET reason = 'x' WHERE tenant_id = $1 AND ticket_id = $2::uuid",
        [tenant.tenantId, uuid],
      ],
      [
        "DELETE FROM kitchen_ticket_status_changes WHERE tenant_id = $1 AND ticket_id = $2::uuid",
        [tenant.tenantId, uuid],
      ],
      [
        "UPDATE kitchen_station_feed SET sequence = sequence WHERE tenant_id = $1 AND ticket_id = $2::uuid",
        [tenant.tenantId, uuid],
      ],
      [
        "DELETE FROM kitchen_station_feed WHERE tenant_id = $1 AND ticket_id = $2::uuid",
        [tenant.tenantId, uuid],
      ],
    ];
    for (const [sql, params] of attempts)
      await expect(
        asOwnerTenant(tenant.tenantId, (client) => client.query(sql, params)),
        sql,
      ).rejects.toThrow(/append-only/i);
    expect((await changesOf(ticketId)).length).toBeGreaterThan(0);
  });
});

// ===== Illegal transitions ========================================================

describe("KDS illegal transitions change nothing", () => {
  async function stateOf(ticketId: string, stationId: string) {
    return {
      detail: await ticketDetail(ticketId),
      changes: (await changesOf(ticketId)).length,
      cursor: await cursorOf(stationId),
    };
  }

  it("KDS-04 bumping a ticket that was never started is refused with 409", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const before = await stateOf(ticketId, ids.kitchenA);
    const response = await kds().bump(ticketId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(await stateOf(ticketId, ids.kitchenA)).toEqual(before);
  });

  it("KDS-04 starting a cancelled ticket and bumping a done ticket twice are refused with 409", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.nasi },
      { menuItemId: ids.kopi },
    ]);
    const cancelled = await ticketOn(placed.orderId, ids.kitchenA);
    expect(
      (await kds().voidTicket(cancelled, { reason: "Salah input" })).status,
    ).toBe(200);
    const beforeCancelled = await stateOf(cancelled, ids.kitchenA);
    expect((await kds().start(cancelled)).status).toBe(409);
    expect((await kds().recall(cancelled, { reason: "Coba" })).status).toBe(
      409,
    );
    expect(await stateOf(cancelled, ids.kitchenA)).toEqual(beforeCancelled);

    const done = await ticketOn(placed.orderId, ids.barA);
    expect((await kds().start(done)).status).toBe(200);
    expect((await kds().bump(done)).status).toBe(200);
    const beforeDone = await stateOf(done, ids.barA);
    expect((await kds().bump(done)).status).toBe(409);
    expect((await kds().start(done)).status).toBe(409);
    expect(await stateOf(done, ids.barA)).toEqual(beforeDone);
  });

  it("KDS-04 recall and void without a reason are refused and change nothing", async () => {
    const placed = await placeOrder([{ menuItemId: ids.kopi }]);
    const ticketId = await ticketOn(placed.orderId, ids.barA);
    expect((await kds().start(ticketId)).status).toBe(200);
    expect((await kds().bump(ticketId)).status).toBe(200);
    const before = await stateOf(ticketId, ids.barA);

    for (const body of [{}, { reason: "" }]) {
      const response = await kds().recall(ticketId, body);
      expect([409, 422], JSON.stringify(body)).toContain(response.status);
    }
    const voidResponse = await kds().voidTicket(ticketId, {});
    expect([409, 422]).toContain(voidResponse.status);
    expect(await stateOf(ticketId, ids.barA)).toEqual(before);
    expect(before.detail.status).toBe("done");
  });

  it("KDS-04 recalling a ticket that is not done is refused with 409", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const before = await stateOf(ticketId, ids.kitchenA);
    const response = await kds().recall(ticketId, { reason: "Terlalu cepat" });
    expect(response.status).toBe(409);
    expect(await stateOf(ticketId, ids.kitchenA)).toEqual(before);
  });

  it("KDS-04 a priority outside 0..9 is refused and an unknown ticket is not found", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const before = await stateOf(ticketId, ids.kitchenA);
    expect((await kds().priority(ticketId, 10)).status).toBe(422);
    expect((await kds().priority(ticketId, -1)).status).toBe(422);
    expect(await stateOf(ticketId, ids.kitchenA)).toEqual(before);

    const missing = uuidToUlid(randomUUID());
    expect((await kds().ticket(missing)).status).toBe(404);
    expect((await kds().start(missing)).status).toBe(404);
    expect([404, 422]).toContain((await kds().ticket("not-a-ticket")).status);
  });
});

// ===== Isolation and authorization ================================================

describe("KDS isolation and authorization", () => {
  let target: { orderId: string; ticketId: string };

  beforeAll(async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    target = {
      orderId: placed.orderId,
      ticketId: await ticketOn(placed.orderId, ids.kitchenA),
    };
  });

  it("TEN-01 another tenant's staff cannot read or act on a ticket, and RLS shows them no KDS row", async () => {
    const other = (path: string) =>
      tenantBCook.client.get(path).set(headersB).set(originHeader);
    const base = `/api/outlets/${tenant.outletId}/kitchen`;
    const before = await ticketDetail(target.ticketId);

    // Through the other tenant's own host, naming this tenant's outlet.
    for (const path of [
      `${base}/tickets/${target.ticketId}`,
      `${base}/stations/${ids.kitchenA}/tickets`,
      `${base}/stations/${ids.kitchenA}/feed?after=0`,
    ])
      expect([403, 404], path).toContain((await other(path)).status);
    const acted = await tenantBCook.client
      .post(`${base}/tickets/${target.ticketId}/start`)
      .set(headersB)
      .set(originHeader)
      .send({});
    expect([403, 404]).toContain(acted.status);

    // Through the other tenant's own outlet: the ticket does not exist there.
    const own = await tenantBCook.client
      .get(
        `/api/outlets/${tenantB.outletId}/kitchen/tickets/${target.ticketId}`,
      )
      .set(headersB)
      .set(originHeader);
    expect([403, 404]).toContain(own.status);

    // Through this tenant's host with another tenant's account.
    const crossHost = await tenantBCook.client
      .get(`${base}/tickets/${target.ticketId}`)
      .set(headers)
      .set(originHeader);
    expect([401, 403, 404]).toContain(crossHost.status);

    expect(await ticketDetail(target.ticketId)).toEqual(before);

    // The restricted app role under the other tenant sees none of the rows.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantB.tenantId],
      );
      for (const table of [
        "kitchen_tickets",
        "kitchen_ticket_items",
        "kitchen_ticket_status_changes",
        "kitchen_station_feed",
        "kitchen_station_cursors",
      ]) {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
          [tenant.tenantId],
        );
        expect(result.rows[0]?.count, table).toBe("0");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 the outlet RLS hides KDS rows from a context scoped to another outlet", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenant.tenantId, JSON.stringify([ids.outletB])],
      );
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM kitchen_tickets",
      );
      expect(result.rows[0]?.count).toBe("0");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 staff of outlet B cannot read or act on outlet A's station and tickets", async () => {
    const asB = kds(outletBStaff, tenant.outletId);
    expect((await asB.snapshot(ids.kitchenA)).status).toBe(403);
    expect((await asB.feed(ids.kitchenA, 0)).status).toBe(403);
    expect([403, 404]).toContain((await asB.ticket(target.ticketId)).status);
    expect([403, 404]).toContain((await asB.start(target.ticketId)).status);

    // Naming their own outlet in the path does not help: the station and the
    // ticket belong to outlet A.
    const ownOutlet = kds(outletBStaff, ids.outletB);
    expect([403, 404]).toContain(
      (await ownOutlet.snapshot(ids.kitchenA)).status,
    );
    expect([403, 404]).toContain(
      (await ownOutlet.ticket(target.ticketId)).status,
    );
    expect((await ticketDetail(target.ticketId)).status).toBe("new");

    // They do get their own outlet's station (empty: nothing was fired there).
    const own = await ownOutlet.snapshot(ids.barB);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.tickets).toEqual([]);
  });

  it("TEN-03 staff without kds.ticket.process get 403 everywhere, anonymous callers 401", async () => {
    const denied = kds(noKds);
    expect((await denied.snapshot(ids.kitchenA)).status).toBe(403);
    expect((await denied.feed(ids.kitchenA, 0)).status).toBe(403);
    expect((await denied.ticket(target.ticketId)).status).toBe(403);
    expect((await denied.start(target.ticketId)).status).toBe(403);
    expect((await denied.item(uuidToUlid(randomUUID()), "start")).status).toBe(
      403,
    );

    const anonymous = await agent(app)
      .get(
        `/api/outlets/${tenant.outletId}/kitchen/stations/${ids.kitchenA}/tickets`,
      )
      .set(headers)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
    expect((await ticketDetail(target.ticketId)).status).toBe("new");
  });

  it("TEN-03 a station-scoped cook sees and works only their own station", async () => {
    const asBarista = kds(barista);
    const barOrder = await placeOrder([{ menuItemId: ids.kopi }]);
    const barTicket = await ticketOn(barOrder.orderId, ids.barA);

    const own = await asBarista.snapshot(ids.barA);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.tickets.map((t: { id: string }) => t.id)).toContain(
      barTicket,
    );
    expect((await asBarista.start(barTicket)).status).toBe(200);

    // The kitchen station of the same outlet is out of reach, read or write.
    expect((await asBarista.snapshot(ids.kitchenA)).status).toBe(403);
    expect((await asBarista.feed(ids.kitchenA, 0)).status).toBe(403);
    expect((await asBarista.ticket(target.ticketId)).status).toBe(403);
    expect((await asBarista.start(target.ticketId)).status).toBe(403);
    expect((await ticketDetail(target.ticketId)).status).toBe("new");
    expect(
      (await changesOf(target.ticketId)).map((row) => row.to_status),
    ).toEqual(["new"]);
  });

  it("TEN-03 an unknown station, or one of another outlet, is refused (fail closed)", async () => {
    for (const stationId of [randomUUID(), ids.barB]) {
      const snapshotResponse = await kds().snapshot(stationId);
      expect([403, 404], stationId).toContain(snapshotResponse.status);
      const feedResponse = await kds().feed(stationId, 0);
      expect([403, 404], stationId).toContain(feedResponse.status);
    }
    // Malformed ids never reach the service.
    expect([403, 404, 422]).toContain(
      (await kds().snapshot("not-a-station")).status,
    );
    expect((await kds().feed(ids.barA, "abc")).status).toBe(422);
    expect((await kds().feed(ids.barA, -1)).status).toBe(422);
  });
});

// ===== Realtime staff login =========================================================

describe("KDS realtime staff login (resolveKdsStaffConnection)", () => {
  async function cookieOf(staff: Member): Promise<string> {
    const session = await staff.client.get("/api/auth/get-session");
    const response = await agent(app)
      .post("/api/auth/sign-in/email")
      .set(originHeader)
      .send({
        email: session.body.user.email,
        password: "Test-password-123!",
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const header = response.headers["set-cookie"] as unknown as
      string[] | string;
    const cookies = Array.isArray(header) ? header : [header];
    return cookies.map((value) => value.split(";")[0]).join("; ");
  }

  const upgrade = (
    host: string,
    cookie: string,
    outletId: string,
    stationId: string,
  ) =>
    ({
      url: `/api/outlets/${outletId}/kitchen/stations/${stationId}/realtime?after=0`,
      headers: { host, ...(cookie ? { cookie } : {}) },
    }) as unknown as IncomingMessage;

  it("TEN-03 a station-scoped cook's socket opens on their own station only", async () => {
    const cookie = await cookieOf(barista);
    const own = await resolveKdsStaffConnection(
      upgrade(tenant.hostname, cookie, tenant.outletId, ids.barA),
    );
    expect(own?.userId).toBe(barista.userId);
    expect(
      await resolveKdsStaffConnection(
        upgrade(tenant.hostname, cookie, tenant.outletId, ids.kitchenA),
      ),
    ).toBeNull();
  });

  it("TEN-01 another tenant's host, no session, another outlet's station or an unknown station is refused", async () => {
    const cookie = await cookieOf(cook);
    expect(
      await resolveKdsStaffConnection(
        upgrade(tenant.hostname, cookie, tenant.outletId, ids.kitchenA),
      ),
    ).not.toBeNull();
    for (const request of [
      upgrade(tenantB.hostname, cookie, tenant.outletId, ids.kitchenA),
      upgrade(tenant.hostname, "", tenant.outletId, ids.kitchenA),
      upgrade(tenant.hostname, cookie, tenant.outletId, ids.barB),
      upgrade(tenant.hostname, cookie, tenant.outletId, randomUUID()),
    ])
      expect(await resolveKdsStaffConnection(request)).toBeNull();
  });
});
