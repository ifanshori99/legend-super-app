// Fail-first tests of the facility metric sources (WS-11 F10, bead
// legend-60tsm; contract docs/briefs/sub-ws11-foundation-design.md §2.1-2.5).
// Data is seeded with the facility tables, the daily readers fill
// `metrics_daily` through `recomputeMetricsDaily`, and every figure is read
// back through the engine (`evaluateMetrics`) like a report run does.
//
// Test day 2025-06-10 (Asia/Jakarta, UTC+7), shower room "S" with units A1 and
// A2 and coworking "W" with unit W1, every facility open 08:00-20:00:
//   A1 completed 09:00-10:00 used until 10:20 (20 min over), completed
//      11:00-12:00 used until 11:50; a cancelled and an issued ticket count nowhere
//   A2 completed 13:00-14:00 on time
//   W1 completed 09:00-11:00 used until 11:30 (30 min over)
//   incidents: S/A1 answered after 300 s, S (no unit) after 600 s, W open.
// Open minutes are 720 per unit.

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
import { reportByCode } from "@starter/shared/dashboard";
import type { MetricDimensionKey } from "@starter/shared/metrics";
import { metricSourceOf } from "../services/metric-sources";
import { unavailableMetrics } from "../../../web/src/features/ws11-reports/mock-families/facility.ts";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import {
  recomputeMetricsDaily,
  refreshMetricsDaily,
} from "../services/metrics-daily.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type Facility = { id: string; areaId: string; units: Record<string, string> };
type World = {
  tenantId: string;
  outlet1: string;
  outlet2: string;
  shower: Facility;
  wfc: Facility;
  /** Shower room of outlet 2. */
  shower2: Facility;
};

const NOW = new Date("2025-06-20T05:00:00Z");
const DAY = "2025-06-10";
const EMPTY_DAY = "2025-06-11";
const NEVER_DAY = "2025-06-12";
let world: World;
let other: World;

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

/** Local time of the test day (UTC+7) as an ISO instant. */
const at = (date: string, hhmm: string): string => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(
    Date.parse(`${date}T00:00:00Z`) + ((h! - 7) * 60 + m!) * 60_000,
  ).toISOString();
};

async function seedFacility(
  tenantId: string,
  outletId: string,
  input: { name: string; type: string; units: string[] },
): Promise<Facility> {
  const id = randomUUID();
  const areaId = randomUUID();
  const units: Record<string, string> = {};
  await asOwner(tenantId, async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, $5, 60, 10, 10, $6, $7, $8)`,
      [
        id,
        tenantId,
        outletId,
        input.name,
        input.type,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "08:00",
            closesAt: "20:00",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area', 0)`,
      [areaId, tenantId, outletId, id],
    );
    for (const [index, code] of input.units.entries()) {
      const unitId = randomUUID();
      units[code] = unitId;
      await client.query(
        `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, 'available', $7)`,
        [unitId, tenantId, outletId, id, areaId, code, index],
      );
    }
  });
  return { id, areaId, units };
}

async function ticket(
  w: World,
  outletId: string,
  facility: Facility,
  input: {
    unit: string;
    date?: string;
    from: string;
    to: string;
    endedAt?: string;
    status: string;
  },
) {
  const date = input.date ?? DAY;
  const starts = at(date, input.from);
  const ends = at(date, input.to);
  const ended = input.endedAt ? at(date, input.endedAt) : null;
  await asOwner(w.tenantId, (client) =>
    client.query(
      `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                   product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes,
                                   status, first_opened_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', $9, $10, $11, 10, $12, $13, $14)`,
      [
        randomUUID(),
        w.tenantId,
        outletId,
        facility.id,
        facility.areaId,
        facility.units[input.unit],
        randomUUID(),
        randomUUID(),
        starts,
        ends,
        new Date(Date.parse(ends) + 10 * 60_000).toISOString(),
        input.status,
        input.status === "issued" || input.status === "cancelled"
          ? null
          : starts,
        ended,
      ],
    ),
  );
}

