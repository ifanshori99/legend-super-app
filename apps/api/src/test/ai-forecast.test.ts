// WS-12 wave 3 part F against PostgreSQL (beads legend-hkd4, legend-lely):
// AI-07 forecast (rule-v1) + job, AI-08 purchase suggestion, AI-13 roster
// inputs, TEN-01..03. Real services with the restricted app role (RLS
// enforced). Every tenant is created here, so numbers never depend on other
// suites. Test data is left behind on purpose: the test PostgreSQL is
// disposable.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleAssignmentSchema } from "@starter/shared/access";
import { businessDateOf } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { forecasts } from "../db/schema/ai-insights.ts";
import { withTenant } from "../db/tenant.ts";
import {
  generateForecasts,
  listForecasts,
} from "../services/ai-forecast.service.ts";
import { addDays } from "../services/ai-forecast.shared.ts";
import { listPurchaseSuggestions } from "../services/ai-purchase-suggestion.service.ts";
import { getRosterInputs } from "../services/ai-roster-inputs.service.ts";
import {
  resolveAccessSnapshot,
  type AccessSnapshot,
} from "../services/permission-resolver.ts";
import {
  resetAiForecastJobThrottle,
  runAiForecastJob,
} from "../worker/ai-forecast.job.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const NOW = new Date("2031-03-16T05:00:00.000Z");
// 2031-03-03 and 2031-03-10 are Mondays; the forecast starts Monday 03-17.
const MON1 = "2031-03-03";
const MON2 = "2031-03-10";
const TARGET = "2031-03-17";

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

type TestTenant = {
  id: string;
  brandId: string;
  entityId: string;
  outlets: string[];
};

async function createTenant(label: string, outletCount: number) {
  const tenant: TestTenant = {
    id: randomUUID(),
    brandId: randomUUID(),
    entityId: randomUUID(),
    outlets: Array.from({ length: outletCount }, () => randomUUID()),
  };
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $4, plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [
      tenant.id,
      `ai-fc-${tenant.id.slice(0, 8)}`,
      cafeLegendPlatformFixtures.tenant.id,
      `AI forecast ${label}`,
    ],
  );
  await asOwner(tenant.id, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
      [tenant.brandId, tenant.id],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Test', false)`,
      [tenant.entityId, tenant.id],
    );
    for (const [index, outletId] of tenant.outlets.entries())
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Test', 'Asia/Jakarta',
                 '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
        [
          outletId,
          tenant.id,
          tenant.brandId,
          tenant.entityId,
          `F${index + 1}-${tenant.id.slice(0, 6).toUpperCase()}`,
          `${label} Outlet ${index + 1}`,
        ],
      );
  });
  return tenant;
}

// ---- access ----------------------------------------------------------------

function accessFor(
  tenant: TestTenant,
  permissions: readonly string[],
  scope: "tenant" | string = "tenant",
): AccessSnapshot {
  const userId = randomUUID();
  const role = {
    id: randomUUID(),
    permissions: [...permissions],
    mfaRequired: false,
    templateKey: null,
    allowedScopeTypes: ["tenant", "outlet"],
  };
  const assignment = roleAssignmentSchema.parse({
    id: randomUUID(),
    tenantId: tenant.id,
    userId,
    roleId: role.id,
    scope:
      scope === "tenant"
        ? { type: "tenant", id: null }
        : { type: "outlet", id: scope },
    validFrom: "2030-01-01T00:00:00.000Z",
    validUntil: null,
    assignedBy: randomUUID(),
    assignedAt: "2030-01-01T00:00:00.000Z",
  });
  return resolveAccessSnapshot({
    tenant: establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    userId,
    assignments: [assignment],
    roles: [role] as never,
    org: {
      brands: [{ id: tenant.brandId }],
      outlets: tenant.outlets.map((id) => ({ id, brandId: tenant.brandId })),
      stations: [],
    } as never,
    mfaVerified: false,
    now: NOW,
  });
}

