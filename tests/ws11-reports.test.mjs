// Report viewer + sales family + exports (WS-11 FE, bead legend-j815; PRD v1.7
// §3 F36; DASH-02, DASH-04). Root node:test suite, no database: loads the shared
// dashboard contract, the web mock runtime and the viewer's pure view model
// with Node type stripping. The screens are exercised in
// e2e/legend-j815.mock.spec.ts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as lib from "../apps/web/src/features/ws11-reports/lib.ts";
// Side effect: the owner screen registers its runs first, so a clash with the
// sales runs would throw here (DASH-02).
import "../apps/web/src/features/ws11-management-home/mock.ts";
import "../apps/web/src/features/ws11-owner-dashboard/mock.ts";
import "../apps/web/src/features/ws11-reports/mock.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { dispatchMock } from "../apps/web/src/lib/mock/runtime.ts";

const BD = "2026-11-01";
const SALES = dashboard.reportCatalog.filter((r) =>
  [
    "sales.daily",
    "sales.per_hour",
    "sales.per_channel",
    "sales.per_menu",
    "sales.per_employee",
    "sales.transactions",
    "sales.per_pax",
    "sales.void",
    "sales.discount",
    "sales.refund",
  ].includes(r.code),
);

afterEach(() => setScenario("normal"));

const post = (path, body) => dispatchMock({ method: "POST", path, body });
const get = (path, query = {}) => dispatchMock({ method: "GET", path, query });

function run(code, groupBy, range) {
  return post("/api/reports/run", {
    reportCode: code,
    period: range,
    groupBy: groupBy ? [groupBy] : [],
    filters: [],
    bucket: "total",
    limit: 100,
  });
}

function cell(result, row, metric) {
  const value = result.rows[row].values.find(
    (c) => c.metricCode === metric,
  )?.value;
  return value?.valueIdr ?? Number(value?.value);
}

