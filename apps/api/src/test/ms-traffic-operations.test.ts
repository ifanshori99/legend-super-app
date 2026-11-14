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
import { reportMetricByCode } from "@starter/shared/dashboard";
import {
  dailyReaders,
  metricSourceOf,
  metricSplitOf,
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
  type SourceLookup,
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
      // Waiting for a waiter to confirm: nobody was seated yet.
      ["t5", 6, "pending_confirmation", `${DAY}T06:20:00Z`, null],
    ];
    for (const [table, pax, status, openedAt, closedAt] of sessions) {
      const id = randomUUID();
      sessionIds.push(id);
      const closed = status === "closed" || status === "voided";
      await client.query(
        `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
           session_token_hash, session_token_sealed, opened_at, last_activity_at, closed_at, closed_reason)
         VALUES ($1, $2, $3, $4, $5, $11, $6, $7, 'sealed', $8, $8, $9, $10)`,
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
          status === "pending_confirmation" ? "open_bill" : "pay_first",
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
      // Fired days before and never closed: too old to be in the queue.
      [ids.stationA, "2025-07-10T05:00:00Z", null, null],
    ];
    for (const [station, firedAt, doneAt, cancelledAt] of tickets)
      await client.query(
        `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id,
           business_date, ticket_no, status, fired_at, done_at, cancelled_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'), $7, $8, $9, $10)`,
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
    // [kind, businessDate, idempotency key (random when omitted)]
    // A swap replacement (legend-v51rh) is a `remake` row keyed
    // `swap:issue:<id>`; it is not a kitchen remake, so remake_count skips it.
    const deductions: [string, string, string?][] = [
      ["remake", DAY],
      ["remake", DAY],
      ["comp", DAY],
      ["sale", DAY],
      ["remake", NEXT_DAY],
      ["remake", DAY, `swap:issue:${randomUUID()}`],
      ["remake", NEXT_DAY, `swap:issue:${randomUUID()}`],
    ];
    for (const [kind, businessDate, idemKey] of deductions)
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
          idemKey ?? randomUUID(),
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

    // pax: voided and pending_confirmation sessions excluded (3 + 2 + 4).
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
    // The weight of the dwell average: sessions closed on the day.
    expect(value(key("closed_session_count"))).toBe("2");
    expect(value(key("closed_session_count", "zone", seedA.zone1))).toBe("2");
    expect(rows.has(key("closed_session_count", "zone", seedA.zone2))).toBe(
      false,
    );

    // waiter calls: the cancelled call and the bill request are out.
    expect(value(key("waiter_call_count"))).toBe("2");
    expect(value(key("waiter_call_count", "zone", seedA.zone1))).toBe("1");
    expect(value(key("waiter_call_count", "zone", seedA.zone2))).toBe("1");

    // kitchen: queue at day end, serving seconds (600 + 1200 + 300) / 3.
    // The ticket fired on 2025-07-10 is older than the day: not counted.
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
    // The weight of the serving average: tickets done on the day.
    expect(value(key("served_ticket_count"))).toBe("3");
    expect(value(key("served_ticket_count", "station", seedA.stationA))).toBe(
      "2",
    );
    expect(value(key("served_ticket_count", "station", seedA.stationB))).toBe(
      "1",
    );
    expect(value(key("served_ticket_count", "hour", "12"))).toBe("2");
    expect(value(key("served_ticket_count", "hour", "13"))).toBe("1");

    // remake and comp of the business date only; the sale row and the swap
    // replacement remake (`swap:issue:...`) are not counted.
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
    // Averages store 0 on a quiet day (total-row rule) with a volume of 0, so
    // the weighted multi-day mean leaves the day out.
    expect(rows.get(key("avg_serving_time"))?.value).toBe("0");
    expect(rows.get(key("avg_dwell_minutes"))?.value).toBe("0.0000");
    expect(rows.get(key("served_ticket_count"))?.value).toBe("0");
    expect(rows.get(key("closed_session_count"))?.value).toBe("0");
    expect(rows.has(key("avg_serving_time", "station", seedA.stationA))).toBe(
      false,
    );
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

  it("averages over days weighted by volume; a day without volume is left out (S8)", async () => {
    const outletId = b.outlet2;
    const station = randomUUID();
    const insert = (
      day: string,
      code: string,
      value: string,
      dimension: [string, string] | null = null,
    ) => {
      const definition = reportMetricByCode.get(code)!;
      const decimal = definition.unit === "decimal";
      return owner.query(
        `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code,
           definition_id, definition_version, dimension_key, dimension_value,
           unit, value_int, value_decimal, finality, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'final', now())`,
        [
          b.tenantId,
          outletId,
          day,
          code,
          definition.id,
          definition.version,
          dimension?.[0] ?? null,
          dimension?.[1] ?? null,
          definition.unit,
          decimal ? null : value,
          decimal ? value : null,
        ],
      );
    };
    // 1 Jun: 1 ticket at 100 s, 1 session of 10 min; 2 Jun: 3 tickets at
    // 400 s, 3 sessions of 40 min; 3 Jun: quiet (average 0, volume 0).
    for (const [day, serving, tickets, dwell, sessions] of [
      ["2025-06-01", "100", "1", "10.0000", "1"],
      ["2025-06-02", "400", "3", "40.0000", "3"],
      ["2025-06-03", "0", "0", "0.0000", "0"],
    ] as const) {
      await insert(day, "avg_serving_time", serving);
      await insert(day, "served_ticket_count", tickets);
      await insert(day, "avg_dwell_minutes", dwell);
      await insert(day, "closed_session_count", sessions);
      if (tickets !== "0") {
        await insert(day, "avg_serving_time", serving, ["station", station]);
        await insert(day, "served_ticket_count", tickets, ["station", station]);
      }
    }
    const ctx = context(b.tenantId, outletId);
    const run = (codes: string[], groupBy: string[] = []) =>
      withTenantSnapshot(ctx, (tx) =>
        evaluateMetrics(
          tx,
          ctx,
          {
            metricCodes: codes,
            period: { start: date("2025-06-01"), end: date("2025-06-03") },
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
    const valueOf = (result: EvaluatedMetrics, code: string) =>
      (
        result.series.find((series) => series.metricCode === code)!.points[0]!
          .value as { value: unknown }
      ).value;
    const total = await run(["avg_serving_time", "avg_dwell_minutes"]);
    // (100 × 1 + 400 × 3) / 4, not (100 + 400 + 0) / 3.
    expect(valueOf(total, "avg_serving_time")).toBe(325);
    // (10 × 1 + 40 × 3) / 4, not (10 + 40 + 0) / 3.
    expect(valueOf(total, "avg_dwell_minutes")).toBe("32.5000");
    const byStation = await run(["avg_serving_time"], ["station"]);
    expect(valueOf(byStation, "avg_serving_time")).toBe(325);
  });

  // Rows of avg_serving_time (and its weight) for outlet 1 of tenant b.
  async function storedServing(
    rows: readonly (readonly [string, string, string | null])[],
    sources?: SourceLookup,
  ) {
    const outletId = b.outlet1;
    for (const [day, serving, tickets] of rows)
      for (const [code, value] of [
        ["avg_serving_time", serving],
        ["served_ticket_count", tickets],
      ] as const) {
        if (value === null) continue;
        const definition = reportMetricByCode.get(code)!;
        await owner.query(
          `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code,
             definition_id, definition_version, unit, value_int, finality, computed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'final', now())`,
          [
            b.tenantId,
            outletId,
            day,
            code,
            definition.id,
            definition.version,
            definition.unit,
            value,
          ],
        );
      }
    const ctx = context(b.tenantId, outletId);
    const [first, last] = [rows[0]![0], rows.at(-1)![0]];
    return withTenantSnapshot(ctx, (tx) =>
      evaluateMetrics(
        tx,
        ctx,
        {
          metricCodes: ["avg_serving_time"],
          period: { start: date(first), end: date(last) },
          bucket: "total",
          outletFilter: outletIdsForQuery(ctx.outletScope),
          groupBy: [],
          filters: [],
          comparePrevious: false,
          viewer: "full",
        },
        LATE,
        sources ? { sources } : {},
      ),
    );
  }

  it("days without a stored weight row fall back to the plain mean; a real zero volume stays out (R-A 1)", async () => {
    // Rows written before the weight code existed: no served_ticket_count.
    const result = await storedServing([
      ["2025-08-01", "100", null],
      ["2025-08-02", "400", null],
      ["2025-08-03", "0", "0"],
    ]);
    expect(result.availability[0]?.status).toBe("available");
    expect(
      (result.series[0]!.points[0]!.value as { value: unknown } | null)?.value,
    ).toBe(250);
  });

  it("a weight that is not a stored daily count makes the average unsupported (R-A 5)", async () => {
    const sources: SourceLookup = {
      sourceOf: (code) =>
        code === "served_ticket_count"
          ? {
              kind: "derived",
              code,
              numerator: "pax",
              denominator: "pax",
              scale: 1,
            }
          : metricSourceOf(code),
      splitOf: metricSplitOf,
    };
    const result = await storedServing([["2025-08-10", "100", "1"]], sources);
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
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
