// Fail-first tests for the traffic-operations metric family (WS-11 F2, bead
// legend-a82g9; brief docs/briefs/268a-ws11-traffic-menu-payments.md, common
// rules in 268-ws11-family-common.md). The family answers from table
// sessions, service requests, kitchen tickets and recipe deductions through
// `metrics_daily`; metrics with no stored source answer `unavailable`.
//
// Rows are seeded with the owner pool and `session_replication_role =
// replica`, so foreign keys to orders and order items are not needed; check
// constraints still apply.

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
import {
  dailyReaders,
  metricSourceOf,
  METRIC_SOURCE_MODULES,
  assertRegistry,
  type DailyMetricReader,
} from "../services/metric-sources";
import {
  recomputeMetricsDaily,
  refreshMetricsDaily,
} from "../services/metrics-daily.service";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = { tenantId: string; outlet1: string; outlet2: string };

const DAY = "2025-07-14";
const EMPTY_DAY = "2025-07-13";
const NEXT_DAY = "2025-07-15";
/** Long after every seeded date: all days are settled. */
const LATE = new Date("2025-08-20T05:00:00Z");

const readers = dailyReaders()
  .filter(({ family }) => family === "traffic-operations")
  .map(({ family, reader }) => ({ family, reader }));

const date = (value: string) => businessDateSchema.parse(value);

function context(tenantId: string, outletId?: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    outletId
      ? { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] }
      : { kind: "tenant" },
  );
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `mstr-${label}-${randomUUID().slice(0, 6)}`,
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

type Seed = {
  zone1: string;
  zone2: string;
  stationA: string;
  stationB: string;
};

const LAYOUT = JSON.stringify({
  x: 1,
  y: 1,
  width: 10,
  height: 10,
  rotation: 0,
  shape: "rect",
});

