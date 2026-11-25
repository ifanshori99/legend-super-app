// Report surfaces whose server side is not built yet (legend-x73li, sizing
// X7-2): the export button (POST /api/reports/exports has no route, 404) and
// reports whose metrics have no server source (1267 F1: one shared list). A real
// build hides the button and lists those reports as "Segera hadir"; mock mode
// keeps both so the clickable mockup still works.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as lib from "../apps/web/src/features/ws11-reports/lib.ts";

test("the export button is offered only in mock mode until the export API exists", () => {
  assert.equal(lib.reportExportOffered({ mock: false }), false);
  assert.equal(lib.reportExportOffered({ mock: true }), true);
});

const HELD_BACK = ["finance", "attendance", "payroll", "performance"];

test("a report is coming soon outside mock mode when its family is held back or none of its metrics has a source", () => {
  const unbuilt = dashboard.dashboardMetricDefinitions; // catalog exists
  assert.ok(unbuilt.length > 0);
  let soon = 0;
  for (const report of dashboard.reportCatalog) {
    const allUnbuilt = report.metrics.every((code) =>
      dashboard.METRIC_CODES_WITHOUT_SOURCE.includes(code),
    );
    assert.equal(
      lib.reportHasData(report, { mock: false }),
      !allUnbuilt && !HELD_BACK.includes(report.family),
      report.code,
    );
    assert.equal(lib.reportHasData(report, { mock: true }), true, report.code);
    if (allUnbuilt) soon += 1;
  }
  assert.ok(soon > 0, "the catalog still has reports without a source");
});

test("release 1 opens no report of the four held back families", () => {
  for (const family of HELD_BACK) {
    const reports = dashboard.reportCatalog.filter((r) => r.family === family);
    assert.ok(reports.length > 0, family);
    for (const report of reports)
      assert.equal(
        lib.reportHasData(report, { mock: false }),
        false,
        report.code,
      );
  }
});

test("a tile or deep link to a sourceless report is coming soon, not a screen", () => {
  const q = "?startDate=2026-11-01&endDate=2026-11-01";
  const sourceless = dashboard.reportCatalog.filter(
    (report) => !lib.reportHasData(report, { mock: false }),
  );
  assert.ok(sourceless.length > 0);
  for (const report of sourceless) {
    assert.equal(
      lib.reportPathIsComingSoon(report.route, { mock: false }),
      true,
      report.code,
    );
    assert.equal(
      lib.reportPathIsComingSoon(report.route + q, { mock: false }),
      true,
      report.code,
    );
    assert.equal(
      lib.reportPathIsComingSoon(report.route, { mock: true }),
      false,
      report.code,
    );
  }
  const built = dashboard.reportCatalog.find((report) =>
    lib.reportHasData(report, { mock: false }),
  );
  assert.equal(lib.reportPathIsComingSoon(built.route, { mock: false }), false);
  for (const path of ["/reports", "/kelola"])
    assert.equal(
      lib.reportPathIsComingSoon(path, { mock: false }),
      false,
      path,
    );
});

test("the facility report hub uses the same availability rule as the catalog", () => {
  const hub = readFileSync(
    "apps/web/src/features/facility-report/components/facility-report-hub.tsx",
    "utf8",
  );
  assert.match(hub, /reportHasData\(report, \{ mock: API_MOCK \}\)/);
});

test("1267 F2: a result whose metrics all lack a source says so instead of blaming the period", () => {
  const unavailable = { status: "unavailable", reason: "source_not_built" };
  const result = (availability) => ({ availability });
  assert.equal(
    lib.isResultSourceMissing(result([{ metricCode: "a", ...unavailable }])),
    true,
  );
  assert.equal(
    lib.isResultSourceMissing(
      result([
        { metricCode: "a", ...unavailable },
        { metricCode: "b", status: "available" },
      ]),
    ),
    false,
  );
  assert.equal(
    lib.isResultSourceMissing(
      result([
        {
          metricCode: "a",
          status: "unavailable",
          reason: "dimension_not_supported",
        },
      ]),
    ),
    false,
  );
});
