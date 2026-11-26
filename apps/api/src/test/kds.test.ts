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
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  KDS_RESYNC_REQUIRED,
  KITCHEN_FEED_PAGE_LIMIT,
  kitchenStationFeedSchema,
  kitchenStationSnapshotSchema,
  kitchenTicketDetailSchema,
  kitchenTicketItemSchema,
  type KitchenStationFeed,
  type KitchenStationSnapshot,
  type KitchenTicketDetail,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { appendStationFeed } from "../services/kds-support.ts";
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
  teh: randomUUID(), // beverage_bar, override bar B (outlet B only) -> bar A here
  roti: randomUUID(), // pastry: a station type that exists only in outlet B
  mie: randomUUID(), // hot_kitchen type only, no station override -> kitchen A
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
let outletCashier: Member; // POS cashier limited to outlet A (legend-s2dh)
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
    ["tenant", "outlet"],
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
  outletCashier = await member(
    tenant,
    ids.cashierRole,
    { type: "outlet", id: tenant.outletId },
    "KDS Kasir Outlet A",
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
    // Brand-level menu: a station TYPE, plus an optional station override
    // that only applies inside that station's outlet (legend-s2dh).
    const items: [string, string, string | null, string | null][] = [
      [ids.kopi, "Kopi Susu", ids.barA, "beverage_bar"],
      [ids.nasi, "Nasi Goreng", ids.kitchenA, "hot_kitchen"],
      [ids.air, "Air Mineral", null, null],
      [ids.teh, "Teh Tarik", ids.barB, "beverage_bar"],
      [ids.roti, "Roti Bakar", ids.pastryB, "pastry"],
      [ids.mie, "Mie Goreng", null, "hot_kitchen"],
    ];
    for (const [id, name, stationId, stationType] of items)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          ids.category,
          name,
          randomUUID(),
          stationId,
          stationType,
        ],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const id of [ids.kopi, ids.nasi, ids.air, ids.teh, ids.roti, ids.mie])
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
  return posAs(who);
}

