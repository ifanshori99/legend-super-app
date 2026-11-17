// Fail-first tests of the WFC metrics `revpash` and `seat_occupancy_pct` (bead
// legend-p4q10; CTO decision 14 Nov, brief 987). Both used to be claimed
// `unavailable`; they are now stored per zone in `metrics_daily` by the daily
// job and read back through the engine like a report run does.
//
// Rules under test (from the brief, not from the implementation):
//   - a WFC zone is a `floor_zones` row with `is_wfc` true; other zones are ignored;
//   - seats = sum of `tables.capacity` of the zone's active tables;
//   - revenue = net sales of paid/completed orders (never voided or unpaid) on
//     the order's `business_date`, reached through order -> table session ->
//     table -> zone. Net excludes service charge and tax; for a tax-inclusive
//     order (`prices_include_tax`) both are backed out of the gross subtotal;
//   - open hours = the zone's `hours` for the weekday of the business date,
//     falling back to the outlet's opening hours; no hours or no seats means
//     no value for that zone (absent, never a divide by zero);
//   - revpash = revenue / (seats * open hours);
//   - seat_occupancy_pct = sum over sessions of the time inside the open window
//     (a session still open at `now` or spanning the closing time is clipped to
//     the window) times pax, divided by (seats * open hours), times 100.
//
// Test day 2025-07-14 (Monday, Asia/Jakarta UTC+7), settled long before NOW.
// Zones of outlet 1 (every zone is open every weekday unless stated):
//   Z1 WFC 09:00-17:00 (8 h), tables A (4 seats) and B (2 seats) plus an
//      inactive table C (10 seats, not counted): 6 seats, 48 seat-hours.
//        sessions: s1 A pax 3 10:00-12:00 (6 seat-h), s2 B pax 2 08:00-10:00
//        (clipped to 09:00-10:00: 2), s3 A pax 4 16:00-18:00 (clipped to
//        16:00-17:00: 4), a voided session B pax 5 11:00-12:00 (counts nowhere).
//        orders: tax-exclusive net 120 000 (sc 6 000, tax 13 200), tax-inclusive
//        net 120 000 (gross 133 200, sc 6 000, tax 7 200); a voided order, an
//        unpaid order and an order of the next day add nothing; neither does a
//        takeaway order with no table session.
//        revpash 240 000 / 48 = 5 000; occupancy 12 / 48 = 25 %.
//   Z2 not WFC: busy, but never reported.
//   Z3 WFC 10:00-12:00, one table of 2 seats (4 seat-h), session pax 2 opened
//      11:00 and still open: clipped to 12:00 = 2 seat-h; order net 8 000.
//        revpash 2 000; occupancy 50 %.
//   Z4 WFC, only an inactive table: 0 seats, so no value.
//   Z5 WFC with `hours` empty: falls back to the outlet's 08:00-22:00 (14 h),
//      one table of 2 seats (28 seat-h); order net 14 000; session pax 2
//      08:00-15:00 (14 seat-h). revpash 500; occupancy 50 %.
//   Z6 WFC with a window of zero length (09:00-09:00): no value.
// Outlet 2: Z7 WFC 09:00-17:00, one table of 4 seats, order net 16 000, session
//   pax 4 09:00-13:00 (16 of 32 seat-h): revpash 500; occupancy 50 %.
// Another tenant has its own WFC zone and order that must never show up here.
//
// Assumptions where the spec is silent: the zone dimension value is the zone id;
// a WFC zone with seats and hours but no activity reports 0 (not absent);
// `hours: []` on a zone means "use the outlet's hours" while a zero-length
// window means the zone is closed.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  outletIdsForQuery,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { metricSourceOf } from "../services/metric-sources";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import { recomputeMetricsDaily } from "../services/metrics-daily.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

const NOW = new Date("2025-08-20T05:00:00Z");
const DAY = "2025-07-14";
const NEXT_DAY = "2025-07-15";
const EMPTY_DAY = "2025-07-16";

type World = { tenantId: string; outlet1: string; outlet2: string };
type Ids = {
  z1: string;
  z2: string;
  z3: string;
  z4: string;
  z5: string;
  z6: string;
  z7: string;
  zOther: string;
};

let world: World;
let other: World;
let ids: Ids;

function context(tenantId: string): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

