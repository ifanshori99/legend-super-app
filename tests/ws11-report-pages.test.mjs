// Report pages batch A + B and drill-down paths (WS-11, beads legend-imfe,
// legend-9fo4, legend-tp3x; PRD v1.7 §3 F36; DASH-01, DASH-02, I1/I4). Root
// node:test suite, no database: checks the route files, the generated route
// tree, the mock runs of the new families and the dashboard tile paths.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import "../apps/web/src/features/ws11-management-home/mock.ts";
import "../apps/web/src/features/ws11-owner-dashboard/mock.ts";
import { buildReportRuns } from "../apps/web/src/features/ws11-reports/mock.ts";
import { dispatchMock } from "../apps/web/src/lib/mock/runtime.ts";

const BATCH_A = ["menu", "payments", "tax", "inventory", "cogs", "purchasing"];
const BATCH_B = [
  "finance",
  "loyalty",
  "crm",
  "reservation",
  "attendance",
  "payroll",
  "performance",
];
const SERVED = dashboard.reportCatalog.filter((r) =>
  [...BATCH_A, ...BATCH_B].includes(r.family),
);
const routeFile = (report) =>
  `apps/web/src/routes/_kelola/reports.${report.route
    .replace(/^\/reports\//, "")
    .split("/")
    .join(".")}.tsx`;

describe("report pages batch A + B · DASH-01", () => {
  test("DASH-01: every batch A and B report has a thin route at its contract path", () => {
    assert.ok(SERVED.length >= 60, `only ${SERVED.length} reports`);
    for (const report of SERVED) {
      const file = routeFile(report);
      assert.ok(existsSync(file), `${report.code} -> ${file}`);
      const source = readFileSync(file, "utf8");
      assert.match(
        source,
        new RegExp(`reportRouteOptions\\("${report.code}"\\)`),
      );
      assert.match(source, new RegExp(`"/_kelola${report.route}"`));
    }
  });

  test("DASH-01: the generated route tree knows every batch route", () => {
    const tree = readFileSync("apps/web/src/routeTree.gen.ts", "utf8");
    for (const report of SERVED)
      assert.ok(
        tree.includes(`'/_kelola${report.route}'`),
        `${report.code} missing from routeTree.gen.ts`,
      );
  });
});

