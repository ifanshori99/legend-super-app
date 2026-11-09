// Fail-first tests for the "reservation-delivery" metric family (WS-11 F8,
// bead legend-5wzoc; contracts docs/briefs/268b-shared-context.md and
// docs/briefs/sub-ws11-foundation-design.md §2.1, §2.4, §2.5).
//
// Rows are seeded straight into `reservations` and `delivery_channel_orders`
// (owner pool), then the REAL registry readers run through
// `recomputeMetricsDaily`; values are read from `metrics_daily` and through
// `evaluateMetrics`. Day = 2025-06-10 (business day of the outlet clock,
// Asia/Jakarta). Choices pinned here: reservation_count leaves out `cancelled`;
// delivery metrics leave out `cancelled` and `rejected` orders; delivery_sales
// is gross - commission and is not a ledger metric, so it has no residual row.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  outletIdSchema,
  outletIdsForQuery,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { METRIC_LEDGER_ADJUSTMENT } from "@starter/shared/metrics";
import { metricSourceOf } from "../services/metric-sources";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import { recomputeMetricsDaily } from "../services/metrics-daily.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = {
  tenantId: string;
  outlet1: string;
  outlet2: string;
  zone1: string;
  zone2: string;
};

type Row = {
  metric_code: string;
  dimension_key: string | null;
  dimension_value: string | null;
  value_int: string | null;
  finality: string;
  id: string;
  updated_at: Date;
};

const DAY = "2025-06-10";
const NEXT_DAY = "2025-06-11";
const EMPTY_DAY = "2025-06-20";
/** Long after DAY: the day is settled. */
const LATE = new Date("2025-09-15T05:00:00Z");
/** Inside DAY (12:00 WIB): the day is not over yet. */
const DURING_DAY = new Date("2025-06-10T05:00:00Z");
const QUERY_NOW = new Date("2025-09-15T05:00:00Z");

const MENU_A = "11111111-1111-4111-8111-111111111111";
const MENU_B = "22222222-2222-4222-8222-222222222222";

let world: World;
let other: World;
let reservationBId: string;

const date = (value: string) => businessDateSchema.parse(value);

function context(tenantId: string, outletIds?: string[]): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(
    tenant,
    outletIds
      ? {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `msrd-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const zone1 = randomUUID();
  const zone2 = randomUUID();
  for (const [id, name] of [
    [zone1, "Zona Satu"],
    [zone2, "Zona Dua"],
  ] as const)
    await owner.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, $4, 'pay_first', '[]')`,
      [id, tenant.tenantId, tenant.outletId, name],
    );
  return {
    tenantId: tenant.tenantId,
    outlet1: tenant.outletId,
    outlet2,
    zone1,
    zone2,
  };
}

