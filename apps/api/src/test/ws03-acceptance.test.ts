// WS-03 wave 1 acceptance (black box). Written from the bead cards
// (legend-7csf, legend-49pw, legend-rml8, legend-khiv) and the existing public
// contracts, independent of the slice implementations. Tests may fail until the
// slices land:
//   (a) legend-7csf  guest reads run under an outlet-scoped RLS context   (S1)
//   (b) legend-49pw  inclusive vs exclusive QR quote                      (S4)
//   (c) legend-rml8  secondary-table scan joins the party session         (S2)
//   (d) legend-khiv  closing a session cancels its open service requests  (S2)
//
// Assumptions (the cards leave these open):
// - (a) The outlet-scoped context shows up as `app.outlet_ids` being the
//   outlet (not the tenant-wide '*') while guest reads run. A temporary
//   RESTRICTIVE select policy on the outlet tables logs `current_setting` for
//   every row a guest read touches; it always returns true, so it never changes
//   what the guest sees.
// - (b) An inclusive tenant is one whose tax_settings.prices_include_tax and
//   tax rule price_includes_tax are both true; the menu price then already
//   contains service charge and PB1. Service 5% on net, PB1 10% on (net +
//   service) means 115.500 gross = 100.000 net + 5.000 service + 10.500 tax, so
//   both modes must total 115.500. Only amounts, not the net `subtotalIdr`, are
//   asserted because the card does not say which figure `subtotalIdr` carries
//   in inclusive mode.
// - (d) "Cancelled" is the existing `cancelled` service request status, and it
//   is visible through the outlet inbox status filter.

import { randomUUID } from "node:crypto";
import type { Client, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createReservationInputSchema } from "@starter/shared/reservation";
import { seatReservationInputSchema } from "@starter/shared/reservation";
import { createReservation } from "../services/reservation-booking.ts";
import { seatReservation } from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { setReservationDepositPort } from "../services/reservation-ports.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  issueQr,
  owner,
  scan,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

let app: Express;

/** Full-day window for every weekday: ordering is open whenever tests run. */
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

// ---------------------------------------------------------------------------
// Isolated tenant with one menu item, PB1 10% (service in base) and a 5% zone.
// ---------------------------------------------------------------------------

type World = {
  tenant: IsolatedTenant;
  staff: Staff;
  itemId: string;
  itemPriceIdr: number;
};

