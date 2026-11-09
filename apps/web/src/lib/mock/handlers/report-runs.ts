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
import { cafeLegendFixtures } from "@starter/shared/core";
import { ApiError } from "../../api/errors.ts";
import { registerMock } from "../registry.ts";

/**
 * One run answers one question: report, split, period and outlet scope. Two
 * screens may run the same report with a different split (the owner's
 * per-channel table, the GM's unsplit total), and two outlets are two
 * questions, so the key carries all four; the same question registered twice
 * with different numbers would break DASH-02 (a tile and its drill-down must
 * agree), so it fails loudly instead of last-write-wins.
 *
 * The scope is the sorted outlet ids, or `*` for "all outlets" (a run whose
 * filter is `all`, or a request without `outletIds`). A request without
 * outlets keeps the old behaviour: it is answered by whichever run answers
 * that report, split and period (legend-3nuv).
 */
const ALL_OUTLETS = "*";
const runs = new Map<string, ReportResult>();
const registeredCodes = new Set<string>();

type Period = { readonly startDate: string; readonly endDate: string };

function scopeOf(outletIds: readonly string[] | undefined): string {
  return outletIds === undefined || outletIds.length === 0
    ? ALL_OUTLETS
    : [...outletIds].sort().join(",");
}

const TENANT_OUTLET_SCOPE = scopeOf(
  cafeLegendFixtures.outlets.map((outlet) => outlet.id),
);

function scopeOfResult(result: ReportResult): string {
  return result.outletFilter.kind === "outlets"
    ? scopeOf(result.outletFilter.outletIds)
    : ALL_OUTLETS;
}

function questionKey(
  reportCode: string,
  groupBy: readonly string[],
  period: Period,
): string {
  return `${reportCode}|${groupBy.join(",")}|${period.startDate}|${period.endDate}`;
}

function runKey(question: string, scope: string): string {
  return `${question}|${scope}`;
}

/** Scopes registered per question, in registration order. */
const scopesByQuestion = new Map<string, string[]>();

function findRun(
  question: string,
  outletIds: readonly string[] | undefined,
): ReportResult | undefined {
  const scope = scopeOf(outletIds);
  const exact = runs.get(runKey(question, scope));
  if (exact !== undefined) return exact;
  // A run over all outlets answers only a request that names every outlet of
  // the tenant (the same set); a narrower request must not get all-outlet
  // figures. A request without outlets is answered by the first run of the
  // question.
  if (scope === TENANT_OUTLET_SCOPE) {
    const all = runs.get(runKey(question, ALL_OUTLETS));
    if (all !== undefined) return all;
  }
  if (scope !== ALL_OUTLETS) return undefined;
  const first = scopesByQuestion.get(question)?.[0];
  return first === undefined ? undefined : runs.get(runKey(question, first));
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

/**
 * Whether a run for this exact question is already registered. A screen that
 * would otherwise serve different numbers for the same key yields to the
 * first owner (registration order is the feature folder order of the glob).
 * Without `outletIds` any outlet's run counts.
 */
export function hasMockReportRun(
  reportCode: string,
  groupBy: readonly string[],
  period: Period,
  outletIds?: readonly string[],
): boolean {
  const question = questionKey(reportCode, groupBy, period);
  return outletIds === undefined
    ? scopesByQuestion.has(question)
    : runs.has(runKey(question, scopeOf(outletIds)));
}

/** Registers the runs a screen can serve (record keys are labels only). */
export function registerMockReportRuns(
  registered: Readonly<Record<string, ReportResult>>,
): void {
  for (const result of Object.values(registered)) {
    // Builder previews carry no catalog code; they are not served here.
    if (result.reportCode === null) continue;
    const question = questionKey(
      result.reportCode,
      result.groupBy,
      result.period,
    );
    const scope = scopeOfResult(result);
    const key = runKey(question, scope);
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
    const scopes = scopesByQuestion.get(question) ?? [];
    if (!scopes.includes(scope)) scopes.push(scope);
    scopesByQuestion.set(question, scopes);
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
  const run = findRun(
    questionKey(body.reportCode, body.groupBy, body.period),
    body.outletIds,
  );
  // A split or period the fixture was not built for is contract drift, not a demo.
  if (run === undefined)
    throw new ApiError(
      400,
      "REPORT_FILTER_NOT_SUPPORTED",
      "Laporan ini tidak mendukung pemecahan data yang diminta.",
    );
  return { data: scenario === "empty" ? { ...run, rows: [] } : run };
});