async function incident(
  w: World,
  outletId: string,
  facility: Facility,
  input: { unit?: string; at: string; answeredAfterSeconds?: number },
) {
  const triggered = at(DAY, input.at);
  await asOwner(w.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_incidents (id, tenant_id, outlet_id, facility_id, unit_id, type, triggered_at,
                                       offline, responded_at)
       VALUES ($1, $2, $3, $4, $5, 'assist', $6, false, $7)`,
      [
        randomUUID(),
        w.tenantId,
        outletId,
        facility.id,
        input.unit ? facility.units[input.unit] : null,
        triggered,
        input.answeredAfterSeconds === undefined
          ? null
          : new Date(
              Date.parse(triggered) + input.answeredAfterSeconds * 1000,
            ).toISOString(),
      ],
    ),
  );
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `msf-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const shower = await seedFacility(tenant.tenantId, tenant.outletId, {
    name: "Shower",
    type: "shower",
    units: ["A1", "A2"],
  });
  const wfc = await seedFacility(tenant.tenantId, tenant.outletId, {
    name: "WFC",
    type: "coworking",
    units: ["W1"],
  });
  const shower2 = await seedFacility(tenant.tenantId, outlet2, {
    name: "Shower 2",
    type: "shower",
    units: ["A1"],
  });
  return {
    tenantId: tenant.tenantId,
    outlet1: tenant.outletId,
    outlet2,
    shower,
    wfc,
    shower2,
  };
}

type Dim = { key: MetricDimensionKey; value: string };

function evaluate(
  w: World,
  input: {
    codes: string[];
    start?: string;
    end?: string;
    bucket?: "total" | "day";
    groupBy?: MetricDimensionKey[];
  },
): Promise<EvaluatedMetrics> {
  const ctx = context(w.tenantId);
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes: input.codes,
        period: {
          start: businessDateSchema.parse(input.start ?? DAY),
          end: businessDateSchema.parse(input.end ?? DAY),
        },
        bucket: input.bucket ?? "total",
        outletFilter: outletIdsForQuery(ctx.outletScope),
        groupBy: input.groupBy ?? [],
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

/** Value of one code for one split value (or the total when dim is null). */
async function figure(
  w: World,
  code: string,
  dim: Dim | null,
  period: { start?: string; end?: string } = {},
): Promise<{ value: number | null; finality: string }> {
  const result = await evaluate(w, {
    codes: [code],
    groupBy: dim ? [dim.key] : [],
    ...period,
  });
  const series = result.series.find(
    (entry) =>
      entry.metricCode === code &&
      (dim === null
        ? entry.dimensions.length === 0
        : entry.dimensions.some(
            (d) => d.key === dim.key && d.value === dim.value,
          )),
  );
  expect(series, `${code} ${JSON.stringify(dim)}`).toBeDefined();
  const point = series!.points[0]!;
  return { value: numberOf(point.value), finality: point.finality };
}

const facilityDim = (id: string): Dim => ({ key: "facility", value: id });
const unitDim = (id: string): Dim => ({ key: "unit", value: id });

beforeAll(async () => {
  world = await makeWorld("a");
  other = await makeWorld("b");
  const { shower, wfc } = world;
  await ticket(world, world.outlet1, shower, {
    unit: "A1",
    from: "09:00",
    to: "10:00",
    endedAt: "10:20",
    status: "completed",
  });
  await ticket(world, world.outlet1, shower, {
    unit: "A1",
    from: "11:00",
    to: "12:00",
    endedAt: "11:50",
    status: "completed",
  });
  await ticket(world, world.outlet1, shower, {
    unit: "A1",
    from: "15:00",
    to: "16:00",
    status: "cancelled",
  });
  await ticket(world, world.outlet1, shower, {
    unit: "A1",
    from: "17:00",
    to: "18:00",
    status: "issued",
  });
  await ticket(world, world.outlet1, shower, {
    unit: "A2",
    from: "13:00",
    to: "14:00",
    endedAt: "14:00",
    status: "completed",
  });
  await ticket(world, world.outlet1, wfc, {
    unit: "W1",
    from: "09:00",
    to: "11:00",
    endedAt: "11:30",
    status: "completed",
  });
  await incident(world, world.outlet1, shower, {
    unit: "A1",
    at: "10:00",
    answeredAfterSeconds: 300,
  });
  await incident(world, world.outlet1, shower, {
    at: "12:00",
    answeredAfterSeconds: 600,
  });
  await incident(world, world.outlet1, wfc, { unit: "W1", at: "15:00" });

  // Other outlet of the same tenant and another tenant: noise the first
  // outlet's figures must never include.
  await ticket(world, world.outlet2, world.shower2, {
    unit: "A1",
    from: "09:00",
    to: "10:00",
    endedAt: "10:30",
    status: "completed",
  });
  await ticket(other, other.outlet1, other.shower, {
    unit: "A1",
    from: "09:00",
    to: "10:00",
    endedAt: "10:30",
    status: "completed",
  });
  await incident(other, other.outlet1, other.shower, { at: "10:00" });

  await recomputeMetricsDaily(
    context(world.tenantId),
    world.outlet1,
    businessDateSchema.parse(DAY),
    businessDateSchema.parse(EMPTY_DAY),
    { now: NOW },
  );
  await recomputeMetricsDaily(
    context(other.tenantId),
    other.outlet1,
    businessDateSchema.parse(DAY),
    businessDateSchema.parse(DAY),
    { now: NOW },
  );
});

afterAll(async () => {
  await owner.end();
});

describe("facility.revenue and facility.occupancy", () => {
  it("counts completed shower sessions per facility and unit", async () => {
    expect((await figure(world, "shower_sessions", null)).value).toBe(3);
    expect(
      (await figure(world, "shower_sessions", facilityDim(world.shower.id)))
        .value,
    ).toBe(3);
    expect(
      (await figure(world, "shower_sessions", unitDim(world.shower.units.A1!)))
        .value,
    ).toBe(2);
    expect(
      (await figure(world, "shower_sessions", unitDim(world.shower.units.A2!)))
        .value,
    ).toBe(1);
  });
});

describe("facility.overtime", () => {
  it("counts sessions ended after their slot and the seconds over", async () => {
    expect(
      (await figure(world, "facility_overtime_sessions", null)).value,
    ).toBe(2);
    expect((await figure(world, "facility_overtime_seconds", null)).value).toBe(
      3000,
    );
    expect(
      (
        await figure(
          world,
          "facility_overtime_seconds",
          facilityDim(world.shower.id),
        )
      ).value,
    ).toBe(1200);
    expect(
      (
        await figure(
          world,
          "facility_overtime_sessions",
          unitDim(world.shower.units.A2!),
        )
      ).value,
    ).toBe(0);
  });
});

describe("facility.incidents", () => {
  it("counts incidents per facility and unit", async () => {
    expect((await figure(world, "facility_incident_count", null)).value).toBe(
      3,
    );
    expect(
      (
        await figure(
          world,
          "facility_incident_count",
          facilityDim(world.shower.id),
        )
      ).value,
    ).toBe(2);
    expect(
      (
        await figure(
          world,
          "facility_incident_count",
          unitDim(world.wfc.units.W1!),
        )
      ).value,
    ).toBe(1);
  });
});

const FACILITY_REPORTS = [
  "facility.revenue",
  "facility.revpash",
  "facility.occupancy",
  "facility.subscriptions",
  "facility.wifi",
  "facility.fnb_conversion",
  "facility.overtime",
  "facility.cleaning_time",
  "facility.incidents",
  "facility.product_revenue",
  "facility.unit_utilization",
];

describe("unavailable facility metrics", () => {
  const UNAVAILABLE = [
    "shower_occupancy_pct",
    "unit_utilization_pct",
    "facility_incident_response_seconds",
    "shower_revenue",
    "facility_product_revenue",
    "facility_product_sales",
    "active_subscriptions",
    "wifi_sessions",
    "wifi_quota_used",
    "shower_sessions_with_fnb",
    "shower_fnb_conversion_pct",
    "facility_cleaning_count",
    "facility_cleaning_seconds",
    "revpash",
    "seat_occupancy_pct",
  ];

  it("claims each code as unavailable with a reason, never a zero", async () => {
    for (const code of UNAVAILABLE)
      expect(metricSourceOf(code)).toEqual({
        kind: "unavailable",
        code,
        reason: "source_not_built",
      });
    const result = await evaluate(world, { codes: UNAVAILABLE });
    expect(result.availability.map((a) => a.status)).toEqual(
      UNAVAILABLE.map(() => "unavailable"),
    );
    for (const series of result.series)
      for (const point of series.points) expect(point.value).toBeNull();
  });

  it("stores no row for them: the daily readers write only the four sums", async () => {
    const { rows } = await owner.query<{ metric_code: string }>(
      `SELECT DISTINCT metric_code FROM metrics_daily
        WHERE tenant_id = $1 AND metric_code = ANY($2)`,
      [world.tenantId, UNAVAILABLE],
    );
    expect(rows).toEqual([]);
  });

  it("matches the web mock's list of unavailable metrics exactly", () => {
    const codes = new Set(
      FACILITY_REPORTS.flatMap((report) => reportByCode(report)!.metrics),
    );
    const registry = [...codes]
      .filter((code) => metricSourceOf(code).kind === "unavailable")
      .sort();
    expect([...unavailableMetrics].sort()).toEqual(registry);
  });

  it("claims every metric of the 11 facility reports", () => {
    const codes = new Set(
      FACILITY_REPORTS.flatMap((report) => reportByCode(report)!.metrics),
    );
    expect(codes.size).toBe(19);
    for (const code of codes)
      expect(["daily", "unavailable"], code).toContain(
        metricSourceOf(code).kind,
      );
  });
});

describe("isolation", () => {
  it("never mixes another outlet or tenant into an outlet's figures", async () => {
    // Outlet 2 and the other tenant each have one completed overtime session.
    const own = await evaluate(world, {
      codes: ["facility_overtime_sessions"],
      groupBy: ["outlet"],
    });
    const byOutlet = new Map(
      own.series.map((series) => [
        series.dimensions.find((d) => d.key === "outlet")?.value,
        numberOf(series.points[0]!.value),
      ]),
    );
    expect(byOutlet.get(world.outlet1)).toBe(2);
    // Outlet 2 has tickets but no stored rows yet: no value, not outlet 1's.
    expect(byOutlet.get(world.outlet2) ?? null).toBeNull();

    await refreshMetricsDaily(
      context(world.tenantId),
      { outletId: world.outlet2, businessDate: businessDateSchema.parse(DAY) },
      NOW,
    );
    const both = await evaluate(world, {
      codes: ["facility_overtime_sessions", "facility_incident_count"],
      groupBy: ["outlet"],
    });
    const value = (code: string, outlet: string) =>
      numberOf(
        both.series.find(
          (series) =>
            series.metricCode === code &&
            series.dimensions.some((d) => d.value === outlet),
        )!.points[0]!.value,
      );
    expect(value("facility_overtime_sessions", world.outlet1)).toBe(2);
    expect(value("facility_overtime_sessions", world.outlet2)).toBe(1);
    expect(value("facility_incident_count", world.outlet1)).toBe(3);
    expect(value("facility_incident_count", world.outlet2)).toBe(0);

    expect((await figure(other, "facility_incident_count", null)).value).toBe(
      1,
    );
    expect(
      (await figure(other, "facility_overtime_sessions", null)).value,
    ).toBe(1);
  });

  it("writes no row of another tenant's outlet", async () => {
    const before = await owner.query(
      "SELECT count(*)::int AS n FROM metrics_daily WHERE tenant_id = $1",
      [other.tenantId],
    );
    await refreshMetricsDaily(
      context(world.tenantId),
      { outletId: other.outlet1, businessDate: businessDateSchema.parse(DAY) },
      NOW,
    ).catch(() => undefined);
    const after = await owner.query(
      "SELECT count(*)::int AS n FROM metrics_daily WHERE tenant_id = $1",
      [other.tenantId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("empty and uncomputed days", () => {
  it("writes zero totals for a day without activity", async () => {
    const rows = await owner.query<{
      metric_code: string;
      value_int: string | null;
    }>(
      `SELECT metric_code, value_int::text AS value_int FROM metrics_daily
        WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
          AND dimension_key IS NULL
          AND metric_code IN ('shower_sessions', 'facility_incident_count',
                              'facility_overtime_seconds')`,
      [world.tenantId, world.outlet1, EMPTY_DAY],
    );
    expect(rows.rows.map((r) => r.metric_code).sort()).toEqual([
      "facility_incident_count",
      "facility_overtime_seconds",
      "shower_sessions",
    ]);
    for (const row of rows.rows) expect(row.value_int).toBe("0");
  });

  it("keeps a day the job never computed an estimate", async () => {
    const covered = await figure(world, "shower_sessions", null, {
      start: DAY,
      end: EMPTY_DAY,
    });
    // Tenant-wide: 3 sessions of outlet 1 plus 1 of outlet 2 (refreshed above).
    expect(covered).toEqual({ value: 4, finality: "final" });
    const gap = await figure(world, "shower_sessions", null, {
      start: DAY,
      end: NEVER_DAY,
    });
    expect(gap.finality).toBe("estimate");
  });
});

describe("backfill", () => {
  it("recomputing the same range changes nothing", async () => {
    const range = [
      context(world.tenantId),
      world.outlet1,
      businessDateSchema.parse(DAY),
      businessDateSchema.parse(EMPTY_DAY),
      { now: NOW },
    ] as const;
    const snapshot = () =>
      owner.query(
        `SELECT id, metric_code, dimension_key, dimension_value, value_int::text, value_decimal::text, updated_at
           FROM metrics_daily WHERE tenant_id = $1 AND outlet_id = $2
          ORDER BY metric_date, metric_code, dimension_key NULLS FIRST, dimension_value NULLS FIRST`,
        [world.tenantId, world.outlet1],
      );
    const before = await snapshot();
    const again = await recomputeMetricsDaily(...range);
    const after = await snapshot();
    expect(again).toMatchObject({ written: 0, deleted: 0, failedFamilies: [] });
    expect(again.unchanged).toBeGreaterThan(0);
    expect(after.rows).toEqual(before.rows);
  });
});