async function asTenantOwner<T>(
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

async function buildWorld(
  inclusive: boolean,
  itemPriceIdr: number,
): Promise<World> {
  const tenant = await createIsolatedTenant(`ws3${randomUUID().slice(0, 7)}`);
  const staff = await staffOfIsolatedTenant(app, tenant);
  const categoryId = randomUUID();
  const itemId = randomUUID();
  const priceListId = randomUUID();
  await asTenantOwner(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Akseptansi WS-03', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Nasi Akseptansi', true, $5)`,
      [itemId, tenant.tenantId, tenant.brandId, categoryId, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [priceListId, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, itemId, itemPriceIdr],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', $4, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId, inclusive],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PB1-WS03', 'PB1 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               $4, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId, inclusive],
    );
  });
  return { tenant, staff, itemId, itemPriceIdr };
}

async function seatGuest(world: World) {
  const headers = { Host: world.tenant.hostname };
  const zone = await createZone(
    world.staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(
    world.staff.client,
    { zoneId: zone.id },
    headers,
  );
  const qr = await issueQr(world.staff.client, table.id, headers);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: world.tenant.hostname,
  });
  expect(scanned.status).toBe(201);
  return {
    qrToken: qr.token,
    sessionToken: scanned.body.data.sessionToken as string,
    sessionId: scanned.body.data.session.id as string,
  };
}

function guestRequest(
  world: World,
  guest: { sessionToken: string; sessionId: string },
) {
  const base = `/api/table-sessions/${guest.sessionId}`;
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", world.tenant.hostname)
      .set("Authorization", `Bearer ${guest.sessionToken}`)
      .set(originHeader);
  return {
    addItem: () =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        menuItemId: world.itemId,
        quantity: 1,
        modifierIds: [],
        expectedCartVersion: 0,
      }),
    quote: () => auth(client.post(`${base}/quote`)).send({}),
  };
}

async function quoteOneLine(world: World) {
  const guest = await seatGuest(world);
  const request = guestRequest(world, guest);
  const added = await request.addItem();
  expect(added.status).toBe(201);
  const quote = await request.quote();
  expect(quote.status).toBe(200);
  return { guest, quote: quote.body.data };
}

// ---------------------------------------------------------------------------
// (a) outlet-scoped guest context probe
// ---------------------------------------------------------------------------

const PROBED_TABLES = ["tables", "floor_zones", "table_sessions", "price_lists"];

async function installOutletProbe() {
  await owner.query(
    `CREATE TABLE IF NOT EXISTS ws03_probe_log (
       id bigserial PRIMARY KEY, rel text, tenant text, outlets text)`,
  );
  await owner.query(
    `CREATE OR REPLACE FUNCTION ws03_probe(rel text) RETURNS boolean
       LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
     BEGIN
       INSERT INTO ws03_probe_log (rel, tenant, outlets)
       VALUES (rel, current_setting('app.tenant_id', true), current_setting('app.outlet_ids', true));
       RETURN true;
     END $$`,
  );
  for (const table of PROBED_TABLES)
    await owner.query(
      `CREATE POLICY ws03_probe ON ${table} AS RESTRICTIVE FOR SELECT USING (ws03_probe('${table}'))`,
    );
}

async function removeOutletProbe() {
  for (const table of PROBED_TABLES)
    await owner.query(`DROP POLICY IF EXISTS ws03_probe ON ${table}`);
  await owner.query("DROP FUNCTION IF EXISTS ws03_probe(text)");
  await owner.query("DROP TABLE IF EXISTS ws03_probe_log");
}

async function probeMark(): Promise<number> {
  const { rows } = await owner.query<{ max: string }>(
    "SELECT coalesce(max(id), 0)::text AS max FROM ws03_probe_log",
  );
  return Number(rows[0]!.max);
}

async function probeRowsSince(mark: number, tenantId: string) {
  const { rows } = await owner.query<{ rel: string; outlets: string | null }>(
    "SELECT rel, outlets FROM ws03_probe_log WHERE id > $1 AND tenant = $2 ORDER BY id",
    [mark, tenantId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// (c) / (d) fixtures on the seeded tenant
// ---------------------------------------------------------------------------

const outletA = outletIdSchema.parse(seededOutletA);
const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asSeededOwner<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return asTenantOwner(seededTenantId, run);
}

let floorStaff: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const key = () => `ws03-${randomUUID()}`;

async function floor(count: number) {
  const zone = await createZone(floorStaff.client);
  zoneIds.push(zone.id);
  const tables: { id: string; token: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const table = await createTable(floorStaff.client, { zoneId: zone.id });
    tableIds.push(table.id);
    tables.push({
      id: table.id,
      token: (await issueQr(floorStaff.client, table.id)).token,
    });
  }
  return { zoneId: zone.id as string, outletId: zone.outletId as string, tables };
}

async function sessionRows(ids: string[]) {
  const { rows } = await asSeededOwner((client) =>
    client.query<{ id: string; table_id: string }>(
      "SELECT id, table_id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2)",
      [seededTenantId, ids],
    ),
  );
  return rows;
}

async function bookParty(zoneId: string, date: string) {
  const created = await createReservation(
    tenantScope(),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, "19:00", "Asia/Jakarta").toISOString(),
      pax: 4,
      zoneId,
      guestName: "Tamu Akseptansi",
      contactPhone: "081234567890",
    }),
    key(),
  );
  return created.reservation.id as string;
}

type SeatedGuest = { sessionToken: string; sessionId: string };

function guestCall(
  guest: SeatedGuest,
  body: Record<string, unknown> = {},
  host = seededHostname,
) {
  return agent(app)
    .post(`/api/table-sessions/${guest.sessionId}/service-requests`)
    .set("Host", host)
    .set("Authorization", `Bearer ${guest.sessionToken}`)
    .send({
      type: "call_waiter",
      reason: "utensils",
      idempotencyKey: randomUUID(),
      ...body,
    });
}

async function scanAsGuest(token: string): Promise<SeatedGuest> {
  const scanned = await scan(app, { token });
  expect(scanned.status).toBe(201);
  return {
    sessionToken: scanned.body.data.sessionToken,
    sessionId: scanned.body.data.session.id,
  };
}

const closeSession = (sessionId: string) =>
  floorStaff.client
    .post(`/api/table-sessions/${sessionId}/close`)
    .set(originHeader)
    .send({ tableCleaned: true });

const inbox = (outletId: string, status: string) =>
  floorStaff.client
    .get(`/api/outlets/${outletId}/service-requests?status=${status}&limit=100`)
    .set("Host", seededHostname);

// ---------------------------------------------------------------------------

let exclusiveWorld: World;
let inclusiveWorld: World;
let secondOutletId: string;

beforeAll(async () => {
  app = createApp();
  // Settled zero bill: closing a pay_first session needs a verifiable bill.
  setTableSessionSettlementLookup(async () => ({
    billTotalIdr: idr(0),
    paidIdr: idr(0),
  }));
  // Reservation policy "none": no deposit is opened for the party seating.
  setReservationDepositPort({
    async assertReady() {},
    async openDeposit() {
      throw new Error("No deposit expected in WS-03 acceptance");
    },
  });
  floorStaff = await staffWithRole(app, {
    template: "owner",
    label: "WS03 Acceptance Owner",
  });
  await asSeededOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, 'ws03-acc', 'none', 0, 60, 24, 0, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA],
    );
  });
  exclusiveWorld = await buildWorld(false, 100_000);
  inclusiveWorld = await buildWorld(true, 115_500);
  // A second outlet in the exclusive tenant, so "another outlet" really exists.
  secondOutletId = randomUUID();
  await asTenantOwner(exclusiveWorld.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, 'OUT-WS03-B', 'Outlet B WS03', 'Jl. Uji 2', timezone, opening_hours, 'active'
         FROM outlets WHERE id = $2`,
      [secondOutletId, exclusiveWorld.tenant.outletId],
    );
  });
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  setReservationDepositPort(null);
  await asSeededOwner(async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    await client.query(
      "DELETE FROM service_requests WHERE tenant_id = $1 AND table_id = ANY($2)",
      [seededTenantId, tableIds],
    );
    for (const table of [
      "reservation_deposit_allocations",
      "reservation_tables",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
        [seededTenantId, zoneIds],
      );
    await client.query(
      `DELETE FROM reservation_idempotency WHERE tenant_id = $1 AND (reservation_id IN ${rsv} OR reservation_id IS NULL)`,
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2)",
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  // Isolated tenants stay in the disposable database (append-only audit rows);
  // give them a valid creator so the platform tenant list still parses them.
  for (const world of [exclusiveWorld, inclusiveWorld])
    if (world)
      await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
        world.tenant.tenantId,
        randomUUID(),
      ]);
  await owner.end();
});