async function asOwner<T>(
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

/** Local time (UTC+7) of a test day as an ISO instant. */
const at = (date: string, hhmm: string): string => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(
    Date.parse(`${date}T00:00:00Z`) + ((h! - 7) * 60 + m!) * 60_000,
  ).toISOString();
};

const LAYOUT = JSON.stringify({
  x: 1,
  y: 1,
  width: 10,
  height: 10,
  rotation: 0,
  shape: "rect",
});
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const hoursOf = (start: string, end: string) => [
  { daysOfWeek: ALL_DAYS, start, end },
];

async function seedWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `rpsh-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  return { tenantId: tenant.tenantId, outlet1: tenant.outletId, outlet2 };
}

async function zone(
  w: World,
  outletId: string,
  input: { name: string; isWfc: boolean; hours: unknown },
): Promise<string> {
  const id = randomUUID();
  await asOwner(w.tenantId, (client) =>
    client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours, is_wfc)
       VALUES ($1, $2, $3, $4, 'open_bill', $5::jsonb, $6)`,
      [
        id,
        w.tenantId,
        outletId,
        `${input.name}-${id.slice(0, 4)}`,
        JSON.stringify(input.hours),
        input.isWfc,
      ],
    ),
  );
  return id;
}

async function table(
  w: World,
  outletId: string,
  zoneId: string,
  capacity: number,
  status = "available",
): Promise<string> {
  const id = randomUUID();
  await asOwner(w.tenantId, (client) =>
    client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'regular', $7::jsonb, $8)`,
      [
        id,
        w.tenantId,
        outletId,
        zoneId,
        `T-${id.slice(0, 8)}`.toUpperCase(),
        capacity,
        LAYOUT,
        status,
      ],
    ),
  );
  return id;
}

async function session(
  w: World,
  outletId: string,
  tableId: string,
  input: {
    pax: number;
    from: string;
    to: string | null;
    status?: "open" | "closed" | "voided";
  },
): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? (input.to === null ? "open" : "closed");
  const opened = at(DAY, input.from);
  const closed = input.to === null ? null : at(DAY, input.to);
  await asOwner(w.tenantId, (client) =>
    client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
         session_token_hash, session_token_sealed, opened_at, last_activity_at, closed_at, closed_reason)
       VALUES ($1, $2, $3, $4, $5, 'open_bill', $6, $7, 'sealed', $8, $8, $9, $10)`,
      [
        id,
        w.tenantId,
        outletId,
        tableId,
        input.pax,
        status,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
        opened,
        closed,
        status === "open"
          ? null
          : status === "voided"
            ? "voided"
            : "paid_and_cleaned",
      ],
    ),
  );
  return id;
}

/**
 * One order on a session (or none). `netIdr` is the sale without service
 * charge and tax: with `inclusive` the stored subtotal is the gross the guest
 * saw and the total equals it, otherwise service and tax are added on top.
 */
