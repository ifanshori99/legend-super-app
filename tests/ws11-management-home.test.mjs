// WS-11 management home per role (bead legend-6na6; PRD v1.7 §3.36 "Dashboard
// Manajemen" → "Beranda per Role", §3 F1 density modes, DASH-01/DASH-02).
// Runs with the root node:test suite and no database: it loads the shared
// dashboard contract, the web app's mock runtime and the home's own composition
// rules with Node type stripping.
//
// The screen itself is exercised in e2e/legend-6na6.mock.spec.ts; this file
// proves what it renders from: which tiles a role gets, which tiles RBAC hides,
// which report a KPI tile runs and with what period/outlets, and that mock mode
// serves the management layout and its runs through the shared endpoint owners.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/ws11-management-home/mock.ts";
import * as home from "../apps/web/src/features/ws11-management-home/lib.ts";
import { AREAS } from "../apps/web/src/lib/areas/definitions.ts";

const layout = dashboard.cafeLegendManagementLayoutFixture;
const runs = dashboard.managementDashboardKpiRuns;

function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}

function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}

function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

afterEach(() => {
  setScenario("normal");
  resetMocks();
});

describe("management home composition (F36 Beranda per Role)", () => {
  test("F36: the layout offers all seven management roles in catalog order", () => {
    assert.deepEqual(
      [...home.rolesInLayout(layout.tiles)],
      [...dashboard.MANAGEMENT_ROLES],
    );
    assert.equal(home.defaultRole(layout.tiles), "gm");
  });

  test("F36: each role gets one KPI tile and its own queue, plus the shared ones", () => {
    for (const role of dashboard.MANAGEMENT_ROLES) {
      const kpi = home.roleKpiTile(layout.tiles, role);
      const queue = home.roleQueueTiles(layout.tiles, role);
      assert.ok(kpi !== null, `${role} has a KPI tile`);
      assert.equal(kpi.managerRole, role);
      assert.ok(queue.length > 0, `${role} has a work queue`);
      assert.ok(
        queue.every(
          (tile) => tile.managerRole === role && tile.kind === "queue",
        ),
        `${role} queue cards are its own queue tiles`,
      );
      // Another role's queue never leaks into this role's home.
      const ownKeys = new Set(
        home.roleWorkTiles(layout.tiles, role).map((tile) => tile.key),
      );
      for (const other of dashboard.MANAGEMENT_ROLES)
        if (other !== role)
          for (const tile of home.roleWorkTiles(layout.tiles, other))
            if (tile.managerRole === other)
              assert.ok(
                !ownKeys.has(tile.key),
                `${role} does not show ${tile.key}`,
              );
    }
  });

  test("F36: the approval box renders once per role", () => {
    const approvals = home.sectionQueueTiles(layout.tiles, "approvals");
    // These roles' own queue IS an approval queue, so the shared box would be
    // the same list twice.
    for (const role of ["gm", "purchasing", "finance", "hr"])
      assert.equal(
        home.showsApprovalBox(
          home.roleQueueTiles(layout.tiles, role),
          approvals,
        ),
        false,
        `${role} already carries the inbox`,
      );
    for (const role of ["outlet_manager", "kitchen_lead", "marketing"])
      assert.equal(
        home.showsApprovalBox(
          home.roleQueueTiles(layout.tiles, role),
          approvals,
        ),
        true,
        `${role} needs the shared inbox`,
      );
  });

  test("F36: the approval box and report links are shared, not part of a role queue", () => {
    assert.deepEqual(home.roleWorkTiles(layout.tiles, null), []);
    const approvals = home.sectionQueueTiles(layout.tiles, "approvals");
    assert.deepEqual(
      approvals.map((tile) => tile.key),
      ["management.approvals"],
    );
    assert.ok(home.sectionTiles(layout.tiles, "reports").length > 0);
  });
});

