// Fail-first tests for the metrics_daily refresh job (WS-11 foundation, bead
// legend-5wzoc; contract: docs/briefs/sub-ws11-foundation-design.md §2.3-2.5,
// decision "Metric sources, metrics_daily and report runs" in docs/DECISIONS.md).
//
// Written from the contract only; `services/metrics-daily.service.ts`,
// `worker/metrics-daily.job.ts` and the `metrics_daily` table do not exist yet,
// so this file fails at import until the foundation lands. Test readers are
// injected through `options.readers`, so no family card is needed.
//
// ASSUMPTIONS (the contract leaves these open; each lives in one place):
// - Column names of `metrics_daily` are the ones in design §2.3; rows are read
//   with raw SQL so the drizzle property names do not matter.
// - `written` counts inserted plus changed rows, `unchanged` counts rows whose
//   value, finality and definition version did not move, `deleted` counts rows
//   removed because the reader no longer returns them.
// - `failedFamilies` holds the `family` string passed in `options.readers`.
// - A throttled `runMetricsDailyJob` call returns null (like
//   `runAiDailySummaryJob`); any other call returns a non-null result.
// - Business-day end is asserted through `businessDayRange` with the outlet's
//   own `business_day_cutoff`, the way ai-anomaly-summary.test.ts does.
// - A refresh for a tenant other than the context's writes nothing for the
//   foreign outlet. Whether it rejects or no-ops is not pinned: the test
//   accepts both and checks the rows.
//
// Every run builds its own tenants and uses distinct business dates per test,
// so tests do not share rows.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  addBusinessDays,
  businessDateSchema,
  businessDayRange,
  idr,
  outletIdSchema,
  tenantIdSchema,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { MetricValue } from "@starter/shared/metrics";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  recomputeMetricsDaily,
  refreshMetricsDaily,
} from "../services/metrics-daily.service";
import {
  METRICS_DAILY_INTERVAL_MS,
  METRICS_DAILY_REFRESH_DAYS,
  METRICS_DAILY_SETTLE_MS,
  resetMetricsDailyJobThrottle,
  runMetricsDailyJob,
} from "../worker/metrics-daily.job";
import type { DailyMetricReader } from "../services/metric-sources/types";
import { agent, signUp } from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type World = {
  tenantId: string;
  outlet1: string;
  outlet2: string;
  cutoff: string;
};

type Row = {
  id: string;
  metric_code: string;
  dimension_key: string | null;
  dimension_value: string | null;
  value_int: string | null;
  finality: string;
  updated_at: Date;
};

let world: World;
let other: World;
let closerUserId: string;

function context(
  tenantId: string,
  scope: { kind: "tenant" } | { kind: "outlets"; outletIds: string[] } = {
    kind: "tenant",
  },
): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(
    tenant,
    scope.kind === "tenant"
      ? scope
      : {
          kind: "outlets",
          outletIds: scope.outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );
}

