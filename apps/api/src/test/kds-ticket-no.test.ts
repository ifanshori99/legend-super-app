// KDS ticket number (bead legend-tzyj2; scan code K-001 on the ticket card).
// Contract: docs/briefs/sub-kds-station-save.md items 3, 4 and 5 and the
// ticket schema in packages/shared/src/kitchen (`ticketNo`, "running number
// per outlet and business day"). Written against the contract and the public
// HTTP surface, never against the service code.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`). Every test works in its own fresh outlet, so the
// expected numbers are exact (1, 2, 3 ...) whatever other files did.
//
// Assumptions where the brief is silent (each is also in the report):
//  - The numbering scope is (tenant, outlet, business_date): one counter per
//    outlet and day, shared by every station of the outlet. The order in
//    which the stations of ONE order get their numbers is not asserted, only
//    that they are distinct and consecutive.
//  - "A new business day" is simulated by moving the business_date of the
//    tickets that already exist one day back (owner connection). A ticket
//    created now then lands on today's business date, which has no ticket
//    yet, so its number must restart at 1 while yesterday's numbers stay.
//  - No test id exists for this feature yet, so tests are named
//    KDS-TICKET-NO-nn.
//  - Concurrent creators are modelled as parallel POS orders (separate HTTP
//    requests = separate database transactions) in the same outlet. They
//    must all succeed (no 5xx from a unique-index violation) and take
//    distinct numbers with no gap.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import {
  kitchenStationSnapshotSchema,
  kitchenTicketDetailSchema,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Member = { client: ReturnType<typeof agent>; userId: string };

type World = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  cashier: Member;
  cook: Member;
  kopi: string; // beverage_bar item
  nasi: string; // hot_kitchen item
};

type Outlet = { id: string; bar: string; kitchen: string };

let app: Express;
let worldA: World;
let worldB: World;

// ---- Fixtures ---------------------------------------------------------------

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

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
  scopes: string[],
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
  return id;
}

async function member(
  tenant: IsolatedTenant,
  roleId: string,
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

/** Tenant, staff, brand menu (station TYPE only), tax setup. No outlet stock. */
async function buildWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `${label}-${randomUUID().slice(0, 6)}`,
  );
  const cashierRole = await insertRole(
    tenant.tenantId,
    "Tiket Kasir Uji",
    [
      "order.view",
      "pos.sale.create",
      "pos.payment.accept",
      "pos.discount.apply",
      "pos.void.request",
    ],
    ["tenant", "outlet"],
  );
  const cookRole = await insertRole(
    tenant.tenantId,
    "Tiket Dapur Uji",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  const cashier = await member(tenant, cashierRole, `Tiket Kasir ${label}`);
  const cook = await member(tenant, cookRole, `Tiket Koki ${label}`);

  const category = randomUUID();
  const kopi = randomUUID();
  const nasi = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Tiket Uji', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name, stationType] of [
      [kopi, "Kopi Susu", "beverage_bar"],
      [nasi, "Nasi Goreng", "hot_kitchen"],
    ])
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
         VALUES ($1, $2, $3, $4, $5, true, $6, NULL, $7)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          category,
          name,
          randomUUID(),
          stationType,
        ],
      );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-TKT', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    cashier,
    cook,
    kopi,
    nasi,
  };
}

/**
 * A fresh outlet in the world's tenant (copy of its first outlet) with one bar
 * and one kitchen station and a takeaway price list, so numbering starts clean.
 */
async function freshOutlet(world: World): Promise<Outlet> {
  const { tenant } = world;
  const outlet: Outlet = {
    id: randomUUID(),
    bar: randomUUID(),
    kitchen: randomUUID(),
  };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Tiket Uji', 'Jl. Uji 9', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        outlet.id,
        `TK-${randomUUID().slice(0, 8)}`.toUpperCase(),
        tenant.tenantId,
        tenant.outletId,
      ],
    );
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar Tiket', 'beverage_bar')`,
      [outlet.bar, tenant.tenantId, outlet.id],
    );
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Dapur Tiket', 'hot_kitchen')`,
      [outlet.kitchen, tenant.tenantId, outlet.id],
    );
    const priceList = randomUUID();
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceList, tenant.tenantId, outlet.id],
    );
    for (const itemId of [world.kopi, world.nasi])
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 20000)`,
        [randomUUID(), tenant.tenantId, priceList, itemId],
      );
  });
  return outlet;
}

beforeAll(async () => {
  app = createApp();
  worldA = await buildWorld("tka");
  worldB = await buildWorld("tkb");
});

afterAll(async () => {
  // Kitchen history is append-only, so the isolated tenants stay in the
  // disposable database; give them a valid creator so the platform tenant
  // list parses (same as kds.test.ts).
  for (const world of [worldA, worldB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      world.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- HTTP + DB helpers ----------------------------------------------------------

/** Create, submit and fire a takeaway order of the given menu items. */
async function placeOrder(
  world: World,
  outlet: Outlet,
  menuItemIds: string[],
): Promise<string> {
  const base = `/api/outlets/${encodeURIComponent(outlet.id)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    world.cashier.client
      .post(`${base}${path}`)
      .set(world.headers)
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
  const current = await world.cashier.client
    .get(`${base}/${orderId}`)
    .set(world.headers)
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

type TicketRow = {
  id: string;
  station_id: string;
  ticket_no: number;
  business_date: string;
};

/** Tickets of one order straight from the table. */
async function ticketsOfOrder(
  world: World,
  orderId: string,
): Promise<TicketRow[]> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const result = await client.query<TicketRow>(
      `SELECT id::text AS id, station_id::text AS station_id, ticket_no,
              business_date::text AS business_date
       FROM kitchen_tickets WHERE order_id = $1::uuid ORDER BY ticket_no`,
      [ulidToUuid(orderId)],
    );
    return result.rows;
  });
}

