// Brief 1270 card W1: paid WFC schema, seats, hourly quota, product split and
// the sales gate, against PostgreSQL with the restricted app role (RLS forced).
// No sale exists in this card: the suite proves that the database and the gate
// refuse everything that would sell a seat twice, sell without a config, or
// let a WFC product out of another door.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createPromotion,
  updatePromotion,
} from "../services/crm-promo.service.ts";
import { wfcProductIds } from "../services/wfc-product-guard.ts";
import { lockWfcClaim } from "../services/wfc-claim-lock.ts";
import { cancelPaymentLinkInTx } from "../services/payment.service.ts";
import { deleteFloorZone, updateFloorZone } from "../services/floor.service.ts";
import { listPosTicketProducts } from "../services/facility-pos-ticket-catalog.ts";
import { updateFacilityProduct } from "../services/facility-products.service.ts";
import {
  assertWfcSalesOpen,
  wfcSalesEnabled,
} from "../services/wfc-sales-gate.ts";
import {
  createWfcSeat,
  listWfcHourlyQuotas,
  listWfcSeats,
  putWfcHourlyQuotas,
  setWfcProduct,
  setWfcSeatStatus,
} from "../services/wfc-seat.service.ts";
import {
  outletContext,
  seedFacility,
  seedMenuItems,
} from "./facility-entitlement-helpers.ts";
import {
  NOW,
  asTenant,
  createWorld,
  owner,
  seedProfile,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

const flag = env as unknown as { WFC_SALES_ENABLED?: boolean };
const was = flag.WFC_SALES_ENABLED;
beforeEach(() => {
  flag.WFC_SALES_ENABLED = false;
});
afterEach(() => {
  flag.WFC_SALES_ENABLED = was;
});
afterAll(async () => {
  await owner.end();
});

const TABLES = [
  "wfc_seats",
  "wfc_hourly_quotas",
  "wfc_business_settings",
  "wfc_seat_reservations",
] as const;

type Failure = { status?: number; code?: string; message: string };

async function failure(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    const e = error as Failure;
    return { status: e.status, code: e.code, message: String(e.message) };
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}

async function seedActor(
  tenantId: string,
  permissions = ["facility.config.manage", "facility.booth.operate"],
): Promise<string> {
  const userId = randomUUID();
  const roleId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "WFC schema test", `${userId}@example.com`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenantId,
      `WFC ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return userId;
}

async function seedZone(world: World, outletId = world.outletA, isWfc = true) {
  const zoneId = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours, is_wfc)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]', $5)`,
      [zoneId, world.tenantId, outletId, `Zona ${short()}`, isWfc],
    ),
  );
  return zoneId;
}

async function seedProduct(
  world: World,
  facilityId: string,
  menuItemId: string | null = null,
) {
  const id = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, menu_item_id)
       VALUES ($1, $2, $3, $4, $5, 'single', 70000, 1, $6)`,
      [
        id,
        world.tenantId,
        world.outletA,
        facilityId,
        `Pass ${short()}`,
        menuItemId,
      ],
    ),
  );
  return id;
}

const SETTINGS = {
  version: 1,
  effective_from: "2026-01-01",
  total_seats: 60,
  wfc_seats: 20,
  open_hours_per_month: 420,
  fixed_cost_idr: 100_000_000,
  target_revenue_idr: 300_000_000,
  target_profit_idr: 50_000_000,
  target_occupancy_bp: 5000,
  spend_per_person_idr: 60_000,
  cogs_bp: 3500,
  avg_stay_minutes: 60,
  reason: "Uji",
};

type Actors = { proposer: string; approver: string };

/** What the second person approved: every number of the version. */
const payloadOf = (settings: Record<string, unknown>) => ({
  version: settings.version,
  effectiveFrom: settings.effective_from,
  totalSeats: settings.total_seats,
  wfcSeats: settings.wfc_seats,
  openHoursPerMonth: settings.open_hours_per_month,
  fixedCostIdr: settings.fixed_cost_idr,
  targetRevenueIdr: settings.target_revenue_idr,
  targetProfitIdr: settings.target_profit_idr,
  targetOccupancyBp: settings.target_occupancy_bp,
  spendPerPersonIdr: settings.spend_per_person_idr,
  cogsBp: settings.cogs_bp,
  avgStayMinutes: settings.avg_stay_minutes,
  noShowMinutes: settings.no_show_minutes ?? 30,
});

/** One decided approval request of a settings change (final level by default). */
async function seedApproval(
  world: World,
  actors: Actors,
  settings: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const row: Record<string, unknown> = {
    id,
    tenant_id: world.tenantId,
    outlet_id: world.outletA,
    chain_id: id,
    source_module: "wfc",
    action_type: "price_change",
    object_type: "wfc_business_settings",
    object_id: settings.id,
    payload: JSON.stringify(payloadOf(settings)),
    requested_by: actors.proposer,
    source: "user",
    level: 1,
    required_levels: 1,
    required_steps: "[]",
    request_reason: "Uji",
    deadline_at: new Date(Date.now() + 3_600_000),
    status: "approved",
    decided_by: actors.approver,
    decided_at: new Date(),
    reason: "Setuju",
    ...overrides,
  };
  await asTenant(world.tenantId, (client) =>
    insertInto(client, "approval_requests", row),
  );
  return id;
}

async function insertInto(
  client: { query: (text: string, values: unknown[]) => Promise<unknown> },
  table: string,
  row: Record<string, unknown>,
) {
  const names = Object.keys(row);
  await client.query(
    `INSERT INTO ${table} (${names.join(", ")})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(row),
  );
}

const settingsRow = (
  world: World,
  actors: Actors,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: randomUUID(),
  tenant_id: world.tenantId,
  outlet_id: world.outletA,
  ...SETTINGS,
  proposed_by: actors.proposer,
  approved_by: actors.approver,
  ...overrides,
});

async function seedSettings(
  world: World,
  actors: Actors,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const row = settingsRow(world, actors, overrides);
  if (!("approval_request_id" in overrides))
    row.approval_request_id = await seedApproval(world, actors, row);
  await asTenant(world.tenantId, (client) =>
    insertInto(client, "wfc_business_settings", row),
  );
  return row.id as string;
}

async function setup() {
  const world = await createWorld();
  const actor = await seedActor(world.tenantId);
  const approver = await seedActor(world.tenantId);
  const zoneId = await seedZone(world);
  const facilityId = await seedFacility(world, world.outletA, "coworking");
  return { world, actor, approver, zoneId, facilityId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const newSeat = (s: Setup, code = `K${short()}`.slice(0, 20)) =>
  createWfcSeat(s.world.context, s.actor, {
    outletId: s.world.outletA,
    zoneId: s.zoneId,
    code,
  });

const asDayPass = async (s: Setup) => {
  const productId = await seedProduct(s.world, s.facilityId);
  const product = await setWfcProduct(s.world.context, s.actor, {
    productId,
    wfc: {
      kind: "day_pass",
      access: "all_day",
      seatFeeIdr: 50_000,
      creditIdr: 20_000,
      durationMinutes: null,
    },
    expectedUpdatedAt: await stampOf(s, productId),
  });
  return product;
};

async function stampOf(s: Setup, productId: string): Promise<string> {
  return asTenant(s.world.tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT updated_at FROM facility_products WHERE id = $1",
      [productId],
    );
    return (rows[0].updated_at as Date).toISOString();
  });
}

/** The product as W1b will leave it: switched on past the price floor. */
const switchOn = (s: Setup, productId: string) =>
  asTenant(s.world.tenantId, (client) =>
    client.query(
      "UPDATE facility_products SET is_active = true WHERE id = $1",
      [productId],
    ),
  );

