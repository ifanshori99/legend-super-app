// Station-scope gate: union of outlet reach and station reach (legend-cy2e;
// PRD v1.7 §3 F7 "Routing Stasiun", §6 B role_assignments, TEN-03).
//
// One user holding the same role at outlet A AND at station B1 (outlet B owns
// stations B1 and B2) must reach BOTH: every station of outlet A, plus only
// station B1 of outlet B. The gate used to take the outlet grant and ignore
// the station grant (or the reverse), so B1 was lost.
//
// Routes that use the gate (requireStationScopePermission):
//  - KDS ticket routes (`/api/outlets/:outletId/kitchen/tickets/:ticketId...`,
//    permission kds.ticket.process): the ticket's own station decides.
//  - Station list (`GET /api/menu/stations`, permission menu.item.view).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS, in a fresh
// isolated tenant. Written against the contracts and the PRD, not the code.
//
// Assumptions where the spec is silent (also in the report):
//  - A ticket of a station the user may not reach answers 403 or 404 (both
//    hide the ticket); the test accepts either, never a 2xx.
//  - A ticket is "reached" when GET detail and POST start answer 200.
//  - `GET /api/menu/stations?outletId=<B>` for a user with only station B1 in
//    outlet B answers 200 with just B1 (the station grant makes outlet B
//    visible, but only B1 is theirs).
//  - The permission code for the station list is `menu.item.view` (the
//    brief said menu.view; the PRD permission catalogue has menu.item.view).
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { createApp } from "../app.ts";
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

const ids = {
  category: randomUUID(),
  priceListA: randomUUID(),
  priceListB: randomUUID(),
  kopi: randomUUID(), // outlet A: routed to bar A
  teh: randomUUID(), // outlet B: beverage_bar, override station B1
  roti: randomUUID(), // outlet B: pastry, override station B2
  outletB: randomUUID(),
  stationA1: randomUUID(), // outlet A
  stationA2: randomUUID(), // outlet A
  stationB1: randomUUID(), // outlet B
  stationB2: randomUUID(), // outlet B
  cookRole: randomUUID(),
  cashierRole: randomUUID(),
};

type Scope = { type: "tenant" | "outlet" | "station"; id: string | null };
type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: Member;
let union: Member; // role at outlet A AND at station B1
let outletOnly: Member; // role at outlet A only (control)
let stationOnly: Member; // role at station B1 only (control)
let stationB2Only: Member; // role at station B2 only: drives B2 tickets legitimately
let ticketA: string; // outlet A, station A1
let ticketB1: string; // outlet B, station B1
let ticketB2: string; // outlet B, station B2

// Receipt numbering double (same as kds.test.ts): the POS needs a receipt port.
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
        number: `SSU-${String(sequenceNumber).padStart(6, "0")}`,
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

// ---- Fixtures -------------------------------------------------------------

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

async function insertRole(
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [
      id,
      tenant.tenantId,
      name,
      JSON.stringify(permissions),
      JSON.stringify(scopes),
    ],
  );
}

/** A signed-in user holding one role at every listed scope. */
async function member(
  roleId: string,
  scopes: Scope[],
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  for (const scope of scopes)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [tenant.tenantId, userId, roleId, scope.type, scope.id],
    );
  return { client, userId };
}