describe("batch A + B mock runs · DASH-02, I1", () => {
  const runs = buildReportRuns();
  const find = (code, group, start, end) =>
    runs.find(
      (run) =>
        run.reportCode === code &&
        run.groupBy.join(",") === group &&
        run.period.startDate === start &&
        run.period.endDate === end,
    );
  const idr = (run, row, code) =>
    run.rows[row].values.find((cell) => cell.metricCode === code).value
      .valueIdr;

  test("DASH-02: every served report has an unsplit run for its default period", () => {
    for (const report of SERVED) {
      assert.ok(
        runs.some(
          (r) => r.reportCode === report.code && r.groupBy.length === 0,
        ),
        report.code,
      );
    }
  });

  test("I1: finance, cogs and tax money of the closed month hangs off the sales day model", () => {
    const [start, end] = ["2026-10-01", "2026-10-31"];
    const sales = find("sales.daily", "", start, end);
    const pnl = find("finance.income_statement", "", start, end);
    const cogs = find("cogs.trend", "", start, end);
    const tax = find("tax.pbjt", "", start, end);
    assert.ok(sales && pnl && cogs && tax, "closed-month runs exist");
    // The shareholder's closed month ties to the books (SH-01).
    assert.equal(idr(sales, 0, "net_sales"), 412_800_000);
    assert.equal(idr(pnl, 0, "net_sales"), idr(sales, 0, "net_sales"));
    assert.equal(idr(pnl, 0, "cogs"), idr(cogs, 0, "cogs"));
    assert.equal(
      idr(pnl, 0, "gross_profit"),
      idr(pnl, 0, "net_sales") - idr(pnl, 0, "cogs"),
    );
    assert.equal(idr(tax, 0, "tax_collected"), 41_280_000);
  });

  test("DASH-02: a split adds up to the unsplit total for every money metric", () => {
    let compared = 0;
    for (const run of runs) {
      if (run.groupBy.length === 0) continue;
      const total = runs.find(
        (r) =>
          r.reportCode === run.reportCode &&
          r.groupBy.length === 0 &&
          r.period.startDate === run.period.startDate &&
          r.period.endDate === run.period.endDate,
      );
      if (total === undefined) continue;
      for (const [index, cell] of total.rows[0].values.entries()) {
        const def = run.definitions[index];
        // Sums only: ratios, averages and balances do not add up across rows.
        if (def.aggregation !== "sum" || cell.value?.unit !== "idr") continue;
        const parts = run.rows.reduce(
          (sum, row) => sum + row.values[index].value.valueIdr,
          0,
        );
        assert.equal(
          parts,
          cell.value.valueIdr,
          `${run.reportCode} by ${run.groupBy} ${def.code}`,
        );
        compared += 1;
      }
    }
    assert.ok(compared > 50, `compared only ${compared} sums`);
  });

  test("SH-02: an open-period closed-only figure is an estimate, a closed month is final", () => {
    const open = runs.find(
      (r) =>
        r.reportCode === "finance.income_statement" &&
        r.groupBy.length === 0 &&
        r.period.status === "open",
    );
    assert.ok(open, "an open-period run exists");
    for (const cell of open.rows[0].values)
      assert.equal(cell.finality, "estimate");
    const closed = runs.find(
      (r) =>
        r.reportCode === "finance.income_statement" &&
        r.groupBy.length === 0 &&
        r.period.accountingPeriodClosed,
    );
    assert.ok(closed, "a closed month run exists");
    for (const cell of closed.rows[0].values)
      assert.equal(cell.finality, "final");
  });

  test("DASH-02: the mock endpoint serves a batch run", async () => {
    const response = await dispatchMock({
      method: "POST",
      path: "/api/reports/run",
      body: {
        reportCode: "tax.pbjt",
        period: { startDate: "2026-11-01", endDate: "2026-11-01" },
        groupBy: [],
        filters: [],
        bucket: "total",
        limit: 100,
      },
    });
    assert.equal(response.data.reportCode, "tax.pbjt");
    assert.equal(response.data.rows[0].values[0].value.valueIdr, 742_000);
  });
});

describe("dashboard drill-down paths · legend-tp3x, DASH-02", () => {
  const tiles = [
    ...dashboard.OWNER_DASHBOARD_TILES,
    ...dashboard.SHAREHOLDER_DASHBOARD_TILES,
    ...dashboard.MANAGEMENT_DASHBOARD_TILES,
  ].filter((tile) => tile.kind === "metric" && tile.reportCode !== null);
  // Families outside batch A and B ship their pages with their own bead.
  const OTHER = new Set(["traffic", "operations", "sales", "facility"]);

  test("legend-tp3x: tile paths keep period and outlet and point at the catalog route", () => {
    for (const tile of tiles) {
      const path = dashboard.dashboardTilePath(tile, {
        startDate: "2026-11-01",
        endDate: "2026-11-01",
        outletIds: ["11111111-1111-4111-8111-111111111111"],
      });
      const report = dashboard.reportByCode(tile.reportCode);
      assert.ok(path?.startsWith(report.route), `${tile.reportCode} ${path}`);
      assert.match(path, /startDate=2026-11-01/);
      assert.match(path, /endDate=2026-11-01/);
      assert.match(path, /outletIds?=/);
    }
  });

  test("legend-tp3x: every tile whose report is in batch A or B has a route file", () => {
    let checked = 0;
    for (const tile of tiles) {
      const report = dashboard.reportByCode(tile.reportCode);
      if (OTHER.has(report.family)) continue;
      assert.ok(
        existsSync(routeFile(report)),
        `${tile.reportCode} has no page`,
      );
      checked += 1;
    }
    assert.ok(checked > 0);
  });
});