describe("legend-7csf guest reads run under an outlet-scoped context", () => {
  it("legend-7csf a QR scan and menu read never see the tenant-wide context, only the table's outlet", async () => {
    const world = exclusiveWorld;
    // Build the table first (staff writes are not part of what is probed).
    const headers = { Host: world.tenant.hostname };
    const zone = await createZone(
      world.staff.client,
      { hours: ALL_DAY },
      headers,
    );
    const table = await createTable(
      world.staff.client,
      { zoneId: zone.id },
      headers,
    );
    const qr = await issueQr(world.staff.client, table.id, headers);

    await installOutletProbe();
    try {
      const mark = await probeMark();
      const scanned = await scan(app, {
        token: qr.token,
        hostname: world.tenant.hostname,
      });
      expect(scanned.status).toBe(201);
      const menu = await agent(app)
        .get(`/api/qr/menu/${qr.token}`)
        .set("Host", world.tenant.hostname);
      expect(menu.status).toBe(200);

      const seen = await probeRowsSince(mark, world.tenant.tenantId);
      // The guest reads really touched outlet tables inside this tenant.
      expect(seen.length).toBeGreaterThan(0);
      for (const row of seen) {
        expect(row.outlets, `${row.rel} read context`).not.toBe("*");
        expect(row.outlets, `${row.rel} read context`).toContain(
          world.tenant.outletId,
        );
        expect(row.outlets, `${row.rel} read context`).not.toContain(
          secondOutletId,
        );
      }
    } finally {
      await removeOutletProbe();
    }
  });

  it("legend-7csf a tampered QR token is refused as not found", async () => {
    const world = exclusiveWorld;
    const headers = { Host: world.tenant.hostname };
    const zone = await createZone(world.staff.client, {}, headers);
    const table = await createTable(
      world.staff.client,
      { zoneId: zone.id },
      headers,
    );
    const qr = await issueQr(world.staff.client, table.id, headers);
    const tampered = `${qr.token.slice(0, -2)}${qr.token.endsWith("AA") ? "BB" : "AA"}`;
    const response = await agent(app)
      .get(`/api/qr/menu/${tampered}`)
      .set("Host", world.tenant.hostname);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("legend-49pw inclusive vs exclusive QR quote", () => {
  it("legend-49pw exclusive prices add 5% service and PB1 10% on top of 100.000", async () => {
    const { quote } = await quoteOneLine(exclusiveWorld);
    expect(quote.subtotalIdr).toBe(100_000);
    expect(quote.serviceCharge.rateBp).toBe(500);
    expect(quote.serviceCharge.amountIdr).toBe(5_000);
    expect(quote.taxIdr).toBe(10_500);
    expect(quote.totalIdr).toBe(115_500);
  });

  it("legend-49pw inclusive prices back service and PB1 out of 115.500, total stays 115.500", async () => {
    const { quote } = await quoteOneLine(inclusiveWorld);
    // No error such as QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED, and nothing added.
    expect(quote.serviceCharge.rateBp).toBe(500);
    expect(quote.serviceCharge.amountIdr).toBe(5_000);
    expect(quote.taxIdr).toBe(10_500);
    expect(quote.totalIdr).toBe(115_500);
    expect(quote.totalIdr).toBe(inclusiveWorld.itemPriceIdr);
  });

  it("legend-49pw the guest menu states whether prices include tax and service", async () => {
    for (const [world, expected] of [
      [exclusiveWorld, false],
      [inclusiveWorld, true],
    ] as const) {
      const guest = await seatGuest(world);
      const menu = await agent(app)
        .get(`/api/qr/menu/${guest.qrToken}`)
        .set("Host", world.tenant.hostname);
      expect(menu.status).toBe(200);
      expect(menu.body.data.pricing.pricesIncludeTaxAndService).toBe(expected);
    }
  });
});

describe("legend-rml8 secondary table joins the party session", () => {
  it("legend-rml8 scanning the secondary table of a seated party joins its open session", async () => {
    const f = await floor(2);
    const [a, b] = f.tables as [(typeof f.tables)[0], (typeof f.tables)[0]];
    const reservationId = await bookParty(f.zoneId, "2027-06-11");
    // Party seated on two tables; the first listed (b) is the primary.
    const seated = await seatReservation(
      tenantScope(),
      floorStaff.userId,
      outletA,
      reservationId,
      seatReservationInputSchema.parse({ tableIds: [b.id, a.id] }),
      key(),
    );

    const secondary = await scan(app, { token: a.token });
    expect(secondary.status).toBe(201);
    expect(secondary.body.data.outcome).toBe("joined");
    expect(secondary.body.data.session.id).toBe(seated.tableSessionId);
    expect(secondary.body.data.session.status).toBe("open");

    // The primary table's QR lands in the very same session.
    const primary = await scan(app, { token: b.token });
    expect(primary.body.data.outcome).toBe("joined");
    expect(primary.body.data.session.id).toBe(seated.tableSessionId);

    // Exactly one session exists for the whole party.
    expect(await sessionRows([a.id, b.id])).toHaveLength(1);
  });

  it("legend-rml8 a free table that belongs to no party still opens its own session", async () => {
    const f = await floor(1);
    const scanned = await scan(app, { token: f.tables[0]!.token });
    expect(scanned.status).toBe(201);
    expect(scanned.body.data.outcome).toBe("opened");
  });
});

describe("legend-khiv closing a session cancels its open service requests", () => {
  it("legend-khiv close cancels pending and acknowledged requests and the next session starts clean", async () => {
    const f = await floor(1);
    const table = f.tables[0]!;
    const guest = await scanAsGuest(table.token);

    const waiter = await guestCall(guest);
    expect(waiter.status).toBe(201);
    const bill = await guestCall(guest, {
      type: "request_bill",
      reason: undefined,
    });
    expect(bill.status).toBe(201);
    const pendingId = waiter.body.data.id as string;
    const acknowledgedId = bill.body.data.id as string;
    const acked = await floorStaff.client
      .post(`/api/service-requests/${acknowledgedId}/acknowledge`)
      .set(originHeader)
      .set("Host", seededHostname);
    expect(acked.status).toBe(200);

    const closed = await closeSession(guest.sessionId);
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe("closed");

    const cancelled = await inbox(f.outletId, "cancelled");
    expect(cancelled.status).toBe(200);
    const cancelledIds = cancelled.body.data.map((r: { id: string }) => r.id);
    expect(cancelledIds).toContain(pendingId);
    expect(cancelledIds).toContain(acknowledgedId);
    for (const status of ["pending", "acknowledged"]) {
      const open = await inbox(f.outletId, status);
      const openIds = open.body.data.map((r: { id: string }) => r.id);
      expect(openIds).not.toContain(pendingId);
      expect(openIds).not.toContain(acknowledgedId);
    }

    // A stale request must not absorb the next session's call: the same table
    // and kind opens a brand new request (201, not a dedupe 200).
    const next = await scanAsGuest(table.token);
    expect(next.sessionId).not.toBe(guest.sessionId);
    const again = await guestCall(next);
    expect(again.status).toBe(201);
    expect(again.body.data.id).not.toBe(pendingId);
    expect(again.body.data.status).toBe("pending");
    expect(again.body.data.tableSessionId).toBe(next.sessionId);
  });

  it("legend-khiv closing a session leaves requests that are already resolved untouched", async () => {
    const f = await floor(1);
    const guest = await scanAsGuest(f.tables[0]!.token);
    const call = await guestCall(guest);
    expect(call.status).toBe(201);
    const id = call.body.data.id as string;
    const resolved = await floorStaff.client
      .post(`/api/service-requests/${id}/resolve`)
      .set(originHeader)
      .set("Host", seededHostname)
      .send({});
    expect(resolved.status).toBe(200);

    expect((await closeSession(guest.sessionId)).status).toBe(200);

    const done = await inbox(f.outletId, "resolved");
    expect(done.body.data.map((r: { id: string }) => r.id)).toContain(id);
    const cancelled = await inbox(f.outletId, "cancelled");
    expect(cancelled.body.data.map((r: { id: string }) => r.id)).not.toContain(
      id,
    );
  });
});

// Keep the `Client` type import used for query helpers typed elsewhere.
export type { Client };
