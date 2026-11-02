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

/**
 * One run answers one question: report, split and period. Two screens may run
 * the same report with a different split (the owner's per-channel table, the
 * GM's unsplit total), so the key carries all three; the same question
 * registered twice with different numbers would break DASH-02 (a tile and its
 * drill-down must agree), so it fails loudly instead of last-write-wins.
 */
const runs = new Map<string, ReportResult>();
const registeredCodes = new Set<string>();

function runKey(
  reportCode: string,
  groupBy: readonly string[],
  period: { readonly startDate: string; readonly endDate: string },
): string {
  return `${reportCode}|${groupBy.join(",")}|${period.startDate}|${period.endDate}`;
}

/** The numbers of a run, independent of column order and finality flags. */
function figuresOf(result: ReportResult): string {
  return JSON.stringify(
    result.rows.map((row) => [
      row.dimensions.map((dimension) => `${dimension.key}=${dimension.value}`),
      row.values
        .map((cell) => [cell.metricCode, cell.value] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ]),
  );
}

/** Registers the runs a screen can serve (record keys are labels only). */
export function registerMockReportRuns(
  registered: Readonly<Record<string, ReportResult>>,
): void {
  for (const result of Object.values(registered)) {
    // Builder previews carry no catalog code; they are not served here.
    if (result.reportCode === null) continue;
    const key = runKey(result.reportCode, result.groupBy, result.period);
    const existing = runs.get(key);
    if (
      existing !== undefined &&
      existing !== result &&
      figuresOf(existing) !== figuresOf(result)
    )
      throw new Error(
        `Mock report run ${key} is registered twice with different numbers (DASH-02).`,
      );
    runs.set(key, result);
    registeredCodes.add(result.reportCode);
  }
}

registerMock(runReportEndpoint, ({ body, scenario }) => {
  if (!registeredCodes.has(body.reportCode))
    throw new ApiError(
      404,
      "REPORT_NOT_FOUND",
      "Laporan tidak ditemukan di katalog.",
    );
  const run = runs.get(runKey(body.reportCode, body.groupBy, body.period));
  // A split or period the fixture was not built for is contract drift, not a demo.
  if (run === undefined)
    throw new ApiError(
      400,
      "REPORT_FILTER_NOT_SUPPORTED",
      "Laporan ini tidak mendukung pemecahan data yang diminta.",
    );
  return { data: scenario === "empty" ? { ...run, rows: [] } : run };
});