function posAs(who: Member = cashier) {
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
  options: { hold?: boolean; who?: Member } = {},
): Promise<Placed> {
  const pos = () => posAs(options.who);
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
): Promise<{ approvedBy: string; overrideId: string }> {
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
  return { approvedBy: supervisor.userId, overrideId: override.id };
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

  it("KDS-01 a cashier limited to one outlet fires lines whose menu names a station type; each lands on this outlet's station of that type (legend-s2dh)", async () => {
    // Teh Tarik's override is bar B in outlet B, which outlet RLS hides from
    // this cashier; the brand-level type still resolves to bar A (no 409).
    const placed = await placeOrder(
      [
        { menuItemId: ids.teh },
        { menuItemId: ids.mie },
        { menuItemId: ids.air },
      ],
      { who: outletCashier },
    );
    const tickets = await ticketsOfOrder(placed.orderId);
    expect(tickets.map((ticket) => ticket.stationId).sort()).toEqual(
      [ids.barA, ids.kitchenA].sort(),
    );
    const onBar = await ticketDetail(await ticketOn(placed.orderId, ids.barA));
    expect(onBar.items.map((item) => item.name)).toEqual(["Teh Tarik"]);
    const onKitchen = await ticketDetail(
      await ticketOn(placed.orderId, ids.kitchenA),
    );
    expect(onKitchen.items.map((item) => item.name)).toEqual(["Mie Goreng"]);
  });

  it("routes inactive station targets to the first active station of the same outlet", async () => {
    const laterStation = randomUUID();
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE stations SET is_active = false, display_order = 0 WHERE id = $1`,
        [ids.barA],
      );
      await client.query(
        `UPDATE stations SET display_order = 2 WHERE id = $1`,
        [ids.kitchenA],
      );
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type, is_active, display_order)
         VALUES ($1, $2, $3, 'Later station', 'pastry', true, 3)`,
        [laterStation, tenant.tenantId, tenant.outletId],
      );
    });
    try {
      // The explicit override and type-based target both name inactive bar A.
      // Outlet B has active stations with a lower default display order.
      const placed = await placeOrder([
        { menuItemId: ids.kopi },
        { menuItemId: ids.teh },
      ]);
      const tickets = await ticketsOfOrder(placed.orderId);
      expect(tickets.map((ticket) => ticket.stationId)).toEqual([ids.kitchenA]);
      const detail = await ticketDetail(tickets[0]!.id);
      expect(detail.items.map((item) => item.menuItemId).sort()).toEqual(
        [ids.kopi, ids.teh].sort(),
      );
      const misplaced = await rows<{ count: string }>(
        `SELECT count(*)::text AS count FROM kitchen_tickets
         WHERE order_id = $1::uuid AND (tenant_id <> $2 OR outlet_id <> $3)`,
        [ulidToUuid(placed.orderId), tenant.tenantId, tenant.outletId],
      );
      expect(misplaced[0]?.count).toBe("0");
    } finally {
      await asOwnerTenant(tenant.tenantId, async (client) => {
        await client.query(`DELETE FROM stations WHERE id = $1`, [
          laterStation,
        ]);
        await client.query(
          `UPDATE stations SET is_active = true, display_order = 0 WHERE id IN ($1, $2)`,
          [ids.barA, ids.kitchenA],
        );
      });
    }
  });

  it("preserves legacy routing when no station in the outlet is active", async () => {
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE stations SET is_active = false WHERE outlet_id = $1`,
        [tenant.outletId],
      );
    });
    try {
      const placed = await placeOrder([{ menuItemId: ids.kopi }]);
      expect(
        (await ticketsOfOrder(placed.orderId)).map((t) => t.stationId),
      ).toEqual([ids.barA]);
    } finally {
      await asOwnerTenant(tenant.tenantId, async (client) => {
        await client.query(
          `UPDATE stations SET is_active = true WHERE outlet_id = $1`,
          [tenant.outletId],
        );
      });
    }
  });

  it("KDS-01 a station override applies only in its own outlet", async () => {
    // Kopi Susu's override is bar A itself: used as-is in outlet A.
    const placed = await placeOrder([{ menuItemId: ids.kopi }], {
      who: outletCashier,
    });
    const tickets = await ticketsOfOrder(placed.orderId);
    expect(tickets.map((ticket) => ticket.stationId)).toEqual([ids.barA]);
  });

  it("KDS-01 a line whose station cannot be resolved is fired without a ticket and audited; the sale never fails", async () => {
    // Roti is pastry and only outlet B has a pastry station: unresolvable here.
    const placed = await placeOrder(
      [{ menuItemId: ids.nasi }, { menuItemId: ids.roti }],
      { hold: true },
    );

    const fired = await pos().fire(
      placed.orderId,
      placed.lines.map((line) => line.id),
      placed.status,
    );
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);

    // The routable line has its ticket; roti has none.
    const tickets = await ticketsOfOrder(placed.orderId);
    expect(tickets.map((ticket) => ticket.stationId)).toEqual([ids.kitchenA]);
    const onKitchen = await ticketDetail(
      await ticketOn(placed.orderId, ids.kitchenA),
    );
    expect(onKitchen.items.map((item) => item.name)).toEqual(["Nasi Goreng"]);

    // Both lines are fired, so the sale goes on.
    const order = await pos().get(placed.orderId);
    expect(
      order.body.data.items.every(
        (item: { fireStatus: string }) => item.fireStatus === "fired",
      ),
    ).toBe(true);

    // The skipped line is recorded in the audit log.
    const roti = placed.lines.find((line) => line.menuItemId === ids.roti);
    const audit = await rows<{ event: { after?: { itemIds?: string[] } } }>(
      `SELECT event FROM audit_logs
       WHERE tenant_id = $1 AND event->>'action' = 'kitchen_ticket.unrouted'
         AND event->>'objectId' = $2`,
      [tenant.tenantId, placed.orderId],
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.event)).toContain(roti?.id ?? "missing");
  });

  it("KDS-01 an order whose lines are all unroutable still fires and creates no ticket", async () => {
    const placed = await placeOrder([{ menuItemId: ids.roti }]);
    expect(await ticketsOfOrder(placed.orderId)).toEqual([]);
  });
});

// ===== KDS-02 =====================================================================

// ---- Feed seeding helpers (KDS-02 resync, paging and pruning) ------------------------
// Stations of a type no menu item maps to, so seeded cursors and feed rows
// never mix with the routed stations the other tests count on.

async function extraStation(type: "coffee_bar" | "cold_kitchen" | "pastry") {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        `Uji feed ${id.slice(0, 8)}`,
        type,
      ],
    ),
  );
  return id;
}

/** Cursor row and feed rows written as the owner (the trigger allows inserts). */
async function seedFeed(
  stationId: string,
  cursor: number,
  feedRows: { sequence: number; ticketId: string; ageHours?: number }[],
) {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO kitchen_station_cursors (tenant_id, outlet_id, station_id, last_sequence)
       VALUES ($1, $2, $3, $4)`,
      [tenant.tenantId, tenant.outletId, stationId, cursor],
    );
    for (const row of feedRows)
      await client.query(
        `INSERT INTO kitchen_station_feed (id, tenant_id, outlet_id, station_id, sequence, ticket_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::uuid, now() - make_interval(hours => $7))`,
        [
          randomUUID(),
          tenant.tenantId,
          tenant.outletId,
          stationId,
          row.sequence,
          ulidToUuid(row.ticketId),
          row.ageHours ?? 0,
        ],
      );
  });
}

