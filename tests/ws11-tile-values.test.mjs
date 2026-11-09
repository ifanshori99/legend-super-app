// WS-11 tile value and queue-row contract (beads legend-v3pt, legend-kx94).
// Pure contract test: no database, no web app.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import * as tileValues from "../packages/shared/src/dashboard/tile-values.ts";
import * as dashboardEndpoints from "../packages/shared/src/dashboard/endpoints.ts";
import { DASHBOARD_QUEUES } from "../packages/shared/src/dashboard/dashboards.ts";

// Not imported through dashboard/index.ts: its fixtures module is owned by
// another slice and may be mid-change; the barrel is checked by source below.
const dashboard = { ...tileValues, ...dashboardEndpoints, DASHBOARD_QUEUES };
import * as metrics from "../packages/shared/src/metrics/index.ts";
import { cafeLegendFixtures } from "../packages/shared/src/core/index.ts";

const outletId = cafeLegendFixtures.outlets[0].id;
const {
  DASHBOARD_ENDPOINTS,
  dashboardFacilityScopeFixture,
  dashboardFacilityScopeSchema,
  dashboardQueueRowsFixtures,
  dashboardQueueRowsSchema,
  dashboardTileValuesSchema,
  dashboardValuesFixture,
  dashboardValuesQuerySchema,
  dashboardValuesSchema,
  getDashboardValuesEndpoint,
  ownerTodaySalesValuesFixture,
  closedMonthSalesValuesFixture,
} = dashboard;

describe("tile values (legend-v3pt)", () => {
  test("dashboard/index.ts re-exports the tile value contract", () => {
    const index = readFileSync(
      new URL("../packages/shared/src/dashboard/index.ts", import.meta.url),
      "utf8",
    );
    assert.match(index, /export \* from "\.\/tile-values\.ts";/);
  });

  test("fixture carries value, target and a metricComparisonSchema comparison", () => {
    const [entry] = ownerTodaySalesValuesFixture.values;
    assert.ok(entry.target);
    assert.ok(
      metrics.metricComparisonSchema.safeParse(entry.comparison).success,
    );
    assert.ok(dashboardValuesSchema.safeParse(dashboardValuesFixture).success);
  });

  test("endpoint is GET /api/dashboards/:dashboardCode/values and registered", () => {
    assert.equal(getDashboardValuesEndpoint.method, "GET");
    assert.equal(
      getDashboardValuesEndpoint.path,
      "/api/dashboards/:dashboardCode/values",
    );
    assert.equal(
      DASHBOARD_ENDPOINTS.getDashboardValues,
      getDashboardValuesEndpoint,
    );
  });

  test("I2: an open period never carries final", () => {
    const tile = structuredClone(ownerTodaySalesValuesFixture);
    tile.values[0].finality = "final";
    assert.equal(dashboardTileValuesSchema.safeParse(tile).success, false);
  });

  test("I2: money stays an estimate until the accounting period closes", () => {
    const tile = structuredClone(closedMonthSalesValuesFixture);
    assert.ok(dashboardTileValuesSchema.safeParse(tile).success);
    tile.period.accountingPeriodClosed = false;
    assert.equal(dashboardTileValuesSchema.safeParse(tile).success, false);
    tile.values[0].finality = "estimate";
    assert.ok(dashboardTileValuesSchema.safeParse(tile).success);
  });

  test("finality is required on every value", () => {
    const tile = structuredClone(closedMonthSalesValuesFixture);
    delete tile.values[0].finality;
    assert.equal(dashboardTileValuesSchema.safeParse(tile).success, false);
  });

  test("target and comparison units must match the value", () => {
    const tile = structuredClone(ownerTodaySalesValuesFixture);
    tile.values[0].target = { unit: "count", value: 10 };
    assert.equal(dashboardTileValuesSchema.safeParse(tile).success, false);
    const tile2 = structuredClone(ownerTodaySalesValuesFixture);
    tile2.values[0].value = null;
    assert.equal(dashboardTileValuesSchema.safeParse(tile2).success, false);
  });

  test("duplicate metric codes and tile keys are rejected", () => {
    const tile = structuredClone(ownerTodaySalesValuesFixture);
    tile.values.push(structuredClone(tile.values[0]));
    assert.equal(dashboardTileValuesSchema.safeParse(tile).success, false);
    const payload = structuredClone(dashboardValuesFixture);
    payload.tiles.push(structuredClone(payload.tiles[0]));
    assert.equal(dashboardValuesSchema.safeParse(payload).success, false);
  });

  test("query: tenant fields refused, custom period needs both dates", () => {
    const parse = (q) => dashboardValuesQuerySchema.safeParse(q).success;
    assert.ok(parse({}));
    assert.ok(parse({ period: "today", outletIds: [outletId] }));
    assert.equal(parse({ tenantId: outletId }), false);
    assert.equal(parse({ period: "custom" }), false);
    assert.ok(
      parse({
        period: "custom",
        startDate: "2026-11-01",
        endDate: "2026-11-05",
      }),
    );
    assert.equal(
      parse({
        period: "custom",
        startDate: "2026-11-05",
        endDate: "2026-11-01",
      }),
      false,
    );
    assert.equal(
      parse({
        period: "today",
        startDate: "2026-11-01",
        endDate: "2026-11-01",
      }),
      false,
    );
  });
});

describe("queue rows and facility scope (legend-kx94)", () => {
  test("every row queue has a parsing fixture", () => {
    for (const queue of dashboard.DASHBOARD_ROW_QUEUES) {
      const payload = dashboardQueueRowsFixtures[queue];
      assert.ok(payload, queue);
      assert.ok(dashboardQueueRowsSchema.safeParse(payload).success, queue);
      assert.ok(dashboard.DASHBOARD_QUEUES.includes(queue), queue);
    }
  });

  test("a row from the wrong queue is rejected", () => {
    const payload = structuredClone(dashboardQueueRowsFixtures.kitchen_queue);
    payload.queue = "reviews";
    assert.equal(dashboardQueueRowsSchema.safeParse(payload).success, false);
  });

  test("SH-01: review and waiter rows reject identity fields", () => {
    for (const queue of ["reviews", "waiter_calls"]) {
      const payload = structuredClone(dashboardQueueRowsFixtures[queue]);
      payload.rows[0].customerName = "Budi";
      assert.equal(
        dashboardQueueRowsSchema.safeParse(payload).success,
        false,
        queue,
      );
    }
  });

  test("facility units fixture counts every unit of the outlet facilities", () => {
    const { rows } = dashboardQueueRowsFixtures.facility_units;
    assert.ok(rows.length >= 1);
    for (const row of rows)
      assert.ok(Object.values(row.unitCounts).reduce((a, b) => a + b, 0) > 0);
  });

  test("facility scope lists facility ids per outlet and reads through the existing units endpoint", () => {
    assert.ok(
      dashboardFacilityScopeSchema.safeParse(dashboardFacilityScopeFixture)
        .success,
    );
    const scope = dashboardFacilityScopeFixture.outlets.find(
      (o) => o.outletId === outletId,
    );
    assert.ok(scope && scope.facilityIds.length >= 1);
    const rowIds = dashboardQueueRowsFixtures.facility_units.rows.map(
      (r) => r.facilityId,
    );
    assert.deepEqual([...scope.facilityIds].sort(), [...rowIds].sort());
    assert.equal(dashboard.getDashboardFacilityScopeEndpoint.method, "GET");
    assert.equal(
      DASHBOARD_ENDPOINTS.getDashboardQueueRows.path,
      "/api/dashboards/queues/:queue/rows",
    );
  });
});