async function claimRow(s: Setup) {
  const seat = await newSeat(s);
  const product = await asDayPass(s);
  await switchOn(s, product.productId);
  const settingsId = await seedSettings(s.world, {
    proposer: s.actor,
    approver: s.approver,
  });
  const profileId = (await seedProfile(s.world.tenantId)).id;
  return (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    tenant_id: s.world.tenantId,
    outlet_id: s.world.outletA,
    seat_id: seat.id,
    product_id: product.productId,
    customer_profile_id: profileId,
    kind: "day_pass",
    access: "all_day",
    business_date: "2098-11-08",
    slot: "[2098-11-08T03:00:00Z,2098-11-08T05:00:00Z)",
    status: "pending_payment",
    seat_fee_idr: 50_000,
    credit_idr: 20_000,
    price_idr: 70_000,
    settings_version_id: settingsId,
    floor_per_hour_idr: 12_000,
    hold_expires_at: "2098-11-08T03:45:00Z",
    ...overrides,
  });
}
type ClaimRow = ReturnType<Awaited<ReturnType<typeof claimRow>>>;

const insertClaim = (s: Setup, row: Record<string, unknown>) =>
  asTenant(s.world.tenantId, (client) =>
    insertInto(client, "wfc_seat_reservations", row),
  );

const updateClaim = (s: Setup, id: unknown, assignments: string) =>
  asTenant(s.world.tenantId, (client) =>
    client.query(
      `UPDATE wfc_seat_reservations SET ${assignments} WHERE id = $1`,
      [id],
    ),
  );

/** An open payment link of the claim's price; overrides win. */
async function seedLink(
  s: Setup,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await asTenant(s.world.tenantId, (client) =>
    insertInto(client, "payment_links", {
      id,
      tenant_id: s.world.tenantId,
      outlet_id: s.world.outletA,
      token_hash: randomUUID().replaceAll("-", "").repeat(2),
      reference: `wfc-${short()}`,
      subtotal_idr: 70_000,
      total_idr: 70_000,
      paid_idr: 0,
      expires_at: new Date(Date.now() + 1_800_000),
      created_by: "wfc-schema-test",
      ...overrides,
    }),
  );
  return id;
}

const settleLink = (s: Setup, linkId: string) =>
  asTenant(s.world.tenantId, (client) =>
    client.query(
      "UPDATE payment_links SET paid_idr = total_idr, updated_at = now() WHERE id = $1",
      [linkId],
    ),
  );

const CONFIRM =
  "status = 'confirmed', paid_idr = price_idr, hold_expires_at = NULL";

/** A pending claim on its own open link. */
async function pendingOnLink(
  s: Setup,
  row: ClaimRow,
  link: Record<string, unknown> = {},
) {
  await insertClaim(s, row);
  const linkId = await seedLink(s, link);
  await updateClaim(s, row.id, `payment_link_id = '${linkId}'`);
  return linkId;
}

async function confirmedClaim(s: Setup, row: ClaimRow) {
  const linkId = await pendingOnLink(s, row);
  await settleLink(s, linkId);
  await updateClaim(s, row.id, CONFIRM);
  return linkId;
}

describe("WFC tables are tenant and outlet isolated", () => {
  it.each(TABLES)("%s forces RLS with both policies", async (table) => {
    const { rows } = await owner.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              array(SELECT polname::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS policies
         FROM pg_class c WHERE c.oid = to_regclass('public.' || $1)`,
      [table],
    );
    expect(rows[0]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    expect(rows[0].policies).toEqual(
      expect.arrayContaining(["tenant_isolation", "outlet_isolation"]),
    );
  });

  it("another tenant and another outlet see no seat", async () => {
    const s = await setup();
    const other = await setup();
    await newSeat(s);
    expect(await listWfcSeats(s.world.context, s.actor, {})).toHaveLength(1);
    expect(
      await listWfcSeats(other.world.context, other.actor, {}),
    ).toHaveLength(0);
    const inB = outletContext(s.world.tenantId, s.world.outletB);
    const seen = await withTenant(db, inB, (tx) =>
      tx.execute(sql`SELECT id FROM wfc_seats`),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it.each(TABLES)(
    "%s hides its rows from another tenant and outlet",
    async (table) => {
      const s = await setup();
      const build = await claimRow(s);
      await putWfcHourlyQuotas(s.world.context, s.actor, {
        outletId: s.world.outletA,
        quotas: [{ dayOfWeek: 1, hour: 9, seats: 1 }],
      });
      await insertClaim(s, build());
      const other = await setup();
      const count = async (context: typeof s.world.context) =>
        (
          await withTenant(db, context, (tx) =>
            tx.execute(sql`SELECT id FROM ${sql.identifier(table)}`),
          )
        ).rows.length;
      expect(await count(s.world.context)).toBe(1);
      expect(
        await count(outletContext(s.world.tenantId, s.world.outletA)),
      ).toBe(1);
      expect(
        await count(outletContext(s.world.tenantId, s.world.outletB)),
      ).toBe(0);
      expect(await count(other.world.context)).toBe(0);
      // Nor can it be written into: the row keeps its tenant and outlet.
      const touched = await withTenant(
        db,
        outletContext(s.world.tenantId, s.world.outletB),
        (tx) =>
          tx.execute(
            table === "wfc_business_settings"
              ? sql`SELECT id FROM wfc_business_settings FOR KEY SHARE`
              : sql`UPDATE ${sql.identifier(table)} SET tenant_id = tenant_id`,
          ),
      ).then(
        (r) => r.rowCount ?? 0,
        () => 0,
      );
      expect(touched).toBe(0);
    },
  );

  it("the app role cannot delete a claim or touch a settings version", async () => {
    const s = await setup();
    const build = await claimRow(s);
    await insertClaim(s, build());
    for (const statement of [
      sql`DELETE FROM wfc_seat_reservations`,
      sql`UPDATE wfc_business_settings SET cogs_bp = 1`,
      sql`DELETE FROM wfc_business_settings`,
    ])
      await expect(
        withTenant(db, s.world.context, (tx) => tx.execute(statement)),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "42501" }),
      });
    // Even the owner cannot rewrite a version (append-only trigger).
    await expect(
      asTenant(s.world.tenantId, (client) =>
        client.query("UPDATE wfc_business_settings SET cogs_bp = 1"),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("seats", () => {
  it("only a WFC zone takes a seat, code unique per zone", async () => {
    const s = await setup();
    await newSeat(s, "A1");
    expect(await failure(newSeat(s, "A1"))).toMatchObject({
      status: 409,
      code: "SEAT_CODE_TAKEN",
    });
    const plain = await seedZone(s.world, s.world.outletA, false);
    expect(
      await failure(
        createWfcSeat(s.world.context, s.actor, {
          outletId: s.world.outletA,
          zoneId: plain,
          code: "B1",
        }),
      ),
    ).toMatchObject({ status: 409, code: "ZONE_NOT_WFC" });
    const closed = await seedZone(s.world);
    await asTenant(s.world.tenantId, (client) =>
      client.query("UPDATE floor_zones SET status = 'inactive' WHERE id = $1", [
        closed,
      ]),
    );
    expect(
      await failure(
        createWfcSeat(s.world.context, s.actor, {
          outletId: s.world.outletA,
          zoneId: closed,
          code: "B1",
        }),
      ),
    ).toMatchObject({ status: 409, code: "ZONE_NOT_WFC" });
    const otherOutlet = await seedZone(s.world, s.world.outletB);
    expect(
      await failure(
        createWfcSeat(s.world.context, s.actor, {
          outletId: s.world.outletA,
          zoneId: otherOutlet,
          code: "B1",
        }),
      ),
    ).toMatchObject({ status: 404 });
  });

  it("without facility.config.manage nothing is written", async () => {
    const s = await setup();
    const staff = await seedActor(s.world.tenantId, ["facility.booth.operate"]);
    expect(
      await failure(
        createWfcSeat(s.world.context, staff, {
          outletId: s.world.outletA,
          zoneId: s.zoneId,
          code: "A1",
        }),
      ),
    ).toMatchObject({ status: 403 });
    expect(await listWfcSeats(s.world.context, s.actor, {})).toHaveLength(0);
  });

  it("a seat with a live claim cannot be switched off", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build({
      slot: "[2099-01-01T03:00:00Z,2099-01-01T05:00:00Z)",
      hold_expires_at: "2099-01-01T03:00:00Z",
    });
    await insertClaim(s, row);
    expect(
      await failure(
        setWfcSeatStatus(s.world.context, s.actor, {
          seatId: row.seat_id as string,
          status: "inactive",
        }),
      ),
    ).toMatchObject({ status: 409, code: "SEAT_IN_USE" });
  });
});

describe("hourly quota", () => {
  it("is capped by the active WFC seats and replaces per cell", async () => {
    const s = await setup();
    await seedSettings(s.world, { proposer: s.actor, approver: s.approver });
    await newSeat(s);
    const second = await newSeat(s);
    const put = (seats: number) =>
      putWfcHourlyQuotas(s.world.context, s.actor, {
        outletId: s.world.outletA,
        quotas: [{ dayOfWeek: 1, hour: 9, seats }],
      });
    expect(await put(2)).toEqual([{ dayOfWeek: 1, hour: 9, seats: 2 }]);
    expect(await failure(put(3))).toMatchObject({
      status: 409,
      code: "QUOTA_EXCEEDS_SEATS",
    });
    expect(
      await failure(
        setWfcSeatStatus(s.world.context, s.actor, {
          seatId: second.id,
          status: "inactive",
        }),
      ),
    ).toMatchObject({ status: 409, code: "QUOTA_EXCEEDS_SEATS" });
    await put(1);
    await setWfcSeatStatus(s.world.context, s.actor, {
      seatId: second.id,
      status: "inactive",
    });
    expect(
      await listWfcHourlyQuotas(s.world.context, s.actor, {
        outletId: s.world.outletA,
      }),
    ).toEqual([{ dayOfWeek: 1, hour: 9, seats: 1 }]);
  });

  it("a quota raised while a seat is switched off never exceeds the seats", async () => {
    const s = await setup();
    await seedSettings(s.world, { proposer: s.actor, approver: s.approver });
    await newSeat(s);
    const second = await newSeat(s);
    await Promise.allSettled([
      putWfcHourlyQuotas(s.world.context, s.actor, {
        outletId: s.world.outletA,
        quotas: [{ dayOfWeek: 1, hour: 9, seats: 2 }],
      }),
      setWfcSeatStatus(s.world.context, s.actor, {
        seatId: second.id,
        status: "inactive",
      }),
    ]);
    const active = (await listWfcSeats(s.world.context, s.actor, {})).filter(
      (seat) => seat.status === "active",
    ).length;
    const quotas = await listWfcHourlyQuotas(s.world.context, s.actor, {
      outletId: s.world.outletA,
    });
    expect(quotas[0]?.seats ?? 0).toBeLessThanOrEqual(active);
    // Exactly one of the two won.
    expect(quotas.length === 1).toBe(active === 2);
  });

  it("never exceeds the approved wfc_seats, now or in a coming version", async () => {
    const s = await setup();
    const actors = { proposer: s.actor, approver: s.approver };
    await newSeat(s);
    await newSeat(s);
    const put = (seats: number) =>
      putWfcHourlyQuotas(
        s.world.context,
        s.actor,
        {
          outletId: s.world.outletA,
          quotas: [{ dayOfWeek: 1, hour: 9, seats }],
        },
        NOW,
      );
    // No approved number yet: only zero.
    expect(await failure(put(1))).toMatchObject({
      status: 409,
      code: "WFC_CONFIG_INCOMPLETE",
    });
    await put(0);
    await seedSettings(s.world, actors);
    await put(2);
    await seedSettings(s.world, actors, {
      version: 2,
      effective_from: "2027-01-01",
      wfc_seats: 1,
    });
    expect(await failure(put(2))).toMatchObject({
      status: 409,
      code: "QUOTA_EXCEEDS_SEATS",
    });
    await put(1);
    // A newer version of the same day replaces the older one.
    await seedSettings(s.world, actors, { version: 3, wfc_seats: 1 });
    expect(await failure(put(2))).toMatchObject({
      code: "QUOTA_EXCEEDS_SEATS",
    });
  });

  it("the database refuses a duplicate cell, a negative and a wild hour", async () => {
    const s = await setup();
    const insert = (day: number, hour: number, seats: number) =>
      asTenant(s.world.tenantId, (client) =>
        client.query(
          `INSERT INTO wfc_hourly_quotas (tenant_id, outlet_id, day_of_week, hour, seats, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [s.world.tenantId, s.world.outletA, day, hour, seats, s.actor],
        ),
      );
    await insert(0, 9, 1);
    await expect(insert(0, 9, 1)).rejects.toMatchObject({ code: "23505" });
    for (const [day, hour, seats] of [
      [0, 10, -1],
      [0, 24, 1],
      [7, 10, 1],
    ])
      await expect(insert(day!, hour!, seats!)).rejects.toMatchObject({
        code: "23514",
      });
  });
});

