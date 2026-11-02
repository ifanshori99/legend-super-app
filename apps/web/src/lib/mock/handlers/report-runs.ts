// One mock for POST /api/reports/run. Every dashboard tile whose number comes
// from a source report (DASH-01/DASH-02) runs that report, and the report
// screens run reports too, so the runs live in one place: a feature registers
// the results it needs with `registerMockReportRuns` instead of registering a
// second handler (bead legend-jzud: one owner per endpoint).
//
// A report nobody registered, or a split the fixture was not built for, fails
// like the API would; `?mock=empty` returns a run without rows so a widget's
// "no data" state is reviewable.
import {
  runReportEndpoint,
  type ReportResult,
} from "@starter/shared/dashboard";
import { ApiError } from "../../api/errors.ts";
import { registerMock } from "../registry.ts";

const runs = new Map<string, ReportResult>();

/** Registers the runs a screen can serve, by report code. */
export function registerMockReportRuns(
  registered: Readonly<Record<string, ReportResult>>,
): void {
  for (const [reportCode, result] of Object.entries(registered))
    runs.set(reportCode, result);
}

registerMock(runReportEndpoint, ({ body, scenario }) => {
  const run = runs.get(body.reportCode);
  if (run === undefined)
    throw new ApiError(
      404,
      "REPORT_NOT_FOUND",
      "Laporan tidak ditemukan di katalog.",
    );
  // A split the fixture was not built for is contract drift, not a demo.
  if (run.groupBy.join(",") !== body.groupBy.join(","))
    throw new ApiError(
      400,
      "REPORT_FILTER_NOT_SUPPORTED",
      "Laporan ini tidak mendukung pemecahan data yang diminta.",
    );
  return { data: scenario === "empty" ? { ...run, rows: [] } : run };
});