async function seed(world: World, outletId: string): Promise<Seed> {
  const ids = {
    zone1: randomUUID(),
    zone2: randomUUID(),
    stationA: randomUUID(),
    stationB: randomUUID(),
  };
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const t = world.tenantId;
    for (const [id, name] of [
      [ids.zone1, "Indoor"],
      [ids.zone2, "Teras"],
    ] as const)
      await client.query(
        `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
         VALUES ($1, $2, $3, $4, 'pay_first', '[]'::jsonb)`,
        [id, t, outletId, `${name}-${id.slice(0, 4)}`],
      );
    const tables: Record<string, string> = {};
    for (const [key, zone, status] of [
      ["t1", ids.zone1, "available"],
      ["t2", ids.zone1, "available"],
      ["t3", ids.zone1, "available"],
      ["t4", ids.zone2, "available"],
      ["t5", ids.zone2, "inactive"],
    ] as const) {
      tables[key] = randomUUID();
      await client.query(
        `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout, status)
         VALUES ($1, $2, $3, $4, $5, 4, 'regular', $6::jsonb, $7)`,
        [
          tables[key],
          t,
          outletId,
          zone,
          `${key}-${tables[key]!.slice(0, 5)}`.toUpperCase(),
          LAYOUT,
          status,
        ],
      );
    }
    const sessionIds: string[] = [];
    // [table, pax, status, openedAt, closedAt]
    const sessions: [string, number, string, string, string | null][] = [
      ["t1", 3, "closed", `${DAY}T05:00:00Z`, `${DAY}T06:00:00Z`], // 60 min
      ["t2", 2, "closed", `${DAY}T05:30:00Z`, `${DAY}T06:00:00Z`], // 30 min
      ["t4", 4, "open", `${DAY}T06:10:00Z`, null],
      ["t3", 5, "voided", `${DAY}T05:00:00Z`, `${DAY}T05:05:00Z`],
    ];
    for (const [table, pax, status, openedAt, closedAt] of sessions) {
      const id = randomUUID();
      sessionIds.push(id);
      const closed = status === "closed" || status === "voided";
      await client.query(
        `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
           session_token_hash, session_token_sealed, opened_at, last_activity_at, closed_at, closed_reason)
         VALUES ($1, $2, $3, $4, $5, 'pay_first', $6, $7, 'sealed', $8, $8, $9, $10)`,
        [
          id,
          t,
          outletId,
          tables[table],
          pax,
          status,
          randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
          openedAt,
          closedAt,
          closed ? (status === "voided" ? "voided" : "paid_and_cleaned") : null,
        ],
      );
    }
    // [type, status, zone, table]
    const requests: [string, string, string, string, string?][] = [
      ["call_waiter", "pending", ids.zone1, "t1"],
      ["call_waiter", "cancelled", ids.zone1, "t2"],
      ["call_waiter", "pending", ids.zone2, "t4"],
      ["request_bill", "pending", ids.zone1, "t1"],
    ];
    for (const [type, status, zone, table] of requests)
      await client.query(
        `INSERT INTO service_requests (tenant_id, outlet_id, table_session_id, table_id, zone_id, type,
           status, idempotency_key, request_fingerprint, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          t,
          outletId,
          sessionIds[0],
          tables[table],
          zone,
          type,
          status,
          randomUUID(),
          "0".repeat(64),
          `${DAY}T05:15:00Z`,
        ],
      );
    // [station, firedAt, doneAt, cancelledAt]
    const tickets: [string, string, string | null, string | null][] = [
      [ids.stationA, `${DAY}T05:00:00Z`, `${DAY}T05:10:00Z`, null], // 600 s
      [ids.stationA, `${DAY}T05:00:00Z`, `${DAY}T05:20:00Z`, null], // 1200 s
      [ids.stationB, `${DAY}T06:00:00Z`, `${DAY}T06:05:00Z`, null], // 300 s
      [ids.stationA, `${DAY}T05:00:00Z`, null, `${DAY}T05:01:00Z`], // cancelled
      [ids.stationA, `${DAY}T06:30:00Z`, null, null], // still queued
    ];
    for (const [station, firedAt, doneAt, cancelledAt] of tickets)
      await client.query(
        `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id,
           status, fired_at, done_at, cancelled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          randomUUID(),
          t,
          outletId,
          randomUUID(),
          station,
          randomUUID(),
          cancelledAt ? "cancelled" : doneAt ? "done" : "new",
          firedAt,
          doneAt,
          cancelledAt,
        ],
      );
    // [kind, businessDate]
    const deductions: [string, string][] = [
      ["remake", DAY],
      ["remake", DAY],
      ["comp", DAY],
      ["sale", DAY],
      ["remake", NEXT_DAY],
    ];
    for (const [kind, businessDate] of deductions)
      await client.query(
        `INSERT INTO recipe_deductions (tenant_id, outlet_id, kind, status, mode, source_type, source_id,
           business_date, idempotency_key, skip_reason, occurred_at)
         VALUES ($1, $2, $3, 'skipped', 'real_time', 'order_issue', $4, $5, $6, 'no_recipe', $7)`,
        [
          t,
          outletId,
          kind,
          randomUUID(),
          businessDate,
          randomUUID(),
          `${businessDate}T05:00:00Z`,
        ],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return ids;
}

type Stored = { value: string; finality: string };

async function stored(
  world: World,
  outletId: string,
  businessDate: string,
): Promise<Map<string, Stored>> {
  const { rows } = await owner.query<{
    metric_code: string;
    dimension_key: string | null;
    dimension_value: string | null;
    value: string;
    finality: string;
  }>(
    `SELECT metric_code, dimension_key, dimension_value,
            coalesce(value_int::text, value_decimal::text) AS value, finality
       FROM metrics_daily
      WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3`,
    [world.tenantId, outletId, businessDate],
  );
  return new Map(
    rows.map((row) => [
      `${row.metric_code}|${row.dimension_key ?? ""}|${row.dimension_value ?? ""}`,
      { value: row.value, finality: row.finality },
    ]),
  );
}

const key = (code: string, dimKey = "", dimValue = "") =>
  `${code}|${dimKey}|${dimValue}`;

function refresh(
  world: World,
  outletId: string,
  businessDate: string,
  now: Date = LATE,
) {
  return refreshMetricsDaily(
    context(world.tenantId),
    { outletId, businessDate: date(businessDate) },
    now,
    { readers },
  );
}

