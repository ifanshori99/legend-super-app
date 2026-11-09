// Report catalog, run and builder preview (WS-11 foundation, bead legend-5wzoc;
// design docs/briefs/sub-ws11-foundation-design.md §2.6).
//
// - Catalog list and get are served from the shared catalog, filtered by the
//   caller's permissions (`reportPermittedFor`); no database read.
// - Run and preview open ONE `withTenantSnapshot` and make ONE `evaluateMetrics`
//   call, then pivot the series into table rows and fill in `availability`
//   (a metric without a source answers 200 with null cells, never an error).
// - The caller resolves the viewer and the outlet scope (routes/reports.routes
//   mirrors routes/metrics.routes); the request never carries a tenant (TEN-02)
//   and the requested outlets are intersected with the scope (TEN-03).
// - Row dimensions come from `EvaluatedSeries.dimensions` (outlet first, then
//   the one other key). Every row carries its bucket (`bucketStart`/`bucketEnd`,
//   the whole period for `total`); rows run in bucket order, then `sort` or
//   dimension order within a bucket, and `limit` counts all rows.

import {
  decodeCursor,
  encodeCursor,
  outletIdsForQuery,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  reportByCode,
  reportCatalog,
  reportCatalogPageSchema,
  reportMetricByCode,
  reportPermittedFor,
  reportResultSchema,
  ReportError,
  reportErrorHttpStatus,
  type ReportCatalogPage,
  type ReportCatalogQuery,
  type ReportBuilderQuery,
  type ReportDefinition,
  type ReportErrorCode,
  type ReportResult,
  type ReportResultRow,
  type ReportRunInput,
} from "@starter/shared/dashboard";
import {
  type MetricBucket,
  type MetricDimensionValue,
  type MetricFinality,
  type MetricValue,
} from "@starter/shared/metrics";
import { HttpError } from "../lib/http-error";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedSeries,
  type MetricViewer,
} from "./metrics-query.service";

/** What the catalog needs to know about the caller. */
export type ReportAccess = { readonly permissions: readonly string[] };

export type ReportRunOptions = {
  viewer: MetricViewer;
  /** Clock for "today" and `generatedAt` (tests); defaults to now. */
  now?: Date;
};

/** The error handler maps HttpError; ReportError carries the status table. */
export function reportHttpError(
  code: ReportErrorCode,
  message?: string,
): HttpError {
  const error = new ReportError(code, message);
  return new HttpError(reportErrorHttpStatus[code], error.code, error.message);
}

// ---- Catalog ----------------------------------------------------------------

export function listReportCatalog(
  access: ReportAccess,
  query: ReportCatalogQuery,
): ReportCatalogPage {
  const needle = query.search?.toLowerCase();
  let after = -1;
  if (query.cursor !== undefined) {
    let keys: ReturnType<typeof decodeCursor>;
    try {
      keys = decodeCursor(query.cursor);
    } catch {
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    }
    if (typeof keys[0] !== "number")
      throw new HttpError(422, "VALIDATION_ERROR", "Cursor tidak valid.");
    after = keys[0];
  }
  const matches = reportCatalog
    .map((report, position) => ({ report, position }))
    .filter(
      ({ report, position }) =>
        position > after &&
        reportPermittedFor(report, access.permissions) &&
        (query.family === undefined || report.family === query.family) &&
        (query.ownerModule === undefined ||
          report.ownerModule === query.ownerModule) &&
        (needle === undefined ||
          `${report.code} ${report.name} ${report.description}`
            .toLowerCase()
            .includes(needle)),
    );
  const page = matches.slice(0, query.limit);
  const last = page.at(-1);
  return reportCatalogPageSchema.parse({
    data: page.map(({ report }) => report),
    meta: {
      limit: query.limit,
      nextCursor:
        matches.length > page.length && last !== undefined
          ? encodeCursor([last.position])
          : null,
    },
  });
}