const date = (value: string): BusinessDate => businessDateSchema.parse(value);
const count = (value: number): MetricValue => ({ unit: "count", value });

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `mdj-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const { rows } = await owner.query<{ cutoff: string }>(
    "SELECT business_day_cutoff AS cutoff FROM outlets WHERE id = $1",
    [tenant.outletId],
  );
  return {
    tenantId: tenant.tenantId,
    outlet1: tenant.outletId,
    outlet2,
    cutoff: rows[0]!.cutoff,
  };
}

/** A reader the tests steer: `rows` is read at every compute call. */
function makeReader(input: {
  metricCodes: string[];
  dimensions?: "channel"[];
  requiresDailyClose?: boolean;
  writesTotal?: boolean;
  rows: () => {
    metricCode: string;
    dimension: { key: "channel"; value: string } | null;
    value: MetricValue;
  }[];
  throws?: boolean;
}): DailyMetricReader {
  return {
    metricCodes: input.metricCodes,
    dimensions: input.dimensions ?? [],
    requiresDailyClose: input.requiresDailyClose ?? false,
    ...(input.writesTotal === undefined
      ? {}
      : { writesTotal: input.writesTotal }),
    async compute() {
      if (input.throws) throw new Error("reader boom");
      return input.rows();
    },
  };
}

/** `transaction_count` (count): total plus one row per channel. */
function trafficReader(
  channels: Record<string, number>,
  opts: { total?: number; requiresDailyClose?: boolean } = {},
) {
  return makeReader({
    metricCodes: ["transaction_count"],
    dimensions: ["channel"],
    requiresDailyClose: opts.requiresDailyClose ?? false,
    rows: () => [
      {
        metricCode: "transaction_count",
        dimension: null,
        value: count(
          opts.total ?? Object.values(channels).reduce((a, b) => a + b, 0),
        ),
      },
      ...Object.entries(channels).map(([value, n]) => ({
        metricCode: "transaction_count",
        dimension: { key: "channel" as const, value },
        value: count(n),
      })),
    ],
  });
}

async function rowsOf(
  tenantId: string,
  outletId: string,
  businessDate: string,
): Promise<Row[]> {
  const { rows } = await owner.query<Row>(
    `SELECT id, metric_code, dimension_key, dimension_value,
            value_int::text AS value_int, finality, updated_at
       FROM metrics_daily
      WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
      ORDER BY metric_code, dimension_key NULLS FIRST, dimension_value NULLS FIRST`,
    [tenantId, outletId, businessDate],
  );
  return rows;
}

async function countFor(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM metrics_daily WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

function refresh(
  w: World,
  businessDate: string,
  now: Date,
  readers: { family: string; reader: DailyMetricReader }[],
  outletId: string = w.outlet1,
) {
  return refreshMetricsDaily(
    context(w.tenantId),
    { outletId, businessDate: date(businessDate) },
    now,
    { readers },
  );
}

/** One instant long after every test date: all of them are settled. */
const LATE = new Date("2025-12-20T05:00:00Z");

async function markDayClosed(w: World, outletId: string, businessDate: string) {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [w.tenantId],
    );
    await client.query(
      `INSERT INTO pos_daily_closes
         (tenant_id, outlet_id, business_date, order_count, total_sales_idr,
          total_refunds_idr, total_voids_idr, total_variance_idr,
          inventory_deduction_applied, recap, closed_by, closed_at,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0, false, '{}', $4, now(), $5, $6)`,
      [
        w.tenantId,
        outletId,
        businessDate,
        closerUserId,
        randomUUID(),
        "0".repeat(64),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  world = await makeWorld("a");
  other = await makeWorld("b");
  const email = await signUp(agent(), "Penutup Hari");
  const { rows } = await owner.query<{ id: string }>(
    'SELECT id FROM "user" WHERE email = $1',
    [email],
  );
  closerUserId = rows[0]!.id;
});

afterAll(async () => {
  await owner.end();
});

describe("refreshMetricsDaily: idempotent writes", () => {
  it("writes the total and each split of an outlet-day once", async () => {
    const reader = trafficReader({ dine_in: 30, takeaway: 12 });
    const result = await refresh(world, "2025-06-01", LATE, [
      { family: "traffic-operations", reader },
    ]);
    expect(result).toEqual({
      written: 3,
      unchanged: 0,
      deleted: 0,
      failedFamilies: [],
    });
    const rows = await rowsOf(world.tenantId, world.outlet1, "2025-06-01");
    expect(
      rows.map((r) => [r.dimension_key, r.dimension_value, r.value_int]),
    ).toEqual([
      [null, null, "42"],
      ["channel", "dine_in", "30"],
      ["channel", "takeaway", "12"],
    ]);
  });

  it("two runs leave the same row ids, updated_at and row count", async () => {
    const readers = [
      {
        family: "traffic-operations",
        reader: trafficReader({ dine_in: 5, takeaway: 7 }),
      },
    ];
    await refresh(world, "2025-06-02", LATE, readers);
    const before = await rowsOf(world.tenantId, world.outlet1, "2025-06-02");
    const second = await refresh(
      world,
      "2025-06-02",
      new Date(LATE.getTime() + 60_000),
      readers,
    );
    const after = await rowsOf(world.tenantId, world.outlet1, "2025-06-02");
    expect(after).toHaveLength(3);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.updated_at.getTime())).toEqual(
      before.map((r) => r.updated_at.getTime()),
    );
    expect(second).toMatchObject({ written: 0, unchanged: 3, deleted: 0 });
  });

  it("a changed value updates the same row and moves updated_at", async () => {
    const channels = { dine_in: 10 };
    const readers = [
      {
        family: "traffic-operations",
        reader: trafficReader(channels),
      },
    ];
    await refresh(world, "2025-06-03", LATE, readers);
    const before = await rowsOf(world.tenantId, world.outlet1, "2025-06-03");
    channels.dine_in = 15;
    const result = await refresh(world, "2025-06-03", LATE, readers);
    const after = await rowsOf(world.tenantId, world.outlet1, "2025-06-03");
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.value_int)).toEqual(["15", "15"]);
    expect(result.written).toBe(2);
    for (const [index, row] of after.entries())
      expect(row.updated_at.getTime()).toBeGreaterThan(
        before[index]!.updated_at.getTime(),
      );
  });

  it("deletes a dimension that disappears, only for the reader's own codes", async () => {
    const channels: Record<string, number> = { dine_in: 4, takeaway: 6 };
    const traffic = trafficReader(channels);
    const pax = makeReader({
      metricCodes: ["pax"],
      rows: () => [{ metricCode: "pax", dimension: null, value: count(99) }],
    });
    const readers = [
      { family: "traffic-operations", reader: traffic },
      { family: "sales", reader: pax },
    ];
    await refresh(world, "2025-06-04", LATE, readers);
    expect(
      await rowsOf(world.tenantId, world.outlet1, "2025-06-04"),
    ).toHaveLength(4);

    delete channels.takeaway;
    const result = await refresh(world, "2025-06-04", LATE, readers);
    const rows = await rowsOf(world.tenantId, world.outlet1, "2025-06-04");
    expect(result.deleted).toBe(1);
    expect(
      rows.map((r) => [r.metric_code, r.dimension_key, r.dimension_value]),
    ).toEqual([
      ["pax", null, null],
      ["transaction_count", null, null],
      ["transaction_count", "channel", "dine_in"],
    ]);
  });

  it("keeps rows of another reader with the same code in another dimension", async () => {
    const byChannel = makeReader({
      metricCodes: ["transaction_count"],
      dimensions: ["channel"],
      writesTotal: false,
      rows: () => [
        {
          metricCode: "transaction_count",
          dimension: { key: "channel", value: "dine_in" },
          value: count(4),
        },
      ],
    });
    const total = makeReader({
      metricCodes: ["transaction_count"],
      rows: () => [
        { metricCode: "transaction_count", dimension: null, value: count(4) },
      ],
    });
    const readers = [
      { family: "traffic-operations", reader: byChannel },
      { family: "sales", reader: total },
    ];
    await refresh(world, "2025-06-25", LATE, readers);
    const result = await refresh(world, "2025-06-25", LATE, readers);
    expect(result.deleted).toBe(0);
    expect(
      (await rowsOf(world.tenantId, world.outlet1, "2025-06-25")).map((r) => [
        r.dimension_key,
        r.dimension_value,
      ]),
    ).toEqual([
      [null, null],
      ["channel", "dine_in"],
    ]);
  });

  it("owns the stale total row unless the reader says writesTotal: false", async () => {
    let withTotal = true;
    const rows = () => [
      ...(withTotal
        ? [
            {
              metricCode: "transaction_count",
              dimension: null,
              value: count(4),
            },
          ]
        : []),
      {
        metricCode: "transaction_count",
        dimension: { key: "channel" as const, value: "dine_in" },
        value: count(4),
      },
    ];
    const declared = makeReader({
      metricCodes: ["transaction_count"],
      dimensions: ["channel"],
      writesTotal: true,
      rows,
    });
    const readers = [{ family: "sales", reader: declared }];
    await refresh(world, "2025-06-26", LATE, readers);
    withTotal = false;
    const result = await refresh(world, "2025-06-26", LATE, readers);
    expect(result.deleted).toBe(1);
    expect(
      (await rowsOf(world.tenantId, world.outlet1, "2025-06-26")).map((r) => [
        r.dimension_key,
        r.dimension_value,
      ]),
    ).toEqual([["channel", "dine_in"]]);

    // A split reader that does not own the total never deletes it.
    const split = makeReader({
      metricCodes: ["transaction_count"],
      dimensions: ["channel"],
      writesTotal: false,
      rows: () => [
        {
          metricCode: "transaction_count",
          dimension: { key: "channel" as const, value: "dine_in" },
          value: count(4),
        },
      ],
    });
    const total = makeReader({
      metricCodes: ["transaction_count"],
      rows: () => [
        { metricCode: "transaction_count", dimension: null, value: count(4) },
      ],
    });
    const both = [
      { family: "traffic-operations", reader: split },
      { family: "sales", reader: total },
    ];
    await refresh(world, "2025-06-27", LATE, both);
    const again = await refresh(world, "2025-06-27", LATE, both);
    expect(again.deleted).toBe(0);
  });

  it("writes only the outlet-date asked for", async () => {
    await refresh(world, "2025-06-05", LATE, [
      { family: "sales", reader: trafficReader({ dine_in: 1 }) },
    ]);
    expect(
      await rowsOf(world.tenantId, world.outlet2, "2025-06-05"),
    ).toHaveLength(0);
    expect(
      await rowsOf(world.tenantId, world.outlet1, "2025-06-06"),
    ).toHaveLength(0);
  });

  it("two concurrent runs leave no duplicate rows and no error", async () => {
    const readers = [
      {
        family: "traffic-operations",
        reader: trafficReader({ dine_in: 8, takeaway: 2, delivery: 1 }),
      },
    ];
    const results = await Promise.allSettled([
      refresh(world, "2025-06-07", LATE, readers),
      refresh(world, "2025-06-07", LATE, readers),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const rows = await rowsOf(world.tenantId, world.outlet1, "2025-06-07");
    expect(rows).toHaveLength(4);
    expect(
      new Set(rows.map((r) => `${r.metric_code}/${r.dimension_value}`)).size,
    ).toBe(4);
  });
});

describe("refreshMetricsDaily: a failing family", () => {
  it("does not block other readers and keeps its earlier rows", async () => {
    // Seed one void_amount row with a working reader first.
    const working = makeReader({
      metricCodes: ["void_amount"],
      rows: () => [
        {
          metricCode: "void_amount",
          dimension: null,
          value: { unit: "idr", valueIdr: idr(15_000) },
        },
      ],
    });
    await refresh(world, "2025-06-08", LATE, [
      { family: "traffic-operations", reader: working },
    ]);

    const broken = makeReader({
      metricCodes: ["void_amount"],
      rows: () => [],
      throws: true,
    });
    const good = trafficReader({ dine_in: 3 });
    const result = await refresh(world, "2025-06-08", LATE, [
      { family: "traffic-operations", reader: broken },
      { family: "sales", reader: good },
    ]);
    expect(result.failedFamilies).toEqual(["traffic-operations"]);
    const rows = await rowsOf(world.tenantId, world.outlet1, "2025-06-08");
    expect(rows.map((r) => r.metric_code).sort()).toEqual([
      "transaction_count",
      "transaction_count",
      "void_amount",
    ]);
    expect(rows.find((r) => r.metric_code === "void_amount")!.value_int).toBe(
      "15000",
    );
  });
});

describe("finality of a stored row (design §2.4)", () => {
  it("is estimate while the business day has not ended", async () => {
    // 05:00Z is noon in Asia/Jakarta: inside business day 2025-06-10.
    const now = new Date("2025-06-10T05:00:00Z");
    await refresh(world, "2025-06-10", now, [
      { family: "sales", reader: trafficReader({ dine_in: 2 }) },
    ]);
    const rows = await rowsOf(world.tenantId, world.outlet1, "2025-06-10");
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.finality))).toEqual(new Set(["estimate"]));
  });

  it("is estimate until the settle delay passed, then final", async () => {
    const clock = { timeZone: "Asia/Jakarta", cutoff: world.cutoff };
    const dayEnd = businessDayRange(date("2025-06-11"), clock).end;
    const reader = trafficReader({ dine_in: 2 });
    const readers = [{ family: "sales", reader }];

    await refresh(
      world,
      "2025-06-11",
      new Date(dayEnd.getTime() + METRICS_DAILY_SETTLE_MS - 60_000),
      readers,
    );
    expect(
      new Set(
        (await rowsOf(world.tenantId, world.outlet1, "2025-06-11")).map(
          (r) => r.finality,
        ),
      ),
    ).toEqual(new Set(["estimate"]));

    await refresh(
      world,
      "2025-06-11",
      new Date(dayEnd.getTime() + METRICS_DAILY_SETTLE_MS + 60_000),
      readers,
    );
    expect(
      new Set(
        (await rowsOf(world.tenantId, world.outlet1, "2025-06-11")).map(
          (r) => r.finality,
        ),
      ),
    ).toEqual(new Set(["final"]));
  });

  it("a point-of-sale reader needs a pos_daily_closes row to reach final", async () => {
    const readers = [
      {
        family: "sales",
        reader: trafficReader({ dine_in: 2 }, { requiresDailyClose: true }),
      },
    ];
    await refresh(world, "2025-06-12", LATE, readers);
    expect(
      new Set(
        (await rowsOf(world.tenantId, world.outlet1, "2025-06-12")).map(
          (r) => r.finality,
        ),
      ),
    ).toEqual(new Set(["estimate"]));

    await markDayClosed(world, world.outlet1, "2025-06-12");
    await refresh(world, "2025-06-12", LATE, readers);
    expect(
      new Set(
        (await rowsOf(world.tenantId, world.outlet1, "2025-06-12")).map(
          (r) => r.finality,
        ),
      ),
    ).toEqual(new Set(["final"]));
  });

  it("a day close of another outlet does not finalize this outlet", async () => {
    await markDayClosed(world, world.outlet2, "2025-06-13");
    await refresh(world, "2025-06-13", LATE, [
      {
        family: "sales",
        reader: trafficReader({ dine_in: 2 }, { requiresDailyClose: true }),
      },
    ]);
    expect(
      new Set(
        (await rowsOf(world.tenantId, world.outlet1, "2025-06-13")).map(
          (r) => r.finality,
        ),
      ),
    ).toEqual(new Set(["estimate"]));
  });

  it("a reader without requiresDailyClose is final once settled", async () => {
    await refresh(world, "2025-06-14", LATE, [
      { family: "hr", reader: trafficReader({ dine_in: 2 }) },
    ]);
    expect(
      new Set(
        (await rowsOf(world.tenantId, world.outlet1, "2025-06-14")).map(
          (r) => r.finality,
        ),
      ),
    ).toEqual(new Set(["final"]));
  });

  it("a reader's pendingDay keeps a settled day an estimate until it lets go", async () => {
    let pending = true;
    const seen: Date[] = [];
    const base = trafficReader({ dine_in: 2 });
    const reader: DailyMetricReader = {
      ...base,
      async pendingDay(input) {
        seen.push(input.now);
        return pending;
      },
    };
    const finalities = async () =>
      new Set(
        (await rowsOf(world.tenantId, world.outlet1, "2025-06-15")).map(
          (r) => r.finality,
        ),
      );
    await refresh(world, "2025-06-15", LATE, [{ family: "hr", reader }]);
    expect(await finalities()).toEqual(new Set(["estimate"]));
    expect(seen).toEqual([LATE]);

    pending = false;
    await refresh(world, "2025-06-15", LATE, [{ family: "hr", reader }]);
    expect(await finalities()).toEqual(new Set(["final"]));
  });

  it("a held reader does not hold another reader of the same day", async () => {
    await refresh(world, "2025-06-16", LATE, [
      {
        family: "reservation-delivery",
        reader: {
          ...makeReader({
            metricCodes: ["delivery_orders"],
            rows: () => [
              {
                metricCode: "delivery_orders",
                dimension: null,
                value: count(1),
              },
            ],
          }),
          pendingDay: async () => true,
        },
      },
      { family: "hr", reader: trafficReader({ dine_in: 2 }) },
    ]);
    const rows = await rowsOf(world.tenantId, world.outlet1, "2025-06-16");
    expect(
      Object.fromEntries(
        rows
          .filter((r) => r.dimension_key === null)
          .map((r) => [r.metric_code, r.finality]),
      ),
    ).toEqual({ delivery_orders: "estimate", transaction_count: "final" });
  });

  it("asks pendingDay before compute, so a hold that ends mid-run keeps the row an estimate", async () => {
    // The order completes while compute runs: compute already saw the old
    // state, so the row it returns must not be labelled final.
    let pending = true;
    const calls: string[] = [];
    const reader: DailyMetricReader = {
      ...trafficReader({ dine_in: 2 }),
      async pendingDay() {
        calls.push("pendingDay");
        return pending;
      },
      async compute() {
        calls.push("compute");
        pending = false;
        return [
          {
            metricCode: "transaction_count",
            dimension: null,
            value: count(2),
          },
        ];
      },
    };
    await refresh(world, "2025-07-01", LATE, [{ family: "hr", reader }]);
    expect(calls).toEqual(["pendingDay", "compute"]);
    expect(
      (await rowsOf(world.tenantId, world.outlet1, "2025-07-01")).map(
        (r) => r.finality,
      ),
    ).toEqual(["estimate"]);
  });

  it("keepFinal: final rows are neither rewritten nor deleted; estimates and empty days are written", async () => {
    let rows = [
      {
        metricCode: "transaction_count",
        dimension: null,
        value: count(1),
      },
    ];
    const reader: DailyMetricReader = {
      ...makeReader({ metricCodes: ["transaction_count"], rows: () => rows }),
      keepFinal: true,
    };
    const readers = [{ family: "facility", reader }];
    const snapshot = async () =>
      (await rowsOf(world.tenantId, world.outlet1, "2025-07-02")).map((r) => ({
        id: r.id,
        value: r.value_int,
        finality: r.finality,
        updatedAt: r.updated_at.getTime(),
      }));

    // No rows yet, day still open: written as an estimate.
    await refresh(
      world,
      "2025-07-02",
      new Date("2025-07-02T05:00:00Z"),
      readers,
    );
    expect((await snapshot()).map((r) => [r.value, r.finality])).toEqual([
      ["1", "estimate"],
    ]);

    // An estimate is still rewritten, and turns final once settled.
    rows = [{ ...rows[0]!, value: count(2) }];
    await refresh(world, "2025-07-02", LATE, readers);
    const final = await snapshot();
    expect(final.map((r) => [r.value, r.finality])).toEqual([["2", "final"]]);

    // A new value later changes nothing, and an empty answer deletes nothing.
    rows = [{ ...rows[0]!, value: count(3) }];
    await refresh(world, "2025-07-02", LATE, readers);
    expect(await snapshot()).toEqual(final);
    rows = [];
    await refresh(world, "2025-07-02", LATE, readers);
    expect(await snapshot()).toEqual(final);
  });

  it("hands the job's clock to every reader as `now`", async () => {
    const seen: Date[] = [];
    const now = new Date("2025-06-17T05:00:00Z");
    await refresh(world, "2025-06-17", now, [
      {
        family: "hr",
        reader: {
          ...trafficReader({ dine_in: 1 }),
          async compute(input) {
            seen.push(input.now);
            return [
              {
                metricCode: "transaction_count",
                dimension: null,
                value: count(1),
              },
            ];
          },
        },
      },
    ]);
    expect(seen).toEqual([now]);
  });
});

describe("recomputeMetricsDaily", () => {
  it("rewrites every date of an older range", async () => {
    const readers = [
      { family: "sales", reader: trafficReader({ dine_in: 1 }) },
    ];
    await recomputeMetricsDaily(
      context(world.tenantId),
      world.outlet1,
      date("2025-05-01"),
      date("2025-05-03"),
      { readers },
    );
    for (const day of ["2025-05-01", "2025-05-02", "2025-05-03"])
      expect(await rowsOf(world.tenantId, world.outlet1, day)).toHaveLength(2);
    expect(
      await rowsOf(world.tenantId, world.outlet1, "2025-05-04"),
    ).toHaveLength(0);
  });
});

describe("metrics_daily isolation (RLS)", () => {
  const visible = (ctx: ScopedTenantContext) =>
    withTenant(db, ctx, async (tx) => {
      const result = await tx.execute(
        sql`SELECT outlet_id AS outlet, tenant_id AS tenant FROM metrics_daily WHERE metric_date = '2025-06-20'`,
      );
      return result.rows as { outlet: string; tenant: string }[];
    });

  beforeAll(async () => {
    const readers = [
      { family: "sales", reader: trafficReader({ dine_in: 1 }) },
    ];
    await refresh(world, "2025-06-20", LATE, readers, world.outlet1);
    await refresh(world, "2025-06-20", LATE, readers, world.outlet2);
    await refresh(other, "2025-06-20", LATE, readers, other.outlet1);
  });

  it("a tenant sees only its own rows", async () => {
    const a = await visible(context(world.tenantId));
    expect(a.length).toBe(4);
    expect(new Set(a.map((r) => r.tenant))).toEqual(new Set([world.tenantId]));
    const b = await visible(context(other.tenantId));
    expect(new Set(b.map((r) => r.tenant))).toEqual(new Set([other.tenantId]));
    expect(b.length).toBe(2);
  });

  it("an outlet-scoped context reads only its own outlet", async () => {
    const rows = await visible(
      context(world.tenantId, { kind: "outlets", outletIds: [world.outlet1] }),
    );
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.outlet))).toEqual(
      new Set([world.outlet1]),
    );
  });

  it("a tenant B context cannot write rows for a tenant A outlet", async () => {
    const before = await countFor(world.tenantId);
    const beforeB = await countFor(other.tenantId);
    await refreshMetricsDaily(
      context(other.tenantId),
      { outletId: world.outlet1, businessDate: date("2025-06-21") },
      LATE,
      { readers: [{ family: "sales", reader: trafficReader({ dine_in: 1 }) }] },
    ).catch(() => undefined);
    expect(await countFor(world.tenantId)).toBe(before);
    expect(await countFor(other.tenantId)).toBe(beforeB);
    expect(
      await rowsOf(world.tenantId, world.outlet1, "2025-06-21"),
    ).toHaveLength(0);
  });
});

describe("runMetricsDailyJob", () => {
  it("exposes the documented cadence constants", () => {
    expect(METRICS_DAILY_INTERVAL_MS).toBe(15 * 60_000);
    expect(METRICS_DAILY_REFRESH_DAYS).toBe(7);
    expect(METRICS_DAILY_SETTLE_MS).toBeGreaterThan(0);
  });

  it("runs once per interval per tenant unless forced", async () => {
    resetMetricsDailyJobThrottle();
    const ctx = context(world.tenantId);
    const now = new Date("2025-12-20T05:00:00Z");
    expect(await runMetricsDailyJob(ctx, now)).not.toBeNull();
    expect(await runMetricsDailyJob(ctx, now)).toBeNull();
    expect(
      await runMetricsDailyJob(
        ctx,
        new Date(now.getTime() + METRICS_DAILY_INTERVAL_MS + 1),
      ),
    ).not.toBeNull();
    expect(await runMetricsDailyJob(ctx, now, { force: true })).not.toBeNull();
    resetMetricsDailyJobThrottle();
  });

  it("refreshes today and the last 7 days for every open outlet without error", async () => {
    resetMetricsDailyJobThrottle();
    const now = new Date("2025-12-20T05:00:00Z");
    await expect(
      runMetricsDailyJob(context(other.tenantId), now, { force: true }),
    ).resolves.not.toBeUndefined();
    // Dates the job targets stay inside today and 7 days back.
    const today = date("2025-12-20");
    const oldest = addBusinessDays(today, -METRICS_DAILY_REFRESH_DAYS);
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM metrics_daily
        WHERE tenant_id = $1 AND (metric_date < $2 OR metric_date > $3)
          AND metric_date >= '2025-12-01'`,
      [other.tenantId, oldest, today],
    );
    expect(rows[0]!.n).toBe(0);
    resetMetricsDailyJobThrottle();
  });

  it("catch-up: a day held past the window turns final once its hold ends, with the new value", async () => {
    const held = await makeWorld("catchup");
    const day = "2026-01-05";
    let pending = true;
    let orders = 2; // one order is cancelled later
    const computed: string[] = [];
    const isHeldDay = (input: { outletId: string; businessDate: string }) =>
      input.outletId === held.outlet1 && input.businessDate === day;
    const reader: DailyMetricReader = {
      ...makeReader({ metricCodes: ["delivery_orders"], rows: () => [] }),
      async pendingDay(input) {
        return isHeldDay(input) && pending;
      },
      async compute(input) {
        computed.push(`${input.outletId}:${input.businessDate}`);
        return [
          {
            metricCode: "delivery_orders",
            dimension: null,
            value: count(isHeldDay(input) ? orders : 0),
          },
        ];
      },
    };
    const run = (now: string) =>
      runMetricsDailyJob(context(held.tenantId), new Date(now), {
        force: true,
        readers: [{ family: "reservation-delivery", reader }],
      });
    const heldRow = async () =>
      (await rowsOf(held.tenantId, held.outlet1, day)).map((r) => [
        r.value_int,
        r.finality,
      ]);

    await run("2026-01-06T05:00:00Z");
    expect(await heldRow()).toEqual([["2", "estimate"]]);

    // Ten days later the day is outside the 7-day window and still held.
    computed.length = 0;
    await run("2026-01-15T05:00:00Z");
    expect(computed).toContain(`${held.outlet1}:${day}`);
    expect(await heldRow()).toEqual([["2", "estimate"]]);

    // The order is cancelled and the hold ends: the next run finalizes it.
    pending = false;
    orders = 1;
    computed.length = 0;
    await run("2026-01-16T05:00:00Z");
    expect(await heldRow()).toEqual([["1", "final"]]);
    // A final day outside the window (no estimate rows) is not recomputed.
    expect(computed).not.toContain(`${held.outlet1}:2026-01-04`);
    expect(computed).not.toContain(`${held.outlet2}:${day}`);
    resetMetricsDailyJobThrottle();
  });
});
