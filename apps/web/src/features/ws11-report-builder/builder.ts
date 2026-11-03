// Pure rules of the report builder (PRD v1.7 §3 F36 "Report Builder", DASH-01,
// DASH-04). The UI keeps a draft; this file turns it into the contract query,
// decides which metrics, dimensions and filters it may offer, and names the
// contract error a combination would fail with, so an invalid combination is
// prevented before the API refuses it. Loaded in Node by the mock and tests:
// relative `.ts` imports and bare package imports only, no `@/` alias.
import {
  REPORT_BUILDER_MAX_DIMENSIONS,
  REPORT_BUILDER_MAX_FILTERS,
  REPORT_BUILDER_MAX_METRICS,
  REPORT_ERROR_CODES,
  reportBuilderQuerySchema,
  reportByCode,
  reportMetricByCode,
  reportMetricDefinitions,
  selectionContainsPersonalData,
  type ReportBuilderQuery,
  type ReportErrorCode,
} from "@starter/shared/dashboard";
import type { MetricBucket, MetricDefinition } from "@starter/shared/metrics";

export {
  REPORT_BUILDER_MAX_DIMENSIONS,
  REPORT_BUILDER_MAX_FILTERS,
  REPORT_BUILDER_MAX_METRICS,
};

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_month",
  "last_month",
  "custom",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export type FilterDraft = { key: string; valuesText: string };

export type BuilderDraft = {
  metricCodes: string[];
  groupBy: string[];
  filters: FilterDraft[];
  /** Empty = every outlet in the caller's scope (the server intersects it). */
  outletIds: string[];
  preset: PeriodPreset;
  startDate: string;
  endDate: string;
  bucket: MetricBucket;
  sortColumn: string | null;
  sortDirection: "asc" | "desc";
};

/** A problem the UI shows next to the builder, never a raw API message. */
export type BuilderIssue =
  | { kind: "draft"; key: "noMetric" | "filterValues" | "periodRange" }
  | { kind: "contract"; code: ReportErrorCode };

// ---- Dates -----------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = toUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return fromUtc(value);
}

/** Business date "today" in an outlet time zone (falls back to the device's). */
export function todayIn(timeZone: string | undefined, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return fromUtc(now);
  }
}

export function isBusinessDate(value: string): boolean {
  return DATE_PATTERN.test(value) && fromUtc(toUtc(value)) === value;
}

export function resolvePreset(
  preset: Exclude<PeriodPreset, "custom">,
  today: string,
): { startDate: string; endDate: string } {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "today":
      return { startDate: today, endDate: today };
    case "yesterday": {
      const day = addDays(today, -1);
      return { startDate: day, endDate: day };
    }
    case "last_7_days":
      return { startDate: addDays(today, -6), endDate: today };
    case "last_30_days":
      return { startDate: addDays(today, -29), endDate: today };
    case "this_month":
      return { startDate: monthStart, endDate: today };
    case "last_month": {
      const end = addDays(monthStart, -1);
      return { startDate: `${end.slice(0, 7)}-01`, endDate: end };
    }
  }
}

export function daysInPeriod(period: {
  startDate: string;
  endDate: string;
}): number {
  return (
    Math.round(
      (toUtc(period.endDate).getTime() - toUtc(period.startDate).getTime()) /
        86_400_000,
    ) + 1
  );
}

// ---- Draft -----------------------------------------------------------------

export function emptyDraft(today: string): BuilderDraft {
  return {
    metricCodes: [],
    groupBy: [],
    filters: [],
    outletIds: [],
    preset: "last_7_days",
    ...resolvePreset("last_7_days", today),
    bucket: "total",
    sortColumn: null,
    sortDirection: "desc",
  };
}

export function applyPreset(
  draft: BuilderDraft,
  preset: PeriodPreset,
  today: string,
): BuilderDraft {
  if (preset === "custom") return { ...draft, preset };
  return { ...draft, preset, ...resolvePreset(preset, today) };
}

/** Values of one filter: comma or line separated, trimmed, unique, at most 20. */
export function parseFilterValues(text: string): string[] {
  const values = text
    .split(/[,\n]/)
    .map((value) => value.trim().slice(0, 120))
    .filter((value) => value !== "");
  return [...new Set(values)].slice(0, 20);
}

// ---- Metric registry -------------------------------------------------------

/**
 * Metrics the caller may build with: the metric's source report must be one
 * the caller's permissions open (RBAC; the server re-checks). A metric whose
 * report is unknown is hidden, never offered (fail closed).
 */