function systemContext(tenant: TestTenant) {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

// ---- seeding -----------------------------------------------------------------

let orderSeq = 0;
async function seedOrder(
  client: PoolClient,
  tenant: TestTenant,
  outletId: string,
  order: { total: number; status?: string; date: string },
) {
  orderSeq += 1;
  await client.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5, $6, $7, $8)`,
    [
      randomUUID(),
      tenant.id,
      outletId,
      `F${orderSeq}`,
      order.total,
      order.status ?? "completed",
      order.date,
      // 05:00Z is 12:00 in Asia/Jakarta: hour 12.
      `${order.date}T05:00:00.000Z`,
    ],
  );
}

async function seedMondayHistory(tenant: TestTenant, outletId: string) {
  await asOwner(tenant.id, async (client) => {
    await seedOrder(client, tenant, outletId, { total: 100_000, date: MON1 });
    await seedOrder(client, tenant, outletId, { total: 100_000, date: MON1 });
    await seedOrder(client, tenant, outletId, { total: 50_000, date: MON2 });
    // A voided order never counts.
    await seedOrder(client, tenant, outletId, {
      total: 999_000,
      status: "voided",
      date: MON2,
    });
  });
}

let tx: TestTenant; // two outlets, Monday history on outlet 1
let ty: TestTenant; // other tenant
let tj: TestTenant; // job tenant
let tk: TestTenant; // job tenant for the day-after-day run
let x1: string;
let x2: string;
let locActive: string;
let locInactive: string;
const item: Record<string, string> = {};

beforeAll(async () => {
  tx = await createTenant("X", 2);
  ty = await createTenant("Y", 1);
  tj = await createTenant("J", 1);
  tk = await createTenant("K", 1);
  x1 = tx.outlets[0]!;
  x2 = tx.outlets[1]!;
  await seedMondayHistory(tx, x1);
  await seedMondayHistory(ty, ty.outlets[0]!);

  // Job tenant: history relative to the real clock (the job stamps `generated_at`
  // with the real time), one order 7 and one 14 days before today.
  const clock = { timeZone: "Asia/Jakarta", cutoff: "04:00" };
  const today = businessDateOf(new Date(), clock);
  for (const jobTenant of [tj, tk])
    await asOwner(jobTenant.id, async (client) => {
      for (const back of [7, 14])
        await seedOrder(client, jobTenant, jobTenant.outlets[0]!, {
          total: 40_000,
          date: addDays(today, -back),
        });
    });

  // Purchase suggestion fixtures on tenant X outlet 1.
  const uomId = randomUUID();
  locActive = randomUUID();
  locInactive = randomUUID();
  await asOwner(tx.id, async (client) => {
    await client.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, 'kg', 'Kilogram')`,
      [uomId, tx.id],
    );
    for (const [id, active] of [
      [locActive, true],
      [locInactive, false],
    ] as const)
      await client.query(
        `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type, is_active)
         VALUES ($1, $2, $3, $4, 'warehouse', $5)`,
        [id, tx.id, x1, active ? "Gudang" : "Gudang lama", active],
      );
    const items: [string, string, string, string | null, string, string][] = [
      // name, parMin, parMax, on hand (null = no balance row), location, key
      ["Beras", "10", "30", "4", locActive, "low"],
      ["Gula", "10", "20", "12", locActive, "ok"],
      ["Kopi", "5", "15", null, locActive, "none"],
      ["Teh", "10", "30", "1", locInactive, "inactive"],
    ];
    for (const [name, parMin, parMax, onHand, location, key] of items) {
      const itemId = randomUUID();
      item[key] = itemId;
      await client.query(
        `INSERT INTO inventory_items (id, tenant_id, name, category, base_uom_id)
         VALUES ($1, $2, $3, 'bahan', $4)`,
        [itemId, tx.id, name, uomId],
      );
      await client.query(
        `INSERT INTO par_levels (tenant_id, outlet_id, location_id, inventory_item_id, par_min, par_max)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tx.id, x1, location, itemId, parMin, parMax],
      );
      if (onHand !== null)
        await client.query(
          `INSERT INTO stock_balances (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
           VALUES ($1, $2, $3, $4, $5, 1000)`,
          [tx.id, x1, location, itemId, onHand],
        );
    }
  });
});

afterAll(async () => {
  await owner.end();
});

const SALES = ["report.sales.view"];

describe("generateForecasts (AI-07 rule-v1)", () => {
  it("averages the same weekday and hour, ignoring voided orders", async () => {
    const written = await generateForecasts(systemContext(tx), {
      outletId: x1,
      fromDate: TARGET,
      days: 7,
    });
    expect(written).toBe(3);
    const rows = await listForecasts(accessFor(tx, SALES), {
      outletId: x1,
      from: TARGET,
      to: addDays(TARGET, 6),
    });
    const byMetric = Object.fromEntries(
      rows.map((row) => [row.metricCode, row]),
    );
    expect(rows.map((row) => [row.targetDate, row.hour])).toEqual([
      [TARGET, 12],
      [TARGET, 12],
      [TARGET, 12],
    ]);
    // Monday 03-03: 200k / 2 orders; Monday 03-10: 50k / 1 order (voided skipped).
    expect(byMetric.sales_idr?.value).toBe(125_000);
    expect(byMetric.orders?.value).toBe(1.5);
    expect(byMetric.covers?.value).toBe(1.5);
    expect(rows.every((row) => row.modelVersion === "rule-v1")).toBe(true);
  });

  it("is idempotent on the unique key", async () => {
    expect(
      await generateForecasts(systemContext(tx), {
        outletId: x1,
        fromDate: TARGET,
        days: 7,
      }),
    ).toBe(3);
    const rows = await listForecasts(accessFor(tx, SALES), {
      outletId: x1,
      from: TARGET,
      to: addDays(TARGET, 6),
    });
    expect(rows).toHaveLength(3);
  });

  it("removes forecast rows that left the window", async () => {
    await asOwner(tx.id, async (client) => {
      for (const metric of ["sales_idr", "orders", "covers"])
        await client.query(
          `INSERT INTO forecasts (tenant_id, outlet_id, target_date, hour, metric_code, value, model_version)
           VALUES ($1, $2, $3, 3, $4, 9, 'rule-v1')`,
          [tx.id, x1, TARGET, metric],
        );
    });
    const before = await listForecasts(accessFor(tx, SALES), {
      outletId: x1,
      from: TARGET,
      to: TARGET,
    });
    expect(before.map((row) => row.hour)).toContain(3);
    await generateForecasts(systemContext(tx), {
      outletId: x1,
      fromDate: TARGET,
      days: 7,
    });
    const after = await listForecasts(accessFor(tx, SALES), {
      outletId: x1,
      from: TARGET,
      to: TARGET,
    });
    expect(after.map((row) => row.hour)).toEqual([12, 12, 12]);
  });

  it("writes nothing for an outlet with no history", async () => {
    expect(
      await generateForecasts(systemContext(tx), {
        outletId: x2,
        fromDate: TARGET,
        days: 7,
      }),
    ).toBe(0);
  });

  it("filters by metric", async () => {
    const rows = await listForecasts(accessFor(tx, SALES), {
      outletId: x1,
      from: TARGET,
      to: TARGET,
      metricCode: "orders",
    });
    expect(rows.map((row) => row.metricCode)).toEqual(["orders"]);
  });

  it("denies a caller without the permission or outside the outlet", async () => {
    const query = { outletId: x1, from: TARGET, to: TARGET };
    await expect(
      listForecasts(accessFor(tx, ["report.operational.view"]), query),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listForecasts(accessFor(tx, SALES, x2), query),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listForecasts(accessFor(tx, SALES, x1), query),
    ).resolves.toHaveLength(3);
  });

  it("isolates tenants", async () => {
    // Tenant Y cannot read tenant X's outlet through the service ...
    await expect(
      listForecasts(accessFor(ty, SALES), {
        outletId: x1,
        from: TARGET,
        to: TARGET,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // ... nor through RLS, even with a direct query.
    const leaked = await withTenant(db, systemContext(ty), (t) =>
      t.select().from(forecasts),
    );
    expect(leaked.filter((row) => row.tenantId === tx.id)).toHaveLength(0);
    // Same history in tenant Y yields its own rows only.
    await generateForecasts(systemContext(ty), {
      outletId: ty.outlets[0]!,
      fromDate: TARGET,
      days: 7,
    });
    const own = await withTenant(db, systemContext(ty), (t) =>
      t.select().from(forecasts),
    );
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((row) => row.tenantId === ty.id)).toBe(true);
  });
});

describe("listPurchaseSuggestions (AI-08)", () => {
  it("suggests par_max minus on hand below par_min, active locations only", async () => {
    const result = await listPurchaseSuggestions(
      accessFor(tx, ["inventory.stock.view"]),
      { outletId: x1 },
    );
    expect(
      result.map((row) => [row.itemName, row.onHand, row.suggestedQty]),
    ).toEqual([
      ["Beras", 4, 26],
      ["Kopi", 0, 15],
    ]);
    expect(result[0]).toMatchObject({
      inventoryItemId: item.low,
      locationId: locActive,
      locationName: "Gudang",
      unit: "kg",
      parMin: 10,
      parMax: 30,
      reason: "below_min",
    });
  });

  it("accepts purchasing.request.create and denies other callers", async () => {
    await expect(
      listPurchaseSuggestions(accessFor(tx, ["purchasing.request.create"]), {
        outletId: x1,
      }),
    ).resolves.toHaveLength(2);
    await expect(
      listPurchaseSuggestions(accessFor(tx, SALES), { outletId: x1 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listPurchaseSuggestions(accessFor(tx, ["inventory.stock.view"], x2), {
        outletId: x1,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("pages only stock shortages in a repeatable order", async () => {
    const access = accessFor(tx, ["inventory.stock.view"]);
    const page = (offset: number) =>
      listPurchaseSuggestions(access, { outletId: x1, limit: 1, offset });
    expect((await page(0)).map((row) => row.itemName)).toEqual(["Beras"]);
    // Gula sorts between Beras and Kopi but has sufficient stock. SQL must
    // exclude it before applying pagination, and missing balances stay zero.
    expect((await page(1)).map((row) => row.itemName)).toEqual(["Kopi"]);
    expect(await page(1)).toEqual(await page(1));
    expect(await page(2)).toEqual([]);
  });

  it("isolates tenants", async () => {
    await expect(
      listPurchaseSuggestions(accessFor(ty, ["inventory.stock.view"]), {
        outletId: x1,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listPurchaseSuggestions(accessFor(ty, ["inventory.stock.view"]), {
        outletId: ty.outlets[0]!,
      }),
    ).resolves.toEqual([]);
  });
});

describe("getRosterInputs (AI-13)", () => {
  const ROSTER = ["hr.schedule.manage"];

  it("derives headcount from the stored forecast", async () => {
    const roster = await getRosterInputs(accessFor(tx, ROSTER), {
      outletId: x1,
      date: TARGET,
    });
    expect(roster).toMatchObject({
      basis: "forecast",
      coversPerStaff: 12,
      hours: [
        {
          hour: 12,
          forecastCovers: 1.5,
          forecastOrders: 1.5,
          suggestedHeadcount: 1,
        },
      ],
    });
    const tight = await getRosterInputs(accessFor(tx, ROSTER), {
      outletId: x1,
      date: TARGET,
      coversPerStaff: 1,
    });
    expect(tight.hours[0]?.suggestedHeadcount).toBe(2);
  });

  it("falls back to the rule baseline when nothing is generated", async () => {
    const roster = await getRosterInputs(accessFor(tx, ROSTER), {
      outletId: x1,
      date: addDays(TARGET, 7),
    });
    expect(roster.basis).toBe("rule_baseline");
    expect(roster.hours.map((hour) => hour.hour)).toEqual([12]);
    const empty = await getRosterInputs(accessFor(tx, ROSTER), {
      outletId: x2,
      date: TARGET,
    });
    expect(empty).toMatchObject({ basis: "rule_baseline", hours: [] });
  });

  it("denies a caller without the permission, outside the outlet or tenant", async () => {
    const query = { outletId: x1, date: TARGET };
    await expect(
      getRosterInputs(accessFor(tx, SALES), query),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      getRosterInputs(accessFor(tx, ROSTER, x2), query),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      getRosterInputs(accessFor(ty, ROSTER), query),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("runAiForecastJob", () => {
  it("generates once per business day and then skips", async () => {
    resetAiForecastJobThrottle();
    const context = systemContext(tj);
    const first = await runAiForecastJob(context, new Date());
    expect(first).toMatchObject({
      outlets: 1,
      generatedOutlets: 1,
      skippedOutlets: 0,
      failedOutlets: 0,
      // One target weekday with history, one active hour, three metrics.
      rows: 3,
    });
    // Throttled without force.
    expect(await runAiForecastJob(context, new Date())).toBeNull();
    const second = await runAiForecastJob(context, new Date(), { force: true });
    expect(second).toMatchObject({
      generatedOutlets: 0,
      skippedOutlets: 1,
      rows: 0,
    });
  });

  it("adds the newest day when yesterday's run is followed by today's", async () => {
    resetAiForecastJobThrottle();
    const context = systemContext(tk);
    const clock = { timeZone: "Asia/Jakarta", cutoff: "04:00" };
    const now = new Date();
    const today = businessDateOf(now, clock);
    const dates = async () =>
      (
        await withTenant(db, context, (t) =>
          t
            .selectDistinct({ date: forecasts.targetDate })
            .from(forecasts)
            .where(eq(forecasts.outletId, tk.outlets[0]!)),
        )
      )
        .map((row) => row.date)
        .sort();

    // Yesterday's run covers today..today+6 (its tomorrow is today).
    const yesterday = new Date(now.getTime() - 86_400_000);
    await runAiForecastJob(context, yesterday, { force: true });
    expect(await dates()).toEqual([today]);
    // Make those rows look generated yesterday.
    await asOwner(tk.id, (client) =>
      client.query(
        "UPDATE forecasts SET generated_at = generated_at - interval '1 day' WHERE tenant_id = $1",
        [tk.id],
      ),
    );

    // Today's run is not skipped and generates the new day today+7.
    const run = await runAiForecastJob(context, now, { force: true });
    expect(run).toMatchObject({ generatedOutlets: 1, skippedOutlets: 0 });
    expect(await dates()).toEqual([today, addDays(today, 7)]);
    // A second run the same day skips.
    expect(await runAiForecastJob(context, now, { force: true })).toMatchObject(
      { generatedOutlets: 0, skippedOutlets: 1 },
    );
  });
});