/** Every ticket of an outlet, lowest number first (all business dates). */
async function ticketsOfOutlet(
  world: World,
  outlet: Outlet,
): Promise<TicketRow[]> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const result = await client.query<TicketRow>(
      `SELECT id::text AS id, station_id::text AS station_id, ticket_no,
              business_date::text AS business_date
       FROM kitchen_tickets WHERE outlet_id = $1::uuid
       ORDER BY business_date, ticket_no`,
      [outlet.id],
    );
    return result.rows;
  });
}

/** The single ticket number of an order that routes to exactly one station. */
async function ticketNoOf(world: World, orderId: string): Promise<number> {
  const found = await ticketsOfOrder(world, orderId);
  expect(found).toHaveLength(1);
  return found[0]!.ticket_no;
}

// ===== KDS-TICKET-NO ================================================================

describe("KDS ticket number: running per outlet and business day", () => {
  it("KDS-TICKET-NO-01 starts at 1 and rises by one per ticket, across stations", async () => {
    const outlet = await freshOutlet(worldA);
    const first = await placeOrder(worldA, outlet, [worldA.kopi]);
    const second = await placeOrder(worldA, outlet, [worldA.kopi]);
    // A ticket of the other station continues the same outlet counter.
    const third = await placeOrder(worldA, outlet, [worldA.nasi]);
    const fourth = await placeOrder(worldA, outlet, [worldA.kopi]);

    expect(await ticketNoOf(worldA, first)).toBe(1);
    expect(await ticketNoOf(worldA, second)).toBe(2);
    expect(await ticketNoOf(worldA, third)).toBe(3);
    expect(await ticketNoOf(worldA, fourth)).toBe(4);
  });

  it("KDS-TICKET-NO-02 one order on two stations gets one distinct, consecutive number per ticket", async () => {
    const outlet = await freshOutlet(worldA);
    const both = await placeOrder(worldA, outlet, [worldA.kopi, worldA.nasi]);
    const tickets = await ticketsOfOrder(worldA, both);

    expect(tickets).toHaveLength(2);
    expect(new Set(tickets.map((ticket) => ticket.station_id))).toEqual(
      new Set([outlet.bar, outlet.kitchen]),
    );
    // Sorted by number: exactly 1 and 2 (the outlet's first two tickets).
    expect(tickets.map((ticket) => ticket.ticket_no)).toEqual([1, 2]);

    // The next order continues after both, no number is reused.
    const next = await placeOrder(worldA, outlet, [worldA.kopi]);
    expect(await ticketNoOf(worldA, next)).toBe(3);
  });

  it("KDS-TICKET-NO-03 restarts at 1 on a new business day and keeps the old day's numbers", async () => {
    const outlet = await freshOutlet(worldA);
    for (let n = 0; n < 3; n += 1)
      await placeOrder(worldA, outlet, [worldA.kopi]);
    const today = await ticketsOfOutlet(worldA, outlet);
    expect(today.map((ticket) => ticket.ticket_no)).toEqual([1, 2, 3]);
    const todayDate = today[0]!.business_date;

    // Those three tickets now belong to yesterday's business day.
    await asOwnerTenant(worldA.tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE kitchen_tickets SET business_date = business_date - 1 WHERE outlet_id = $1::uuid`,
        [outlet.id],
      );
    });

    const newDayFirst = await placeOrder(worldA, outlet, [worldA.kopi]);
    const newDaySecond = await placeOrder(worldA, outlet, [worldA.nasi]);
    expect(await ticketNoOf(worldA, newDayFirst)).toBe(1);
    expect(await ticketNoOf(worldA, newDaySecond)).toBe(2);

    const all = await ticketsOfOutlet(worldA, outlet);
    const newDay = all.filter((ticket) => ticket.business_date === todayDate);
    const oldDay = all.filter((ticket) => ticket.business_date !== todayDate);
    expect(newDay.map((ticket) => ticket.ticket_no)).toEqual([1, 2]);
    expect(oldDay.map((ticket) => ticket.ticket_no)).toEqual([1, 2, 3]);
  });

  it("KDS-TICKET-NO-04 two outlets of one tenant count independently", async () => {
    const outletOne = await freshOutlet(worldA);
    const outletTwo = await freshOutlet(worldA);
    const one1 = await placeOrder(worldA, outletOne, [worldA.kopi]);
    const one2 = await placeOrder(worldA, outletOne, [worldA.kopi]);
    const two1 = await placeOrder(worldA, outletTwo, [worldA.kopi]);
    const one3 = await placeOrder(worldA, outletOne, [worldA.kopi]);
    const two2 = await placeOrder(worldA, outletTwo, [worldA.nasi]);

    expect(await ticketNoOf(worldA, one1)).toBe(1);
    expect(await ticketNoOf(worldA, one2)).toBe(2);
    expect(await ticketNoOf(worldA, one3)).toBe(3);
    expect(await ticketNoOf(worldA, two1)).toBe(1);
    expect(await ticketNoOf(worldA, two2)).toBe(2);
  });

  it("KDS-TICKET-NO-05 two tenants count independently", async () => {
    const outletA = await freshOutlet(worldA);
    const outletB = await freshOutlet(worldB);
    await placeOrder(worldA, outletA, [worldA.kopi]);
    await placeOrder(worldA, outletA, [worldA.kopi]);
    const a3 = await placeOrder(worldA, outletA, [worldA.kopi]);
    const b1 = await placeOrder(worldB, outletB, [worldB.kopi]);
    const b2 = await placeOrder(worldB, outletB, [worldB.nasi]);

    expect(await ticketNoOf(worldA, a3)).toBe(3);
    expect(await ticketNoOf(worldB, b1)).toBe(1);
    expect(await ticketNoOf(worldB, b2)).toBe(2);
  });
});

describe("KDS ticket number: concurrent creators", () => {
  it("KDS-TICKET-NO-06 two orders fired at the same time never share a number or fail", async () => {
    const outlet = await freshOutlet(worldA);
    const expected: number[] = [];
    // Several rounds: one round alone might not overlap by luck.
    for (let round = 0; round < 4; round += 1) {
      const [left, right] = await Promise.all([
        placeOrder(worldA, outlet, [worldA.kopi]),
        placeOrder(worldA, outlet, [worldA.kopi]),
      ]);
      const numbers = [
        await ticketNoOf(worldA, left),
        await ticketNoOf(worldA, right),
      ];
      expect(numbers[0]).not.toBe(numbers[1]);
      expected.push(...numbers);
    }
    const stored = await ticketsOfOutlet(worldA, outlet);
    expect(stored.map((ticket) => ticket.ticket_no)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect([...expected].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("KDS-TICKET-NO-07 many parallel orders on both stations take exactly 1..N with no gap or duplicate", async () => {
    const outlet = await freshOutlet(worldA);
    const orders = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        // Even: both stations (2 tickets), odd: one station (1 ticket).
        placeOrder(
          worldA,
          outlet,
          index % 2 === 0 ? [worldA.kopi, worldA.nasi] : [worldA.nasi],
        ),
      ),
    );
    expect(orders).toHaveLength(6);
    const stored = await ticketsOfOutlet(worldA, outlet);
    // 3 orders x 2 tickets + 3 orders x 1 ticket.
    expect(stored.map((ticket) => ticket.ticket_no)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    // Each ticket of one order is still one per station.
    for (const orderId of orders) {
      const tickets = await ticketsOfOrder(worldA, orderId);
      expect(new Set(tickets.map((ticket) => ticket.station_id)).size).toBe(
        tickets.length,
      );
    }
  });
});

describe("KDS ticket number: what the screen receives", () => {
  it("KDS-TICKET-NO-08 the ticket detail and the station snapshot carry ticketNo", async () => {
    const outlet = await freshOutlet(worldA);
    await placeOrder(worldA, outlet, [worldA.kopi]);
    const second = await placeOrder(worldA, outlet, [worldA.kopi]);
    const secondTicket = (await ticketsOfOrder(worldA, second))[0]!;
    expect(secondTicket.ticket_no).toBe(2);

    const base = `/api/outlets/${encodeURIComponent(outlet.id)}/kitchen`;
    const detail = await worldA.cook.client
      .get(`${base}/tickets/${uuidToUlid(secondTicket.id)}`)
      .set(worldA.headers)
      .set(originHeader);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(kitchenTicketDetailSchema.parse(detail.body.data).ticketNo).toBe(2);

    const snapshotResponse = await worldA.cook.client
      .get(`${base}/stations/${outlet.bar}/tickets`)
      .set(worldA.headers)
      .set(originHeader);
    expect(snapshotResponse.status, JSON.stringify(snapshotResponse.body)).toBe(
      200,
    );
    const snapshot = kitchenStationSnapshotSchema.parse(
      snapshotResponse.body.data,
    );
    expect(
      snapshot.tickets.map((ticket) => ticket.ticketNo).sort((a, b) => a - b),
    ).toEqual([1, 2]);
  });
});