/** Place and submit a takeaway order in one outlet; returns its order id. */
async function placeOrder(
  outletId: string,
  menuItemIds: string[],
): Promise<string> {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  const created = await send("", {
    channel: "pos",
    serviceType: "takeaway",
    items: menuItemIds.map((menuItemId) => ({
      menuItemId,
      quantity: 1,
      modifierIds: [],
    })),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await send(`/${orderId}/submit`, {
      expectedStatus: status,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const current = await cashier.client
    .get(`${base}/${orderId}`)
    .set(headers)
    .set(originHeader);
  const held = (
    current.body.data.items as { id: string; fireStatus: string }[]
  ).filter((line) => line.fireStatus === "held");
  if (held.length > 0) {
    const fired = await send(`/${orderId}/fire`, {
      itemIds: held.map((line) => line.id),
      expectedStatus: status,
    });
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
  }
  return orderId;
}

/** The ticket of an order on one station, as the ULID the API uses. */
async function ticketOn(orderId: string, stationId: string): Promise<string> {
  const found = await asOwnerTenant((client) =>
    client.query<{ id: string }>(
      `SELECT id::text AS id FROM kitchen_tickets
       WHERE order_id = $1::uuid AND station_id = $2::uuid`,
      [ulidToUuid(orderId), stationId],
    ),
  );
  if (found.rows.length !== 1)
    throw new Error(`Expected one ticket of ${orderId} on ${stationId}`);
  return uuidToUlid(found.rows[0].id);
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`ssu-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };

  await insertRole(
    ids.cookRole,
    "Union Dapur Uji",
    ["kds.ticket.process", "menu.item.view"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    ids.cashierRole,
    "Union Kasir Uji",
    ["order.view", "pos.sale.create", "pos.payment.accept"],
    ["tenant"],
  );

  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Union B', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        ids.outletB,
        `UB-${randomUUID().slice(0, 6)}`.toUpperCase(),
        tenant.tenantId,
        tenant.outletId,
      ],
    );
    const stations: [string, string, string, string][] = [
      [ids.stationA1, tenant.outletId, "Union Bar A1", "beverage_bar"],
      [ids.stationA2, tenant.outletId, "Union Dapur A2", "hot_kitchen"],
      [ids.stationB1, ids.outletB, "Union Bar B1", "beverage_bar"],
      [ids.stationB2, ids.outletB, "Union Pastry B2", "pastry"],
    ];
    for (const [id, outletId, name, type] of stations)
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, outletId, name, type],
      );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Union Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    const items: [string, string, string, string][] = [
      [ids.kopi, "Kopi Union", ids.stationA1, "beverage_bar"],
      [ids.teh, "Teh Union", ids.stationB1, "beverage_bar"],
      [ids.roti, "Roti Union", ids.stationB2, "pastry"],
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
    for (const [priceList, outletId, itemIds] of [
      [ids.priceListA, tenant.outletId, [ids.kopi]],
      [ids.priceListB, ids.outletB, [ids.teh, ids.roti]],
    ] as [string, string, string[]][]) {
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [priceList, tenant.tenantId, outletId],
      );
      for (const itemId of itemIds)
        await client.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, 20000)`,
          [randomUUID(), tenant.tenantId, priceList, itemId],
        );
    }
    // Tenant-wide tax setup: the POS refuses an order without it.
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, randomUUID()],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-SSU', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, randomUUID()],
    );
  });

  cashier = await member(
    ids.cashierRole,
    [{ type: "tenant", id: null }],
    "Union Kasir",
  );
  union = await member(
    ids.cookRole,
    [
      { type: "outlet", id: tenant.outletId },
      { type: "station", id: ids.stationB1 },
    ],
    "Union Outlet A plus Stasiun B1",
  );
  outletOnly = await member(
    ids.cookRole,
    [{ type: "outlet", id: tenant.outletId }],
    "Union Outlet A saja",
  );
  stationOnly = await member(
    ids.cookRole,
    [{ type: "station", id: ids.stationB1 }],
    "Union Stasiun B1 saja",
  );

  stationB2Only = await member(
    ids.cookRole,
    [{ type: "station", id: ids.stationB2 }],
    "Union Stasiun B2 saja",
  );

  const orderA = await placeOrder(tenant.outletId, [ids.kopi]);
  ticketA = await ticketOn(orderA, ids.stationA1);
  const orderB = await placeOrder(ids.outletB, [ids.teh, ids.roti]);
  ticketB1 = await ticketOn(orderB, ids.stationB1);
  ticketB2 = await ticketOn(orderB, ids.stationB2);
});

