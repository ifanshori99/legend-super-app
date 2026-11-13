// Fail-first tests for the loyalty-crm metric family (WS-11 F7, bead
// legend-20ucm; common rules in docs/briefs/268-ws11-family-common.md). The
// family answers from customer visits, tier history, rating feedback and
// promotion redemptions through `metrics_daily`; active_members and
// points_redeemed have no honest source yet and answer `unavailable`.
//
// Rows are seeded with the owner pool and `session_replication_role =
// replica`, so foreign keys to orders, vouchers and promotions are not
// needed; check constraints still apply.

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
import { TIER_UNASSIGNED } from "../services/metric-sources/loyalty-crm";
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
  .filter(({ family }) => family === "loyalty-crm")
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
    `mslc-${label}-${randomUUID().slice(0, 6)}`,
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

type Seed = { gold: string; silver: string; promoA: string; promoB: string };

async function seed(world: World): Promise<Seed> {
  const ids = {
    gold: randomUUID(),
    silver: randomUUID(),
    promoA: randomUUID(),
    promoB: randomUUID(),
  };
  const t = world.tenantId;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const [id, name, rank] of [
      [ids.silver, "Silver", 1],
      [ids.gold, "Gold", 2],
    ] as const)
      await client.query(
        `INSERT INTO loyalty_tiers (id, tenant_id, name, rank, threshold_spend_idr, threshold_visits, benefits)
         VALUES ($1, $2, $3, $4, 0, 0, '{}'::jsonb)`,
        [id, t, `${name}-${id.slice(0, 4)}`, rank],
      );
    const profile = async () => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO customer_profiles (id, tenant_id, name, membership_status)
         VALUES ($1, $2, 'Member Uji', 'pending_verification')`,
        [id, t],
      );
      return id;
    };
    const [p1, p2, p3, p4, p5] = [
      await profile(),
      await profile(),
      await profile(),
      await profile(),
      await profile(),
    ] as [string, string, string, string, string];

    // [profile, from tier, to tier, created at]
    const history: [string, string | null, string | null, string][] = [
      [p1, null, ids.silver, "2025-07-01T05:00:00Z"],
      [p1, ids.silver, ids.gold, `${DAY}T04:00:00Z`],
      [p2, null, ids.silver, "2025-07-02T05:00:00Z"],
      // P4 reaches gold after the day ended: on DAY it is still silver.
      [p4, null, ids.silver, "2025-07-01T05:00:00Z"],
      [p4, ids.silver, ids.gold, "2025-07-20T05:00:00Z"],
    ];
    for (const [profileId, from, to, at] of history)
      await client.query(
        `INSERT INTO customer_tier_history (tenant_id, customer_profile_id, from_tier_id, to_tier_id,
           reason, rolling_spend_idr, rolling_visits, created_at)
         VALUES ($1, $2, $3, $4, 'evaluation', 0, 0, $5)`,
        [t, profileId, from, to, at],
      );

    // [outlet, profile, visited at]
    const visits: [string, string, string][] = [
      [world.outlet1, p1, "2025-07-01T05:00:00Z"], // before: P1 returns
      [world.outlet1, p1, `${DAY}T05:00:00Z`],
      [world.outlet1, p2, `${DAY}T05:00:00Z`], // P2 new, two visits that day
      [world.outlet1, p2, `${DAY}T08:00:00Z`],
      [world.outlet1, p3, `${DAY}T06:00:00Z`], // P3 new, no tier
      [world.outlet2, p4, "2025-07-05T05:00:00Z"], // other outlet: still returning
      [world.outlet1, p4, `${DAY}T07:00:00Z`],
      [world.outlet2, p5, `${DAY}T05:00:00Z`], // another outlet only
      [world.outlet1, p3, `${NEXT_DAY}T05:00:00Z`], // P3 returns the next day
    ];
    for (const [outletId, profileId, at] of visits) {
      const day = at.slice(0, 10);
      await client.query(
        `INSERT INTO customer_visits (tenant_id, outlet_id, customer_profile_id, order_id, business_date, visited_at, spend_idr)
         VALUES ($1, $2, $3, $4, $5, $6, 50000)`,
        [t, outletId, profileId, randomUUID(), day, at],
      );
    }

    // [outlet, kind, rating, comment, created at]
    const feedback: [string, string, number | null, string | null, string][] = [
      [world.outlet1, "rating", 5, null, `${DAY}T05:00:00Z`],
      [world.outlet1, "rating", 4, null, `${DAY}T06:00:00Z`],
      [world.outlet1, "rating", 3, null, `${DAY}T07:00:00Z`],
      [world.outlet1, "complaint", null, "Dingin", `${DAY}T07:00:00Z`],
      [world.outlet2, "rating", 1, null, `${DAY}T05:00:00Z`],
      [world.outlet1, "rating", 2, null, `${NEXT_DAY}T05:00:00Z`],
    ];
    for (const [outletId, kind, rating, comment, at] of feedback)
      await client.query(
        `INSERT INTO feedback (tenant_id, outlet_id, kind, rating, comment, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [t, outletId, kind, rating, comment, at],
      );

    // [outlet, promotion, voucher, discount, released]
    const voucher = randomUUID();
    const redemptions: [
      string,
      string | null,
      string | null,
      number,
      boolean,
    ][] = [
      [world.outlet1, ids.promoA, null, 10_000, false],
      [world.outlet1, ids.promoA, null, 5_000, false],
      [world.outlet1, ids.promoB, null, 7_000, false],
      [world.outlet1, null, voucher, 3_000, false],
      [world.outlet1, ids.promoA, null, 99_000, true], // released: no cost
      [world.outlet2, ids.promoB, null, 1_000, false],
    ];
    for (const [
      outletId,
      promotion,
      voucherId,
      discount,
      released,
    ] of redemptions)
      await client.query(
        `INSERT INTO promotion_redemptions (tenant_id, outlet_id, order_id, promotion_id, voucher_id,
           discount_idr, free_items, status, redeemed_at, released_at)
         VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, $9)`,
        [
          t,
          outletId,
          randomUUID(),
          promotion,
          voucherId,
          discount,
          released ? "released" : "applied",
          `${DAY}T05:30:00Z`,
          released ? `${DAY}T09:00:00Z` : null,
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

function refresh(world: World, outletId: string, businessDate: string) {
  return refreshMetricsDaily(
    context(world.tenantId),
    { outletId, businessDate: date(businessDate) },
    LATE,
    { readers },
  );
}

let a: World;
let b: World;
let seedA: Seed;
let seedB: Seed;

beforeAll(async () => {
  a = await makeWorld("a");
  b = await makeWorld("b");
  seedA = await seed(a);
  seedB = await seed(b);
});

afterAll(async () => {
  await owner.query("DELETE FROM metrics_daily WHERE tenant_id = ANY($1)", [
    [a.tenantId, b.tenantId],
  ]);
});

describe("loyalty-crm registry", () => {
  it("claims its metrics: daily readers and unavailable sources", () => {
    expect(() => assertRegistry(METRIC_SOURCE_MODULES)).not.toThrow();
    for (const code of [
      "new_customers",
      "returning_customers",
      "review_rating",
      "review_count",
      "promo_cost",
    ])
      expect(metricSourceOf(code).kind, code).toBe("daily");
    expect(metricSourceOf("review_rating")).toMatchObject({
      weightCode: "review_count",
    });
    for (const code of ["active_members", "points_redeemed"])
      expect(metricSourceOf(code), code).toMatchObject({
        kind: "unavailable",
        reason: "source_not_built",
      });
    expect(readers.length).toBeGreaterThan(0);
    for (const { reader } of readers as { reader: DailyMetricReader }[])
      expect(reader.metricCodes.length).toBeGreaterThan(0);
  });
});

describe("loyalty-crm daily rows", () => {
  it("computes the figures of the seeded day, tier and promo splits", async () => {
    await refresh(a, a.outlet1, DAY);
    const rows = await stored(a, a.outlet1, DAY);
    const value = (k: string) => rows.get(k)?.value;

    // New: P2 (silver, two visits count once) and P3 (no tier). Returning: P1
    // (gold since 04:00 on the day) and P4 (visited another outlet earlier;
    // its gold comes after the day, so it is still silver).
    expect(value(key("new_customers"))).toBe("2");
    expect(value(key("new_customers", "customer_tier", seedA.silver))).toBe(
      "1",
    );
    expect(value(key("new_customers", "customer_tier", TIER_UNASSIGNED))).toBe(
      "1",
    );
    expect(value(key("returning_customers"))).toBe("2");
    expect(value(key("returning_customers", "customer_tier", seedA.gold))).toBe(
      "1",
    );
    expect(
      value(key("returning_customers", "customer_tier", seedA.silver)),
    ).toBe("1");

    // Reviews: the complaint and the other outlet's rating are out.
    expect(value(key("review_count"))).toBe("3");
    expect(value(key("review_rating"))).toBe("4.0000");

    // Promo cost: the released redemption and the other outlet are out.
    expect(value(key("promo_cost"))).toBe("25000");
    expect(value(key("promo_cost", "promo", seedA.promoA))).toBe("15000");
    expect(value(key("promo_cost", "promo", seedA.promoB))).toBe("7000");
    const promoRows = [...rows.keys()].filter((k) =>
      k.startsWith("promo_cost|promo|"),
    );
    expect(promoRows).toHaveLength(3); // promo A, promo B, the voucher
  });

  it("keeps tenants and outlets apart", async () => {
    await refresh(a, a.outlet2, DAY);
    await refresh(b, b.outlet1, DAY);
    const sibling = await stored(a, a.outlet2, DAY);
    const foreign = await stored(b, b.outlet1, DAY);
    // Outlet 2: only P5 (new, no tier), one rating of 1 and one 1 000 promo.
    expect(sibling.get(key("new_customers"))?.value).toBe("1");
    expect(sibling.get(key("returning_customers"))?.value).toBe("0");
    expect(sibling.get(key("review_rating"))?.value).toBe("1.0000");
    expect(sibling.get(key("promo_cost"))?.value).toBe("1000");
    expect(sibling.has(key("promo_cost", "promo", seedA.promoA))).toBe(false);
    // Same seed shape in tenant b, but only its own tier and promo ids.
    expect(foreign.get(key("promo_cost"))?.value).toBe("25000");
    expect(foreign.has(key("promo_cost", "promo", seedA.promoA))).toBe(false);
    expect(foreign.has(key("promo_cost", "promo", seedB.promoA))).toBe(true);
    expect(
      foreign.has(key("returning_customers", "customer_tier", seedA.gold)),
    ).toBe(false);
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
    expect(rows.get(key("new_customers"))?.value).toBe("0");
    expect(rows.get(key("returning_customers"))?.value).toBe("0");
    expect(rows.get(key("review_count"))?.value).toBe("0");
    // A quiet day stores 0 with a weight of 0: the weighted mean skips it.
    expect(rows.get(key("review_rating"))?.value).toBe("0.0000");
    expect(rows.get(key("promo_cost"))?.value).toBe("0");
    // No pos_daily_closes row: point-of-sale readers stay estimates.
    expect(rows.get(key("promo_cost"))?.finality).toBe("estimate");
    expect(rows.get(key("new_customers"))?.finality).toBe("estimate");
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
    // P3 came back the next day.
    expect(next.get(key("new_customers"))?.value).toBe("0");
    expect(next.get(key("returning_customers"))?.value).toBe("1");
    expect(next.get(key("review_count"))?.value).toBe("1");
    expect(next.get(key("review_rating"))?.value).toBe("2.0000");
  });
});

describe("loyalty-crm reports through the engine", () => {
  function evaluate(
    codes: string[],
    groupBy: string[] = [],
    period = { start: date(DAY), end: date(NEXT_DAY) },
  ): Promise<EvaluatedMetrics> {
    const ctx = context(a.tenantId, a.outlet1);
    return withTenantSnapshot(ctx, (tx) =>
      evaluateMetrics(
        tx,
        ctx,
        {
          metricCodes: codes,
          period,
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

  it("weights the rating by review count and answers the unbuilt metrics as unavailable", async () => {
    await recomputeMetricsDaily(
      context(a.tenantId),
      a.outlet1,
      date(DAY),
      date(NEXT_DAY),
      { readers, now: LATE },
    );
    const result = await evaluate(["review_rating", "returning_customers"]);
    const valueOf = (code: string) =>
      (
        result.series.find((series) => series.metricCode === code)!.points[0]!
          .value as { value: unknown }
      ).value;
    // (4 × 3 + 2 × 1) / 4 reviews, not (4 + 2) / 2.
    expect(valueOf("review_rating")).toBe("3.5000");
    expect(valueOf("returning_customers")).toBe(3);
    for (const code of ["active_members", "points_redeemed"]) {
      const unbuilt = await evaluate([code]);
      expect(unbuilt.availability[0], code).toMatchObject({
        status: "unavailable",
        reason: "source_not_built",
      });
    }
  });

  it("splits returning customers by tier", async () => {
    const result = await evaluate(["returning_customers"], ["customer_tier"], {
      start: date(DAY),
      end: date(DAY),
    });
    const byTier = result.series
      .filter((series) => series.dimension)
      .map((series) => [
        series.dimension!.value,
        (series.points[0]!.value as { value: number }).value,
      ]);
    expect(Object.fromEntries(byTier)).toEqual({
      [seedA.gold]: 1,
      [seedA.silver]: 1,
    });
  });
});