async function order(
  w: World,
  outletId: string,
  sessionId: string | null,
  input: {
    netIdr: number;
    serviceChargeIdr?: number;
    taxIdr?: number;
    inclusive?: boolean;
    status?: string;
    date?: string;
  },
) {
  const sc = input.serviceChargeIdr ?? 0;
  const tax = input.taxIdr ?? 0;
  const subtotal = input.inclusive ? input.netIdr + sc + tax : input.netIdr;
  const total = input.inclusive ? subtotal : subtotal + sc + tax;
  const id = randomUUID();
  const date = input.date ?? DAY;
  await asOwner(w.tenantId, (client) =>
    client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, table_session_id,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         prices_include_tax, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'qr', $5, $6, 'open_bill', $7, 0, $8, $9, 0, $10, $11, $12, $13, $14)`,
      [
        id,
        w.tenantId,
        outletId,
        `RP-${id.slice(0, 12)}`,
        sessionId === null ? "takeaway" : "dine_in",
        sessionId,
        subtotal,
        sc,
        tax,
        total,
        input.inclusive ?? false,
        input.status ?? "completed",
        date,
        at(date, "12:00"),
      ],
    ),
  );
}

type Dim = { key: "zone"; value: string };

function evaluate(
  w: World,
  codes: string[],
  date: string = DAY,
): Promise<EvaluatedMetrics> {
  const ctx = context(w.tenantId);
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes: codes,
        period: {
          start: businessDateSchema.parse(date),
          end: businessDateSchema.parse(date),
        },
        bucket: "total",
        outletFilter: outletIdsForQuery(ctx.outletScope),
        groupBy: ["zone"],
        filters: [],
        comparePrevious: false,
        viewer: "full",
      },
      NOW,
    ),
  );
}

function numberOf(value: unknown): number | null {
  const v = value as { unit: string; value?: number | string } | null;
  return v === null || v.value === undefined ? null : Number(v.value);
}

/** Value of one code for one zone; null when the zone has no value. */
async function figure(
  w: World,
  code: string,
  zoneId: string,
  date: string = DAY,
): Promise<{ value: number | null; finality: string | null }> {
  const result = await evaluate(w, [code], date);
  const dim: Dim = { key: "zone", value: zoneId };
  const series = result.series.find(
    (entry) =>
      entry.metricCode === code &&
      entry.dimensions.some((d) => d.key === dim.key && d.value === dim.value),
  );
  if (!series) return { value: null, finality: null };
  const point = series.points[0]!;
  return { value: numberOf(point.value), finality: point.finality };
}

async function storedZones(
  w: World,
  outletId: string,
  code: string,
  date: string = DAY,
): Promise<string[]> {
  const { rows } = await owner.query<{ dimension_value: string }>(
    `SELECT dimension_value FROM metrics_daily
      WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
        AND metric_code = $4 AND dimension_key = 'zone'`,
    [w.tenantId, outletId, date, code],
  );
  return rows.map((row) => row.dimension_value).sort();
}

async function seedZones(w: World, o1: string, o2: string): Promise<Ids> {
  // Z1: the main WFC zone.
  const z1 = await zone(w, o1, {
    name: "WFC",
    isWfc: true,
    hours: hoursOf("09:00", "17:00"),
  });
  const a = await table(w, o1, z1, 4);
  const b = await table(w, o1, z1, 2);
  await table(w, o1, z1, 10, "inactive");
  const s1 = await session(w, o1, a, { pax: 3, from: "10:00", to: "12:00" });
  const s2 = await session(w, o1, b, { pax: 2, from: "08:00", to: "10:00" });
  await session(w, o1, a, { pax: 4, from: "16:00", to: "18:00" });
  await session(w, o1, b, {
    pax: 5,
    from: "11:00",
    to: "12:00",
    status: "voided",
  });
  await order(w, o1, s1, {
    netIdr: 120_000,
    serviceChargeIdr: 6_000,
    taxIdr: 13_200,
  });
  await order(w, o1, s2, {
    netIdr: 120_000,
    serviceChargeIdr: 6_000,
    taxIdr: 7_200,
    inclusive: true,
  });
  await order(w, o1, s1, { netIdr: 500_000, status: "voided" });
  await order(w, o1, s1, { netIdr: 300_000, status: "awaiting_payment" });
  await order(w, o1, s1, { netIdr: 120_000, date: NEXT_DAY });
  await order(w, o1, null, { netIdr: 700_000 });

  // Z2: not a WFC zone.
  const z2 = await zone(w, o1, {
    name: "Indoor",
    isWfc: false,
    hours: hoursOf("09:00", "17:00"),
  });
  const t2 = await table(w, o1, z2, 4);
  const s2b = await session(w, o1, t2, { pax: 4, from: "10:00", to: "12:00" });
  await order(w, o1, s2b, { netIdr: 999_999 });

  // Z3: a session still open at `now`.
  const z3 = await zone(w, o1, {
    name: "WFC Atas",
    isWfc: true,
    hours: hoursOf("10:00", "12:00"),
  });
  const t3 = await table(w, o1, z3, 2);
  const s3 = await session(w, o1, t3, { pax: 2, from: "11:00", to: null });
  await order(w, o1, s3, { netIdr: 8_000 });

  // Z4: no active table, so no seats.
  const z4 = await zone(w, o1, {
    name: "WFC Tanpa Kursi",
    isWfc: true,
    hours: hoursOf("09:00", "17:00"),
  });
  const t4 = await table(w, o1, z4, 4, "inactive");
  const s4 = await session(w, o1, t4, { pax: 2, from: "10:00", to: "11:00" });
  await order(w, o1, s4, { netIdr: 50_000 });

  // Z5: no zone hours, the outlet's 08:00-22:00 applies.
  const z5 = await zone(w, o1, { name: "WFC Outlet", isWfc: true, hours: [] });
  const t5 = await table(w, o1, z5, 2);
  const s5 = await session(w, o1, t5, { pax: 2, from: "08:00", to: "15:00" });
  await order(w, o1, s5, { netIdr: 14_000 });

  // Z6: a window of zero length.
  const z6 = await zone(w, o1, {
    name: "WFC Tutup",
    isWfc: true,
    hours: hoursOf("09:00", "09:00"),
  });
  const t6 = await table(w, o1, z6, 2);
  const s6 = await session(w, o1, t6, { pax: 2, from: "09:00", to: "10:00" });
  await order(w, o1, s6, { netIdr: 10_000 });

  // Z7: a WFC zone of the tenant's second outlet.
  const z7 = await zone(w, o2, {
    name: "WFC Dua",
    isWfc: true,
    hours: hoursOf("09:00", "17:00"),
  });
  const t7 = await table(w, o2, z7, 4);
  const s7 = await session(w, o2, t7, { pax: 4, from: "09:00", to: "13:00" });
  await order(w, o2, s7, { netIdr: 16_000 });

  return { z1, z2, z3, z4, z5, z6, z7, zOther: "" };
}

beforeAll(async () => {
  world = await seedWorld("a");
  other = await seedWorld("b");
  ids = await seedZones(world, world.outlet1, world.outlet2);

  // Another tenant: a WFC zone with a bigger order that must stay out.
  const zOther = await zone(other, other.outlet1, {
    name: "WFC Lain",
    isWfc: true,
    hours: hoursOf("10:00", "12:00"),
  });
  const tOther = await table(other, other.outlet1, zOther, 2);
  const sOther = await session(other, other.outlet1, tOther, {
    pax: 2,
    from: "10:00",
    to: "12:00",
  });
  await order(other, other.outlet1, sOther, { netIdr: 80_000 });
  ids.zOther = zOther;

  for (const [w, outlet] of [
    [world, world.outlet1],
    [world, world.outlet2],
    [other, other.outlet1],
  ] as const)
    await recomputeMetricsDaily(
      context(w.tenantId),
      outlet,
      businessDateSchema.parse(DAY),
      businessDateSchema.parse(EMPTY_DAY),
      { now: NOW },
    );
});

afterAll(async () => {
  await owner.end();
});

describe("source registration", () => {
  it("no longer claims revpash and seat_occupancy_pct as unavailable", () => {
    for (const code of ["revpash", "seat_occupancy_pct"])
      expect(metricSourceOf(code).kind, code).not.toBe("unavailable");
  });

  it("answers both as available through the engine", async () => {
    const result = await evaluate(world, ["revpash", "seat_occupancy_pct"]);
    expect(result.availability).toEqual([
      { metricCode: "revpash", status: "available" },
      { metricCode: "seat_occupancy_pct", status: "available" },
    ]);
  });
});

describe("revpash", () => {
  it("divides net revenue by seats times open hours (tax and service charge out, tax-inclusive backed out)", async () => {
    // 240 000 net / (6 seats * 8 h) = 5 000.
    const z1 = await figure(world, "revpash", ids.z1);
    expect(z1.value).toBeCloseTo(5_000, 2);
    expect(z1.finality).toBe("final");
  });

  it("counts only paid, non-void orders of the business date at a table of the zone", async () => {
    // The voided (500 000), unpaid (300 000), next-day (120 000) and
    // takeaway (700 000) orders would all move this number.
    expect((await figure(world, "revpash", ids.z1)).value).toBeCloseTo(
      5_000,
      2,
    );
    // The next business day holds only the 120 000 order: 120 000 / 48.
    expect(
      (await figure(world, "revpash", ids.z1, NEXT_DAY)).value,
    ).toBeCloseTo(2_500, 2);
  });

  it("reads each WFC zone on its own seats and hours", async () => {
    expect((await figure(world, "revpash", ids.z3)).value).toBeCloseTo(
      2_000,
      2,
    );
    // Hours fall back to the outlet's 08:00-22:00: 14 000 / (2 * 14).
    expect((await figure(world, "revpash", ids.z5)).value).toBeCloseTo(500, 2);
    expect((await figure(world, "revpash", ids.z7)).value).toBeCloseTo(500, 2);
  });

  it("ignores a zone that is not WFC", async () => {
    expect((await figure(world, "revpash", ids.z2)).value).toBeNull();
    expect(await storedZones(world, world.outlet1, "revpash")).not.toContain(
      ids.z2,
    );
  });

  it("gives no value, never a divide by zero, to a zone without seats or without open hours", async () => {
    expect((await figure(world, "revpash", ids.z4)).value).toBeNull();
    expect((await figure(world, "revpash", ids.z6)).value).toBeNull();
    const stored = await storedZones(world, world.outlet1, "revpash");
    expect(stored).toEqual([ids.z1, ids.z3, ids.z5].sort());
  });

  it("reports 0 for a zone with seats and hours on a day without sales", async () => {
    expect((await figure(world, "revpash", ids.z1, EMPTY_DAY)).value).toBe(0);
  });
});

describe("seat_occupancy_pct", () => {
  it("is occupied seat-hours over available seat-hours, clipped to the open window", async () => {
    // s1 6 + s2 2 (clipped) + s3 4 (clipped) = 12 of 48; voided session ignored.
    const z1 = await figure(world, "seat_occupancy_pct", ids.z1);
    expect(z1.value).toBeCloseTo(25, 2);
    expect(z1.finality).toBe("final");
  });

  it("clips a session still open at now to the closing time", async () => {
    // pax 2 from 11:00 to the 12:00 close = 2 of 4 seat-hours.
    expect(
      (await figure(world, "seat_occupancy_pct", ids.z3)).value,
    ).toBeCloseTo(50, 2);
  });

  it("uses the outlet hours when the zone has none, and each outlet's own zone", async () => {
    expect(
      (await figure(world, "seat_occupancy_pct", ids.z5)).value,
    ).toBeCloseTo(50, 2);
    expect(
      (await figure(world, "seat_occupancy_pct", ids.z7)).value,
    ).toBeCloseTo(50, 2);
  });

  it("never exceeds 100 and is 0 on a day with no session", async () => {
    for (const zoneId of [ids.z1, ids.z3, ids.z5, ids.z7]) {
      const value = (await figure(world, "seat_occupancy_pct", zoneId)).value;
      expect(value).not.toBeNull();
      expect(value!).toBeLessThanOrEqual(100);
    }
    expect(
      (await figure(world, "seat_occupancy_pct", ids.z1, EMPTY_DAY)).value,
    ).toBe(0);
  });

  it("gives no value to a non-WFC zone, a zone without seats or a zone without open hours", async () => {
    for (const zoneId of [ids.z2, ids.z4, ids.z6])
      expect(
        (await figure(world, "seat_occupancy_pct", zoneId)).value,
      ).toBeNull();
    expect(
      await storedZones(world, world.outlet1, "seat_occupancy_pct"),
    ).toEqual([ids.z1, ids.z3, ids.z5].sort());
  });
});

describe("isolation", () => {
  it("never mixes another tenant's zones or orders into the figures", async () => {
    const result = await evaluate(world, ["revpash", "seat_occupancy_pct"]);
    const zones = new Set(
      result.series.flatMap((series) =>
        series.dimensions.filter((d) => d.key === "zone").map((d) => d.value),
      ),
    );
    expect(zones.has(ids.zOther)).toBe(false);
    expect([...zones].sort()).toEqual([ids.z1, ids.z3, ids.z5, ids.z7].sort());
  });

  it("answers the other tenant from its own data only", async () => {
    // 80 000 / (2 seats * 2 h) = 20 000; pax 2 for the whole window = 100 %.
    expect((await figure(other, "revpash", ids.zOther)).value).toBeCloseTo(
      20_000,
      2,
    );
    expect(
      (await figure(other, "seat_occupancy_pct", ids.zOther)).value,
    ).toBeCloseTo(100, 2);
    expect((await figure(other, "revpash", ids.z1)).value).toBeNull();
  });

  it("keeps the second outlet's zone out of the first outlet's rows", async () => {
    expect(await storedZones(world, world.outlet2, "revpash")).toEqual([
      ids.z7,
    ]);
    expect(await storedZones(world, world.outlet1, "revpash")).not.toContain(
      ids.z7,
    );
  });
});
