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

async function seedSettings(
  world: World,
  actors: { proposer: string; approver: string },
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const row: Record<string, unknown> = {
    id: randomUUID(),
    tenant_id: world.tenantId,
    outlet_id: world.outletA,
    ...SETTINGS,
    proposed_by: actors.proposer,
    approved_by: actors.approver,
    ...overrides,
  };
  const names = Object.keys(row);
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO wfc_business_settings (${names.join(", ")})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row),
    ),
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

async function claimRow(s: Setup) {
  const seat = await newSeat(s);
  const product = await asDayPass(s);
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
    business_date: "2026-11-08",
    slot: "[2026-11-08T03:00:00Z,2026-11-08T05:00:00Z)",
    status: "pending_payment",
    seat_fee_idr: 50_000,
    credit_idr: 20_000,
    price_idr: 70_000,
    settings_version_id: settingsId,
    floor_per_hour_idr: 12_000,
    hold_expires_at: "2026-11-08T03:45:00Z",
    ...overrides,
  });
}

async function insertClaim(s: Setup, row: Record<string, unknown>) {
  const names = Object.keys(row);
  await asTenant(s.world.tenantId, (client) =>
    client.query(
      `INSERT INTO wfc_seat_reservations (${names.join(", ")})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row),
    ),
  );
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

describe("seat claims", () => {
  it("one seat is never held twice; a released claim frees it", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const first = build();
    await insertClaim(s, first);
    await expect(insertClaim(s, build())).rejects.toMatchObject({
      code: "23P01",
    });
    // Back-to-back is legal.
    await insertClaim(
      s,
      build({ slot: "[2026-11-08T05:00:00Z,2026-11-08T06:00:00Z)" }),
    );
    for (const status of ["cancelled", "no_show"]) {
      const paid = status === "no_show";
      const linkId = paid ? await seedLink(s) : null;
      await asTenant(s.world.tenantId, (client) =>
        client.query(
          `UPDATE wfc_seat_reservations
              SET status = $2::text, paid_idr = $3, payment_link_id = $4, hold_expires_at = NULL
            WHERE id = $1`,
          [first.id, status, paid ? 70_000 : 0, linkId],
        ),
      );
      const next = build();
      await insertClaim(s, next);
      first.id = next.id;
    }
  });

  it("is issued only when fully paid, and the split always adds up", async () => {
    const s = await setup();
    const build = await claimRow(s);
    const linkId = await seedLink(s);
    const paid = {
      status: "confirmed",
      paid_idr: 70_000,
      payment_link_id: linkId,
      hold_expires_at: null,
    };
    for (const bad of [
      { ...paid, paid_idr: 69_999 },
      { ...paid, payment_link_id: null },
      { ...paid, paid_idr: 70_001 },
      { ...paid, refunded_idr: 70_001 },
      { ...paid, status: "refunded", refunded_idr: 69_999 },
      { price_idr: 70_001 },
      { hold_expires_at: null },
      { credit_idr: 0, price_idr: 50_000 },
      { floor_per_hour_idr: 0 },
      { slot: "[2026-11-08T03:00:00Z,2026-11-08T05:00:00Z]" },
      { kind: "bundle" },
      { access: "peak" },
    ])
      await expect(
        insertClaim(s, build(bad)),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: "23514" });
    // No start or no end: the generated NOT NULL instants refuse it.
    for (const slot of ["empty", "[2026-11-08T03:00:00Z,)"])
      await expect(insertClaim(s, build({ slot }))).rejects.toMatchObject({
        code: "23502",
      });
    await insertClaim(s, build(paid));
    // One payment link funds one claim.
    await expect(
      insertClaim(
        s,
        build({
          ...paid,
          slot: "[2026-11-08T07:00:00Z,2026-11-08T08:00:00Z)",
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("never points at a seat of another outlet", async () => {
    const s = await setup();
    const build = await claimRow(s);
    await expect(
      insertClaim(s, build({ outlet_id: s.world.outletB })),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

async function seedLink(s: Setup): Promise<string> {
  const id = randomUUID();
  await asTenant(s.world.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, 70000, 70000, 70000, 'wfc-schema-test')`,
      [
        id,
        s.world.tenantId,
        s.world.outletA,
        randomUUID().replaceAll("-", "").repeat(2),
        `wfc-${short()}`,
      ],
    ),
  );
  return id;
}

describe("settings versions", () => {
  it("need a second person, every number, and a sane range", async () => {
    const s = await setup();
    const actors = { proposer: s.actor, approver: s.approver };
    for (const bad of [
      { approved_by: s.actor },
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
    ])
      await expect(
        seedSettings(s.world, actors, { [column]: null }),
        column,
      ).rejects.toMatchObject({ code: "23502" });
    await seedSettings(s.world, actors);
    await expect(seedSettings(s.world, actors)).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describe("sales gate", () => {
  const gate = (s: Setup, outletId: string = s.world.outletA) =>
    withTenant(db, s.world.context, (tx) =>
      assertWfcSalesOpen(tx, s.world.context, outletId, NOW),
    );

  it("is off by default and stays off for anything but true", async () => {
    const s = await setup();
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
    // Another outlet of the same tenant is not opened by this one.
    expect(await failure(gate(s, s.world.outletB))).toMatchObject(incomplete);
    flag.WFC_SALES_ENABLED = false;
    expect(await failure(gate(s))).toMatchObject({
      code: "WFC_SALES_DISABLED",
    });
  });
});
