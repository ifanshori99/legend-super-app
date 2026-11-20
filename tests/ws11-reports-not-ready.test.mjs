// Report surfaces whose server side is not built yet (legend-x73li, sizing
// X7-2): the export button (POST /api/reports/exports has no route, 404) and
// the finance/hr report families (their metric sources are empty). A real
// build hides the button and lists those reports as "Segera hadir"; mock mode
// keeps both so the clickable mockup still works.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import * as lib from "../apps/web/src/features/ws11-reports/lib.ts";

test("the export button is offered only in mock mode until the export API exists", () => {
  assert.equal(lib.reportExportOffered({ mock: false }), false);
  assert.equal(lib.reportExportOffered({ mock: true }), true);
});

test("finance and hr report families are listed as coming soon outside mock mode", () => {
  for (const family of ["finance", "attendance", "payroll", "performance"]) {
    assert.equal(
      lib.reportFamilyHasData(family, { mock: false }),
      false,
      family,
    );
    assert.equal(lib.reportFamilyHasData(family, { mock: true }), true, family);
  }
  for (const family of dashboard.REPORT_FAMILIES) {
    if (["finance", "attendance", "payroll", "performance"].includes(family))
      continue;
    assert.equal(
      lib.reportFamilyHasData(family, { mock: false }),
      true,
      family,
    );
  }
});

test("a tile or deep link to a sourceless report family is coming soon, not a screen", () => {
  const q = "?startDate=2026-11-01&endDate=2026-11-01";
  for (const path of [
    "/reports/finance/ebitda",
    "/reports/attendance/daily",
    "/reports/payroll/gross",
    "/reports/performance/employee",
  ]) {
    assert.equal(lib.reportPathIsComingSoon(path, { mock: false }), true, path);
    assert.equal(lib.reportPathIsComingSoon(path, { mock: true }), false, path);
    // dashboard tiles pass the path with its query already stripped by callers
    assert.equal(
      lib.reportPathIsComingSoon(path + q.split("?")[0], { mock: false }),
      true,
    );
  }
  for (const path of [
    "/reports/sales/per-hour",
    "/reports/inventory/waste",
    "/reports",
    "/kelola",
  ])
    assert.equal(
      lib.reportPathIsComingSoon(path, { mock: false }),
      false,
      path,
    );
});

test("every catalog report of a sourceless family has a contract route that the guard covers", () => {
  const sourceless = dashboard.reportCatalog.filter((r) =>
    ["finance", "attendance", "payroll", "performance"].includes(r.family),
  );
  assert.ok(sourceless.length > 0);
  for (const report of sourceless)
    assert.equal(
      lib.reportPathIsComingSoon(report.route, { mock: false }),
      true,
      report.code,
    );
});
