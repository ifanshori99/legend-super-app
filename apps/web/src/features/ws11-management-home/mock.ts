// Mock handlers for the management home (`VITE_API_MOCK=true`), so the screen
// fully works with no API (docs/frontend.md "Typed endpoints and mock mode").
// They serve the layout fixture from `@starter/shared/dashboard`.
//
// `GET /api/dashboards/:dashboard` is one endpoint for three screens (owner,
// shareholder, management), so this handler declines every other dashboard
// kind with `MOCK_UNHANDLED`; those screens register their own handlers and
// neither takes the other out of mock mode.
//
// Loaded in Node by tests/ws11-management-home.test.mjs, so imports are bare
// package imports or relative `.ts` paths (no `@/` alias). `?mock=empty`
// returns the layout without any role work tile, which is the page's honest
// empty state; `?mock=slow|error|offline` are handled by the runtime.
import {
  cafeLegendManagementLayoutFixture,
  dashboardLayoutSchema,
  getDashboardEndpoint,
} from "@starter/shared/dashboard";
import { MOCK_UNHANDLED, registerMock } from "../../lib/mock/registry.ts";

/** Same layout and scope, no role work queue: the empty state of Bead 6na6. */
const emptyLayout = dashboardLayoutSchema.parse({
  ...cafeLegendManagementLayoutFixture,
  tiles: cafeLegendManagementLayoutFixture.tiles.filter(
    (tile) => tile.section !== "work_queue",
  ),
});

registerMock(getDashboardEndpoint, ({ params, scenario }) => {
  if (params.dashboard !== "management") return MOCK_UNHANDLED;
  return {
    data: scenario === "empty" ? emptyLayout : cafeLegendManagementLayoutFixture,
  };
});
