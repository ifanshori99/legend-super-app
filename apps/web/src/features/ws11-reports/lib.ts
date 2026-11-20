// Pure view model of the report viewer (WS-11 FE, bead legend-j815; PRD v1.7
// §3 F36 "Laporan", "Ekspor"; DASH-02, DASH-04). Everything here is driven by
// the report definition from the catalog contract, so a family bead (menu
// engineering, payments, finance...) adds a thin route file and gets the same
// filters, split rules, finality label and export gate. No React and no browser
// API: tests/ws11-reports.test.mjs loads this file with Node, so imports are
// bare packages or relative `.ts` paths only.
import { outletIdSchema } from "@starter/shared/core";
import {
  REPORT_PERIOD_PRESETS,
  PERSONAL_DATA_DIMENSIONS,
  reportExportContainsPersonalData,
  type CreateReportExportInput,
  type ReportDefinition,
  type ReportExportFormat,
  type ReportPeriodPreset,
  type ReportResult,
  type ReportRunInput,
} from "@starter/shared/dashboard";
import type { MetricValue } from "@starter/shared/metrics";

// ---- Server side not built yet (legend-x73li, sizing X7-2) ---------------------
//
// A real build must not show what the server cannot do yet. Mock mode keeps
// both, because the fixtures answer them (clickable mockup).

/**
 * The export button. POST /api/reports/exports has no route yet (legend-ay6e6),
 * so a real build hides it instead of offering a download that answers 404.
 */
export function reportExportOffered(options: { mock: boolean }): boolean {
  return options.mock;
}

/**
 * Families whose metric sources are still empty on the server: finance
 * (legend-qlirp) and hr (legend-y3huu: attendance, payroll, performance). The
 * catalog lists their reports as "Segera hadir" instead of linking to an empty
 * screen. Remove a family from this list when its source lands.
 */
const FAMILIES_WITHOUT_SOURCE: readonly string[] = [
  "finance",
  "attendance",
  "payroll",
  "performance",
];

export function reportFamilyHasData(
  family: string,
  options: { mock: boolean },
): boolean {
  return options.mock || !FAMILIES_WITHOUT_SOURCE.includes(family);
}

// ---- URL contract ------------------------------------------------------------
//
// Dashboard tiles link here with `startDate`, `endDate`, repeated `outletId`
// and an optional `groupBy` (metricSourceReportPath in @starter/shared/metrics,
// DASH-01). The viewer reads the same keys, so a tile and its drill-down filter
// identically (DASH-02). `preset` is the viewer's own shortcut when it picks a
// period itself; explicit dates win over it.

/** `groupBy=total` is the explicit "no split" choice (one total row). */
export const NO_SPLIT = "total";