/** One catalog entry; 404 when unknown, 403 when the caller may not open it. */
export function getReportDefinition(
  access: ReportAccess,
  code: string,
): ReportDefinition {
  const report = reportByCode(code);
  if (report === undefined) throw reportHttpError("REPORT_NOT_FOUND");
  if (!reportPermittedFor(report, access.permissions))
    throw reportHttpError("REPORT_NOT_PERMITTED");
  return report;
}

// ---- Run and preview --------------------------------------------------------

/** Sortable number of a cell value (idr, count, seconds, percent, decimal). */
function numericOf(value: MetricValue | null): number | null {
  if (value === null) return null;
  return value.unit === "idr" ? Number(value.valueIdr) : Number(value.value);
}

type Cell = { value: MetricValue | null; finality: MetricFinality };

function dimensionValueOf(
  row: ReportResultRow,
  key: string,
): string | undefined {
  return row.dimensions.find((dimension) => dimension.key === key)?.value;
}

/** Bucket order first (rows of one bucket stay together), then `sort` or dimensions. */
function sortRows(
  rows: ReportResultRow[],
  sort: { column: string; direction: "asc" | "desc" } | undefined,
): ReportResultRow[] {
  const byBucket = (a: ReportResultRow, b: ReportResultRow) =>
    a.bucketStart.localeCompare(b.bucketStart);
  const inBucket = sortWithinBucket(sort);
  return rows.sort((a, b) => byBucket(a, b) || inBucket(a, b));
}

function sortWithinBucket(
  sort: { column: string; direction: "asc" | "desc" } | undefined,
): (a: ReportResultRow, b: ReportResultRow) => number {
  const byDimensions = (a: ReportResultRow, b: ReportResultRow) =>
    a.dimensions
      .map((d) => d.value)
      .join("\u0000")
      .localeCompare(b.dimensions.map((d) => d.value).join("\u0000"));
  if (sort === undefined) return byDimensions;
  const sign = sort.direction === "asc" ? 1 : -1;
  return (a, b) => {
    const cellA = a.values.find((cell) => cell.metricCode === sort.column);
    const cellB = b.values.find((cell) => cell.metricCode === sort.column);
    if (cellA !== undefined || cellB !== undefined) {
      const x = numericOf(cellA?.value ?? null);
      const y = numericOf(cellB?.value ?? null);
      // No data sorts last in either direction.
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      if (x !== null && y !== null && x !== y) return (x - y) * sign;
      return byDimensions(a, b);
    }
    const x = dimensionValueOf(a, sort.column) ?? "";
    const y = dimensionValueOf(b, sort.column) ?? "";
    return x === y ? byDimensions(a, b) : x.localeCompare(y) * sign;
  };
}

type Selection = {
  metricCodes: readonly string[];
  period: { startDate: string; endDate: string };
  outletIds?: readonly string[] | undefined;
  groupBy: readonly string[];
  filters: ReportBuilderQuery["filters"];
  bucket: MetricBucket;
  sort?: { column: string; direction: "asc" | "desc" } | undefined;
  limit: number;
};

