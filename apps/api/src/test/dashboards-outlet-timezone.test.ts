// Fail-first tests for bead legend-nipn7: the dashboard "today" and the open /
// closed label of a period follow the OUTLET's time zone and business-day
// cutoff, not a fixed default clock. Written from the shared contract
// (packages/shared/src/core/time.ts `businessDateOf`: local date of
// instant - cutoff; dashboard/tile-values.ts: `businessDate` is "the outlet
// business date the values describe"; metrics `period.status` is "open" until
// the period lies wholly before today) and the card text, not from the service.
//
// The service is called directly because the HTTP route cannot inject a clock
// (`options.now` of getDashboardValues).
//
// ASSUMPTIONS:
// - Several outlets with different "today": the EARLIEST outlet today wins, so
//   a period is not called closed while any outlet in scope is still inside it
//   (decision in the brief).
// - A period is closed when its endDate is before today (strictly), so a
//   custom range ending on the outlet's today is still open.
// - Business-day cutoff is 'HH:MM' in outlets.business_day_cutoff.

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import {
  dashboardValuesQuerySchema,
  dashboardValuesSchema,
  reportMetricByCode,
} from "@starter/shared/dashboard";
import {
  admittedTiles,
  getDashboardValues,
  setDashboardCacheTtlMs,
} from "../services/dashboard-run.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

const PERMISSIONS = [
  "dashboard.owner.view",
  "report.operational.view",
  "report.sales.view",
  "report.financial.view",
];

type OutletSpec = { timeZone: string; cutoff: string };