let a: World;
let b: World;
let seedA: Seed;
let seedA2: Seed;
let seedB: Seed;

beforeAll(async () => {
  a = await makeWorld("a");
  b = await makeWorld("b");
  seedA = await seed(a, a.outlet1);
  seedA2 = await seed(a, a.outlet2);
  seedB = await seed(b, b.outlet1);
});

afterAll(async () => {
  await owner.query("DELETE FROM metrics_daily WHERE tenant_id = ANY($1)", [
    [a.tenantId, b.tenantId],
  ]);
});

describe("traffic-operations registry", () => {
  it("claims its metrics: daily readers and unavailable sources", () => {
    expect(() => assertRegistry(METRIC_SOURCE_MODULES)).not.toThrow();
    for (const code of [
      "pax",
      "table_turnover",
      "avg_dwell_minutes",
      "waiter_call_count",
      "order_queue_count",
      "avg_serving_time",
      "remake_count",
      "comp_count",
    ])
      expect(metricSourceOf(code).kind, code).toBe("daily");
    for (const code of [
      "failed_item_count",
      "apology_voucher_count",
      "device_offline_count",
      "table_occupancy_pct",
    ])
      expect(metricSourceOf(code), code).toMatchObject({
        kind: "unavailable",
        reason: "source_not_built",
      });
    expect(readers.length).toBeGreaterThan(0);
    for (const { reader } of readers as {
      reader: DailyMetricReader;
    }[])
      expect(reader.metricCodes.length).toBeGreaterThan(0);
  });
});

