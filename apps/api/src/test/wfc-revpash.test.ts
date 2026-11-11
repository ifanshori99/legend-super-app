// legend-bz9h (Area C, F39/F25, FAC-14): WFC RevPASH report against PostgreSQL
// with the restricted app role (RLS enforced). Money rule M7: revenue is paid
// money only (completed orders, captured tenders, never points), refunds
// subtract, an order never counts below 0, and the rounding is half DOWN so the
// report never claims more than was earned.
//
// Assumptions: hour buckets are UTC-aligned (Jakarta is whole hours ahead);
// every zone of the outlet gets a row per hour of the range, `revpashIdr` is
// null for a zone with no active seat; the report needs
// `facility.config.manage` on the outlet.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { getRevpash } from "../services/wfc-revpash.service.ts";
import { roundHalfDown } from "../services/wfc-revpash.service.ts";
import {
  asTenant,
  createWorld,
  owner,
  short,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const MIN = 60_000;
/** Monday 2026-11-02 12:00 Jakarta = 05:00Z, on the hour. */
const T0 = Date.parse("2026-11-02T05:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN);
const FROM = at(0).toISOString();
const TO = at(120).toISOString();

async function seedActor(
  tenantId: string,
  permissions: string[] = ["facility.config.manage"],
): Promise<string> {
  const userId = randomUUID();
  const roleId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "WFC revpash test", `${userId}@example.com`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
    [
      roleId,
      tenantId,
      `WFC revpash ${roleId.slice(0, 8)}`,
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

async function seedZone(
  world: World,
  seats: { active: number; inactive?: number },
) {
  const zoneId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [zoneId, world.tenantId, world.outletA, `Zona WFC ${short()}`],
    );
    const statuses = [
      ...Array.from({ length: seats.active }, () => "active"),
      ...Array.from({ length: seats.inactive ?? 0 }, () => "inactive"),
    ];
    for (const [index, status] of statuses.entries())
      await client.query(
        `INSERT INTO wfc_seats (id, tenant_id, outlet_id, zone_id, code, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          world.tenantId,
          world.outletA,
          zoneId,
          `S${index}`,
          status,
          at(-600),
        ],
      );
  });
  return zoneId;
}

async function seedSession(world: World, zoneId: string): Promise<string> {
  const tableId = randomUUID();
  const sessionId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout)
       VALUES ($1, $2, $3, $4, $5, 4, 'regular', '{"x":1,"y":1,"width":20,"height":20,"rotation":0,"shape":"rect"}'::jsonb)`,
      [
        tableId,
        world.tenantId,
        world.outletA,
        zoneId,
        `W-${short()}`.toUpperCase(),
      ],
    );
    await client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
         session_token_hash, session_token_sealed, opened_at)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed', $6)`,
      [
        sessionId,
        world.tenantId,
        world.outletA,
        tableId,
        randomBytes(32).toString("hex"),
        at(-30),
      ],
    );
  });
  return sessionId;
}

type Sale = {
  amountIdr: number;
  minutes?: number;
  method?: "cash" | "qris" | "points";
  orderStatus?: "completed" | "draft";
  tenderStatus?: "captured" | "authorized";
};

async function seedSale(
  world: World,
  sessionId: string,
  sale: Sale,
): Promise<string> {
  const orderId = ulidToUuid(createUlid());
  const paidAt = at(sale.minutes ?? 30);
  const method = sale.method ?? "cash";
  const orderStatus = sale.orderStatus ?? "completed";
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5,
               $6, '2026-11-02', $7, $8)`,
      [
        orderId,
        world.tenantId,
        world.outletA,
        `RV-${short()}`.toUpperCase(),
        sale.amountIdr,
        orderStatus,
        paidAt,
        sessionId,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', $4, $5)`,
      [
        orderId,
        world.tenantId,
        world.outletA,
        paidAt,
        orderStatus === "completed" ? paidAt : null,
      ],
    );
    const cash = method === "cash";
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, points_used, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text, $11, CASE WHEN $10::text = 'authorized' THEN NULL ELSE $11::timestamptz END)`,
      [
        world.tenantId,
        world.outletA,
        orderId,
        method,
        cash ? "manual" : "doit",
        sale.amountIdr,
        cash ? sale.amountIdr : null,
        cash ? 0 : null,
        method === "points" ? sale.amountIdr : null,
        sale.tenderStatus ?? "captured",
        paidAt,
      ],
    );
  });
  return orderId;
}

async function seedPosRefund(world: World, orderId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO pos_order_refunds (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
        lines, requested_by, approved_by, approval_request_id, refunded_at)
     VALUES ($1, $2, $3, $4, 'customer_cancelled', 'Uji', $5::jsonb,
             'kasir-uji', 'supervisor-uji', $6, $7)`,
    [
      world.tenantId,
      world.outletA,
      orderId,
      amountIdr,
      JSON.stringify([{ method: "cash", amountIdr, reference: null }]),
      randomUUID(),
      at(45),
    ],
  );
}

async function report(world: World, actor: string, zoneId?: string) {
  return getRevpash(world.context, actor, {
    outletId: world.outletA,
    ...(zoneId ? { zoneId } : {}),
    from: FROM,
    to: TO,
  });
}

const firstHour = (rows: Awaited<ReturnType<typeof report>>) => rows[0]!;