afterAll(async () => {
  setPosReceiptPort(null);
  // KDS history is append-only, so the isolated tenant stays in the disposable
  // database; give it a valid creator so the platform tenant list parses.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- HTTP helpers ---------------------------------------------------------

function kds(who: Member, outletId: string) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/kitchen`;
  return {
    ticket: (ticketId: string) =>
      who.client
        .get(`${base}/tickets/${ticketId}`)
        .set(headers)
        .set(originHeader),
    start: (ticketId: string) =>
      who.client
        .post(`${base}/tickets/${ticketId}/start`)
        .set(headers)
        .set(originHeader)
        .send({}),
    bump: (ticketId: string) =>
      who.client
        .post(`${base}/tickets/${ticketId}/bump`)
        .set(headers)
        .set(originHeader)
        .send({}),
    recall: (ticketId: string, reason: string) =>
      who.client
        .post(`${base}/tickets/${ticketId}/recall`)
        .set(headers)
        .set(originHeader)
        .send({ reason }),
    voidTicket: (ticketId: string, reason: string) =>
      who.client
        .post(`${base}/tickets/${ticketId}/void`)
        .set(headers)
        .set(originHeader)
        .send({ reason }),
    priority: (ticketId: string, priority: number) =>
      who.client
        .patch(`${base}/tickets/${ticketId}/priority`)
        .set(headers)
        .set(originHeader)
        .send({ priority }),
    item: (itemId: string, action: string) =>
      who.client
        .post(`${base}/ticket-items/${itemId}/status`)
        .set(headers)
        .set(originHeader)
        .send({ action }),
  };
}

async function stationIds(who: Member, query = ""): Promise<string[]> {
  const response = await who.client
    .get(`/api/menu/stations?limit=100${query}`)
    .set(headers)
    .set(originHeader);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body.data as { id: string }[]).map((row) => row.id);
}

async function ticketStatus(ticketId: string): Promise<string> {
  const found = await asOwnerTenant((client) =>
    client.query<{ status: string }>(
      "SELECT status FROM kitchen_tickets WHERE id = $1::uuid",
      [ulidToUuid(ticketId)],
    ),
  );
  return found.rows[0].status;
}

const HIDDEN = [403, 404];

// ---- Tests ----------------------------------------------------------------

describe("legend-cy2e station scope gate: outlet reach plus station reach", () => {
  it("a ticket of the other station of outlet B (B2) is hidden and not changed", async () => {
    const asUnion = kds(union, ids.outletB);
    const detail = await asUnion.ticket(ticketB2);
    expect(HIDDEN).toContain(detail.status);
    const started = await asUnion.start(ticketB2);
    expect(HIDDEN).toContain(started.status);
    expect(await ticketStatus(ticketB2)).toBe("new");
  });

  it("a ticket of station B1 (station grant) is reachable with an outlet A grant also held", async () => {
    const asUnion = kds(union, ids.outletB);
    const detail = await asUnion.ticket(ticketB1);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const started = await asUnion.start(ticketB1);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(await ticketStatus(ticketB1)).toBe("in_progress");
  });

  it("a ticket of a station in outlet A (outlet grant) is still reachable", async () => {
    const asUnion = kds(union, tenant.outletId);
    const detail = await asUnion.ticket(ticketA);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const started = await asUnion.start(ticketA);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(await ticketStatus(ticketA)).toBe("in_progress");
  });

  it("the station list holds every station of outlet A plus B1, never B2", async () => {
    const listed = await stationIds(union);
    expect(listed).toEqual(
      expect.arrayContaining([ids.stationA1, ids.stationA2, ids.stationB1]),
    );
    expect(listed).not.toContain(ids.stationB2);
  });

  it("the station list filtered to outlet B holds only B1", async () => {
    expect(await stationIds(union, `&outletId=${ids.outletB}`)).toEqual([
      ids.stationB1,
    ]);
  });

  it("control: an outlet A grant alone reaches no ticket or station of outlet B", async () => {
    const inB = kds(outletOnly, ids.outletB);
    expect(HIDDEN).toContain((await inB.ticket(ticketB1)).status);
    expect(HIDDEN).toContain((await inB.ticket(ticketB2)).status);
    const listed = await stationIds(outletOnly);
    expect(listed).toEqual(
      expect.arrayContaining([ids.stationA1, ids.stationA2]),
    );
    expect(listed).not.toContain(ids.stationB1);
    expect(listed).not.toContain(ids.stationB2);
  });

  it("control: a station B1 grant alone reaches B1 only, nothing of outlet A or B2", async () => {
    const inB = kds(stationOnly, ids.outletB);
    expect((await inB.ticket(ticketB1)).status).toBe(200);
    expect(HIDDEN).toContain((await inB.ticket(ticketB2)).status);
    const inA = kds(stationOnly, tenant.outletId);
    expect(HIDDEN).toContain((await inA.ticket(ticketA)).status);
    expect(await stationIds(stationOnly)).toEqual([ids.stationB1]);
  });
});

// ---- Every ticket and item route behind processTicket ----------------------
//
// Assumptions (also in the report):
//  - The routes are: start, bump, recall (needs a reason), void (needs a
//    reason), priority, and the per-item status route. Detail GET is covered
//    above.
//  - A ticket of a station the user may not reach answers 403 or 404 and
//    leaves the ticket and its lines exactly as they were.
//  - Item routes name the outlet in the path; the item belongs to a ticket of
//    that outlet, so for B2 the union user calls it with outlet B.
//  - Each case uses fresh tickets (one order in outlet A, one in outlet B), so
//    cases never depend on each other. A B2 ticket is moved to the state the
//    route needs by a user whose only grant is station B2.

type Target = "A" | "B1" | "B2";
type State = "new" | "in_progress" | "done";

type Fresh = Record<Target, string>;

const ownerOf = (target: Target): { who: Member; outletId: string } =>
  target === "A"
    ? { who: outletOnly, outletId: tenant.outletId }
    : target === "B1"
      ? { who: stationOnly, outletId: ids.outletB }
      : { who: stationB2Only, outletId: ids.outletB };

async function freshTickets(state: State): Promise<Fresh> {
  const orderA = await placeOrder(tenant.outletId, [ids.kopi]);
  const orderB = await placeOrder(ids.outletB, [ids.teh, ids.roti]);
  const fresh: Fresh = {
    A: await ticketOn(orderA, ids.stationA1),
    B1: await ticketOn(orderB, ids.stationB1),
    B2: await ticketOn(orderB, ids.stationB2),
  };
  for (const target of ["A", "B1", "B2"] as Target[]) {
    const { who, outletId } = ownerOf(target);
    const api = kds(who, outletId);
    if (state !== "new") {
      const started = await api.start(fresh[target]);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
    }
    if (state === "done") {
      const bumped = await api.bump(fresh[target]);
      expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
    }
  }
  return fresh;
}

async function firstItemId(ticketId: string): Promise<string> {
  const found = await asOwnerTenant((client) =>
    client.query<{ id: string }>(
      `SELECT id::text AS id FROM kitchen_ticket_items
       WHERE ticket_id = $1::uuid ORDER BY id LIMIT 1`,
      [ulidToUuid(ticketId)],
    ),
  );
  if (found.rows.length !== 1) throw new Error(`No line on ${ticketId}`);
  return uuidToUlid(found.rows[0].id);
}

/** Ticket row and its lines as stored: proves a refused call changed nothing. */
async function storedState(ticketId: string): Promise<string> {
  const found = await asOwnerTenant(async (client) => {
    const ticket = await client.query(
      "SELECT to_jsonb(t) AS row FROM kitchen_tickets t WHERE id = $1::uuid",
      [ulidToUuid(ticketId)],
    );
    const lines = await client.query(
      `SELECT to_jsonb(i) AS row FROM kitchen_ticket_items i
       WHERE ticket_id = $1::uuid ORDER BY id`,
      [ulidToUuid(ticketId)],
    );
    return { ticket: ticket.rows, lines: lines.rows };
  });
  return JSON.stringify(found);
}

type RouteCase = {
  name: string;
  state: State;
  /** Calls the route as `who` on the ticket. */
  call: (
    who: Member,
    outletId: string,
    ticketId: string,
  ) => Promise<{ status: number; body: any }>;
  /** What a successful call leaves behind. */
  verify: (ticketId: string, body: any) => Promise<void>;
};

const routeCases: RouteCase[] = [
  {
    name: "start",
    state: "new",
    call: (who, outletId, ticketId) => kds(who, outletId).start(ticketId),
    verify: async (ticketId) =>
      expect(await ticketStatus(ticketId)).toBe("in_progress"),
  },
  {
    name: "bump",
    state: "in_progress",
    call: (who, outletId, ticketId) => kds(who, outletId).bump(ticketId),
    verify: async (ticketId) =>
      expect(await ticketStatus(ticketId)).toBe("done"),
  },
  {
    name: "recall",
    state: "done",
    call: (who, outletId, ticketId) =>
      kds(who, outletId).recall(ticketId, "Salah meja"),
    verify: async (ticketId) =>
      expect(await ticketStatus(ticketId)).toBe("recalled"),
  },
  {
    name: "void",
    state: "new",
    call: (who, outletId, ticketId) =>
      kds(who, outletId).voidTicket(ticketId, "Pelanggan batal"),
    verify: async (ticketId) =>
      expect(await ticketStatus(ticketId)).toBe("cancelled"),
  },
  {
    name: "priority",
    state: "new",
    call: (who, outletId, ticketId) => kds(who, outletId).priority(ticketId, 7),
    verify: async (_ticketId, body) => expect(body.data.priority).toBe(7),
  },
  {
    name: "item status: start",
    state: "new",
    call: async (who, outletId, ticketId) =>
      kds(who, outletId).item(await firstItemId(ticketId), "start"),
    verify: async (_ticketId, body) =>
      expect(body.data.status).toBe("in_progress"),
  },
  {
    name: "item status: void",
    state: "new",
    call: async (who, outletId, ticketId) =>
      kds(who, outletId).item(await firstItemId(ticketId), "void"),
    verify: async (_ticketId, body) => expect(body.data.status).toBe("voided"),
  },
];

describe("legend-cy2e union user (outlet A + station B1): every processTicket route", () => {
  for (const route of routeCases) {
    describe(route.name, () => {
      it("works on a ticket of station B1 (station grant)", async () => {
        const fresh = await freshTickets(route.state);
        const response = await route.call(union, ids.outletB, fresh.B1);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        await route.verify(fresh.B1, response.body);
      });

      it("works on a ticket of a station in outlet A (outlet grant)", async () => {
        const fresh = await freshTickets(route.state);
        const response = await route.call(union, tenant.outletId, fresh.A);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        await route.verify(fresh.A, response.body);
      });

      it("is refused on a ticket of station B2 and changes nothing", async () => {
        const fresh = await freshTickets(route.state);
        const before = await storedState(fresh.B2);
        const response = await route.call(union, ids.outletB, fresh.B2);
        expect(HIDDEN, JSON.stringify(response.body)).toContain(
          response.status,
        );
        expect(await storedState(fresh.B2)).toBe(before);
      });
    });
  }
});
