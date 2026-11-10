// WS-03 P2 (CTO decision 3): locks what a guest gets from scanning the QR of a
// SECONDARY table of a multi-table party. Real Express app + services +
// PostgreSQL (disposable server from `pnpm test`).
//
// Locked behaviour:
//  - the scan returns the party session, whose `tableId` is the PRIMARY table
//    (first table of the seating), and the scan response `table` is the
//    primary table too;
//  - the session token from the secondary scan orders into that same session;
//  - a secondary table that is not occupied never joins the party.
//
// Assumption: the party is seated in an open_bill zone (staff-seated sessions
// are confirmed by the host), so a checkout needs no payment provider.
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createReservationInputSchema,
  seatReservationInputSchema,
} from "@starter/shared/reservation";
import { outletIdSchema } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { seatReservation } from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
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

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

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

function context() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

type Floor = {
  zoneId: string;
  tables: { id: string; token: string }[];
};

async function floor(count: number): Promise<Floor> {
  const zone = await createZone(
    staff.client,
    { paymentMode: "open_bill", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const tables: Floor["tables"] = [];
  for (let i = 0; i < count; i += 1) {
    const table = await createTable(staff.client, { zoneId: zone.id }, headers);
    tables.push({
      id: table.id,
      token: (await issueQr(staff.client, table.id, headers)).token,
    });
  }
  return { zoneId: zone.id as string, tables };
}

/** Staff seats a party; the FIRST table id is the primary table. */
async function seatParty(
  zoneId: string,
  date: string,
  tableIds: string[],
): Promise<string> {
  const created = await createReservation(
    context(),
    outletIdSchema.parse(tenant.outletId),
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, "19:00", "Asia/Jakarta").toISOString(),
      pax: 4,
      zoneId,
      guestName: "Tamu Party",
      contactPhone: "081234567890",
    }),
    `p2-${randomUUID()}`,
  );
  const seated = await seatReservation(
    context(),
    staff.userId,
    outletIdSchema.parse(tenant.outletId),
    created.reservation.id,
    seatReservationInputSchema.parse({ tableIds }),
    `p2-${randomUUID()}`,
  );
  return seated.tableSessionId;
}

const scanTable = (token: string) =>
  scan(app, { token, hostname: tenant.hostname });

