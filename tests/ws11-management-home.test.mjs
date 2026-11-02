// WS-11 management home per role (bead legend-6na6; PRD v1.7 §3.36 "Dashboard
// Manajemen" → "Beranda per Role", §3 F1 density modes, DASH-01). Runs with
// the root node:test suite and no database: it loads the shared dashboard
// contract, the web app's mock runtime and the home's own composition rules
// with Node type stripping.
//
// The screen itself is exercised in e2e/legend-6na6.mock.spec.ts; this file
// proves the rules it renders from: which tiles a role gets, which tiles RBAC
// hides, that every KPI card cites a registry definition and a source report,
// and that mock mode serves the management layout without hijacking the owner
// or shareholder dashboards that share the same endpoint.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import { MOCK_UNHANDLED, registerMock } from "../apps/web/src/lib/mock/registry.ts";
import "../apps/web/src/features/ws11-management-home/mock.ts";
import * as home from "../apps/web/src/features/ws11-management-home/lib.ts";
import { AREAS } from "../apps/web/src/lib/areas/definitions.ts";

const layout = dashboard.cafeLegendManagementLayoutFixture;

function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
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

  test("F36: each role gets its own work tiles plus the shared ones", () => {
    const finance = home.roleWorkTiles(layout.tiles, "finance");
    assert.deepEqual(
      finance.map((tile) => tile.key),
      ["management.finance_kpi", "management.finance_queue"],
    );
    // A role never sees another role's queue (the outlet manager's kitchen
    // and stock tiles stay out of the finance home).
    assert.ok(
      !finance.some((tile) => tile.key === "management.outlet_queue"),
    );
    // The approval inbox and the report links are role-independent: they are
    // not part of the role work queue, they render in their own sections.
    assert.deepEqual(home.roleWorkTiles(layout.tiles, null), []);
  });

  test("F36: every role's work queue is non-empty and in the work_queue section", () => {
    for (const role of dashboard.MANAGEMENT_ROLES) {
      const tiles = home.roleWorkTiles(layout.tiles, role);
      assert.ok(tiles.length > 0, `${role} has work tiles`);
      assert.ok(
        tiles.every((tile) => tile.section === home.WORK_QUEUE_SECTION),
        `${role} tiles live in the work queue section`,
      );
    }
  });

  test("F36: sections drop empty groups and keep render order", () => {
    const sections = home.layoutSections(layout, [
      "dashboard.management.view",
      "approval.inbox.view",
      "audit.log.view",
    ]);
    assert.deepEqual(
      sections.map((group) => group.section),
      ["work_queue", "approvals", "reports"],
    );
    // Without the inbox permission the approval section disappears entirely
    // instead of showing a heading over nothing.
    assert.deepEqual(
      home
        .layoutSections(layout, ["dashboard.management.view"])
        .map((group) => group.section),
      ["work_queue", "reports"],
    );
  });
});

describe("management home RBAC and metric definitions", () => {
  test("F36: tiles that need a permission the caller does not hold are hidden", () => {
    // A kitchen lead's home without the approval or audit permission: the
    // inbox and audit link are absent, the role's own KPIs stay.
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
    assert.ok(withApprovals.some((tile) => tile.key === "management.audit_log"));
  });

  test("DASH-01: every metric tile cites registry definitions and a source report", () => {
    for (const tile of layout.tiles) {
      if (tile.kind !== "metric") continue;
      const lines = home.metricLines(tile);
      assert.equal(
        lines.length,
        tile.metricCodes.length,
        `${tile.key} resolves every metric code`,
      );
      for (const line of lines) assert.ok(line.name.length > 0);
      const report = dashboard.dashboardTileReport(tile);
      assert.ok(report !== null, `${tile.key} drills into a report`);
      assert.match(report.route, /^\/reports\//);
    }
  });
});

describe("management home mock mode", () => {
  test("F36: mock mode serves the management layout and declines other dashboards", async () => {
    const response = await get("/api/dashboards/management");
    assert.equal(response.data.dashboard, "management");
    assert.equal(response.data.tiles.length, layout.tiles.length);

    // Owner and shareholder screens register their own handler for the same
    // endpoint; this mock must not answer for them.
    const declined = await failure(get("/api/dashboards/owner"));
    assert.equal(declined.code, "NOT_FOUND");
  });

  test("F36: the empty scenario removes the role work queue", async () => {
    setScenario("empty");
    const response = await get("/api/dashboards/management");
    assert.ok(
      response.data.tiles.every((tile) => tile.section !== "work_queue"),
    );
    // The shared approval box and report links stay: an empty queue is not an
    // empty page.
    assert.deepEqual(
      [...new Set(response.data.tiles.map((tile) => tile.section))],
      ["approvals", "reports"],
    );
  });

  test("F36: a second mock on the same endpoint can answer the dashboards it owns", async () => {
    registerMock(dashboard.getDashboardEndpoint, ({ params }) =>
      params.dashboard === "owner"
        ? { data: dashboard.cafeLegendDashboardFixtures.ownerLayout }
        : MOCK_UNHANDLED,
    );

    const management = await get("/api/dashboards/management");
    assert.equal(management.data.dashboard, "management");

    const owner = await get("/api/dashboards/owner");
    assert.equal(owner.data.dashboard, "owner");
  });
});

describe("management home page chrome", () => {
  test("F1: the kelola area renders the management shell in Padat & Presisi", () => {
    assert.equal(AREAS.kelola.density, "padat");
    assert.equal(AREAS.kelola.shell, "management");
    assert.equal(AREAS.kelola.indexPath, "/kelola");
  });
});