describe("roundHalfDown", () => {
  it("rounds .5 down and never up", () => {
    expect(roundHalfDown(1, 2)).toBe(0);
    expect(roundHalfDown(3, 2)).toBe(1);
    expect(roundHalfDown(25_001, 2)).toBe(12_500);
    expect(roundHalfDown(10_000, 3)).toBe(3_333);
    expect(roundHalfDown(20_000, 3)).toBe(6_667);
    expect(roundHalfDown(0, 5)).toBe(0);
  });
});

describe("RevPASH per zone and hour", () => {
  it("divides paid revenue by seat hours and rounds half down", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId);
    const zoneId = await seedZone(world, { active: 2 });
    const sessionId = await seedSession(world, zoneId);
    await seedSale(world, sessionId, { amountIdr: 25_001 });

    const rows = await report(world, actor, zoneId);

    expect(rows).toHaveLength(2);
    expect(firstHour(rows)).toEqual({
      zoneId,
      hourStart: at(0).toISOString(),
      revenueIdr: 25_001,
      seatHours: 2,
      revpashIdr: 12_500,
    });
    expect(rows[1]).toMatchObject({
      revenueIdr: 0,
      seatHours: 2,
      revpashIdr: 0,
    });
  });

  it("puts a sale in the hour it was paid", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId);
    const zoneId = await seedZone(world, { active: 1 });
    const sessionId = await seedSession(world, zoneId);
    await seedSale(world, sessionId, { amountIdr: 40_000, minutes: 75 });

    const rows = await report(world, actor, zoneId);

    expect(rows.map((row) => row.revenueIdr)).toEqual([0, 40_000]);
  });

  it("returns null, not 0, for a zone with no active seat", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId);
    const zoneId = await seedZone(world, { active: 0, inactive: 2 });
    const sessionId = await seedSession(world, zoneId);
    await seedSale(world, sessionId, { amountIdr: 30_000 });

    const rows = await report(world, actor, zoneId);

    expect(firstHour(rows)).toMatchObject({
      revenueIdr: 30_000,
      seatHours: 0,
      revpashIdr: null,
    });
  });

  it("does not count inactive seats", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId);
    const zoneId = await seedZone(world, { active: 3, inactive: 2 });

    const rows = await report(world, actor, zoneId);

    expect(firstHour(rows).seatHours).toBe(3);
  });

  it("M7 counts completed orders with captured money tenders only", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId);
    const zoneId = await seedZone(world, { active: 1 });
    const sessionId = await seedSession(world, zoneId);
    await seedSale(world, sessionId, { amountIdr: 10_000 });
    await seedSale(world, sessionId, {
      amountIdr: 50_000,
      orderStatus: "draft",
    });
    await seedSale(world, sessionId, {
      amountIdr: 50_000,
      tenderStatus: "authorized",
    });
    await seedSale(world, sessionId, { amountIdr: 50_000, method: "points" });

    const rows = await report(world, actor, zoneId);

    expect(firstHour(rows).revenueIdr).toBe(10_000);
  });

  it("M7 subtracts refunds and never goes below 0", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId);
    const zoneId = await seedZone(world, { active: 1 });
    const sessionId = await seedSession(world, zoneId);
    const partial = await seedSale(world, sessionId, { amountIdr: 40_000 });
    const full = await seedSale(world, sessionId, { amountIdr: 20_000 });
    await seedPosRefund(world, partial, 15_000);
    await seedPosRefund(world, full, 20_000);

    const rows = await report(world, actor, zoneId);

    expect(firstHour(rows).revenueIdr).toBe(25_000);
  });

  it("keeps zones apart and lists every zone of the outlet without a filter", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId);
    const zoneA = await seedZone(world, { active: 1 });
    const zoneB = await seedZone(world, { active: 4 });
    await seedSale(world, await seedSession(world, zoneA), {
      amountIdr: 12_000,
    });
    await seedSale(world, await seedSession(world, zoneB), {
      amountIdr: 8_000,
    });

    const rows = await report(world, actor);

    const hour0 = rows.filter((row) => row.hourStart === at(0).toISOString());
    expect(hour0.map((row) => [row.zoneId, row.revenueIdr]).sort()).toEqual(
      [
        [zoneA, 12_000],
        [zoneB, 8_000],
      ].sort(),
    );
    expect(hour0.find((row) => row.zoneId === zoneB)?.revpashIdr).toBe(2_000);
  });
});

describe("access and isolation", () => {
  it("is refused without facility.config.manage", async () => {
    const world = await createWorld();
    const actor = await seedActor(world.tenantId, ["facility.booth.operate"]);
    const zoneId = await seedZone(world, { active: 1 });

    await expect(report(world, actor, zoneId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("TEN-01 never reads another tenant's zone, seats or sales", async () => {
    const mine = await createWorld();
    const theirs = await createWorld();
    const actor = await seedActor(mine.tenantId);
    const theirZone = await seedZone(theirs, { active: 2 });
    await seedSale(theirs, await seedSession(theirs, theirZone), {
      amountIdr: 99_000,
    });

    await expect(report(mine, actor, theirZone)).rejects.toMatchObject({
      status: 404,
    });
    const own = await report(mine, actor);
    expect(own).toEqual([]);
  });
});
