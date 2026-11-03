// Mock mode for the owner dashboard (`VITE_API_MOCK=true`), so the screen
// works with no API (docs/frontend.md "Typed endpoints and mock mode"). It
// serves the owner layout and the part-1 report runs from
// `@starter/shared/dashboard` fixtures through the shared endpoint owners in
// `lib/mock/handlers/`, because `/api/dashboards/:dashboard` and
// `/api/reports/run` are read by several WS-11 screens (bead legend-ssu7).
//
// `?mock=empty` keeps the layout and returns runs without rows (each widget's
// honest "no data"); `?mock=slow|error|offline` are handled by the runtime.
//
// Loaded in Node by tests/ws11-owner-dashboard.test.mjs: bare package imports
// and relative `.ts` paths only, no `@/` alias.
import { cafeLegendCrmFixtures, listFeedback } from "@starter/shared/crm";
import {
  cafeLegendDashboardFixtures,
  ownerDashboardBoardRuns,
} from "@starter/shared/dashboard";
import { ownerInsightRuns } from "./insights-mock.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMockDashboard } from "../../lib/mock/handlers/dashboards.ts";
import { registerMockReportRuns } from "../../lib/mock/handlers/report-runs.ts";

// The owner tiles are the same in every scenario; only the report runs change,
// so no separate empty layout is registered.
registerMockDashboard("owner", {
  normal: cafeLegendDashboardFixtures.ownerLayout,
});

registerMockReportRuns(ownerDashboardBoardRuns);
// Part 2 (bead legend-gb03): cost, service, finance, alert, multi-outlet runs.
registerMockReportRuns(ownerInsightRuns);

// "Ulasan terbaru" reads the CRM feedback queue (PRD §3 F34 "Operasional").
// No other feature owns GET /api/feedback yet, so this screen registers it.
registerMock(listFeedback, ({ query, scenario }) =>
  paginateFixture(
    cafeLegendCrmFixtures.feedback.filter(
      (item) => query.kind === undefined || item.kind === query.kind,
    ),
    query,
    (item) => item.id,
    scenario,
  ),
);