export function usableMetrics(
  permissions: readonly string[],
): MetricDefinition[] {
  return [...reportMetricDefinitions]
    .filter((metric) => {
      if (metric.status !== "active") return false;
      const report = reportByCode(metric.sourceReport.reportCode);
      return (
        report !== undefined &&
        report.requiredPermissions.every((code) => permissions.includes(code))
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
}

/** Dimensions every selected metric declares, in the first metric's order. */
export function sharedDimensions(metricCodes: readonly string[]): string[] {
  const definitions = metricCodes
    .map((code) => reportMetricByCode.get(code))
    .filter((definition): definition is MetricDefinition => !!definition);
  const [first] = definitions;
  if (first === undefined) return [];
  return first.dimensions.filter((key) =>
    definitions.every((definition) => definition.dimensions.includes(key)),
  );
}

/**
 * Keys a filter may use: the shared dimensions without `outlet`, which is
 * chosen with outletIds only (TEN-03, the contract refuses an outlet filter).
 */
export function filterableDimensions(metricCodes: readonly string[]): string[] {
  return sharedDimensions(metricCodes).filter((key) => key !== "outlet");
}

/**
 * After the metric selection changes, drops the splits, filters and sort that
 * the new selection no longer offers; `dropped` lists them for a notice.
 */
export function reconcileDraft(draft: BuilderDraft): {
  draft: BuilderDraft;
  dropped: string[];
} {
  const shared = sharedDimensions(draft.metricCodes);
  const filterable = filterableDimensions(draft.metricCodes);
  const dropped: string[] = [];
  const groupBy = draft.groupBy.filter((key) => {
    const keep = shared.includes(key);
    if (!keep) dropped.push(key);
    return keep;
  });
  const filters = draft.filters.filter((filter) => {
    const keep = filterable.includes(filter.key);
    if (!keep) dropped.push(filter.key);
    return keep;
  });
  const sortStillValid =
    draft.sortColumn === null ||
    draft.metricCodes.includes(draft.sortColumn) ||
    groupBy.includes(draft.sortColumn);
  return {
    draft: {
      ...draft,
      groupBy,
      filters,
      sortColumn: sortStillValid ? draft.sortColumn : null,
    },
    dropped: [...new Set(dropped)],
  };
}

// ---- Query -----------------------------------------------------------------

export function draftToRawQuery(draft: BuilderDraft) {
  return {
    metricCodes: draft.metricCodes,
    period: { startDate: draft.startDate, endDate: draft.endDate },
    ...(draft.outletIds.length > 0 ? { outletIds: draft.outletIds } : {}),
    groupBy: draft.groupBy,
    filters: draft.filters.map((filter) => ({
      key: filter.key,
      values: parseFilterValues(filter.valuesText),
    })),
    bucket: draft.bucket,
    ...(draft.sortColumn === null
      ? {}
      : {
          sort: { column: draft.sortColumn, direction: draft.sortDirection },
        }),
  };
}

export type DraftValidation =
  | { ok: true; query: ReportBuilderQuery }
  | { ok: false; issues: BuilderIssue[] };

/**
 * Validates with the contract itself (reportBuilderQuerySchema), so the UI and
 * the API cannot disagree. Contract issues become the stable report error
 * codes; the wording lives in the text catalog.
 */
export function validateDraft(draft: BuilderDraft): DraftValidation {
  const issues: BuilderIssue[] = [];
  if (draft.metricCodes.length === 0)
    issues.push({ kind: "draft", key: "noMetric" });
  if (
    draft.filters.some(
      (filter) => parseFilterValues(filter.valuesText).length === 0,
    )
  )
    issues.push({ kind: "draft", key: "filterValues" });
  if (
    !isBusinessDate(draft.startDate) ||
    !isBusinessDate(draft.endDate) ||
    draft.startDate > draft.endDate
  )
    issues.push({ kind: "draft", key: "periodRange" });
  if (issues.length > 0) return { ok: false, issues };

  const parsed = reportBuilderQuerySchema.safeParse(draftToRawQuery(draft));
  if (parsed.success) return { ok: true, query: parsed.data };
  const codes = new Set<ReportErrorCode>();
  for (const issue of parsed.error.issues)
    codes.add(
      issue.message.includes("not offered by the source")
        ? "REPORT_FILTER_NOT_SUPPORTED"
        : "REPORT_QUERY_INVALID",
    );
  return {
    ok: false,
    issues: [...codes].map((code) => ({ kind: "contract", code })),
  };
}

/** A saved query back into an editable draft. */
export function queryToDraft(query: ReportBuilderQuery): BuilderDraft {
  return {
    metricCodes: [...query.metricCodes],
    groupBy: [...query.groupBy],
    filters: query.filters.map((filter) => ({
      key: filter.key,
      valuesText: filter.values.join(", "),
    })),
    outletIds: [...(query.outletIds ?? [])],
    preset: "custom",
    startDate: query.period.startDate,
    endDate: query.period.endDate,
    bucket: query.bucket,
    sortColumn: query.sort?.column ?? null,
    sortDirection: query.sort?.direction ?? "desc",
  };
}

/** DASH-04: a split or filter by a person makes the output personal data. */
export function queryHasPersonalData(query: {
  groupBy: readonly string[];
  filters: readonly { key: string }[];
}): boolean {
  return selectionContainsPersonalData(query);
}

export function draftHasPersonalData(draft: BuilderDraft): boolean {
  return selectionContainsPersonalData(draft);
}

/** The contract error code an ApiError carries, when it is a report error. */
export function reportErrorCodeOf(error: unknown): ReportErrorCode | null {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return (REPORT_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as ReportErrorCode)
    : null;
}

export function isOfflineError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 0 || code === "NETWORK_ERROR";
}

// ---- Schedule --------------------------------------------------------------

export type ScheduleDraft = {
  frequency: "daily" | "weekly" | "monthly";
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  format: "csv" | "xlsx" | "pdf";
  recipientsText: string;
};

export function emptyScheduleDraft(): ScheduleDraft {
  return {
    frequency: "weekly",
    timeOfDay: "07:00",
    dayOfWeek: 1,
    dayOfMonth: 1,
    format: "pdf",
    recipientsText: "",
  };
}

export function parseRecipients(text: string): string[] {
  const values = text
    .split(/[,;\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "");
  return [...new Set(values)];
}

/** The create/update schedule fields, day fields set only for their frequency. */
export function scheduleSettings(draft: ScheduleDraft) {
  return {
    frequency: draft.frequency,
    timeOfDay: draft.timeOfDay,
    dayOfWeek: draft.frequency === "weekly" ? draft.dayOfWeek : null,
    dayOfMonth: draft.frequency === "monthly" ? draft.dayOfMonth : null,
    format: draft.format,
    recipients: parseRecipients(draft.recipientsText),
  };
}