async function feedSequences(stationId: string): Promise<number[]> {
  return (
    await rows<{ sequence: number }>(
      `SELECT sequence::int AS sequence FROM kitchen_station_feed
       WHERE station_id = $1 ORDER BY sequence`,
      [stationId],
    )
  ).map((row) => row.sequence);
}

async function anyTicket(): Promise<string> {
  const placed = await placeOrder([{ menuItemId: ids.kopi }]);
  return ticketOn(placed.orderId, ids.barA);
}

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
    // A cursor ahead of the station is not trusted: resync, never an empty page.
    const beyond = await kds().feed(ids.barA, later.toSequence + 1_000);
    expect(beyond.status, JSON.stringify(beyond.body)).toBe(409);
    expect(beyond.body.error.code).toBe(KDS_RESYNC_REQUIRED);

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

  it("KDS-02 a cursor ahead of the station, too far behind it, or past pruned rows must resync with 409 KDS_RESYNC_REQUIRED", async () => {
    const ticketId = await anyTicket();
    const expectResync = async (stationId: string, after: number) => {
      const response = await kds().feed(stationId, after);
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe(KDS_RESYNC_REQUIRED);
    };

    // A station without any change: only 0 is a valid cursor.
    const empty = await extraStation("coffee_bar");
    expect((await feed(empty, 0)).entries).toEqual([]);
    await expectResync(empty, 1);

    // Far behind: 5000 changes ahead of a cursor at 100 (lag limit 2000).
    const lagging = await extraStation("cold_kitchen");
    await seedFeed(lagging, 5_000, [
      { sequence: 3_001, ticketId },
      { sequence: 5_000, ticketId },
    ]);
    await expectResync(lagging, 100);
    await expectResync(lagging, 5_001);
    // Exactly at the limit still resumes: 5000 - 3000 = 2000.
    expect((await feed(lagging, 3_000)).entries).toHaveLength(1);

    // Rows 1..5 were pruned: a cursor before the oldest retained row resyncs,
    // one that starts right at it does not (row 5 is the one it still needs).
    const pruned = await extraStation("pastry");
    await seedFeed(
      pruned,
      10,
      [6, 7, 8, 9, 10].map((sequence) => ({ sequence, ticketId })),
    );
    await expectResync(pruned, 2);
    await expectResync(pruned, 4);
    expect((await feed(pruned, 5)).entries).toHaveLength(1);
    expect((await feed(pruned, 10)).entries).toEqual([]);
  });

  it("KDS-02 more changed tickets than one page gives hasMore, and the next page continues from toSequence without a gap or duplicate", async () => {
    const template = ulidToUuid(await anyTicket());
    const total = KITCHEN_FEED_PAGE_LIMIT + 50;
    const station = await extraStation("coffee_bar");
    await asOwnerTenant(tenant.tenantId, async (client) => {
      // `total` distinct tickets, each a clone of one real ticket with its
      // own cloned order line and ticket line (a detail needs >= 1 line), and
      // one feed row each, so nothing collapses. Cloning through temp tables
      // keeps every column without listing them.
      await client.query(
        `CREATE TEMP TABLE seed ON COMMIT DROP AS
         SELECT n, gen_random_uuid() AS ticket_id, gen_random_uuid() AS order_item_id
         FROM generate_series(1, $1::int) AS n`,
        [total],
      );
      await client.query(
        `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no, status, priority, fired_at)
         SELECT s.ticket_id, t.tenant_id, t.outlet_id, t.order_id, $2::uuid, gen_random_uuid(), '2026-11-01',
                (SELECT coalesce(max(m.ticket_no), 0) FROM kitchen_tickets m
                 WHERE m.tenant_id = t.tenant_id AND m.outlet_id = t.outlet_id AND m.business_date = '2026-11-01') + s.n::int,
                'new', 0, now()
         FROM kitchen_tickets t, seed s WHERE t.id = $1::uuid`,
        [template, station],
      );
      await client.query(
        `CREATE TEMP TABLE order_line_clone ON COMMIT DROP AS
         SELECT oi.*, s.order_item_id AS new_id FROM order_items oi, seed s
         WHERE oi.id = (SELECT order_item_id FROM kitchen_ticket_items WHERE ticket_id = $1::uuid LIMIT 1)`,
        [template],
      );
      await client.query("UPDATE order_line_clone SET id = new_id");
      await client.query("ALTER TABLE order_line_clone DROP COLUMN new_id");
      await client.query(
        "INSERT INTO order_items SELECT * FROM order_line_clone",
      );
      await client.query(
        `CREATE TEMP TABLE ticket_line_clone ON COMMIT DROP AS
         SELECT ti.*, s.ticket_id AS new_ticket_id, s.order_item_id AS new_order_item_id
         FROM kitchen_ticket_items ti, seed s WHERE ti.ticket_id = $1::uuid`,
        [template],
      );
      await client.query(
        `UPDATE ticket_line_clone
         SET id = gen_random_uuid(), ticket_id = new_ticket_id, order_item_id = new_order_item_id`,
      );
      await client.query(
        "ALTER TABLE ticket_line_clone DROP COLUMN new_ticket_id, DROP COLUMN new_order_item_id",
      );
      await client.query(
        "INSERT INTO kitchen_ticket_items SELECT * FROM ticket_line_clone",
      );
      await client.query(
        `INSERT INTO kitchen_station_feed (id, tenant_id, outlet_id, station_id, sequence, ticket_id, occurred_at)
         SELECT gen_random_uuid(), t.tenant_id, t.outlet_id, t.station_id, s.n, t.id, now()
         FROM kitchen_tickets t JOIN seed s ON s.ticket_id = t.id`,
      );
      await client.query(
        `INSERT INTO kitchen_station_cursors (tenant_id, outlet_id, station_id, last_sequence)
         VALUES ($1, $2, $3, $4)`,
        [tenant.tenantId, tenant.outletId, station, total],
      );
    });

    const first = await feed(station, 0);
    expect(first.entries).toHaveLength(KITCHEN_FEED_PAGE_LIMIT);
    expect(first.hasMore).toBe(true);
    expect(first.toSequence).toBe(KITCHEN_FEED_PAGE_LIMIT);
    const second = await feed(station, first.toSequence);
    expect(second.entries).toHaveLength(total - KITCHEN_FEED_PAGE_LIMIT);
    expect(second.hasMore).toBe(false);
    expect(second.toSequence).toBe(total);
    const sequences = [...first.entries, ...second.entries].map(
      (entry) => entry.sequence,
    );
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(
      new Set([...first.entries, ...second.entries].map((e) => e.ticket.id))
        .size,
    ).toBe(total);
  });

  it("KDS-02 parallel fires on one station keep the feed gapless 1..n and equal to the cursor", async () => {
    const before = await cursorOf(ids.barA);
    const parallel = 6;
    const placed = await Promise.all(
      Array.from({ length: parallel }, () =>
        placeOrder([{ menuItemId: ids.kopi }]),
      ),
    );
    expect(placed).toHaveLength(parallel);
    const sequences = await feedSequences(ids.barA);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(sequences.length - before).toBe(parallel);
    expect(await cursorOf(ids.barA)).toBe(sequences.length);
  });

  it("KDS-02 the feed of a station is pruned only past both the retention and the lag, and only by the app", async () => {
    const ticketId = await anyTicket();
    const station = await extraStation("coffee_bar");
    // Cursor 2999: the next change is 3000, a multiple of 500, so it prunes
    // rows below 3000 - 2000 = 1000 that are older than 24 hours.
    await seedFeed(station, 2_999, [
      { sequence: 1, ticketId, ageHours: 25 }, // old and far behind: pruned
      { sequence: 2, ticketId, ageHours: 25 },
      { sequence: 500, ticketId, ageHours: 1 }, // far behind but recent: kept
      { sequence: 2_500, ticketId, ageHours: 25 }, // old but inside the lag: kept
    ]);
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const sequence = await withTenant(db, context, (tx) =>
      appendStationFeed(tx, context, {
        outletId: tenant.outletId,
        stationId: station,
        ticketId,
        now: new Date(),
      }),
    );
    expect(sequence).toBe(3_000);
    expect(await feedSequences(station)).toEqual([500, 2_500, 3_000]);
    // The feed still answers for a cursor inside the retained range.
    expect((await feed(station, 2_500)).entries).toHaveLength(1);
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
  it("KDS-03 a void on the KDS stays kitchen-only and tells the POS through an order event", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.kopi },
      { menuItemId: ids.nasi },
    ]);
    const before = await pos().get(placed.orderId);
    expect(before.status).toBe(200);
    const kopiLine = lineOf(placed, ids.kopi);
    const nasiLine = lineOf(placed, ids.nasi);

    const barTicket = await ticketOn(placed.orderId, ids.barA);
    const voided = await kds().voidTicket(barTicket, { reason: "Susu habis" });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const kitchenTicket = await ticketDetail(
      await ticketOn(placed.orderId, ids.kitchenA),
    );
    const voidedLine = await kds().item(kitchenTicket.items[0]!.id, "void");
    expect(voidedLine.status, JSON.stringify(voidedLine.body)).toBe(200);

    // The bill is untouched: lines and total change only through a POS void.
    const after = await pos().get(placed.orderId);
    expect(after.body.data.totalIdr).toBe(before.body.data.totalIdr);
    expect(
      after.body.data.items.map((item: { status: string }) => item.status),
    ).toEqual(
      before.body.data.items.map((item: { status: string }) => item.status),
    );

    // The cashier sees both KDS voids in the order's event log, in order.
    const events = await cashier.client
      .get(
        `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders/${placed.orderId}/events?limit=50`,
      )
      .set(headers)
      .set(originHeader);
    expect(events.status, JSON.stringify(events.body)).toBe(200);
    const notices = (
      events.body.data as {
        type: string;
        actorId: string | null;
        payload: Record<string, unknown>;
      }[]
    ).filter((event) => event.type === "order.kitchen_voided");
    expect(notices).toHaveLength(2);
    expect(notices[0]?.actorId).toBe(cook.userId);
    expect(notices[0]?.payload).toMatchObject({
      ticketId: barTicket,
      stationId: ids.barA,
      orderItemIds: [kopiLine.id],
      ticketCancelled: true,
      reason: "Susu habis",
    });
    expect(notices[1]?.payload).toMatchObject({
      ticketId: kitchenTicket.id,
      stationId: ids.kitchenA,
      orderItemIds: [nasiLine.id],
      ticketCancelled: true,
    });
  });

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

    // Ticket-level rows only; the per-item rows are asserted in their own test.
    const log = (await changesOf(ticketId)).filter(
      (row) => row.order_item_id === null,
    );
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

  it("KDS-04 ticket start records one status change per queued line, and an item recall clears readyAt (legend-9x2e, legend-naz1)", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.nasi },
      { menuItemId: ids.nasi, note: "Pedas" },
    ]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const [first, second] = (await ticketDetail(ticketId)).items;
    expect(first && second).toBeTruthy();

    expect((await kds().start(ticketId)).status).toBe(200);
    const startRows = (await changesOf(ticketId)).filter(
      (row) => row.order_item_id !== null && row.to_status === "in_progress",
    );
    expect(startRows.map((row) => row.item_to_status)).toEqual([
      "in_progress",
      "in_progress",
    ]);
    expect(new Set(startRows.map((row) => row.order_item_id)).size).toBe(2);
    for (const row of startRows) {
      expect(row.from_status).toBe("new");
      expect(row.actor_id).toBe(cook.userId);
    }

    // Item recall: the line is redone, so its old ready time must not stay.
    expect((await kds().item(first!.id, "ready")).status).toBe(200);
    const ready = (await ticketDetail(ticketId)).items.find(
      (i) => i.id === first!.id,
    );
    expect(ready?.readyAt).not.toBeNull();
    const recalled = await kds().item(first!.id, "recall");
    expect(recalled.status, JSON.stringify(recalled.body)).toBe(200);
    const after = (await ticketDetail(ticketId)).items.find(
      (i) => i.id === first!.id,
    );
    expect(after?.status).toBe("in_progress");
    expect(after?.readyAt).toBeNull();
    expect(after?.recalledCount).toBe(1);
  });

  it("KDS-04 ticket bump, recall and void each record one status change per affected line, and recall clears readyAt", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.nasi },
      { menuItemId: ids.nasi, note: "Pedas" },
    ]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const [first, second] = (await ticketDetail(ticketId)).items;
    // One line in progress, one still queued: the bump moves both to ready.
    expect((await kds().item(first!.id, "start")).status).toBe(200);

    // Rows written by the three ticket-level actions only (the item start
    // above ends in in_progress, the ticket creation row has no line).
    const lineRows = () =>
      rows<{
        order_item_id: string;
        from_status: string;
        to_status: string;
        item_from_status: string;
        item_to_status: string;
        reason: string | null;
      }>(
        `SELECT order_item_id::text AS order_item_id, from_status, to_status,
                item_from_status, item_to_status, reason
         FROM kitchen_ticket_status_changes
         WHERE ticket_id = $1::uuid AND order_item_id IS NOT NULL
           AND to_status IN ('done', 'recalled', 'cancelled')
         ORDER BY occurred_at, id`,
        [ulidToUuid(ticketId)],
      );
    const shape = (list: Awaited<ReturnType<typeof lineRows>>) =>
      list
        .map((row) =>
          [
            row.from_status,
            row.to_status,
            row.item_from_status,
            row.item_to_status,
          ].join(">"),
        )
        .sort();

    expect((await kds().bump(ticketId)).status).toBe(200);
    let list = await lineRows();
    expect(shape(list)).toEqual([
      "in_progress>done>in_progress>ready",
      "in_progress>done>queued>ready",
    ]);
    expect(new Set(list.map((row) => row.order_item_id)).size).toBe(2);
    expect(
      (await ticketDetail(ticketId)).items.every((i) => i.readyAt !== null),
    ).toBe(true);

    expect(
      (await kds().recall(ticketId, { reason: "Salah meja" })).status,
    ).toBe(200);
    list = (await lineRows()).filter((row) => row.to_status === "recalled");
    expect(shape(list)).toEqual([
      "done>recalled>ready>in_progress",
      "done>recalled>ready>in_progress",
    ]);
    for (const row of list) expect(row.reason).toBe("Salah meja");
    // The lines are being redone: no stale ready time may survive the recall.
    const recalled = await ticketDetail(ticketId);
    expect(recalled.items.every((i) => i.status === "in_progress")).toBe(true);
    expect(recalled.items.every((i) => i.readyAt === null)).toBe(true);
    expect(second && recalled.items.length).toBe(2);

    expect(
      (await kds().voidTicket(ticketId, { reason: "Bahan habis" })).status,
    ).toBe(200);
    list = (await lineRows()).filter((row) => row.to_status === "cancelled");
    expect(shape(list)).toEqual([
      "recalled>cancelled>in_progress>voided",
      "recalled>cancelled>in_progress>voided",
    ]);
    for (const row of list) expect(row.reason).toBe("Bahan habis");
    // Each ticket-level change still has its own ticket row (no line id).
    const ticketRows = (await changesOf(ticketId)).filter(
      (row) => row.order_item_id === null,
    );
    expect(ticketRows.map((row) => row.to_status)).toEqual([
      "new",
      "in_progress",
      "done",
      "recalled",
      "cancelled",
    ]);
  });

  it("KDS-04 voiding a ticket needs a reason and records it with the user", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const voided = await kds().voidTicket(ticketId, { reason: "Bahan habis" });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const detail = kitchenTicketDetailSchema.parse(voided.body.data);
    expect(detail.status).toBe("cancelled");
    expect(detail.items.every((item) => item.status === "voided")).toBe(true);
    const log = (await changesOf(ticketId)).filter(
      (row) => row.order_item_id === null,
    );
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

    // Pruning is the one exception: a feed row older than 24 hours AND more
    // than KITCHEN_FEED_MAX_LAG behind the cursor may be deleted, never
    // updated; a recent row, an old row a cursor may still resume from, and
    // the status changes stay.
    const station = await extraStation("cold_kitchen");
    await seedFeed(station, 2003, [
      { sequence: 1, ticketId, ageHours: 25 },
      { sequence: 2, ticketId, ageHours: 1 },
      { sequence: 3, ticketId, ageHours: 25 },
    ]);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE kitchen_station_feed SET occurred_at = now() WHERE station_id = $1 AND sequence = 1",
          [station],
        ),
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "DELETE FROM kitchen_station_feed WHERE station_id = $1 AND sequence = 2",
          [station],
        ),
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "DELETE FROM kitchen_station_feed WHERE station_id = $1 AND sequence = 3",
          [station],
        ),
      ),
    ).rejects.toThrow(/append-only/i);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "DELETE FROM kitchen_station_feed WHERE station_id = $1 AND sequence = 1",
        [station],
      ),
    );
    expect(await feedSequences(station)).toEqual([2, 3]);
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

  it("KDS-04 two bumps of the same ticket at once: exactly one wins, the other gets 409, one status change is recorded", async () => {
    const placed = await placeOrder([
      { menuItemId: ids.nasi },
      { menuItemId: ids.nasi, note: "Pedas" },
    ]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    expect((await kds().start(ticketId)).status).toBe(200);

    const results = await Promise.all([
      kds().bump(ticketId),
      kds().bump(ticketId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const done = await rows<{ order_item_id: string | null }>(
      `SELECT order_item_id::text AS order_item_id
       FROM kitchen_ticket_status_changes
       WHERE ticket_id = $1::uuid AND to_status = 'done'`,
      [ulidToUuid(ticketId)],
    );
    // One ticket row plus one row per line, from the single winner.
    expect(done.filter((row) => row.order_item_id === null)).toHaveLength(1);
    expect(done.filter((row) => row.order_item_id !== null)).toHaveLength(2);
    expect((await ticketDetail(ticketId)).status).toBe("done");
  });

  it("KDS-04 a user without station permission gets 404 (as for an unknown ticket) at once, even while another transaction holds the order and ticket locks", async () => {
    const placed = await placeOrder([{ menuItemId: ids.nasi }]);
    const ticketId = await ticketOn(placed.orderId, ids.kitchenA);
    const [line] = (await ticketDetail(ticketId)).items;
    const before = await stateOf(ticketId, ids.kitchenA);

    // Hold the order row and the ticket row locked, like a busy POS/KDS write.
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      await holder.query(
        "SELECT 1 FROM orders WHERE id = $1::uuid FOR UPDATE",
        [ulidToUuid(placed.orderId)],
      );
      await holder.query(
        "SELECT 1 FROM kitchen_tickets WHERE id = $1::uuid FOR UPDATE",
        [ulidToUuid(ticketId)],
      );

      // The barista only has bar A: kitchen A is out of reach. If the check ran
      // after the locks, these would hang until the holder commits.
      const asBarista = kds(barista);
      const attempts = [
        asBarista.voidTicket(ticketId, { reason: "Uji" }),
        asBarista.bump(ticketId),
        asBarista.item(line!.id, "void"),
        asBarista.item(line!.id, "start"),
      ];
      const settled = await Promise.race([
        Promise.all(attempts.map((attempt) => attempt.then((r) => r.status))),
        new Promise<"timeout">((resolve) =>
          setTimeout(resolve, 5000, "timeout"),
        ),
      ]);
      expect(settled).toEqual([404, 404, 404, 404]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(await stateOf(ticketId, ids.kitchenA)).toEqual(before);
  });

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
    // Another station's ticket answers like an unknown ticket (404), so the
    // status cannot be used to probe which ticket ids exist.
    expect((await asBarista.ticket(target.ticketId)).status).toBe(404);
    expect((await asBarista.start(target.ticketId)).status).toBe(404);
    expect(
      (await asBarista.voidTicket(target.ticketId, { reason: "Uji" })).status,
    ).toBe(404);
    expect((await ticketDetail(target.ticketId)).status).toBe("new");
    // A void on their own station works for a station-only cook too (it
    // locks the order to tell the POS).
    const ownVoid = await asBarista.voidTicket(barTicket, { reason: "Uji" });
    expect(ownVoid.status, JSON.stringify(ownVoid.body)).toBe(200);
    expect(
      (await changesOf(target.ticketId)).map((row) => row.to_status),
    ).toEqual(["new"]);
  });

  it("legend-qqvf a foreign-station ticket answers exactly like an unknown ticket (detail and action)", async () => {
    const asBarista = kds(barista);
    // Positive control: the cook's own station ticket works.
    const barOrder = await placeOrder([{ menuItemId: ids.kopi }]);
    const barTicket = await ticketOn(barOrder.orderId, ids.barA);
    expect((await asBarista.ticket(barTicket)).status).toBe(200);
    expect((await asBarista.start(barTicket)).status).toBe(200);

    const strip = (body: { requestId?: unknown; error?: unknown }) => {
      const rest: Record<string, unknown> = { ...body };
      delete rest.requestId;
      const error = { ...((rest.error as Record<string, unknown>) ?? {}) };
      delete error.requestId;
      return { ...rest, error };
    };
    const unknownId = uuidToUlid(randomUUID());
    const before = await ticketDetail(target.ticketId);

    const unknownDetail = await asBarista.ticket(unknownId);
    const foreignDetail = await asBarista.ticket(target.ticketId);
    expect(unknownDetail.status).toBe(404);
    expect(foreignDetail.status).toBe(unknownDetail.status);
    expect(strip(foreignDetail.body)).toEqual(strip(unknownDetail.body));

    const unknownStart = await asBarista.start(unknownId);
    const foreignStart = await asBarista.start(target.ticketId);
    expect(unknownStart.status).toBe(404);
    expect(foreignStart.status).toBe(unknownStart.status);
    expect(strip(foreignStart.body)).toEqual(strip(unknownStart.body));

    const unknownBump = await asBarista.bump(unknownId);
    const foreignBump = await asBarista.bump(target.ticketId);
    expect(foreignBump.status).toBe(unknownBump.status);
    expect(strip(foreignBump.body)).toEqual(strip(unknownBump.body));

    // A line of another station answers like an unknown line.
    const [foreignLine] = (await ticketDetail(target.ticketId)).items;
    const unknownItem = await asBarista.item(uuidToUlid(randomUUID()), "start");
    const foreignItem = await asBarista.item(foreignLine!.id, "start");
    expect(unknownItem.status).toBe(404);
    expect(foreignItem.status).toBe(unknownItem.status);
    expect(strip(foreignItem.body)).toEqual(strip(unknownItem.body));

    expect(await ticketDetail(target.ticketId)).toEqual(before);
  });

  it("legend-cot3 a station-scoped cook changes priority and item status on their own station only", async () => {
    const asBarista = kds(barista);
    const barOrder = await placeOrder([{ menuItemId: ids.kopi }]);
    const barTicket = await ticketOn(barOrder.orderId, ids.barA);
    const kitchenOrder = await placeOrder([{ menuItemId: ids.nasi }]);
    const kitchenTicket = await ticketOn(kitchenOrder.orderId, ids.kitchenA);
    const [barLine] = (await ticketDetail(barTicket)).items;
    const [kitchenLine] = (await ticketDetail(kitchenTicket)).items;

    // Positive control: the same calls succeed on the barista's own station.
    const ownPriority = await asBarista.priority(barTicket, 7);
    expect(ownPriority.status, JSON.stringify(ownPriority.body)).toBe(200);
    expect(ownPriority.body.data.priority).toBe(7);
    const ownStart = await asBarista.item(barLine!.id, "start");
    expect(ownStart.status, JSON.stringify(ownStart.body)).toBe(200);
    expect((await ticketDetail(barTicket)).priority).toBe(7);
    expect((await ticketDetail(barTicket)).items[0]?.status).not.toBe(
      barLine?.status,
    );
    expect((await asBarista.bump(barTicket)).status).toBe(200);
    const ownServe = await asBarista.item(barLine!.id, "serve");
    expect(ownServe.status, JSON.stringify(ownServe.body)).toBe(200);

    // The kitchen ticket of the same outlet: refused, nothing changes.
    const before = await ticketDetail(kitchenTicket);
    const changesBefore = (await changesOf(kitchenTicket)).length;
    const cursorBefore = await cursorOf(ids.kitchenA);
    const denied = [
      await asBarista.priority(kitchenTicket, 9),
      await asBarista.item(kitchenLine!.id, "start"),
      await asBarista.item(kitchenLine!.id, "serve"),
      await asBarista.item(kitchenLine!.id, "void"),
      // Permission runs before the state machine, so bump and recall of a
      // ticket that is not started/done still answer 404, not 409.
      await asBarista.bump(kitchenTicket),
      await asBarista.recall(kitchenTicket, { reason: "Uji" }),
    ];
    for (const response of denied) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body.error?.code ?? response.body.code).toBe("NOT_FOUND");
    }
    const after = await ticketDetail(kitchenTicket);
    expect(after).toEqual(before);
    expect(after.priority).toBe(before.priority);
    expect(after.items.map((item) => item.status)).toEqual(
      before.items.map((item) => item.status),
    );
    expect((await changesOf(kitchenTicket)).length).toBe(changesBefore);
    expect(await cursorOf(ids.kitchenA)).toBe(cursorBefore);
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

describe("P1 cloud station ticket bytes (legend-wasr7.2)", () => {
  const printOf = (ticketId: string, who: Member = cook, query = "32") =>
    who.client
      .get(
        `/api/outlets/${encodeURIComponent(tenant.outletId)}/kitchen/tickets/${ticketId}/print?paperWidth=${query}`,
      )
      .set(headers)
      .set(originHeader);

  it("returns the station ticket as ESC/POS bytes to a cook of that station only", async () => {
    const placed = await placeOrder([{ menuItemId: ids.kopi }]);
    const ticketId = await ticketOn(placed.orderId, ids.barA);
    const res = await printOf(ticketId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ paperWidth: 32, reprint: false });
    const bytes = Buffer.from(res.body.data.escposBase64, "base64");
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(bytes.toString("latin1")).toContain("Kopi");

    // The barista of Bar A prints Bar A, but a kitchen ticket answers like an
    // unknown ticket (404).
    expect((await printOf(ticketId, barista)).status).toBe(200);
    const hot = await placeOrder([{ menuItemId: ids.nasi }]);
    const hotTicket = await ticketOn(hot.orderId, ids.kitchenA);
    expect((await printOf(hotTicket, barista)).status).toBe(404);
    expect((await printOf(uuidToUlid(randomUUID()))).status).toBe(404);
    expect((await printOf(ticketId, cook, "40")).status).toBe(422);
  });

  it("the cloud remembers the first print: every later GET is CETAK ULANG even without reprint (P3)", async () => {
    const placed = await placeOrder([{ menuItemId: ids.kopi }]);
    const ticketId = await ticketOn(placed.orderId, ids.barA);
    const text = (res: { body: { data: { escposBase64: string } } }) =>
      Buffer.from(res.body.data.escposBase64, "base64").toString("latin1");
    const first = await printOf(ticketId, cook, "32");
    expect(first.body.data.reprint).toBe(false);
    expect(text(first)).not.toContain("CETAK ULANG");
    // Two more asks that never say "reprint": both are marked, and so is the
    // same ask from another member (a reload or a second tablet remembers).
    for (const who of [cook, cook, barista]) {
      const again = await printOf(ticketId, who, "32&reprint=false");
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.body.data.reprint).toBe(true);
      expect(text(again)).toContain("CETAK ULANG");
      expect(text(again)).toContain("Kopi");
    }
    const [count] = (
      await owner.query(
        "SELECT print_count FROM tablet_print_marks WHERE kind = 'kds_ticket' AND ref_id = $1",
        [ticketId],
      )
    ).rows;
    expect(count.print_count).toBe(4);
    // The page may still force the banner; a bad flag is refused.
    const other = await ticketOn(
      (await placeOrder([{ menuItemId: ids.kopi }])).orderId,
      ids.barA,
    );
    expect(
      (await printOf(other, cook, "32&reprint=true")).body.data.reprint,
    ).toBe(true);
    expect((await printOf(other, cook, "32&reprint=maybe")).status).toBe(422);
    // A refused print (unknown ticket) leaves no mark.
    expect((await printOf(uuidToUlid(randomUUID()))).status).toBe(404);
  });
});