describe("management home RBAC and metric definitions", () => {
  test("F36: tiles that need a permission the caller does not hold are hidden", () => {
    const visible = home.permittedTiles(layout.tiles, [
      "dashboard.management.view",
    ]);
    assert.ok(!visible.some((tile) => tile.key === "management.approvals"));
    assert.ok(!visible.some((tile) => tile.key === "management.audit_log"));
    assert.ok(visible.some((tile) => tile.key === "management.kitchen_kpi"));

    const withApprovals = home.permittedTiles(layout.tiles, [
      "dashboard.management.view",
      "approval.inbox.view",
      "audit.log.view",
    ]);
    assert.ok(
      withApprovals.some((tile) => tile.key === "management.approvals"),
    );
    assert.ok(
      withApprovals.some((tile) => tile.key === "management.audit_log"),
    );
  });

  test("DASH-01: every KPI cell is a registry metric and every tile drills into a report", () => {
    for (const tile of layout.tiles) {
      const report = dashboard.dashboardTileReport(tile);
      if (tile.kind === "metric") {
        assert.ok(report !== null, `${tile.key} has a source report`);
        assert.match(report.route, /^\/reports\//);
        for (const line of home.kpiLines(tile, null))
          assert.ok(
            line.name.length > 0,
            `${tile.key} ${line.code} has a name`,
          );
      }
    }
  });
});

describe("management home KPI values (DASH-02)", () => {
  test("DASH-02: a role KPI tile runs its source report unsplit for the same period and outlets", () => {
    const tile = home.roleKpiTile(layout.tiles, "finance");
    assert.ok(tile !== null);
    const input = home.kpiRunInput(tile, layout);
    assert.equal(input.reportCode, "finance.cash_position");
    assert.deepEqual(input.groupBy, []);
    assert.deepEqual(input.period, {
      startDate: layout.monitoringPeriod.startDate,
      endDate: layout.monitoringPeriod.endDate,
    });
    assert.deepEqual(input.outletIds, [...layout.availableOutlets]);
  });

  test("DASH-02: purchasing's month-to-date tile runs the month up to the business date", () => {
    const tile = home.roleKpiTile(layout.tiles, "purchasing");
    assert.ok(tile !== null);
    const period = home.resolveTilePeriod(tile, layout);
    assert.equal(period.preset, "this_month");
    assert.equal(period.startDate, "2026-11-01");
    assert.equal(period.endDate, layout.businessDate);
  });

  test("DASH-02: the strip reads each metric from the run and formats by unit", () => {
    const tile = home.roleKpiTile(layout.tiles, "gm");
    assert.ok(tile !== null);
    const run = runs[tile.reportCode];
    assert.ok(run !== undefined);
    const lines = home.kpiLines(tile, run);
    assert.deepEqual(
      lines.map((line) => line.code),
      [...tile.metricCodes],
    );
    assert.deepEqual(lines[0].value, { unit: "idr", valueIdr: 7_420_000 });
    assert.equal(home.formatPercent("68.4000"), "68,4");
    assert.equal(home.secondsToMinutes(780), 13);
    // A metric the run does not carry is "no data", never zero.
    assert.equal(home.metricValueOf(run, "food_cost_pct"), null);
  });

  test("DASH-01: the drill-down path carries the tile's period and outlet", () => {
    const tile = home.roleKpiTile(layout.tiles, "kitchen_lead");
    assert.ok(tile !== null);
    const path = home.tileDrillDownPath(tile, layout);
    assert.ok(path !== null);
    assert.match(path, /^\/reports\/operations\/kitchen-queue\?/);
    assert.match(path, /startDate=2026-11-01/);
    assert.match(path, new RegExp(`outletId=${layout.availableOutlets[0]}`));
  });

  test("DASH-02: every KPI tile of every role has a fixture run", () => {
    for (const role of dashboard.MANAGEMENT_ROLES) {
      const tile = home.roleKpiTile(layout.tiles, role);
      assert.ok(tile !== null);
      assert.ok(
        runs[tile.reportCode] !== undefined,
        `${role} needs a run for ${tile.reportCode}`,
      );
    }
  });
});

describe("management home mock mode", () => {
  test("F36: mock mode serves the management layout through the shared owner", async () => {
    const response = await get("/api/dashboards/management");
    assert.equal(response.data.dashboard, "management");
    assert.equal(response.data.tiles.length, layout.tiles.length);

    // Owner and shareholder screens register their own layout; this mock must
    // not answer for them (and must not have registered a second handler).
    const declined = await failure(get("/api/dashboards/owner"));
    assert.equal(declined.code, "NOT_FOUND");
  });

  test("DASH-02: mock mode serves the role KPI run with values", async () => {
    const tile = home.roleKpiTile(layout.tiles, "hr");
    assert.ok(tile !== null);
    const response = await post(
      "/api/reports/run",
      home.kpiRunInput(tile, layout),
    );
    assert.equal(response.data.reportCode, "attendance.by_station");
    assert.equal(
      home.metricValueOf(response.data, "attendance_late_count").value,
      3,
    );
  });

  test("F36: the empty scenario removes the role work queue but keeps the page", async () => {
    setScenario("empty");
    const response = await get("/api/dashboards/management");
    assert.ok(
      response.data.tiles.every((tile) => tile.section !== "work_queue"),
    );
    assert.deepEqual(
      [...new Set(response.data.tiles.map((tile) => tile.section))],
      ["approvals", "reports"],
    );
  });

  test("DASH-02: the empty scenario returns a run without rows", async () => {
    setScenario("empty");
    const tile = home.roleKpiTile(layout.tiles, "gm");
    assert.ok(tile !== null);
    const response = await post(
      "/api/reports/run",
      home.kpiRunInput(tile, layout),
    );
    assert.deepEqual(response.data.rows, []);
    assert.equal(home.isRunEmpty(response.data), true);
  });
});

describe("management home page chrome", () => {
  test("F1: the kelola area renders the management shell in Padat & Presisi", () => {
    assert.equal(AREAS.kelola.density, "padat");
    assert.equal(AREAS.kelola.shell, "management");
    assert.equal(AREAS.kelola.indexPath, "/kelola");
  });
});