describe("traffic-operations daily rows", () => {
  it("computes the figures of the seeded day, zone and station splits", async () => {
    await refresh(a, a.outlet1, DAY);
    const rows = await stored(a, a.outlet1, DAY);
    const value = (k: string) => rows.get(k)?.value;

    // pax: voided session excluded (3 + 2 + 4).
    expect(value(key("pax"))).toBe("9");
    expect(value(key("pax", "zone", seedA.zone1))).toBe("5");
    expect(value(key("pax", "zone", seedA.zone2))).toBe("4");
    expect(value(key("pax", "hour", "12"))).toBe("5");
    expect(value(key("pax", "hour", "13"))).toBe("4");

    // turnover: 2 closed sessions / 4 tables in service (the inactive one is out).
    expect(value(key("table_turnover"))).toBe("0.5000");
    expect(value(key("table_turnover", "zone", seedA.zone1))).toBe("0.6667");
    expect(value(key("table_turnover", "zone", seedA.zone2))).toBe("0.0000");
    // dwell: (60 + 30) / 2 minutes.
    expect(value(key("avg_dwell_minutes"))).toBe("45.0000");
    expect(value(key("avg_dwell_minutes", "zone", seedA.zone1))).toBe(
      "45.0000",
    );

    // waiter calls: the cancelled call and the bill request are out.
    expect(value(key("waiter_call_count"))).toBe("2");
    expect(value(key("waiter_call_count", "zone", seedA.zone1))).toBe("1");
    expect(value(key("waiter_call_count", "zone", seedA.zone2))).toBe("1");

    // kitchen: queue at day end, serving seconds (600 + 1200 + 300) / 3.
    expect(value(key("order_queue_count"))).toBe("1");
    expect(value(key("order_queue_count", "station", seedA.stationA))).toBe(
      "1",
    );
    expect(value(key("avg_serving_time"))).toBe("700");
    expect(value(key("avg_serving_time", "station", seedA.stationA))).toBe(
      "900",
    );
    expect(value(key("avg_serving_time", "station", seedA.stationB))).toBe(
      "300",
    );
    expect(value(key("avg_serving_time", "hour", "12"))).toBe("900");
    expect(value(key("avg_serving_time", "hour", "13"))).toBe("300");

    // remake and comp of the business date only; the sale row is not counted.
    expect(value(key("remake_count"))).toBe("2");
    expect(value(key("comp_count"))).toBe("1");
  });

  it("keeps tenants and outlets apart", async () => {
    await refresh(a, a.outlet2, DAY);
    await refresh(b, b.outlet1, DAY);
    const own = await stored(a, a.outlet1, DAY);
    const sibling = await stored(a, a.outlet2, DAY);
    const foreign = await stored(b, b.outlet1, DAY);
    // Same seed in every outlet: equal totals, but each outlet carries only
    // its own zone ids.
    expect(sibling.get(key("pax"))?.value).toBe("9");
    expect(foreign.get(key("pax"))?.value).toBe("9");
    expect(own.has(key("pax", "zone", seedA2.zone1))).toBe(false);
    expect(sibling.has(key("pax", "zone", seedA.zone1))).toBe(false);
    expect(foreign.has(key("pax", "zone", seedA.zone1))).toBe(false);
    expect(foreign.has(key("pax", "zone", seedB.zone1))).toBe(true);
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM metrics_daily
        WHERE tenant_id = $1 AND outlet_id = ANY($2)`,
      [b.tenantId, [a.outlet1, a.outlet2]],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("writes zero totals and no final label for a day without data", async () => {
    await refresh(a, a.outlet1, EMPTY_DAY);
    const rows = await stored(a, a.outlet1, EMPTY_DAY);
    expect(rows.get(key("pax"))?.value).toBe("0");
    expect(rows.get(key("waiter_call_count"))?.value).toBe("0");
    expect(rows.get(key("remake_count"))?.value).toBe("0");
    expect(rows.get(key("table_turnover"))?.value).toBe("0.0000");
    expect(rows.get(key("order_queue_count"))?.value).toBe("0");
    // No pos_daily_closes row: point-of-sale readers stay estimates.
    expect(rows.get(key("pax"))?.finality).toBe("estimate");
    expect(rows.get(key("remake_count"))?.finality).toBe("estimate");
    // A day the job never computed has no row at all.
    expect((await stored(a, a.outlet1, "2025-07-12")).size).toBe(0);
  });

  it("backfill is idempotent", async () => {
    const from = date(EMPTY_DAY);
    const to = date(NEXT_DAY);
    await recomputeMetricsDaily(context(a.tenantId), a.outlet1, from, to, {
      readers,
      now: LATE,
    });
    const second = await recomputeMetricsDaily(
      context(a.tenantId),
      a.outlet1,
      from,
      to,
      { readers, now: LATE },
    );
    expect(second.written).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.unchanged).toBeGreaterThan(0);
    expect(second.failedFamilies).toEqual([]);
    const next = await stored(a, a.outlet1, NEXT_DAY);
    expect(next.get(key("remake_count"))?.value).toBe("1");
    expect(next.get(key("comp_count"))?.value).toBe("0");
  });
});

describe("traffic-operations reports through the engine", () => {
  function evaluate(
    codes: string[],
    groupBy: string[] = [],
  ): Promise<EvaluatedMetrics> {
    const ctx = context(a.tenantId, a.outlet1);
    return withTenantSnapshot(ctx, (tx) =>
      evaluateMetrics(
        tx,
        ctx,
        {
          metricCodes: codes,
          period: { start: date(DAY), end: date(DAY) },
          bucket: "total",
          outletFilter: outletIdsForQuery(ctx.outletScope),
          groupBy,
          filters: [],
          comparePrevious: false,
          viewer: "full",
        },
        LATE,
      ),
    );
  }

  it("answers pax per zone and the unbuilt metrics as unavailable", async () => {
    await refresh(a, a.outlet1, DAY);
    const result = await evaluate(["pax"], ["zone"]);
    expect(result.availability[0]?.status).toBe("available");
    const unbuilt = await evaluate(["failed_item_count"]);
    expect(unbuilt.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "source_not_built",
    });
    const byZone = result.series
      .filter((series) => series.metricCode === "pax" && series.dimension)
      .map((series) => [
        series.dimension!.value,
        (series.points[0]!.value as { value: number }).value,
      ]);
    expect(Object.fromEntries(byZone)).toEqual({
      [seedA.zone1]: 5,
      [seedA.zone2]: 4,
    });
  });

  it("marks a split the reader does not build as not supported", async () => {
    const result = await evaluate(["remake_count"], ["station"]);
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
  });
});