describe("product", () => {
  it("locks price = seat fee + credit, unlinked from the till, inactive", async () => {
    const s = await setup();
    const product = await asDayPass(s);
    expect(product).toMatchObject({
      priceIdr: 70_000,
      isActive: false,
      wfc: { kind: "day_pass", access: "all_day", creditIdr: 20_000 },
    });
    const db1 = (assignments: string) =>
      asTenant(s.world.tenantId, (client) =>
        client.query(
          `UPDATE facility_products SET ${assignments} WHERE id = $1`,
          [product.productId],
        ),
      );
    for (const bad of [
      "price_idr = 70001",
      "credit_idr = 0, price_idr = 50000",
      "credit_idr = NULL",
      "wfc_access = NULL",
      "wfc_kind = NULL",
      "wfc_kind = 'seat_reservation'",
      "duration_minutes = 60",
      "sessions = 2",
      "type = 'package_component'",
      `menu_item_id = '${randomUUID()}'`,
    ])
      await expect(db1(bad), bad).rejects.toMatchObject({ code: "23514" });
  });

  it("the ordinary product editor cannot reprice, link or activate it", async () => {
    const s = await setup();
    const { productId } = await asDayPass(s);
    for (const change of [
      { priceIdr: 1 },
      { isActive: true },
      { sessions: 2 },
      { maxPerDay: 1 },
    ])
      expect(
        await failure(
          updateFacilityProduct(s.world.context, s.actor, productId, {
            ...change,
            expectedUpdatedAt: await stampOf(s, productId),
          } as never),
        ),
      ).toMatchObject({ status: 409, code: "WFC_PRODUCT_MANAGED" });
    const renamed = await updateFacilityProduct(
      s.world.context,
      s.actor,
      productId,
      {
        name: "Nama baru",
        priceIdr: 70_000,
        expectedUpdatedAt: await stampOf(s, productId),
      } as never,
    );
    expect(renamed.name).toBe("Nama baru");
  });

  it("refuses a till-linked product and a shower product", async () => {
    const s = await setup();
    const [menuItemId] = await seedMenuItems(s.world, 1);
    const wfc = {
      kind: "day_pass" as const,
      access: "all_day" as const,
      seatFeeIdr: 50_000,
      creditIdr: 20_000,
      durationMinutes: null,
    };
    const linked = await seedProduct(s.world, s.facilityId, menuItemId);
    const shower = await seedProduct(s.world, await seedFacility(s.world));
    for (const productId of [linked, shower])
      expect(
        await failure(
          setWfcProduct(s.world.context, s.actor, {
            productId,
            wfc,
            expectedUpdatedAt: await stampOf(s, productId),
          }),
        ),
      ).toMatchObject({ status: 409, code: "NOT_WFC_ELIGIBLE" });
    const { products } = await listPosTicketProducts(
      s.world.context,
      s.world.outletA as never,
    );
    expect(products.map((p) => p.id as string)).toContain(linked);
    const { productId } = await asDayPass(s);
    const after = await listPosTicketProducts(
      s.world.context,
      s.world.outletA as never,
    );
    expect(after.products.map((p) => p.id as string)).not.toContain(productId);
  });

  it("a stale editor is refused and a client price is not a field", async () => {
    const s = await setup();
    const productId = await seedProduct(s.world, s.facilityId);
    const wfc = {
      kind: "seat_reservation" as const,
      access: "off_peak" as const,
      seatFeeIdr: 10_000,
      creditIdr: 10_000,
      durationMinutes: 60,
    };
    expect(
      await failure(
        setWfcProduct(s.world.context, s.actor, {
          productId,
          wfc,
          expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
        }),
      ),
    ).toMatchObject({ code: "PRECONDITION_FAILED" });
    const expectedUpdatedAt = await stampOf(s, productId);
    for (const bad of [
      { productId, wfc, priceIdr: 1, expectedUpdatedAt },
      { productId, wfc: { ...wfc, creditIdr: 0 }, expectedUpdatedAt },
      { productId, wfc: { ...wfc, durationMinutes: null }, expectedUpdatedAt },
    ])
      expect(
        await failure(setWfcProduct(s.world.context, s.actor, bad as never)),
      ).toMatchObject({ status: 400 });
  });

  it("clearing an ordinary product leaves it untouched", async () => {
    const s = await setup();
    const productId = await seedProduct(s.world, s.facilityId);
    const stamp = await stampOf(s, productId);
    const result = await setWfcProduct(s.world.context, s.actor, {
      productId,
      wfc: null,
      expectedUpdatedAt: stamp,
    });
    expect(result).toMatchObject({ isActive: true, wfc: null });
    expect(await stampOf(s, productId)).toBe(stamp);
  });

  it("cannot lose its WFC kind once a claim references it", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    await insertClaim(s, row);
    const productId = row.product_id as string;
    expect(
      await failure(
        setWfcProduct(s.world.context, s.actor, {
          productId,
          wfc: null,
          expectedUpdatedAt: await stampOf(s, productId),
        }),
      ),
    ).toMatchObject({ status: 409, code: "WFC_PRODUCT_IN_USE" });
  });
});