function asGuest(sessionToken: string, sessionId: string) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${sessionToken}`)
      .set(originHeader);
  const base = `/api/table-sessions/${sessionId}`;
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

async function sessionCount(tableIds: string[]): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2)",
    [tenant.tenantId, tableIds],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`ss-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  // The floor role cannot seat reservations; the host who seats the party can.
  await owner.query(
    `UPDATE roles SET permissions = permissions || '["reservation.view","reservation.manage"]'::jsonb WHERE id = $1`,
    [tenant.roleId],
  );
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, 'p2-1', 'none', 0, 60, 24, 0, 0, 0, 90, 30, true)`,
      [tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Secondary Scan Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
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
       VALUES ($1, $2, NULL, 'PBJT-SS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  // The isolated tenant stays in the disposable test database (append-only
  // audit rows); give it a valid creator so the tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("ws03 secondary-table scan", () => {
  it("returns the party session with the primary table, not the scanned one", async () => {
    const f = await floor(3);
    const [primary, secondary, third] = f.tables as [
      Floor["tables"][0],
      Floor["tables"][0],
      Floor["tables"][0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-06-01", [
      primary.id,
      secondary.id,
    ]);

    const scanned = await scanTable(secondary.token);
    expect(scanned.status).toBe(201);
    expect(scanned.body.data.outcome).toBe("joined");
    expect(scanned.body.data.session.id).toBe(sessionId);
    expect(scanned.body.data.session.tableId).toBe(primary.id);
    expect(scanned.body.data.table.id).toBe(primary.id);
    expect(scanned.body.data.table.id).not.toBe(secondary.id);
    // No second session was opened for the party's tables.
    expect(await sessionCount([primary.id, secondary.id])).toBe(1);

    // A table outside the party is unaffected: it opens its own session.
    const other = await scanTable(third.token);
    expect(other.body.data.outcome).toBe("opened");
    expect(other.body.data.session.id).not.toBe(sessionId);
    expect(other.body.data.session.tableId).toBe(third.id);
  });

  it("the primary and the secondary QR give the same session and table", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      Floor["tables"][0],
      Floor["tables"][0],
    ];
    await seatParty(f.zoneId, "2027-06-02", [primary.id, secondary.id]);
    const fromPrimary = await scanTable(primary.token);
    const fromSecondary = await scanTable(secondary.token);
    expect(fromSecondary.body.data.session.id).toBe(
      fromPrimary.body.data.session.id,
    );
    expect(fromSecondary.body.data.session.tableId).toBe(
      fromPrimary.body.data.session.tableId,
    );
    expect(fromSecondary.body.data.table.id).toBe(
      fromPrimary.body.data.table.id,
    );
  });

  it("the first table of the seating is primary whichever QR is scanned first", async () => {
    const f = await floor(2);
    const [a, b] = f.tables as [Floor["tables"][0], Floor["tables"][0]];
    // `b` is listed first, so `b` is primary and `a` is secondary.
    const sessionId = await seatParty(f.zoneId, "2027-06-03", [b.id, a.id]);
    const scanned = await scanTable(a.token);
    expect(scanned.body.data.session.id).toBe(sessionId);
    expect(scanned.body.data.session.tableId).toBe(b.id);
    expect(scanned.body.data.table.id).toBe(b.id);
  });

  it("a guest who scans the secondary QR can order into the party session", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      Floor["tables"][0],
      Floor["tables"][0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-06-04", [
      primary.id,
      secondary.id,
    ]);
    const scanned = await scanTable(secondary.token);
    expect(scanned.status).toBe(201);
    const guest = asGuest(scanned.body.data.sessionToken, sessionId);

    const view = await guest.view();
    expect(view.status).toBe(200);
    const added = await guest.add({
      menuItemId: ids.kopi,
      quantity: 2,
      expectedCartVersion: view.body.data.cart.version,
    });
    expect(added.status).toBe(201);
    const placed = await guest.checkout({
      expectedCartVersion: added.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(placed.body.data.order.totalIdr).toBeGreaterThan(0);

    // The order sits on the party's session (bound to the primary table).
    const { rows } = await owner.query<{
      table_session_id: string;
      session_table_id: string;
    }>(
      `SELECT o.table_session_id, s.table_id AS session_table_id
         FROM orders o JOIN table_sessions s
           ON s.tenant_id = o.tenant_id AND s.id = o.table_session_id
        WHERE o.tenant_id = $1 AND o.id = $2`,
      [tenant.tenantId, ulidToUuid(placed.body.data.order.id as string)],
    );
    expect(rows[0]?.table_session_id).toBe(sessionId);
    expect(rows[0]?.session_table_id).toBe(primary.id);
  });

  it("a secondary table that is not occupied does not join the party", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      Floor["tables"][0],
      Floor["tables"][0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-06-05", [
      primary.id,
      secondary.id,
    ]);
    // Stale hold: the secondary table was freed while the party row remains.
    await asOwnerTenant((client) =>
      client.query(
        "UPDATE tables SET status = 'available' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, secondary.id],
      ),
    );

    const scanned = await scanTable(secondary.token);
    expect(scanned.status).toBe(201);
    expect(scanned.body.data.outcome).toBe("opened");
    expect(scanned.body.data.session.id).not.toBe(sessionId);
    // It opens its own session on its own table, not the party's primary.
    expect(scanned.body.data.session.tableId).toBe(secondary.id);
    expect(scanned.body.data.table.id).toBe(secondary.id);
  });

  it("after the party closes, the secondary QR opens a fresh session on its own table", async () => {
    const f = await floor(2);
    const [primary, secondary] = f.tables as [
      Floor["tables"][0],
      Floor["tables"][0],
    ];
    const sessionId = await seatParty(f.zoneId, "2027-06-06", [
      primary.id,
      secondary.id,
    ]);
    // Close as the staff would; a zero bill needs no settlement.
    const closed = await staff.client
      .post(`/api/table-sessions/${sessionId}/close`)
      .set(headers)
      .set(originHeader)
      .send({ tableCleaned: true, waiterConfirmedEmpty: true });
    expect(closed.status).toBe(200);

    const scanned = await scanTable(secondary.token);
    expect(scanned.body.data.outcome).toBe("opened");
    expect(scanned.body.data.session.id).not.toBe(sessionId);
    expect(scanned.body.data.session.tableId).toBe(secondary.id);
  });
});
