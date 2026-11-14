import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  businessDateSchema,
  outletIdsForQuery,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { reportMetricByCode } from "@starter/shared/dashboard";
import {
  backfillMetricsDaily,
  parseArgs,
} from "../scripts/metrics-daily-backfill";
import {
  evaluateMetrics,
  withTenantSnapshot,
} from "../services/metrics-query.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

const FROM = businessDateSchema.parse("2025-06-01");
const NOW = new Date("2025-06-04T12:00:00Z");
type World = Awaited<ReturnType<typeof createIsolatedTenant>> & {
  slug: string;
};
let own: World;
let foreign: World;

async function seed(label: string): Promise<World> {
  const suffix = `backfill-${label}-${randomUUID().slice(0, 6)}`;
  const world = await createIsolatedTenant(suffix);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const station = randomUUID();
    for (const [day, seconds, count] of [
      ["2025-06-01", 100, 1],
      ["2025-06-02", 400, 3],
    ] as const) {
      for (let n = 0; n < count; n++) {
        await client.query(
          `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id,
             station_id, fire_batch_id, business_date, ticket_no, status, fired_at, done_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'done',
             $9::timestamptz - $10 * interval '1 second', $9)`,
          [
            randomUUID(),
            world.tenantId,
            world.outletId,
            randomUUID(),
            station,
            randomUUID(),
            day,
            n + 1,
            `${day}T05:00:00Z`,
            seconds,
          ],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { ...world, slug: `tenant-${suffix}` };
}

async function rows(world: World) {
  return (
    await owner.query(
      `SELECT *, metric_date::text AS metric_date FROM metrics_daily WHERE tenant_id = $1
       ORDER BY outlet_id, metrics_daily.metric_date, metric_code, dimension_key, dimension_value`,
      [world.tenantId],
    )
  ).rows;
}

beforeAll(async () => {
  own = await seed("own");
  foreign = await seed("foreign");
});

describe("metrics daily operator backfill", () => {
  it("accepts pnpm argument forwarding and validates operator flags", () => {
    expect(
      parseArgs(["--from", "2025-06-01", "--tenant", "tenant--demo"]),
    ).toMatchObject({ tenant: "tenant--demo" });
    expect(
      parseArgs([
        "--",
        "--from",
        "2025-06-01",
        "--tenant",
        "tenant-demo",
        "--dry-run",
      ]),
    ).toMatchObject({
      from: FROM,
      tenant: "tenant-demo",
      dryRun: true,
    });
    for (const args of [
      [],
      ["--from"],
      ["--from", "2025-02-30"],
      ["--from", "2025-06-01", "--unknown"],
      ["--from", "2025-06-01", "--tenant"],
      ["--from", "2025-06-01", "--from", "2025-06-02"],
      ["--from", "2025-06-01", "--dry-run", "--dry-run"],
    ])
      expect(() => parseArgs(args)).toThrow();
  });

  it("rejects an unknown tenant instead of expanding to all tenants", async () => {
    await expect(
      backfillMetricsDaily({
        from: FROM,
        tenant: `missing-${randomUUID()}`,
        now: NOW,
      }),
    ).rejects.toThrow();
  });

  it("dry-run does not write, including source days", async () => {
    const before = await rows(own);
    await backfillMetricsDaily({
      from: FROM,
      tenant: own.slug,
      dryRun: true,
      now: NOW,
    });
    expect(await rows(own)).toEqual(before);
    expect(await rows(foreign)).toEqual([]);
  });

  it("recomputes source days, preserves weighted means, and isolates tenants", async () => {
    await backfillMetricsDaily({ from: FROM, tenant: own.slug, now: NOW });
    const stored = await rows(own);
    expect(stored.length).toBeGreaterThan(0);
    expect([...new Set(stored.map((row) => row.metric_date))].sort()).toEqual([
      "2025-06-01",
      "2025-06-02",
    ]);
    expect(await rows(foreign)).toEqual([]);
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(own.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const result = await withTenantSnapshot(context, (tx) =>
      evaluateMetrics(
        tx,
        context,
        {
          metricCodes: ["avg_serving_time"],
          period: { start: FROM, end: businessDateSchema.parse("2025-06-02") },
          bucket: "total",
          outletFilter: outletIdsForQuery(context.outletScope),
          groupBy: [],
          filters: [],
          comparePrevious: false,
          viewer: "full",
        },
        NOW,
      ),
    );
    expect(result.series[0]?.points[0]?.value).toEqual({
      unit: "seconds",
      value: 325,
    });
  });

  it("a second run leaves values, row IDs and timestamps unchanged", async () => {
    await backfillMetricsDaily({ from: FROM, tenant: own.slug, now: NOW });
    const before = await rows(own);
    await backfillMetricsDaily({ from: FROM, tenant: own.slug, now: NOW });
    expect(await rows(own)).toEqual(before);
  });

  it("leaves an existing metric on a day without source data untouched", async () => {
    const definition = reportMetricByCode.get("avg_serving_time")!;
    await owner.query(
      `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code,
         definition_id, definition_version, unit, value_int, finality, computed_at)
       VALUES ($1, $2, '2025-06-03', 'avg_serving_time', $3, $4,
         'seconds', 123, 'final', '2025-06-03T12:00:00Z')`,
      [own.tenantId, own.outletId, definition.id, definition.version],
    );
    const before = await rows(own);
    await backfillMetricsDaily({ from: FROM, tenant: own.slug, now: NOW });
    expect(await rows(own)).toEqual(before);
  });

  it("includes closed outlets and derives source dates from their business cutoff", async () => {
    const shifted = await seed("shifted");
    await owner.query(
      "UPDATE outlets SET status = 'closed', business_day_cutoff = '06:00' WHERE id = $1",
      [shifted.outletId],
    );
    await owner.query(
      `UPDATE kitchen_tickets SET fired_at = fired_at - interval '7 hours',
         done_at = done_at - interval '7 hours' WHERE tenant_id = $1`,
      [shifted.tenantId],
    );
    await backfillMetricsDaily({
      from: businessDateSchema.parse("2025-05-31"),
      tenant: shifted.slug,
      now: NOW,
    });
    const stored = await rows(shifted);
    const total = stored.filter(
      (row) =>
        row.metric_code === "served_ticket_count" && row.dimension_key === null,
    );
    expect(total.map((row) => [row.metric_date, row.value_int])).toEqual([
      ["2025-05-31", "1"],
      ["2025-06-01", "3"],
    ]);
  });
});