const refused = { code: "23514" };

describe("seat claims", () => {
  it("one seat is never held twice; a released claim frees it", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const first = build();
    await confirmedClaim(s, first);
    await expect(insertClaim(s, build())).rejects.toMatchObject({
      code: "23P01",
    });
    // Back-to-back is legal.
    await insertClaim(
      s,
      build({ slot: "[2098-11-08T05:00:00Z,2098-11-08T06:00:00Z)" }),
    );
    await updateClaim(s, first.id, "status = 'no_show'");
    const second = build();
    await insertClaim(s, second);
    await updateClaim(
      s,
      second.id,
      "status = 'cancelled', hold_expires_at = NULL",
    );
    await insertClaim(s, build());
  });

  it("starts pending and unpaid, and the split always adds up", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const paid = {
      status: "confirmed",
      paid_idr: 70_000,
      hold_expires_at: null,
    };
    for (const bad of [
      paid,
      { ...paid, payment_link_id: await seedLink(s, { paid_idr: 70_000 }) },
      { status: "cancelled", hold_expires_at: null },
      { paid_idr: 70_000 },
      { price_idr: 70_001 },
      { hold_expires_at: null },
      { credit_idr: 0, price_idr: 50_000 },
      { floor_per_hour_idr: 0 },
      { slot: "[2098-11-08T03:00:00Z,2098-11-08T05:00:00Z]" },
      { kind: "bundle" },
      { access: "peak" },
    ])
      await expect(
        insertClaim(s, build(bad)),
        JSON.stringify(bad),
      ).rejects.toMatchObject(refused);
    // No start or no end: the generated NOT NULL instants refuse it.
    for (const slot of ["empty", "[2098-11-08T03:00:00Z,)"])
      await expect(insertClaim(s, build({ slot }))).rejects.toMatchObject({
        code: "23502",
      });
  });

  it("never points at a seat of another outlet", async () => {
    const s = await setup();
    const build = await claimRow(s);
    await expect(
      insertClaim(s, build({ outlet_id: s.world.outletB })),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
  });
});

