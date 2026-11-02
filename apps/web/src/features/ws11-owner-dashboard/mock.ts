// Mock handlers for the owner dashboard (VITE_API_MOCK=true), so the screen
// works end to end with no API (docs/frontend.md "Typed endpoints and mock
// mode"). The layout and every report run come from @starter/shared/dashboard
// fixtures, the review list from @starter/shared/crm, and the runtime
// validates each response against the same schema the API will use.
//
// `?mock=empty` keeps the layout but returns report runs without rows, so every
// section can be reviewed in its honest empty state.
//
// Loaded in Node by tests/ws11-owner-dashboard.test.mjs: bare package imports
// and relative `.ts` paths only, no `@/` alias.
import { cafeLegendCrmFixtures, listFeedback } from "@starter/shared/crm";
import {
  cafeLegendDashboardFixtures,
  getDashboardEndpoint,
  ownerDashboardBoardRuns,
  runReportEndpoint,
  type ReportResult,
} from "@starter/shared/dashboard";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";

/** A run with no rows: the empty state of every widget in the section. */
function emptyRun(run: ReportResult): ReportResult {
  return { ...run, rows: [] };
}

registerMock(getDashboardEndpoint, () => ({
  // The dashboard layout is the tile catalog for the caller's scope (DASH-01).
  data: cafeLegendDashboardFixtures.ownerLayout,
}));

registerMock(runReportEndpoint, ({ body, scenario }) => {
  const run = ownerDashboardBoardRuns[body.reportCode];
  if (run === undefined)
    throw new ApiError(
      404,
      "REPORT_NOT_FOUND",
      "Laporan tidak ditemukan di katalog.",
    );
  // A split the fixture was not built for is a contract drift, not a demo.
  if (run.groupBy.join(",") !== body.groupBy.join(","))
    throw new ApiError(
      400,
      "REPORT_FILTER_NOT_SUPPORTED",
      "Laporan ini tidak mendukung pemecahan data yang diminta.",
    );
  return { data: scenario === "empty" ? emptyRun(run) : run };
});

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