async function world(outlets: OutletSpec[]) {
  const tenant = await createIsolatedTenant(
    `dashtz-${randomUUID().slice(0, 8)}`,
  );
  const ids: string[] = [];
  for (const [index, spec] of outlets.entries()) {
    if (index === 0) {
      await owner.query(
        "UPDATE outlets SET timezone = $3, business_day_cutoff = $4 WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, tenant.outletId, spec.timeZone, spec.cutoff],
      );
      ids.push(tenant.outletId);
      continue;
    }
    const id = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet tambahan', address, $4, $5, opening_hours, status
       FROM outlets WHERE id = $3`,
      [
        id,
        `TZ-${randomUUID().slice(0, 8)}`.toUpperCase(),
        tenant.outletId,
        spec.timeZone,
        spec.cutoff,
      ],
    );
    ids.push(id);
  }
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  return { context, ids, tenantId: tenant.tenantId };
}

async function run(
  w: Awaited<ReturnType<typeof world>>,
  now: string,
  query: Record<string, unknown> = {},
) {
  const result = await getDashboardValues(
    w.context,
    {
      dashboard: "owner",
      viewer: "full",
      tiles: admittedTiles("owner", PERMISSIONS),
      query: dashboardValuesQuerySchema.parse(query),
    },
    { now: new Date(now) },
  );
  return dashboardValuesSchema.parse(result);
}

const periodOf = (result: Awaited<ReturnType<typeof run>>, tileKey: string) => {
  const tile = result.tiles.find((candidate) => candidate.tileKey === tileKey);
  expect(tile, tileKey).toBeDefined();
  return tile!.period;
};

const custom = (date: string) => ({
  period: "custom",
  startDate: date,
  endDate: date,
});

// 2025-06-10T16:30Z = 23:30 WIB on 10 Jun = 00:30 WITA / 01:30 WIT on 11 Jun.
const JUST_BEFORE_WIB_MIDNIGHT = "2025-06-10T16:30:00.000Z";
// 2025-06-10T20:00Z = 03:00 WIB on 11 Jun (before a 04:00 cutoff).
const BEFORE_CUTOFF = "2025-06-10T20:00:00.000Z";
// 2025-06-10T21:30Z = 04:30 WIB on 11 Jun (after a 04:00 cutoff).
const AFTER_CUTOFF = "2025-06-10T21:30:00.000Z";

beforeAll(() => {
  setDashboardCacheTtlMs(0);
});

describe("dashboard today follows the outlet time zone and cutoff (legend-nipn7)", () => {
  it("an outlet east of WIB is already on the next day while WIB is still before midnight", async () => {
    const w = await world([{ timeZone: "Asia/Jayapura", cutoff: "00:00" }]);
    const result = await run(w, JUST_BEFORE_WIB_MIDNIGHT);
    expect(result.businessDate).toBe("2025-06-11");
    const today = periodOf(result, "owner.today_sales");
    expect(today.startDate).toBe("2025-06-11");
    expect(today.endDate).toBe("2025-06-11");
  });

  it("an outlet in WIB is still on the previous day at the same instant", async () => {
    const w = await world([{ timeZone: "Asia/Jakarta", cutoff: "00:00" }]);
    const result = await run(w, JUST_BEFORE_WIB_MIDNIGHT);
    expect(result.businessDate).toBe("2025-06-10");
    expect(periodOf(result, "owner.today_sales").endDate).toBe("2025-06-10");
  });

  it("before the closing-time cutoff the business day is still yesterday", async () => {
    const w = await world([{ timeZone: "Asia/Jakarta", cutoff: "04:00" }]);
    const before = await run(w, BEFORE_CUTOFF);
    expect(before.businessDate).toBe("2025-06-10");
    const today = periodOf(before, "owner.today_sales");
    expect(today.startDate).toBe("2025-06-10");
    expect(today.endDate).toBe("2025-06-10");

    const after = await run(w, AFTER_CUTOFF);
    expect(after.businessDate).toBe("2025-06-11");
    expect(periodOf(after, "owner.today_sales").endDate).toBe("2025-06-11");
  });
});

describe("a period is open until the outlet's own day has passed (legend-nipn7)", () => {
  it("a range ending on the outlet's today is open even though the default clock has moved on (before cutoff)", async () => {
    const w = await world([{ timeZone: "Asia/Jakarta", cutoff: "04:00" }]);
    // Outlet today is 10 Jun at 03:00 WIB on 11 Jun.
    const open = periodOf(
      await run(w, BEFORE_CUTOFF, custom("2025-06-10")),
      "owner.today_sales",
    );
    expect(open.status).toBe("open");
    // After the cutoff 10 Jun is over.
    const closed = periodOf(
      await run(w, AFTER_CUTOFF, custom("2025-06-10")),
      "owner.today_sales",
    );
    expect(closed.status).toBe("closed");
  });

  it("a range ending on the day before an eastern outlet's today is closed while WIB is still on that day", async () => {
    const w = await world([{ timeZone: "Asia/Jayapura", cutoff: "00:00" }]);
    // Jayapura is on 11 Jun, so 10 Jun is over for this outlet.
    const closed = periodOf(
      await run(w, JUST_BEFORE_WIB_MIDNIGHT, custom("2025-06-10")),
      "owner.today_sales",
    );
    expect(closed.status).toBe("closed");
    const open = periodOf(
      await run(w, JUST_BEFORE_WIB_MIDNIGHT, custom("2025-06-11")),
      "owner.today_sales",
    );
    expect(open.status).toBe("open");
  });

  it("with outlets on different days the earliest today counts: the period stays open while any outlet is still inside it", async () => {
    const w = await world([
      { timeZone: "Asia/Jakarta", cutoff: "00:00" }, // today 10 Jun
      { timeZone: "Asia/Jayapura", cutoff: "00:00" }, // today 11 Jun
    ]);
    const stillOpen = await run(
      w,
      JUST_BEFORE_WIB_MIDNIGHT,
      custom("2025-06-10"),
    );
    expect(periodOf(stillOpen, "owner.today_sales").status).toBe("open");
    const closed = await run(w, JUST_BEFORE_WIB_MIDNIGHT, custom("2025-06-09"));
    expect(periodOf(closed, "owner.today_sales").status).toBe("closed");
    // The default "today" tiles use that earliest day too.
    expect(
      periodOf(await run(w, JUST_BEFORE_WIB_MIDNIGHT), "owner.today_sales")
        .endDate,
    ).toBe("2025-06-10");
  });

  it("an open period never carries final figures", async () => {
    const w = await world([{ timeZone: "Asia/Jakarta", cutoff: "04:00" }]);
    const result = await run(w, BEFORE_CUTOFF, custom("2025-06-10"));
    const tile = result.tiles.find((t) => t.tileKey === "owner.today_sales")!;
    expect(tile.period.status).toBe("open");
    for (const entry of tile.values) expect(entry.finality).not.toBe("final");
  });

  it("tile finality follows the outlet's today, consistent with period.status", async () => {
    const w = await world([{ timeZone: "Asia/Jayapura", cutoff: "00:00" }]);
    // A stored final day of 5 transactions on 10 Jun: without data a value is
    // null and never final, so the day needs a row to prove finality.
    const definition = reportMetricByCode.get("transaction_count")!;
    await owner.query(
      `INSERT INTO metrics_daily (tenant_id, outlet_id, metric_date, metric_code, definition_id, definition_version,
         dimension_key, dimension_value, unit, value_int, finality, computed_at)
       VALUES ($1, $2, '2025-06-10', 'transaction_count', $3, $4, NULL, NULL, $5, 5, 'final', now())`,
      [
        w.tenantId,
        w.ids[0],
        definition.id,
        definition.version,
        definition.unit,
      ],
    );
    const countOf = (result: Awaited<ReturnType<typeof run>>) => {
      const tile = result.tiles.find(
        (t) => t.tileKey === "owner.transactions_today",
      )!;
      return {
        period: tile.period,
        entry: tile.values.find((v) => v.metricCode === "transaction_count")!,
      };
    };
    // 22:00 WIB on 10 Jun = 00:00 on 11 Jun in Jayapura: 10 Jun is over there
    // while the default (WIB) clock is still on 10 Jun.
    const over = countOf(
      await run(w, "2025-06-10T15:00:00.000Z", custom("2025-06-10")),
    );
    expect(over.period.status).toBe("closed");
    expect(over.entry.value).not.toBeNull();
    expect(over.entry.finality).toBe("final");
    // At 21:00 WIB (23:00 Jayapura) the day is still running: same stored
    // row, but only an estimate.
    const running = countOf(
      await run(w, "2025-06-10T14:00:00.000Z", custom("2025-06-10")),
    );
    expect(running.period.status).toBe("open");
    expect(running.entry.value).not.toBeNull();
    expect(running.entry.finality).toBe("estimate");
  });
});