describe("report routes · DASH-02", () => {
  test("DASH-02: every sales report has a route file at its contract path", () => {
    assert.equal(SALES.length, 10);
    for (const report of SALES) {
      const slug = report.route.replace(/^\/reports\//, "").split("/");
      const file = `apps/web/src/routes/_kelola/reports.${slug.join(".")}.tsx`;
      assert.ok(existsSync(file), `${report.code} -> ${file}`);
    }
    assert.equal(
      dashboard.reportRouteForCode("sales.per_hour"),
      "/reports/sales/per-hour",
    );
  });
});

describe("viewer view model · DASH-02", () => {
  test("DASH-02: period presets resolve against the business date (Monday weeks)", () => {
    assert.deepEqual(lib.resolvePreset("today", BD), {
      startDate: BD,
      endDate: BD,
    });
    assert.deepEqual(lib.resolvePreset("this_week", BD), {
      startDate: "2026-10-26",
      endDate: BD,
    });
    assert.deepEqual(lib.resolvePreset("last_month", BD), {
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    assert.deepEqual(lib.resolvePreset("last_quarter", BD), {
      startDate: "2026-07-01",
      endDate: "2026-09-30",
    });
    assert.equal(lib.resolvePreset("custom", BD), null);
  });

  test("DASH-02: a dashboard tile link is read back into the same period, outlets and split", () => {
    const layout = dashboard.cafeLegendDashboardFixtures.ownerLayout;
    const tile = layout.tiles.find((t) => t.reportCode === "sales.per_channel");
    const path = dashboard.dashboardTilePath(tile, {
      startDate: BD,
      endDate: BD,
      outletIds: layout.availableOutlets,
      groupBy: "channel",
    });
    const url = new URL(path, "https://x.test");
    const raw = {
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
      outletId: url.searchParams.getAll("outletId"),
      groupBy: url.searchParams.get("groupBy"),
    };
    const search = lib.validateReportSearch(raw);
    const definition = dashboard.reportByCode("sales.per_channel");
    assert.equal(url.pathname, definition.route);
    assert.deepEqual(search.outletId, layout.availableOutlets);
    const period = lib.resolvePeriod(definition, search, BD);
    assert.deepEqual(period.range, { startDate: BD, endDate: BD });
    assert.equal(period.preset, "today");
    assert.equal(lib.resolveSplit(definition, search), "channel");
  });

  test("DASH-02: malformed links fall back to the report default instead of failing", () => {
    const search = lib.validateReportSearch({
      startDate: "2026-13-40",
      endDate: "x",
      outletId: "not-a-uuid",
      groupBy: "DROP TABLE",
      preset: "someday",
    });
    assert.deepEqual(search, {});
  });

  test("DASH-04: a report opens split by a person only when it is about people", () => {
    const by = (code) => lib.defaultSplit(dashboard.reportByCode(code));
    assert.equal(by("sales.per_hour"), "hour");
    assert.equal(by("sales.per_employee"), "employee");
    assert.notEqual(by("sales.void"), "employee");
    assert.equal(by("sales.refund"), "payment_method");
  });

  test("DASH-04: the export gate follows the report and the split, never a client flag", () => {
    const void_ = dashboard.reportByCode("sales.void");
    const daily = dashboard.reportByCode("sales.daily");
    assert.equal(lib.selectionIsPersonal(void_, null), true);
    assert.equal(lib.selectionIsPersonal(daily, "channel"), false);
    assert.equal(
      lib.selectionIsPersonal(
        { containsPersonalData: false, dimensions: ["employee"] },
        "employee",
      ),
      true,
    );
  });
});

describe("sales report runs · DASH-02", () => {
  test("DASH-02: every offered preset x split of every sales report is served and valid", async () => {
    let served = 0;
    for (const report of SALES)
      for (const preset of lib.namedPresets(report)) {
        const range = lib.resolvePreset(preset, BD);
        for (const split of [null, ...report.dimensions]) {
          const response = await run(report.code, split, range);
          dashboard.reportResultSchema.parse(response.data);
          assert.equal(response.data.reportCode, report.code);
          served += 1;
        }
      }
    assert.ok(served > 100, `served ${served}`);
  });

  test("DASH-02: splitting a report never changes its totals", async () => {
    const range = lib.resolvePreset("last_month", BD);
    const total = (await run("sales.per_hour", null, range)).data;
    for (const split of ["hour", "outlet"]) {
      const rows = (await run("sales.per_hour", split, range)).data;
      for (const metric of ["net_sales", "transaction_count", "pax"]) {
        const sum = rows.rows.reduce((s, _, i) => s + cell(rows, i, metric), 0);
        assert.equal(sum, cell(total, 0, metric), `${split} ${metric}`);
      }
    }
  });

  test("DASH-02: the viewer and the owner dashboard read one channel run", async () => {
    const owner = dashboard.ownerDashboardBoardRuns["sales.per_channel"];
    const response = await run("sales.per_channel", "channel", {
      startDate: BD,
      endDate: BD,
    });
    for (const index of owner.rows.keys())
      assert.equal(
        cell(response.data, index, "net_sales"),
        cell(owner, index, "net_sales"),
      );
    const total = await run("sales.daily", null, {
      startDate: BD,
      endDate: BD,
    });
    const ownerNet = owner.rows.reduce(
      (s, row) =>
        s + row.values.find((c) => c.metricCode === "net_sales").value.valueIdr,
      0,
    );
    assert.equal(cell(total.data, 0, "net_sales"), ownerNet);
  });

  test("DASH-02: the open day is an estimate, a closed month is final", async () => {
    const open = (
      await run("sales.daily", null, { startDate: BD, endDate: BD })
    ).data;
    assert.equal(lib.resultFinality(open), "estimate");
    assert.equal(open.period.status, "open");
    const closed = (
      await run("sales.daily", null, lib.resolvePreset("last_month", BD))
    ).data;
    assert.equal(lib.resultFinality(closed), "final");
  });

  test("DASH-02: the empty scenario returns no rows, which the viewer reads as empty", async () => {
    setScenario("empty");
    const result = (
      await run("sales.per_menu", "menu_item", { startDate: BD, endDate: BD })
    ).data;
    assert.equal(lib.isResultEmpty(result), true);
  });

  test("DASH-02: the catalog and one definition are served", async () => {
    const page = await get("/api/reports", { family: "sales", limit: 25 });
    assert.ok(page.data.length >= 10);
    assert.ok(page.data.every((r) => r.family === "sales"));
    const one = await get("/api/reports/sales.per_hour");
    assert.equal(one.data.route, "/reports/sales/per-hour");
  });
});

describe("exports · DASH-04", () => {
  const query = (groupBy) => ({
    period: { startDate: BD, endDate: BD },
    groupBy,
    filters: [],
    bucket: "total",
  });

  test("DASH-04: a personal-data export waits for approval and produces no file", async () => {
    const created = await post("/api/reports/exports", {
      reportCode: "sales.per_employee",
      format: "xlsx",
      query: query(["employee"]),
      idempotencyKey: "test-pii-0001",
    });
    assert.equal(created.data.containsPersonalData, true);
    assert.equal(created.data.status, "pending_approval");
    assert.equal(created.data.file, null);
    assert.equal(dashboard.reportExportNeedsApproval(created.data), true);
    const again = await post("/api/reports/exports", {
      reportCode: "sales.per_employee",
      format: "xlsx",
      query: query(["employee"]),
      idempotencyKey: "test-pii-0001",
    });
    assert.equal(again.data.id, created.data.id);
  });

  test("DASH-04: splitting an aggregate report by a person makes the export personal", async () => {
    const created = await post("/api/reports/exports", {
      reportCode: "sales.void",
      format: "csv",
      query: query(["employee"]),
    });
    assert.equal(created.data.status, "pending_approval");
  });

  test("DASH-04: an aggregate export is queued, then ready with a download path", async () => {
    const created = await post("/api/reports/exports", {
      reportCode: "sales.per_hour",
      format: "csv",
      query: query(["hour"]),
    });
    assert.equal(created.data.containsPersonalData, false);
    assert.equal(created.data.status, "queued");
    const listed = await get("/api/reports/exports", { limit: 25 });
    assert.ok(listed.data.some((job) => job.id === created.data.id));
    const ready = listed.data.find((job) => job.status === "ready");
    assert.ok(ready.file.downloadPath.startsWith("/api/reports/exports/"));
  });
});