async function reservation(
  w: World,
  outletId: string,
  input: {
    reservedFor: string;
    status: "confirmed" | "pending_deposit" | "cancelled" | "no_show";
    zoneId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  const closed = input.status === "cancelled" || input.status === "no_show";
  await owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, guest_name, reserved_for, duration_minutes, pax,
        zone_id, deposit_idr, policy_snapshot, status, source, closed_at)
     VALUES ($1, $2, $3, 'Tamu Uji', $4, 90, 4, $5, 0, '{}', $6, 'staff', $7)`,
    [
      id,
      w.tenantId,
      outletId,
      input.reservedFor,
      input.zoneId ?? null,
      input.status,
      closed ? input.reservedFor : null,
    ],
  );
  return id;
}

async function deliveryOrder(
  w: World,
  outletId: string,
  input: {
    platform: "gofood" | "grabfood" | "shopeefood";
    status?: "delivered" | "cancelled" | "rejected" | "received";
    grossIdr: number;
    commissionIdr: number;
    receivedAt: string;
    lines: { menuItemId: string | null; lineTotalIdr: number }[];
  },
): Promise<void> {
  await owner.query(
    `INSERT INTO delivery_channel_orders
       (tenant_id, outlet_id, platform, external_order_id, status, source,
        gross_idr, commission_idr, payload_hash, lines, received_at)
     VALUES ($1, $2, $3, $4, $5, 'platform', $6, $7, $8, $9::jsonb, $10)`,
    [
      w.tenantId,
      outletId,
      input.platform,
      `EXT-${randomUUID().slice(0, 10)}`,
      input.status ?? "delivered",
      input.grossIdr,
      input.commissionIdr,
      "a".repeat(64),
      JSON.stringify(
        input.lines.map((line, index) => ({
          lineNo: index + 1,
          externalItemId: null,
          externalItemName: "Menu uji",
          menuItemId: line.menuItemId,
          variantId: null,
          quantity: 1,
          unitPriceIdr: line.lineTotalIdr,
          lineTotalIdr: line.lineTotalIdr,
          modifiers: [],
          note: null,
          mapping: line.menuItemId === null ? "unmatched" : "matched",
          channelPriceIdr: line.menuItemId === null ? null : line.lineTotalIdr,
        })),
      ),
      input.receivedAt,
    ],
  );
}

async function rowsOf(
  w: World,
  outletId: string,
  businessDate: string,
): Promise<Row[]> {
  const { rows } = await owner.query<Row>(
    `SELECT id, metric_code, dimension_key, dimension_value,
            value_int::text AS value_int, finality, updated_at
       FROM metrics_daily
      WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
        AND metric_code IN ('reservation_count', 'no_show_reservations',
                            'delivery_orders', 'delivery_sales')
      ORDER BY metric_code, dimension_key NULLS FIRST, dimension_value NULLS FIRST`,
    [w.tenantId, outletId, businessDate],
  );
  return rows;
}

/** value of a stored row: null key = the total. */
function stored(
  rows: Row[],
  code: string,
  dimension: [string, string] | null = null,
): number | undefined {
  const row = rows.find(
    (entry) =>
      entry.metric_code === code &&
      entry.dimension_key === (dimension?.[0] ?? null) &&
      entry.dimension_value === (dimension?.[1] ?? null),
  );
  return row === undefined ? undefined : Number(row.value_int);
}

function splitsOf(rows: Row[], code: string, key: string): number[] {
  return rows
    .filter((row) => row.metric_code === code && row.dimension_key === key)
    .map((row) => Number(row.value_int));
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function evaluate(
  w: World,
  request: {
    metricCodes: string[];
    day?: string;
    groupBy?: string[];
    outletIds?: string[];
  },
): Promise<EvaluatedMetrics> {
  const ctx = context(w.tenantId, request.outletIds);
  const day = date(request.day ?? DAY);
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes: request.metricCodes,
        period: { start: day, end: day },
        bucket: "total",
        outletFilter: outletIdsForQuery(ctx.outletScope),
        groupBy: request.groupBy ?? [],
        filters: [],
        comparePrevious: false,
        viewer: "full",
      },
      QUERY_NOW,
    ),
  );
}

function numberOf(
  result: EvaluatedMetrics,
  code: string,
  dimension: [string, string] | null = null,
): number | null {
  const series = result.series.find(
    (entry) =>
      entry.metricCode === code &&
      (dimension === null
        ? entry.dimensions.length === 0
        : entry.dimensions.some(
            (d) => d.key === dimension[0] && d.value === dimension[1],
          )),
  );
  const value = series?.points[0]?.value ?? null;
  if (value === null) return null;
  return "valueIdr" in value ? value.valueIdr : Number(value.value);
}

async function seedDay(w: World): Promise<string> {
  // 12:30 and 12:50 WIB -> hour 12; 19:15 and 19:45 WIB -> hour 19.
  await reservation(w, w.outlet1, {
    reservedFor: "2025-06-10T05:30:00Z",
    status: "confirmed",
    zoneId: w.zone1,
  });
  const bookingB = await reservation(w, w.outlet1, {
    reservedFor: "2025-06-10T12:15:00Z",
    status: "confirmed",
    zoneId: w.zone1,
  });
  await reservation(w, w.outlet1, {
    reservedFor: "2025-06-10T12:45:00Z",
    status: "no_show",
    zoneId: w.zone2,
  });
  await reservation(w, w.outlet1, {
    reservedFor: "2025-06-10T05:50:00Z",
    status: "confirmed",
    zoneId: null,
  });
  // Cancelled: not counted. Next business day: not counted.
  await reservation(w, w.outlet1, {
    reservedFor: "2025-06-10T05:30:00Z",
    status: "cancelled",
    zoneId: w.zone1,
  });
  await reservation(w, w.outlet1, {
    reservedFor: "2025-06-11T05:30:00Z",
    status: "confirmed",
    zoneId: w.zone1,
  });
  // Other outlet of the same tenant: one confirmed.
  await reservation(w, w.outlet2, {
    reservedFor: "2025-06-10T05:30:00Z",
    status: "confirmed",
  });

  // Delivery, outlet 1: net 80,000 (gofood), 40,000 (grabfood), 6,667 (gofood).
  await deliveryOrder(w, w.outlet1, {
    platform: "gofood",
    grossIdr: 100_000,
    commissionIdr: 20_000,
    receivedAt: "2025-06-10T05:00:00Z",
    lines: [
      { menuItemId: MENU_A, lineTotalIdr: 60_000 },
      { menuItemId: MENU_B, lineTotalIdr: 40_000 },
    ],
  });
  await deliveryOrder(w, w.outlet1, {
    platform: "grabfood",
    grossIdr: 50_000,
    commissionIdr: 10_000,
    receivedAt: "2025-06-10T06:00:00Z",
    lines: [{ menuItemId: MENU_A, lineTotalIdr: 50_000 }],
  });
  // 6,667 shared 3,333 : 6,667 -> 2,222 + 4,445 (the remainder cent goes to the
  // biggest line); the unmatched line is "unmapped".
  await deliveryOrder(w, w.outlet1, {
    platform: "gofood",
    grossIdr: 10_000,
    commissionIdr: 3_333,
    receivedAt: "2025-06-10T07:00:00Z",
    lines: [
      { menuItemId: MENU_A, lineTotalIdr: 3_333 },
      { menuItemId: null, lineTotalIdr: 6_667 },
    ],
  });
  // Cancelled and rejected orders, and an order of the next business day.
  for (const status of ["cancelled", "rejected"] as const)
    await deliveryOrder(w, w.outlet1, {
      platform: "gofood",
      status,
      grossIdr: 99_000,
      commissionIdr: 9_000,
      receivedAt: "2025-06-10T08:00:00Z",
      lines: [{ menuItemId: MENU_A, lineTotalIdr: 99_000 }],
    });
  await deliveryOrder(w, w.outlet1, {
    platform: "gofood",
    grossIdr: 77_000,
    commissionIdr: 7_000,
    receivedAt: "2025-06-11T08:00:00Z",
    lines: [{ menuItemId: MENU_A, lineTotalIdr: 77_000 }],
  });
  // Other outlet of the same tenant.
  await deliveryOrder(w, w.outlet2, {
    platform: "shopeefood",
    grossIdr: 25_000,
    commissionIdr: 5_000,
    receivedAt: "2025-06-10T05:00:00Z",
    lines: [{ menuItemId: MENU_B, lineTotalIdr: 25_000 }],
  });
  return bookingB;
}

beforeAll(async () => {
  world = await makeWorld("a");
  other = await makeWorld("b");
  reservationBId = await seedDay(world);
  // A second tenant with its own busy day on the same date: must never leak.
  await seedDay(other);
  await recomputeMetricsDaily(
    context(world.tenantId),
    world.outlet1,
    date(DAY),
    date(NEXT_DAY),
    { now: LATE },
  );
  await recomputeMetricsDaily(
    context(world.tenantId),
    world.outlet2,
    date(DAY),
    date(DAY),
    { now: LATE },
  );
});

afterAll(async () => {
  await owner.end();
});

describe("registry claims", () => {
  it("claims the five codes of the family, the percent as derived", () => {
    expect(metricSourceOf("reservation_count").kind).toBe("daily");
    expect(metricSourceOf("no_show_reservations").kind).toBe("daily");
    expect(metricSourceOf("delivery_orders").kind).toBe("daily");
    expect(metricSourceOf("delivery_sales").kind).toBe("daily");
    expect(metricSourceOf("reservation_no_show_pct")).toMatchObject({
      kind: "derived",
      numerator: "no_show_reservations",
      denominator: "reservation_count",
      scale: 100,
    });
  });
});

describe("reservation reports answer from the data", () => {
  it("reservation.bookings: counts every reservation except cancelled, of the business day only", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(stored(rows, "reservation_count")).toBe(4);
    const result = await evaluate(world, {
      metricCodes: ["reservation_count"],
    });
    // Outlet 1 (4) + outlet 2 (1).
    expect(numberOf(result, "reservation_count")).toBe(5);
  });

  it("reservation.by_zone: one row per zone, no-zone bookings are 'unassigned'", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(stored(rows, "reservation_count", ["zone", world.zone1])).toBe(2);
    expect(stored(rows, "reservation_count", ["zone", world.zone2])).toBe(1);
    expect(stored(rows, "reservation_count", ["zone", "unassigned"])).toBe(1);
    const result = await evaluate(world, {
      metricCodes: ["reservation_count"],
      groupBy: ["zone"],
    });
    expect(numberOf(result, "reservation_count", ["zone", world.zone1])).toBe(
      2,
    );
  });

  it("reservation.peak_hours: bookings per arrival hour of the outlet clock", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(stored(rows, "reservation_count", ["hour", "12"])).toBe(2);
    expect(stored(rows, "reservation_count", ["hour", "19"])).toBe(2);
  });

  it("reservation.no_show: no-shows and the derived percentage", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(stored(rows, "no_show_reservations")).toBe(1);
    // The derived percent is never stored.
    expect(
      rows.some((row) => row.metric_code === "reservation_no_show_pct"),
    ).toBe(false);
    const result = await evaluate(world, {
      metricCodes: ["no_show_reservations", "reservation_no_show_pct"],
      outletIds: [world.outlet1],
    });
    expect(numberOf(result, "no_show_reservations")).toBe(1);
    expect(numberOf(result, "reservation_no_show_pct")).toBe(25);
  });

  it("a pending-deposit booking still counts (only cancelled is left out)", async () => {
    const w = await makeWorld("pd");
    await reservation(w, w.outlet1, {
      reservedFor: "2025-06-10T05:30:00Z",
      status: "pending_deposit",
    });
    await recomputeMetricsDaily(
      context(w.tenantId),
      w.outlet1,
      date(DAY),
      date(DAY),
      { now: LATE },
    );
    expect(stored(await rowsOf(w, w.outlet1, DAY), "reservation_count")).toBe(
      1,
    );
  });
});

describe("delivery reports answer from the data", () => {
  it("delivery.orders: orders per channel without cancelled or rejected", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(stored(rows, "delivery_orders")).toBe(3);
    expect(stored(rows, "delivery_orders", ["channel", "gofood"])).toBe(2);
    expect(stored(rows, "delivery_orders", ["channel", "grabfood"])).toBe(1);
    const result = await evaluate(world, {
      metricCodes: ["delivery_orders"],
      groupBy: ["channel"],
    });
    expect(numberOf(result, "delivery_orders", ["channel", "shopeefood"])).toBe(
      1,
    );
  });

  it("delivery.channel_sales: net (gross - commission) per channel", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(stored(rows, "delivery_sales")).toBe(126_667);
    expect(stored(rows, "delivery_sales", ["channel", "gofood"])).toBe(86_667);
    expect(stored(rows, "delivery_sales", ["channel", "grabfood"])).toBe(
      40_000,
    );
    const total = await evaluate(world, { metricCodes: ["delivery_sales"] });
    expect(numberOf(total, "delivery_sales")).toBe(146_667); // + outlet 2
    const split = await evaluate(world, {
      metricCodes: ["delivery_sales"],
      groupBy: ["channel"],
    });
    expect(numberOf(split, "delivery_sales", ["channel", "gofood"])).toBe(
      86_667,
    );
  });

  it("delivery.by_menu: net shared over the lines, unmatched lines 'unmapped'", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(stored(rows, "delivery_sales", ["menu_item", MENU_A])).toBe(90_222);
    expect(stored(rows, "delivery_sales", ["menu_item", MENU_B])).toBe(32_000);
    expect(stored(rows, "delivery_sales", ["menu_item", "unmapped"])).toBe(
      4_445,
    );
  });

  it("delivery.settlement: delivery_sales is a number, payment_fee is not claimed here", async () => {
    const result = await evaluate(world, {
      metricCodes: ["delivery_sales", "payment_fee"],
      groupBy: ["channel"],
    });
    expect(
      result.availability.find((entry) => entry.metricCode === "delivery_sales")
        ?.status,
    ).toBe("available");
    expect(numberOf(result, "delivery_sales", ["channel", "grabfood"])).toBe(
      40_000,
    );
  });
});

describe("splits add up to the total", () => {
  it("zone, hour, channel and menu rows each sum to their total", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(sum(splitsOf(rows, "reservation_count", "zone"))).toBe(
      stored(rows, "reservation_count"),
    );
    expect(sum(splitsOf(rows, "reservation_count", "hour"))).toBe(
      stored(rows, "reservation_count"),
    );
    expect(sum(splitsOf(rows, "delivery_orders", "channel"))).toBe(
      stored(rows, "delivery_orders"),
    );
    expect(sum(splitsOf(rows, "delivery_sales", "channel"))).toBe(
      stored(rows, "delivery_sales"),
    );
    expect(sum(splitsOf(rows, "delivery_sales", "menu_item"))).toBe(
      stored(rows, "delivery_sales"),
    );
  });

  it("delivery_sales is not a ledger metric: no residual row is written", async () => {
    const rows = await rowsOf(world, world.outlet1, DAY);
    expect(
      rows.some((row) => row.dimension_value === METRIC_LEDGER_ADJUSTMENT),
    ).toBe(false);
  });
});

describe("tenant and outlet isolation", () => {
  it("outlet 2 holds only its own rows", async () => {
    const rows = await rowsOf(world, world.outlet2, DAY);
    expect(stored(rows, "reservation_count")).toBe(1);
    expect(stored(rows, "delivery_orders")).toBe(1);
    expect(stored(rows, "delivery_sales")).toBe(20_000);
    expect(stored(rows, "delivery_sales", ["channel", "gofood"])).toBe(
      undefined,
    );
  });

  it("the other tenant's data never reaches this tenant's query", async () => {
    // `other` was seeded identically but never recomputed: no stored rows, and
    // the first tenant's totals stay 5 and 146,667.
    expect((await rowsOf(other, other.outlet1, DAY)).length).toBe(0);
    const result = await evaluate(world, {
      metricCodes: ["reservation_count", "delivery_sales"],
    });
    expect(numberOf(result, "reservation_count")).toBe(5);
    expect(numberOf(result, "delivery_sales")).toBe(146_667);
  });

  it("a context of another tenant writes nothing for a foreign outlet", async () => {
    await recomputeMetricsDaily(
      context(other.tenantId),
      world.outlet1,
      date(EMPTY_DAY),
      date(EMPTY_DAY),
      { now: LATE },
    ).catch(() => undefined);
    expect((await rowsOf(world, world.outlet1, EMPTY_DAY)).length).toBe(0);
    expect((await rowsOf(other, world.outlet1, EMPTY_DAY)).length).toBe(0);
  });

  it("a recompute for the other tenant counts only its own rows", async () => {
    await recomputeMetricsDaily(
      context(other.tenantId),
      other.outlet1,
      date(DAY),
      date(DAY),
      { now: LATE },
    );
    const rows = await rowsOf(other, other.outlet1, DAY);
    expect(stored(rows, "reservation_count")).toBe(4);
    expect(stored(rows, "delivery_sales")).toBe(126_667);
  });
});

describe("finality and empty days", () => {
  it("a day with no activity stores zero totals for every code", async () => {
    await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(EMPTY_DAY),
      date(EMPTY_DAY),
      { now: LATE },
    );
    const rows = await rowsOf(world, world.outlet1, EMPTY_DAY);
    for (const code of [
      "reservation_count",
      "no_show_reservations",
      "delivery_orders",
      "delivery_sales",
    ])
      expect(stored(rows, code), code).toBe(0);
  });

  it("a day never computed has no value and is not final", async () => {
    const result = await evaluate(world, {
      metricCodes: ["reservation_count", "delivery_orders"],
      day: "2025-06-25",
    });
    for (const series of result.series)
      expect(series.points[0]?.finality).not.toBe("final");
  });

  it("a computed day inside its own business day is an estimate, a settled one is final", async () => {
    const w = await makeWorld("fin");
    await reservation(w, w.outlet1, {
      reservedFor: "2025-06-10T05:30:00Z",
      status: "confirmed",
    });
    await recomputeMetricsDaily(
      context(w.tenantId),
      w.outlet1,
      date(DAY),
      date(DAY),
      { now: DURING_DAY },
    );
    expect(
      new Set((await rowsOf(w, w.outlet1, DAY)).map((row) => row.finality)),
    ).toEqual(new Set(["estimate"]));
    await recomputeMetricsDaily(
      context(w.tenantId),
      w.outlet1,
      date(DAY),
      date(DAY),
      { now: LATE },
    );
    expect(
      new Set((await rowsOf(w, w.outlet1, DAY)).map((row) => row.finality)),
    ).toEqual(new Set(["final"]));
  });

  it("a delivery order in flight keeps the delivery rows an estimate until it ends", async () => {
    const w = await makeWorld("hold");
    await reservation(w, w.outlet1, {
      reservedFor: "2025-06-10T05:30:00Z",
      status: "confirmed",
    });
    const order = (status: "received" | "delivered") =>
      deliveryOrder(w, w.outlet1, {
        platform: "gofood",
        status,
        grossIdr: 50_000,
        commissionIdr: 10_000,
        receivedAt: "2025-06-10T05:00:00Z",
        lines: [{ menuItemId: MENU_A, lineTotalIdr: 50_000 }],
      });
    await order("delivered");
    await order("received");
    // An in-flight order of outlet 2 never holds outlet 1.
    await deliveryOrder(w, w.outlet2, {
      platform: "grabfood",
      status: "received",
      grossIdr: 1_000,
      commissionIdr: 0,
      receivedAt: "2025-06-10T05:00:00Z",
      lines: [{ menuItemId: MENU_A, lineTotalIdr: 1_000 }],
    });
    const recompute = () =>
      recomputeMetricsDaily(
        context(w.tenantId),
        w.outlet1,
        date(DAY),
        date(DAY),
        { now: LATE },
      );
    const finalityByCode = async () => {
      const out: Record<string, Set<string>> = {};
      for (const row of await rowsOf(w, w.outlet1, DAY))
        (out[row.metric_code] ??= new Set()).add(row.finality);
      return out;
    };
    const setStatus = (from: string, to: string) =>
      owner.query(
        `UPDATE delivery_channel_orders SET status = $3
          WHERE tenant_id = $1 AND outlet_id = $2 AND status = $4`,
        [w.tenantId, w.outlet1, to, from],
      );

    await recompute();
    expect(await finalityByCode()).toEqual({
      delivery_orders: new Set(["estimate"]),
      delivery_sales: new Set(["estimate"]),
      no_show_reservations: new Set(["final"]),
      reservation_count: new Set(["final"]),
    });

    // Every in-flight status holds the day.
    await setStatus("received", "picked_up");
    await recompute();
    expect((await finalityByCode()).delivery_sales).toEqual(
      new Set(["estimate"]),
    );

    await setStatus("picked_up", "delivered");
    await recompute();
    expect((await finalityByCode()).delivery_sales).toEqual(new Set(["final"]));
    expect((await finalityByCode()).delivery_orders).toEqual(
      new Set(["final"]),
    );

    // A late order that is then cancelled lets the day go final again.
    await order("received");
    await recompute();
    expect((await finalityByCode()).delivery_orders).toEqual(
      new Set(["estimate"]),
    );
    await setStatus("received", "cancelled");
    await recompute();
    expect((await finalityByCode()).delivery_orders).toEqual(
      new Set(["final"]),
    );
  });
});

describe("backfill is idempotent", () => {
  it("a second recompute leaves ids, values and updated_at alone", async () => {
    const before = await rowsOf(world, world.outlet1, DAY);
    const second = await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(DAY),
      date(NEXT_DAY),
      { now: new Date(LATE.getTime() + 60_000) },
    );
    expect(second).toMatchObject({
      written: 0,
      deleted: 0,
      failedFamilies: [],
    });
    expect(second.unchanged).toBeGreaterThan(0);
    const after = await rowsOf(world, world.outlet1, DAY);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.updated_at.getTime())).toEqual(
      before.map((row) => row.updated_at.getTime()),
    );
  });

  it("a changed reservation updates the same rows and the row count stays", async () => {
    const before = await rowsOf(world, world.outlet1, DAY);
    // Booking B was confirmed; it becomes a no-show.
    await owner.query(
      `UPDATE reservations SET status = 'no_show', closed_at = reserved_for
        WHERE id = $1`,
      [reservationBId],
    );
    await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date(DAY),
      date(DAY),
      { now: new Date(LATE.getTime() + 120_000) },
    );
    const after = await rowsOf(world, world.outlet1, DAY);
    expect(after).toHaveLength(before.length);
    expect(stored(after, "no_show_reservations")).toBe(2);
    expect(stored(after, "reservation_count")).toBe(4);
  });
});