describe("review 1: paid is proven by the payment link", () => {
  it("takes only an open link of the same outlet, price and no discount", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    await insertClaim(s, row);
    const other = await setup();
    const bad: [string, string][] = [
      [
        "amount",
        await seedLink(s, { subtotal_idr: 69_999, total_idr: 69_999 }),
      ],
      [
        "discount",
        await seedLink(s, {
          subtotal_idr: 70_000,
          discount_idr: 1,
          total_idr: 69_999,
        }),
      ],
      [
        "discount hidden by tax",
        await seedLink(s, {
          subtotal_idr: 70_000,
          discount_idr: 1_000,
          tax_idr: 1_000,
        }),
      ],
      ["outlet", await seedLink(s, { outlet_id: s.world.outletB })],
      ["tenant", await seedLink(other)],
      [
        "cancelled",
        await seedLink(s, { expires_at: new Date(Date.now() - 1) }),
      ],
      ["no expiry", await seedLink(s, { expires_at: null })],
    ];
    for (const [label, linkId] of bad)
      await expect(
        updateClaim(s, row.id, `payment_link_id = '${linkId}'`),
        label,
      ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
  });

  it("confirms only on a link paid in full (the total, tax included)", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    const linkId = await pendingOnLink(s, row, {
      tax_idr: 7_000,
      total_idr: 77_000,
    });
    const setPaid = (amount: number) =>
      asTenant(s.world.tenantId, (client) =>
        client.query("UPDATE payment_links SET paid_idr = $2 WHERE id = $1", [
          linkId,
          amount,
        ]),
      );
    for (const amount of [0, 70_000, 76_999]) {
      await setPaid(amount);
      await expect(
        updateClaim(s, row.id, CONFIRM),
        String(amount),
      ).rejects.toMatchObject(refused);
    }
    await setPaid(77_000);
    await expect(
      updateClaim(s, row.id, "status = 'confirmed', hold_expires_at = NULL"),
    ).rejects.toMatchObject(refused);
    await expect(
      updateClaim(
        s,
        row.id,
        `${CONFIRM}, paid_idr = 69999`.replace("paid_idr = price_idr, ", ""),
      ),
    ).rejects.toMatchObject(refused);
    await updateClaim(s, row.id, CONFIRM);
  });

  it("does not confirm a cancelled link that is paid later, but records the money", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    const linkId = await pendingOnLink(s, row);
    await withTenant(db, s.world.context, (tx) =>
      cancelPaymentLinkInTx(tx, s.world.context, {
        linkId,
        now: new Date(),
        reason: "uji",
      }),
    );
    await settleLink(s, linkId);
    await expect(updateClaim(s, row.id, CONFIRM)).rejects.toMatchObject(
      refused,
    );
    await updateClaim(
      s,
      row.id,
      "status = 'cancelled', hold_expires_at = NULL",
    );
    await updateClaim(s, row.id, "paid_idr = price_idr");
    await expect(updateClaim(s, row.id, CONFIRM)).rejects.toMatchObject(
      refused,
    );
    await updateClaim(
      s,
      row.id,
      "status = 'refunded', refunded_idr = paid_idr",
    );
  });

  it("a link the gateway paid just after its own expiry still confirms", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    const linkId = await pendingOnLink(s, row, {
      expires_at: new Date(Date.now() + 400),
    });
    await settleLink(s, linkId);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await updateClaim(s, row.id, CONFIRM);
  });

  it("one link funds one claim and never moves", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    const linkId = await pendingOnLink(s, row);
    const second = build({
      slot: "[2098-11-08T07:00:00Z,2098-11-08T08:00:00Z)",
    });
    await insertClaim(s, second);
    await expect(
      updateClaim(s, second.id, `payment_link_id = '${linkId}'`),
    ).rejects.toMatchObject({ code: "23505" });
    const otherLink = await seedLink(s);
    for (const value of ["NULL", `'${otherLink}'`])
      await expect(
        updateClaim(s, row.id, `payment_link_id = ${value}`),
      ).rejects.toMatchObject(refused);
  });

  it("locks link first, then claim: settlement and confirm never deadlock", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    const linkId = await pendingOnLink(s, row);
    const confirmInOrder = () =>
      withTenant(db, s.world.context, async (tx) => {
        const claim = await lockWfcClaim(tx, s.world.context, row.id);
        if (claim.status !== "pending_payment") return "already";
        await tx.execute(
          sql`UPDATE wfc_seat_reservations SET status = 'confirmed', paid_idr = price_idr, hold_expires_at = NULL WHERE id = ${row.id}`,
        );
        return "confirmed";
      });
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [s.world.tenantId],
      );
      // Settlement holds the bill row, as applyConfirmation does.
      await client.query(
        "SELECT 1 FROM payment_links WHERE id = $1 FOR UPDATE",
        [linkId],
      );
      // A caller that takes the claim first fails at once instead of waiting
      // on the link with the claim locked.
      await expect(updateClaim(s, row.id, CONFIRM)).rejects.toMatchObject({
        code: "55P03",
      });
      const racers = Promise.all([confirmInOrder(), confirmInOrder()]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The waiters hold nothing: the claim row is free for the settlement.
      await client.query(
        "SELECT 1 FROM wfc_seat_reservations WHERE id = $1 FOR UPDATE NOWAIT",
        [row.id],
      );
      await client.query(
        "UPDATE payment_links SET paid_idr = total_idr WHERE id = $1",
        [linkId],
      );
      await client.query("COMMIT");
      expect((await racers).sort()).toEqual(["already", "confirmed"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("review 2: a claim is a frozen snapshot on legal steps", () => {
  it("no sale value ever changes", async () => {
    const s = await setup();
    // Saved before any version: once one is in force, a Rp70.000 day pass is
    // under the W1b price floor.
    const other = await asDayPass(s);
    const build = await claimRow(s);
    const row = build();
    await insertClaim(s, row);
    const seat = await newSeat(s);
    const settings = await seedSettings(
      s.world,
      { proposer: s.actor, approver: s.approver },
      { version: 2 },
    );
    const profile = (await seedProfile(s.world.tenantId)).id;
    for (const change of [
      "seat_fee_idr = 40000, credit_idr = 30000",
      "seat_fee_idr = 50001, price_idr = 70001",
      "slot = '[2098-11-08T03:00:00Z,2098-11-08T06:00:00Z)'",
      `seat_id = '${seat.id}'`,
      `settings_version_id = '${settings}'`,
      "floor_per_hour_idr = 1",
      `product_id = '${other.productId}'`,
      `customer_profile_id = '${profile}'`,
      "kind = 'seat_reservation'",
      "access = 'off_peak'",
      "business_date = '2098-11-09'",
      `outlet_id = '${s.world.outletB}'`,
      "created_at = now() + interval '1 day'",
    ])
      await expect(
        updateClaim(s, row.id, change),
        change,
      ).rejects.toMatchObject(refused);
  });

  it("paid and refund never go down, refund never past paid", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    await confirmedClaim(s, row);
    await updateClaim(s, row.id, "status = 'cancelled'");
    await updateClaim(s, row.id, "refunded_idr = 10000");
    for (const change of [
      "paid_idr = 0",
      "paid_idr = 69999",
      "refunded_idr = 9999",
      "refunded_idr = 70001",
      "status = 'refunded'",
    ])
      await expect(
        updateClaim(s, row.id, change),
        change,
      ).rejects.toMatchObject(refused);
    await updateClaim(s, row.id, "status = 'refunded', refunded_idr = 70000");
  });

  it("paid goes from nothing straight to the price", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    const linkId = await pendingOnLink(s, row);
    await settleLink(s, linkId);
    for (const amount of [1, 69_999, 70_001])
      await expect(
        updateClaim(s, row.id, `paid_idr = ${amount}`),
        String(amount),
      ).rejects.toMatchObject({
        ...refused,
        message: expect.stringContaining("is paid straight to its price"),
      });
    await updateClaim(s, row.id, "paid_idr = price_idr");
  });

  describe("refund after the seat was used or its slot began", () => {
    const FULL = "status = 'refunded', refunded_idr = paid_idr";
    const PAST = {
      slot: "[2026-11-08T03:00:00Z,2026-11-08T05:00:00Z)",
      hold_expires_at: "2026-11-08T03:45:00Z",
    };
    const after: Record<string, string[]> = {
      checked_in: ["status = 'checked_in'"],
      no_show: ["status = 'no_show'"],
      completed: ["status = 'checked_in'", "status = 'completed'"],
    };
    type Intent = { id: string; ref: string };
    /** A provider transaction that paid the link (amount: the link total). */
    async function payIntent(
      s: Setup,
      linkId: string,
      overrides: Record<string, unknown> = {},
    ): Promise<Intent> {
      const intent = { id: randomUUID(), ref: `pay-${randomUUID()}` };
      await asTenant(s.world.tenantId, (client) =>
        insertInto(client, "payment_intents", {
          id: intent.id,
          tenant_id: s.world.tenantId,
          outlet_id: s.world.outletA,
          payment_link_id: linkId,
          method: "qris",
          provider: "doit",
          amount_idr: 70_000,
          idempotency_key: `wfc-${intent.id}`,
          provider_ref: intent.ref,
          status: "paid",
          paid_at: new Date(),
          instructions: JSON.stringify({
            method: "qris",
            qrPayload: "uji",
            issuer: null,
          }),
          expires_at: new Date(),
          ...overrides,
        }),
      );
      return intent;
    }
    /** A refund the provider itself reported on a transaction of an intent. */
    const refundOn = (
      s: Setup,
      intent: Intent,
      amount: number,
      overrides: Record<string, unknown> = {},
    ) =>
      asTenant(s.world.tenantId, (client) =>
        insertInto(client, "payment_provider_refunds", {
          tenant_id: s.world.tenantId,
          outlet_id: s.world.outletA,
          payment_intent_id: intent.id,
          provider: "doit",
          provider_refund_id: `rf-${randomUUID()}`,
          provider_payment_ref: intent.ref,
          amount_idr: amount,
          source: "refund_webhook",
          ...overrides,
        }),
      );
    /** A second payment of an intent, held as unallocated money. */
    const unallocatedOn = (s: Setup, intent: Intent) =>
      asTenant(s.world.tenantId, (client) =>
        insertInto(client, "payment_unallocated_funds", {
          tenant_id: s.world.tenantId,
          outlet_id: s.world.outletA,
          payment_intent_id: intent.id,
          amount_idr: 70_000,
          reason: "double_payment",
        }),
      );
    const providerRefund = async (s: Setup, linkId: string, amount: number) =>
      refundOn(s, await payIntent(s, linkId), amount);

    it.each(Object.keys(after))("%s gives no money back", async (status) => {
      const s = await setup();
      const build = await claimRow(s);
      const row = build();
      const linkId = await confirmedClaim(s, row);
      for (const step of after[status]!) await updateClaim(s, row.id, step);
      const refuse = async (label: string) => {
        for (const change of ["refunded_idr = 1", FULL])
          await expect(
            updateClaim(s, row.id, change),
            `${label}: ${change}`,
          ).rejects.toMatchObject(refused);
      };
      await refuse("no provider refund");
      // Another link's refund does not count.
      await providerRefund(s, await seedLink(s), 70_000);
      await refuse("another link");
      // Refunded in steps on the settling transaction: one rupiah short is not
      // enough, the full total is.
      const settling = await payIntent(s, linkId);
      await refundOn(s, settling, 50_000);
      await refundOn(s, settling, 19_999);
      await refuse("one rupiah short");
      await refundOn(s, settling, 1);
      await updateClaim(s, row.id, FULL);
    });

    it("a refund of a double payment is not the refund of the seat", async () => {
      const s = await setup();
      const build = await claimRow(s);
      const cases: Record<string, (linkId: string) => Promise<void>> = {
        "a second intent paid twice": async (linkId) => {
          await payIntent(s, linkId);
          const second = await payIntent(s, linkId);
          await unallocatedOn(s, second);
          await refundOn(s, second, 70_000);
        },
        "a second transaction of the same intent": async (linkId) => {
          const intent = await payIntent(s, linkId);
          await unallocatedOn(s, intent);
          await refundOn(s, intent, 70_000);
        },
        "refunds split over two intents": async (linkId) => {
          await refundOn(s, await payIntent(s, linkId), 35_000);
          await refundOn(s, await payIntent(s, linkId), 35_000);
        },
        "another transaction reference": async (linkId) => {
          await refundOn(s, await payIntent(s, linkId), 70_000, {
            provider_payment_ref: `pay-${randomUUID()}`,
          });
        },
        "another provider": async (linkId) => {
          await refundOn(s, await payIntent(s, linkId), 70_000, {
            provider: "duitku",
          });
        },
        "an intent below the total": async (linkId) => {
          await refundOn(
            s,
            await payIntent(s, linkId, { amount_idr: 69_999 }),
            70_000,
          );
        },
        "an intent never paid": async (linkId) => {
          await refundOn(
            s,
            await payIntent(s, linkId, { paid_at: null, status: "pending" }),
            70_000,
          );
        },
        "an intent without a provider reference": async (linkId) => {
          await refundOn(
            s,
            await payIntent(s, linkId, { provider_ref: null }),
            70_000,
          );
        },
      };
      for (const [label, arrange] of Object.entries(cases)) {
        const row = build();
        const linkId = await confirmedClaim(s, row);
        await updateClaim(s, row.id, "status = 'no_show'");
        await arrange(linkId);
        await expect(updateClaim(s, row.id, FULL), label).rejects.toMatchObject(
          refused,
        );
      }
    });

    it("a step that uses the seat never carries a refund", async () => {
      const s = await setup();
      const build = await claimRow(s);
      const row = build();
      await confirmedClaim(s, row);
      await expect(
        updateClaim(s, row.id, "status = 'no_show', refunded_idr = 1"),
      ).rejects.toMatchObject(refused);
      await updateClaim(s, row.id, "status = 'checked_in'");
      await expect(
        updateClaim(s, row.id, "status = 'completed', refunded_idr = 1"),
      ).rejects.toMatchObject(refused);
    });

    it("the total of the link counts, tax included", async () => {
      const s = await setup();
      const build = await claimRow(s);
      const row = build();
      const linkId = await pendingOnLink(s, row, {
        tax_idr: 7_000,
        total_idr: 77_000,
      });
      await settleLink(s, linkId);
      await updateClaim(s, row.id, CONFIRM);
      await updateClaim(s, row.id, "status = 'no_show'");
      const intent = await payIntent(s, linkId, { amount_idr: 77_000 });
      await refundOn(s, intent, 70_000);
      await expect(updateClaim(s, row.id, FULL)).rejects.toMatchObject(refused);
      await refundOn(s, intent, 7_000);
      await updateClaim(s, row.id, FULL);
    });

    it("confirmed is cancelled or refunded only before its slot", async () => {
      const s = await setup();
      const build = await claimRow(s);
      const future = build();
      await confirmedClaim(s, future);
      await updateClaim(s, future.id, "status = 'cancelled'");
      await updateClaim(s, future.id, FULL);
      const direct = build();
      await confirmedClaim(s, direct);
      await updateClaim(s, direct.id, FULL);

      const begun = build(PAST);
      const linkId = await confirmedClaim(s, begun);
      for (const change of [
        "status = 'cancelled'",
        "status = 'cancelled', refunded_idr = paid_idr",
        FULL,
      ])
        await expect(
          updateClaim(s, begun.id, change),
          change,
        ).rejects.toMatchObject(refused);
      await providerRefund(s, linkId, 70_000);
      await updateClaim(s, begun.id, FULL);
      // An unpaid hold is still released after its slot began.
      const held = build(PAST);
      await insertClaim(s, held);
      await updateClaim(
        s,
        held.id,
        "status = 'cancelled', hold_expires_at = NULL",
      );
    });
  });

  it("only legal status steps; a closed claim never comes back", async () => {
    const s = await setup();
    const build = await claimRow(s);
    let hour = 0;
    const next = () => {
      hour += 1;
      const at = (h: number) => `2098-11-${String(10 + h)}T01:00:00Z`;
      return build({
        slot: `[${at(hour)},${at(hour).replace("T01", "T02")})`,
      });
    };
    const reach: Record<string, string[]> = {
      pending_payment: [],
      cancelled: ["status = 'cancelled', hold_expires_at = NULL"],
      confirmed: [CONFIRM],
      checked_in: [CONFIRM, "status = 'checked_in'"],
      no_show: [CONFIRM, "status = 'no_show'"],
      completed: [CONFIRM, "status = 'checked_in'", "status = 'completed'"],
      refunded: [CONFIRM, "status = 'refunded', refunded_idr = paid_idr"],
    };
    const illegal: Record<string, string[]> = {
      pending_payment: ["checked_in", "completed", "no_show", "refunded"],
      cancelled: ["pending_payment", "confirmed", "checked_in", "no_show"],
      confirmed: ["pending_payment", "completed"],
      checked_in: ["pending_payment", "confirmed", "no_show", "cancelled"],
      no_show: ["pending_payment", "confirmed", "checked_in", "completed"],
      completed: ["pending_payment", "confirmed", "checked_in", "cancelled"],
      refunded: ["confirmed", "checked_in", "cancelled", "completed"],
    };
    for (const [from, targets] of Object.entries(illegal)) {
      const row = next();
      const linkId = await pendingOnLink(s, row);
      await settleLink(s, linkId);
      for (const step of reach[from]!) await updateClaim(s, row.id, step);
      for (const to of targets)
        await expect(
          updateClaim(
            s,
            row.id,
            `status = '${to}', paid_idr = price_idr, hold_expires_at = ${to === "pending_payment" ? "now()" : "NULL"}`,
          ),
          `${from} -> ${to}`,
        ).rejects.toMatchObject(refused);
    }
  });
});

describe("review 4: a claim copies its live product, seat and zone", () => {
  it("refuses another split, kind, access, length or a dead product", async () => {
    const s = await setup();
    const build = await claimRow(s);
    for (const bad of [
      { seat_fee_idr: 40_000, credit_idr: 30_000 },
      { seat_fee_idr: 10_000, credit_idr: 10_000, price_idr: 20_000 },
      { kind: "seat_reservation" },
      { access: "off_peak" },
    ])
      await expect(
        insertClaim(s, build(bad)),
        JSON.stringify(bad),
      ).rejects.toMatchObject(refused);
    const plain = await seedProduct(s.world, s.facilityId);
    await expect(
      insertClaim(s, build({ product_id: plain })),
    ).rejects.toMatchObject(refused);
    const row = build();
    await asTenant(s.world.tenantId, (client) =>
      client.query(
        "UPDATE facility_products SET is_active = false WHERE id = $1",
        [row.product_id],
      ),
    );
    await expect(insertClaim(s, row)).rejects.toMatchObject(refused);
  });

  it("a seat reservation lasts exactly the product duration", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const productId = await seedProduct(s.world, s.facilityId);
    await setWfcProduct(s.world.context, s.actor, {
      productId,
      wfc: {
        kind: "seat_reservation",
        access: "all_day",
        seatFeeIdr: 50_000,
        creditIdr: 20_000,
        durationMinutes: 60,
      },
      expectedUpdatedAt: await stampOf(s, productId),
    });
    await switchOn(s, productId);
    const row = (end: string) =>
      build({
        product_id: productId,
        kind: "seat_reservation",
        slot: `[2098-11-08T03:00:00Z,2098-11-08T${end}Z)`,
      });
    for (const end of ["03:59:00", "04:01:00", "05:00:00"])
      await expect(insertClaim(s, row(end)), end).rejects.toMatchObject(
        refused,
      );
    await insertClaim(s, row("04:00:00"));
  });

  it("refuses a switched-off seat and a zone that is not open WFC", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    await setWfcSeatStatus(s.world.context, s.actor, {
      seatId: row.seat_id,
      status: "inactive",
    });
    await expect(insertClaim(s, row)).rejects.toMatchObject(refused);
    await setWfcSeatStatus(s.world.context, s.actor, {
      seatId: row.seat_id,
      status: "active",
    });
    for (const change of ["is_wfc = false", "status = 'inactive'"]) {
      await asTenant(s.world.tenantId, (client) =>
        client.query(`UPDATE floor_zones SET ${change} WHERE id = $1`, [
          s.zoneId,
        ]),
      );
      await expect(insertClaim(s, row), change).rejects.toMatchObject(refused);
      await asTenant(s.world.tenantId, (client) =>
        client.query(
          "UPDATE floor_zones SET is_wfc = true, status = 'active' WHERE id = $1",
          [s.zoneId],
        ),
      );
    }
    await insertClaim(s, row);
  });

  it("claim and seat switch race: never a live claim on a dead seat", async () => {
    for (let round = 0; round < 8; round++) {
      const s = await setup();
      const build = await claimRow(s);
      const row = build({
        slot: "[2099-01-01T03:00:00Z,2099-01-01T05:00:00Z)",
        hold_expires_at: "2099-01-01T03:00:00Z",
      });
      const [claim, off] = await Promise.allSettled([
        insertClaim(s, row),
        setWfcSeatStatus(s.world.context, s.actor, {
          seatId: row.seat_id,
          status: "inactive",
        }),
      ]);
      expect([claim.status, off.status].sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
    }
  });

  it("a claim in flight blocks the seat switch, a switch in flight the claim", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [s.world.tenantId],
      );
      await client.query(
        "UPDATE wfc_seats SET status = 'inactive' WHERE id = $1",
        [row.seat_id],
      );
      const claim = insertClaim(s, row).then(
        () => "inserted",
        (error: { code?: string }) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await client.query("COMMIT");
      expect(await claim).toBe("23514");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("review 4: a WFC product is never a promo reward", () => {
  const benefitOf = (productId: string) => ({
    kind: "facility_entitlement" as const,
    facilityProductId: productId,
    quantity: 1,
  });

  it("the guard names only WFC products of the tenant", async () => {
    const s = await setup();
    const other = await setup();
    const { productId } = await asDayPass(s);
    const plain = await seedProduct(s.world, s.facilityId);
    const ids = (setupOf: Setup, list: string[]) =>
      withTenant(db, setupOf.world.context, (tx) =>
        wfcProductIds(tx, setupOf.world.context.tenant.tenantId, list),
      );
    expect([...(await ids(s, [productId, plain]))]).toEqual([productId]);
    expect((await ids(other, [productId])).size).toBe(0);
    expect((await ids(s, [])).size).toBe(0);
  });

  const promo = (productId: string, patch: Record<string, unknown> = {}) =>
    ({
      name: `Promo ${short()}`,
      description: "",
      status: "draft",
      codeHash: null,
      voucherRequired: false,
      startsAt: new Date().toISOString(),
      endsAt: null,
      conditions: [],
      benefit: benefitOf(productId),
      stackGroup: "uji",
      stackable: true,
      priority: 0,
      quotaTotal: null,
      quotaPerCustomer: null,
      budgetIdr: null,
      ...patch,
    }) as unknown as Parameters<typeof createPromotion>[2];
  const notReward = { status: 409, code: "WFC_PRODUCT_NOT_REWARD" };

  it("cannot be saved as a reward, draft included", async () => {
    const s = await setup();
    const { productId } = await asDayPass(s);
    const marketer = await seedActor(s.world.tenantId, ["promo.manage"]);
    for (const status of ["draft", "active"])
      expect(
        await failure(
          createPromotion(
            s.world.context,
            marketer,
            promo(productId, { status }),
          ),
        ),
        status,
      ).toMatchObject(notReward);
    const plain = await seedProduct(s.world, s.facilityId);
    const saved = await createPromotion(
      s.world.context,
      marketer,
      promo(plain),
    );
    expect(
      await failure(
        updatePromotion(s.world.context, marketer, saved.id, {
          benefit: benefitOf(productId),
        } as never),
      ),
    ).toMatchObject(notReward);
  });

  it("a promotion from before the product became WFC can only be switched off", async () => {
    const s = await setup();
    const marketer = await seedActor(s.world.tenantId, ["promo.manage"]);
    const productId = await seedProduct(s.world, s.facilityId);
    const { productId: otherWfc } = await asDayPass(s);
    const old = await createPromotion(
      s.world.context,
      marketer,
      promo(productId, { status: "active" }),
    );
    await setWfcProduct(s.world.context, s.actor, {
      productId,
      wfc: {
        kind: "day_pass",
        access: "all_day",
        seatFeeIdr: 50_000,
        creditIdr: 20_000,
        durationMinutes: null,
      },
      expectedUpdatedAt: await stampOf(s, productId),
    });
    const set = (patch: Record<string, unknown>) =>
      updatePromotion(s.world.context, marketer, old.id, patch as never);
    for (const patch of [
      { name: "Masih aktif" },
      { status: "paused", benefit: benefitOf(otherWfc) },
      {
        status: "paused",
        benefit: { ...benefitOf(productId), quantity: 2 },
      },
    ])
      expect(await failure(set(patch)), JSON.stringify(patch)).toMatchObject(
        notReward,
      );
    expect((await set({ status: "paused" })).status).toBe("paused");
    expect(await failure(set({ status: "active" }))).toMatchObject(notReward);
    expect((await set({ status: "ended" })).status).toBe("ended");
  });
});

describe("review 5: a zone keeps its WFC seats", () => {
  async function held() {
    const s = await setup();
    const build = await claimRow(s);
    const row = build({
      slot: "[2099-01-01T03:00:00Z,2099-01-01T05:00:00Z)",
      hold_expires_at: "2099-01-01T03:00:00Z",
    });
    await insertClaim(s, row);
    return { s, row };
  }
  const change = (s: Setup, patch: Record<string, unknown>) =>
    updateFloorZone(s.world.context, s.zoneId, patch as never, s.actor);

  it("a live claim blocks is_wfc off and inactive, not a rename", async () => {
    const { s, row } = await held();
    for (const patch of [{ isWfc: false }, { status: "inactive" }])
      expect(await failure(change(s, patch))).toMatchObject({
        status: 409,
        code: "WFC_ZONE_IN_USE",
      });
    await change(s, { name: "Nama baru", isWfc: true, status: "active" });
    await updateClaim(
      s,
      row.id,
      "status = 'cancelled', hold_expires_at = NULL",
    );
    await change(s, { isWfc: false });
  });

  it("a quota above the seats left blocks it too", async () => {
    const s = await setup();
    await seedSettings(s.world, { proposer: s.actor, approver: s.approver });
    await newSeat(s);
    const put = (seats: number) =>
      putWfcHourlyQuotas(s.world.context, s.actor, {
        outletId: s.world.outletA,
        quotas: [{ dayOfWeek: 1, hour: 9, seats }],
      });
    await put(1);
    for (const patch of [{ isWfc: false }, { status: "inactive" }])
      expect(await failure(change(s, patch))).toMatchObject({
        status: 409,
        code: "WFC_ZONE_IN_USE",
      });
    await put(0);
    await change(s, { status: "inactive" });
  });

  it("a zone with a seat cannot be deleted; a bare zone can", async () => {
    const s = await setup();
    const bare = await seedZone(s.world);
    await newSeat(s);
    expect(
      await failure(deleteFloorZone(s.world.context, s.zoneId, s.actor)),
    ).toMatchObject({ status: 409, code: "WFC_ZONE_IN_USE" });
    await deleteFloorZone(s.world.context, bare, s.actor);
  });

  it("quota and zone switch race: the quota never exceeds the seats", async () => {
    for (let round = 0; round < 5; round++) {
      const s = await setup();
      await seedSettings(s.world, { proposer: s.actor, approver: s.approver });
      await newSeat(s);
      const results = await Promise.allSettled([
        putWfcHourlyQuotas(s.world.context, s.actor, {
          outletId: s.world.outletA,
          quotas: [{ dayOfWeek: 1, hour: 9, seats: 1 }],
        }),
        change(s, { isWfc: false }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
    }
  });

  it("a zone switch waits for a claim in flight, then refuses", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const row = build({
      slot: "[2099-01-01T03:00:00Z,2099-01-01T05:00:00Z)",
      hold_expires_at: "2099-01-01T03:00:00Z",
    });
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [s.world.tenantId],
      );
      await insertInto(client, "wfc_seat_reservations", row);
      const off = failure(change(s, { isWfc: false }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await client.query("COMMIT");
      expect(await off).toMatchObject({ status: 409, code: "WFC_ZONE_IN_USE" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("claim and zone switch race: exactly one wins", async () => {
    for (let round = 0; round < 8; round++) {
      const s = await setup();
      const build = await claimRow(s);
      const row = build({
        slot: "[2099-01-01T03:00:00Z,2099-01-01T05:00:00Z)",
        hold_expires_at: "2099-01-01T03:00:00Z",
      });
      const results = await Promise.allSettled([
        insertClaim(s, row),
        change(s, { isWfc: false }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
    }
  });
});

describe("settings versions", () => {
  it("need a second person, every number, and a sane range", async () => {
    const s = await setup();
    const actors = { proposer: s.actor, approver: s.approver };
    for (const bad of [
      { wfc_seats: 61 },
      { wfc_seats: 0 },
      { fixed_cost_idr: 0 },
      { target_revenue_idr: 0 },
      { target_profit_idr: -1 },
      { target_occupancy_bp: 0 },
      { target_occupancy_bp: 10_001 },
      { cogs_bp: 10_000 },
      { spend_per_person_idr: 0 },
      { avg_stay_minutes: 0 },
      { open_hours_per_month: 745 },
      { version: 0 },
    ])
      await expect(
        seedSettings(s.world, actors, bad),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: "23514" });
    for (const column of [
      "avg_stay_minutes",
      "fixed_cost_idr",
      "cogs_bp",
      "wfc_seats",
      "approved_by",
      "approval_request_id",
    ])
      await expect(
        seedSettings(s.world, actors, { [column]: null }),
        column,
      ).rejects.toMatchObject({ code: expect.stringMatching(/^235(02|14)$/) });
    await seedSettings(s.world, actors);
    await expect(seedSettings(s.world, actors)).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describe("review 3: a settings version carries its own approval", () => {
  it("must match proposer, approver, outlet, purpose and a final approval", async () => {
    const s = await setup();
    const actors = { proposer: s.actor, approver: s.approver };
    const third = await seedActor(s.world.tenantId);
    const pending = {
      status: "pending",
      decided_by: null,
      decided_at: null,
      reason: null,
    };
    const bad: Record<string, Record<string, unknown>> = {
      proposer: { requested_by: third },
      approver: { decided_by: third },
      rejected: { status: "rejected" },
      pending,
      "first of two levels": { required_levels: 2 },
      outlet: { outlet_id: s.world.outletB },
      "tenant-wide": { outlet_id: null },
      purpose: { object_type: "order" },
    };
    const attempt = async (
      overrides: Record<string, unknown>,
      people: Actors = actors,
    ) => {
      const row = settingsRow(s.world, people);
      return seedSettings(s.world, people, {
        id: row.id,
        approval_request_id: await seedApproval(
          s.world,
          actors,
          row,
          overrides,
        ),
      });
    };
    for (const [label, overrides] of Object.entries(bad))
      await expect(attempt(overrides), label).rejects.toMatchObject(refused);
    await expect(
      seedSettings(s.world, actors, { approval_request_id: randomUUID() }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
    // One person on both sides.
    await expect(
      attempt({}, { proposer: s.actor, approver: s.actor }),
    ).rejects.toMatchObject(refused);
    await attempt({});
  });

  it("must be the request of this very version: module, object and every number", async () => {
    const s = await setup();
    const actors = { proposer: s.actor, approver: s.approver };
    const attempt = async (
      change: (
        row: Record<string, unknown>,
        payload: Record<string, unknown>,
      ) => Record<string, unknown>,
    ) => {
      const row = settingsRow(s.world, actors);
      return seedSettings(s.world, actors, {
        id: row.id,
        approval_request_id: await seedApproval(
          s.world,
          actors,
          row,
          change(row, payloadOf(row)),
        ),
      });
    };
    await expect(
      attempt(() => ({ source_module: "inbox" })),
      "inbox",
    ).rejects.toMatchObject(refused);
    await expect(
      attempt(() => ({ object_id: randomUUID() })),
      "another version",
    ).rejects.toMatchObject(refused);
    await expect(
      attempt(() => ({ payload: "{}" })),
      "empty",
    ).rejects.toMatchObject(refused);
    for (const key of Object.keys(payloadOf(SETTINGS))) {
      for (const [label, value] of [
        ["other", key === "effectiveFrom" ? "2026-01-02" : 7_777_777],
        ["null", null],
        ["text", "7"],
      ] as const)
        await expect(
          attempt((_, payload) => ({
            payload: JSON.stringify({ ...payload, [key]: value }),
          })),
          `${key} ${label}`,
        ).rejects.toMatchObject(refused);
      await expect(
        attempt((_, payload) => {
          const rest: Record<string, unknown> = { ...payload };
          delete rest[key];
          return { payload: JSON.stringify(rest) };
        }),
        `${key} missing`,
      ).rejects.toMatchObject(refused);
    }
    // Further fields (who it is for, a note) do not matter.
    await attempt((_, payload) => ({
      payload: JSON.stringify({ ...payload, note: "uji" }),
    }));
  });

  it("one approval covers one version", async () => {
    const s = await setup();
    const actors = { proposer: s.actor, approver: s.approver };
    const first = settingsRow(s.world, actors);
    const approval = await seedApproval(s.world, actors, first);
    const again = () =>
      seedSettings(s.world, actors, {
        id: first.id,
        approval_request_id: approval,
      });
    await again();
    await expect(again()).rejects.toMatchObject({ code: "23505" });
    await expect(
      seedSettings(s.world, actors, {
        version: 2,
        approval_request_id: approval,
      }),
    ).rejects.toMatchObject(refused);
  });
});

describe("sales gate", () => {
  const gate = (s: Setup, outletId: string = s.world.outletA) =>
    withTenant(db, s.world.context, (tx) =>
      assertWfcSalesOpen(tx, s.world.context, outletId, NOW),
    );

  it("is off by default and stays off for anything but true", async () => {
    const s = await setup();
    // The value the process started with, before this suite touched it.
    expect(process.env.WFC_SALES_ENABLED).toBeUndefined();
    expect(was).toBe(false);
    flag.WFC_SALES_ENABLED = was;
    expect(wfcSalesEnabled()).toBe(false);
    for (const value of [undefined, "true", 1]) {
      flag.WFC_SALES_ENABLED = value as never;
      expect(wfcSalesEnabled()).toBe(false);
    }
    flag.WFC_SALES_ENABLED = false;
    expect(await failure(gate(s))).toMatchObject({
      status: 403,
      code: "WFC_SALES_DISABLED",
    });
  });

  it("stays closed until settings, seats and quota are all there", async () => {
    const s = await setup();
    flag.WFC_SALES_ENABLED = true;
    const incomplete = { status: 409, code: "WFC_CONFIG_INCOMPLETE" };
    const actors = { proposer: s.actor, approver: s.approver };
    expect(await failure(gate(s))).toMatchObject(incomplete);
    await newSeat(s);
    await putWfcHourlyQuotas(s.world.context, s.actor, {
      outletId: s.world.outletA,
      quotas: [{ dayOfWeek: 0, hour: 9, seats: 0 }],
    });
    // A future version does not open the sale.
    await seedSettings(s.world, actors, { effective_from: "2026-11-09" });
    expect(await failure(gate(s))).toMatchObject(incomplete);
    const first = await seedSettings(s.world, actors, { version: 2 });
    // Every cell zero is still closed.
    expect(await failure(gate(s))).toMatchObject(incomplete);
    await putWfcHourlyQuotas(s.world.context, s.actor, {
      outletId: s.world.outletA,
      quotas: [{ dayOfWeek: 0, hour: 9, seats: 1 }],
    });
    expect((await gate(s)).id).toBe(first);
    const newer = await seedSettings(s.world, actors, { version: 3 });
    expect((await gate(s)).id).toBe(newer);
    // 02:00 on the 9th is still the business day of the 8th (cutoff 04:00): the
    // version of the 9th is not in force yet.
    const night = await withTenant(db, s.world.context, (tx) =>
      assertWfcSalesOpen(
        tx,
        s.world.context,
        s.world.outletA,
        new Date("2026-11-08T19:00:00Z"),
      ),
    );
    expect(night.id).toBe(newer);
    // Another outlet of the same tenant is not opened by this one.
    expect(await failure(gate(s, s.world.outletB))).toMatchObject(incomplete);
    flag.WFC_SALES_ENABLED = false;
    expect(await failure(gate(s))).toMatchObject({
      code: "WFC_SALES_DISABLED",
    });
  });
});