async function buildResult(
  context: ScopedTenantContext,
  report: ReportDefinition | null,
  selection: Selection,
  options: ReportRunOptions,
): Promise<ReportResult> {
  const now = options.now ?? new Date();
  const definitions = selection.metricCodes.map((code) => {
    const definition = reportMetricByCode.get(code);
    if (definition === undefined)
      throw new HttpError(
        404,
        "METRIC_NOT_FOUND",
        `Metrik "${code}" tidak terdaftar.`,
      );
    return definition;
  });
  const outletFilter = outletIdsForQuery(
    context.outletScope,
    selection.outletIds,
  );
  const range = {
    start: selection.period.startDate as BusinessDate,
    end: selection.period.endDate as BusinessDate,
  };

  const evaluated = await withTenantSnapshot(context, (tx) =>
    evaluateMetrics(
      tx,
      context,
      {
        metricCodes: selection.metricCodes,
        period: range,
        bucket: selection.bucket,
        outletFilter,
        groupBy: selection.groupBy,
        filters: selection.filters,
        comparePrevious: false,
        viewer: options.viewer,
      },
      now,
    ),
  );

  const periodClosed = evaluated.period.status === "closed";
  const accountingPeriodClosed = evaluated.period.accountingPeriodClosed;

  // Pivot: one row per (bucket, dimension values), one cell per requested metric.
  const rowsByKey = new Map<
    string,
    {
      bucketStart: BusinessDate;
      bucketEnd: BusinessDate;
      dimensions: MetricDimensionValue[];
      cells: Map<string, Cell>;
    }
  >();
  const buckets = new Map<
    string,
    { bucketStart: BusinessDate; bucketEnd: BusinessDate }
  >();
  const addSeries = (series: EvaluatedSeries) => {
    // The engine puts outlet first; a row follows the requested groupBy order.
    const dimensions = selection.groupBy.flatMap((key) =>
      series.dimensions.filter((dimension) => dimension.key === key),
    );
    if (dimensions.length !== selection.groupBy.length) return;
    const dimensionKey = dimensions.map((d) => `${d.key}=${d.value}`).join("|");
    for (const point of series.points) {
      buckets.set(point.bucketStart, point);
      const key = `${point.bucketStart}|${dimensionKey}`;
      const row = rowsByKey.get(key) ?? {
        bucketStart: point.bucketStart,
        bucketEnd: point.bucketEnd,
        dimensions,
        cells: new Map(),
      };
      rowsByKey.set(key, row);
      row.cells.set(series.metricCode, {
        value: point.value,
        finality: point.finality,
      });
    }
  };
  for (const series of evaluated.series) addSeries(series);
  // A table without a split always shows one row per bucket, even with no data.
  if (selection.groupBy.length === 0) {
    if (buckets.size === 0)
      buckets.set(range.start, {
        bucketStart: range.start,
        bucketEnd: range.end,
      });
    for (const bucket of buckets.values())
      if (!rowsByKey.has(`${bucket.bucketStart}|`))
        rowsByKey.set(`${bucket.bucketStart}|`, {
          ...bucket,
          dimensions: [],
          cells: new Map(),
        });
  }

  const unavailable = new Set(
    evaluated.availability
      .filter((entry) => entry.status === "unavailable")
      .map((entry) => entry.metricCode),
  );
  const rows: ReportResultRow[] = [...rowsByKey.values()].map((row) => ({
    bucketStart: row.bucketStart,
    bucketEnd: row.bucketEnd,
    dimensions: row.dimensions,
    values: definitions.map((definition) => {
      const cell = row.cells.get(definition.code);
      const value = unavailable.has(definition.code)
        ? null
        : (cell?.value ?? null);
      // SH-02: a figure is final only for a closed period, and for
      // closed-period-only metrics or reports only once the books are closed.
      const mayBeFinal =
        periodClosed &&
        (accountingPeriodClosed ||
          (definition.officiality !== "closed_period_only" &&
            report?.closedPeriodOnly !== true));
      return {
        metricCode: definition.code,
        value,
        finality: mayBeFinal ? (cell?.finality ?? "estimate") : "estimate",
      };
    }),
  }));

  return reportResultSchema.parse({
    reportCode: report?.code ?? null,
    period: evaluated.period,
    bucket: evaluated.period.bucket,
    outletFilter: evaluated.outletFilter,
    definitions: evaluated.definitions,
    availability: evaluated.availability,
    groupBy: selection.groupBy,
    rows: sortRows(rows, selection.sort).slice(0, selection.limit),
    generatedAt: now.toISOString(),
    rowLimit: selection.limit,
  });
}

/** Runs one catalog report; the report's metrics are the columns. */
export function runReport(
  context: ScopedTenantContext,
  input: ReportRunInput,
  options: ReportRunOptions,
): Promise<ReportResult> {
  const report = reportByCode(input.reportCode);
  if (report === undefined) throw reportHttpError("REPORT_NOT_FOUND");
  return buildResult(
    context,
    report,
    { ...input, metricCodes: report.metrics },
    options,
  );
}

/** Ad hoc builder query: same result shape with `reportCode` null. */
export function previewReport(
  context: ScopedTenantContext,
  query: ReportBuilderQuery,
  options: ReportRunOptions,
): Promise<ReportResult> {
  return buildResult(context, null, query, options);
}