export type ReportSearch = {
  startDate?: string;
  endDate?: string;
  outletId?: string[];
  groupBy?: string;
  preset?: ReportPeriodPreset;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIMENSION_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Router `validateSearch`: keeps only well-formed values, so a hand-edited or
 * stale link degrades to the report default instead of failing the page.
 * Outlet ids are still intersected with the caller's scope by the API (TEN-03).
 */
export function validateReportSearch(
  raw: Record<string, unknown>,
): ReportSearch {
  const search: ReportSearch = {};
  const start = typeof raw.startDate === "string" ? raw.startDate : "";
  const end = typeof raw.endDate === "string" ? raw.endDate : "";
  if (isRealDate(start) && isRealDate(end) && start <= end) {
    search.startDate = start;
    search.endDate = end;
  }
  const outlets = (Array.isArray(raw.outletId) ? raw.outletId : [raw.outletId])
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .filter((value) => outletIdSchema.safeParse(value).success);
  if (outlets.length > 0) search.outletId = [...new Set(outlets)].slice(0, 50);
  if (
    typeof raw.groupBy === "string" &&
    (raw.groupBy === NO_SPLIT || DIMENSION_KEY.test(raw.groupBy))
  )
    search.groupBy = raw.groupBy;
  if (
    typeof raw.preset === "string" &&
    (REPORT_PERIOD_PRESETS as readonly string[]).includes(raw.preset)
  )
    search.preset = raw.preset as ReportPeriodPreset;
  return search;
}

// ---- Periods -----------------------------------------------------------------
//
// The server owns "today" (outlet business date, D-CORE); the viewer receives
// the business date from the dashboard layout and only does calendar math on
// it. Weeks start on Monday (Indonesia).

export type DateRange = { startDate: string; endDate: string };

function toUtc(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = toUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

function monthStart(year: number, monthIndex: number): string {
  return iso(new Date(Date.UTC(year, monthIndex, 1)));
}

function monthEnd(year: number, monthIndex: number): string {
  return iso(new Date(Date.UTC(year, monthIndex + 1, 0)));
}

/** The date range a preset covers, up to the business date; null for custom. */
export function resolvePreset(
  preset: ReportPeriodPreset,
  businessDate: string,
): DateRange | null {
  const today = toUtc(businessDate);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const weekday = (today.getUTCDay() + 6) % 7;
  const weekStart = addDays(businessDate, -weekday);
  const quarterFirstMonth = Math.floor(month / 3) * 3;
  switch (preset) {
    case "today":
      return { startDate: businessDate, endDate: businessDate };
    case "yesterday": {
      const day = addDays(businessDate, -1);
      return { startDate: day, endDate: day };
    }
    case "this_week":
      return { startDate: weekStart, endDate: businessDate };
    case "last_week":
      return {
        startDate: addDays(weekStart, -7),
        endDate: addDays(weekStart, -1),
      };
    case "this_month":
      return { startDate: monthStart(year, month), endDate: businessDate };
    case "last_month":
      return {
        startDate: monthStart(year, month - 1),
        endDate: monthEnd(year, month - 1),
      };
    case "this_quarter":
      return {
        startDate: monthStart(year, quarterFirstMonth),
        endDate: businessDate,
      };
    case "last_quarter":
      return {
        startDate: monthStart(year, quarterFirstMonth - 3),
        endDate: monthEnd(year, quarterFirstMonth - 1),
      };
    case "this_year":
    case "year_to_date":
      return { startDate: monthStart(year, 0), endDate: businessDate };
    case "custom":
      return null;
  }
}

/** Presets a definition offers other than `custom`, in definition order. */
export function namedPresets(
  definition: Pick<ReportDefinition, "periodPresets">,
): ReportPeriodPreset[] {
  return definition.periodPresets.filter((preset) => preset !== "custom");
}

/** The first offered preset that covers exactly this range, else `custom`. */
export function presetForRange(
  definition: Pick<ReportDefinition, "periodPresets">,
  range: DateRange,
  businessDate: string,
): ReportPeriodPreset {
  for (const preset of namedPresets(definition)) {
    const candidate = resolvePreset(preset, businessDate);
    if (
      candidate !== null &&
      candidate.startDate === range.startDate &&
      candidate.endDate === range.endDate
    )
      return preset;
  }
  return "custom";
}

export type ResolvedPeriod = {
  range: DateRange;
  preset: ReportPeriodPreset;
};

/**
 * Period precedence: explicit dates from a link, then the viewer's own preset,
 * then the report's default. Null while the business date is unknown and the
 * link carries no dates.
 */
export function resolvePeriod(
  definition: Pick<ReportDefinition, "periodPresets" | "defaultPeriod">,
  search: ReportSearch,
  businessDate: string | null,
): ResolvedPeriod | null {
  if (search.startDate !== undefined && search.endDate !== undefined) {
    const range = { startDate: search.startDate, endDate: search.endDate };
    return {
      range,
      preset:
        businessDate === null
          ? "custom"
          : presetForRange(definition, range, businessDate),
    };
  }
  if (businessDate === null) return null;
  const wanted =
    search.preset !== undefined &&
    definition.periodPresets.includes(search.preset)
      ? search.preset
      : definition.defaultPeriod;
  const range = resolvePreset(wanted, businessDate);
  if (range === null) {
    const fallback = resolvePreset(definition.defaultPeriod, businessDate);
    return fallback === null
      ? null
      : { range: fallback, preset: definition.defaultPeriod };
  }
  return { range, preset: wanted };
}

// ---- Split (group-by) --------------------------------------------------------

/** `sales.per_hour` is about hours, `sales.per_menu` about menu items... */
const SUFFIX_DIMENSION: Readonly<Record<string, string>> = Object.freeze({
  hour: "hour",
  channel: "channel",
  menu: "menu_item",
  employee: "employee",
  zone: "zone",
  station: "station",
  supplier: "supplier",
  outlet: "outlet",
  day: "day_of_week",
  promo: "promo",
});

export function isPersonalDimension(key: string): boolean {
  return PERSONAL_DATA_DIMENSIONS.includes(key);
}

/**
 * The split a report opens with when the link names none: the dimension its
 * code is "per" (`sales.per_hour` -> `hour`), else the first dimension that is
 * neither the outlet nor a person (a report never opens split by a person
 * unless it is about people). Null when the definition offers no split.
 */
export function defaultSplit(
  definition: Pick<ReportDefinition, "code" | "dimensions">,
): string | null {
  const last = definition.code.split(".").at(-1) ?? "";
  if (last.startsWith("per_")) {
    const wanted = SUFFIX_DIMENSION[last.slice(4)];
    if (wanted !== undefined && definition.dimensions.includes(wanted))
      return wanted;
  }
  return (
    definition.dimensions.find(
      (key) => key !== "outlet" && !isPersonalDimension(key),
    ) ??
    definition.dimensions[0] ??
    null
  );
}

/** The split in effect: the link's, if the definition allows it, else default. */
export function resolveSplit(
  definition: Pick<ReportDefinition, "code" | "dimensions">,
  search: ReportSearch,
): string | null {
  if (search.groupBy === NO_SPLIT) return null;
  if (
    search.groupBy !== undefined &&
    definition.dimensions.includes(search.groupBy)
  )
    return search.groupBy;
  return defaultSplit(definition);
}

// ---- Requests ----------------------------------------------------------------

export const REPORT_ROW_LIMIT = 100;

export type ReportQuerySelection = {
  period: DateRange;
  outletIds?: readonly string[];
  groupBy: string | null;
};

/**
 * Outlet ids reach here only through validateReportSearch (outletIdSchema), so
 * the brand is restored here; the API intersects them with the caller's scope.
 */
function outletsOf(selection: ReportQuerySelection): {
  outletIds?: ReportRunInput["outletIds"];
} {
  return selection.outletIds && selection.outletIds.length > 0
    ? { outletIds: [...selection.outletIds] as ReportRunInput["outletIds"] }
    : {};
}

/** POST /api/reports/run input; outlets stay unset to mean "my whole scope". */
export function buildRunInput(
  reportCode: string,
  selection: ReportQuerySelection,
): ReportRunInput {
  return {
    reportCode,
    period: { ...selection.period },
    ...outletsOf(selection),
    groupBy: selection.groupBy === null ? [] : [selection.groupBy],
    filters: [],
    bucket: "total",
    limit: REPORT_ROW_LIMIT,
  };
}

/** The totals run behind the summary strip: the same filters, no split. */
export function buildTotalsInput(
  reportCode: string,
  selection: ReportQuerySelection,
): ReportRunInput {
  return buildRunInput(reportCode, { ...selection, groupBy: null });
}

/**
 * DASH-04: whether this view's output is personal data. The server derives the
 * same flag from the report and the splits and gates the export on it.
 */
export function selectionIsPersonal(
  definition: Pick<ReportDefinition, "containsPersonalData">,
  groupBy: string | null,
): boolean {
  return reportExportContainsPersonalData({
    report: definition,
    query: { groupBy: groupBy === null ? [] : [groupBy], filters: [] },
  });
}

/** POST /api/reports/exports body for what is on screen. */
export function buildExportInput(
  reportCode: string,
  format: ReportExportFormat,
  selection: ReportQuerySelection,
  idempotencyKey: string,
): CreateReportExportInput {
  return {
    reportCode,
    format,
    query: {
      period: { ...selection.period },
      ...outletsOf(selection),
      groupBy: selection.groupBy === null ? [] : [selection.groupBy],
      filters: [],
      bucket: "total",
    },
    idempotencyKey,
  };
}

// ---- Result ------------------------------------------------------------------

/** True when a result carries no number at all (its empty state). */
export function isResultEmpty(result: ReportResult): boolean {
  return (
    result.rows.length === 0 ||
    result.rows.every((row) => row.values.every((cell) => cell.value === null))
  );
}

export type ResultFinality = "final" | "estimate" | "none";

/**
 * Closed or running (SH-02): "final" only when every figure is final; a single
 * estimate makes the whole view an estimate, never the other way round.
 */
export function resultFinality(result: ReportResult): ResultFinality {
  let seen = false;
  for (const row of result.rows)
    for (const cell of row.values) {
      if (cell.value === null) continue;
      seen = true;
      if (cell.finality !== "final") return "estimate";
    }
  return seen ? "final" : "none";
}

/** A numeric reading of a value for bar length; never shown as text. */
export function metricNumber(value: MetricValue | null): number | null {
  if (value === null) return null;
  switch (value.unit) {
    case "idr":
      return value.valueIdr;
    case "count":
    case "seconds":
      return value.value;
    case "percent":
    case "decimal":
      return Number(value.value);
  }
}

export type ChartDatum = {
  label: string;
  dimension: string;
  value: MetricValue | null;
  amount: number;
  share: number;
};

/**
 * Bars of one metric across the split rows. Order is the server's (an hour
 * axis stays chronological; a ranking is the report's own sort). The share is
 * against the largest bar, never a percentage of a total the metric may not
 * have (an average does not add up).
 */
export function chartData(
  result: ReportResult,
  metricCode: string,
): ChartDatum[] {
  const rows = result.rows.map((row) => {
    const value = row.values.find((cell) => cell.metricCode === metricCode);
    const dimension = row.dimensions[0];
    return {
      label: dimension?.value ?? "",
      dimension: dimension?.key ?? "",
      value: value?.value ?? null,
    };
  });
  const amounts = rows.map((row) => Math.max(0, metricNumber(row.value) ?? 0));
  const max = Math.max(0, ...amounts);
  return rows.map((row, index) => ({
    ...row,
    amount: amounts[index] ?? 0,
    share: max > 0 ? (amounts[index] ?? 0) / max : 0,
  }));
}

/** A chart needs one split dimension and at least two bars worth comparing. */
export function isChartable(result: ReportResult): boolean {
  return result.groupBy.length === 1 && result.rows.length >= 2;
}

/** "08" or "8" -> "08.00" (the hour dimension carries the hour only). */
export function hourLabel(value: string): string | null {
  if (!/^\d{1,2}$/.test(value)) return null;
  return `${value.padStart(2, "0")}.00`;
}

/**
 * Outlet wall-clock date, used only when the dashboard layout (the contract's
 * source of the business date) cannot be read; "today" in the outlet zone.
 */
export function clockBusinessDate(
  now: Date = new Date(),
  timeZone = "Asia/Jakarta",
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
