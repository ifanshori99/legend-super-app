// Mock mode for the management home (`VITE_API_MOCK=true`), so the screen
// fully works with no API (docs/frontend.md "Typed endpoints and mock mode").
// It serves the management layout and the role KPI runs from
// `@starter/shared/dashboard` fixtures through the shared endpoint owners
// (`lib/mock/handlers/`), because `/api/dashboards/:dashboard` and
// `/api/reports/run` are read by several WS-11 screens.
//
// `?mock=empty` drops the role work tiles from the layout (the page's honest
// empty state) and returns report runs without rows (the strip's "no data");
// `?mock=slow|error|offline` are handled by the runtime.
//
// Loaded in Node by tests/ws11-management-home.test.mjs: bare package imports
// and relative `.ts` paths only, no `@/` alias.
import {
  cafeLegendManagementLayoutFixture,
  dashboardLayoutSchema,
  managementDashboardKpiRuns,
} from "@starter/shared/dashboard";
import { registerMockDashboard } from "../../lib/mock/handlers/dashboards.ts";
import { registerMockReportRuns } from "../../lib/mock/handlers/report-runs.ts";

/** Same layout and scope, no role work queue: the empty state of this screen. */
const emptyLayout = dashboardLayoutSchema.parse({
  ...cafeLegendManagementLayoutFixture,
  tiles: cafeLegendManagementLayoutFixture.tiles.filter(
    (tile) => tile.section !== "work_queue",
  ),
});

registerMockDashboard("management", {
  normal: cafeLegendManagementLayoutFixture,
  empty: emptyLayout,
});

registerMockReportRuns(managementDashboardKpiRuns);
