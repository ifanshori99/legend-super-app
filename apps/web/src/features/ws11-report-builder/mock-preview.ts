// Mock-only preview results for the report builder (`VITE_API_MOCK=true`).
//
// DASH-02: a builder cell must be the number the report viewer, the owner
// board and the export show for the same metric, period and split. So this
// file computes from the SAME deterministic day model as the viewer mock:
// `features/ws11-reports/mock-day-model.ts` owns the open business day 1 Nov
// 2026 anchored on the owner board (net sales Rp 7.420.000, 96 transactions,
// 148 guests), the weekday factors, the closed-month tie to the books
// (Rp 412.800.000), the split weights and the largest-remainder distribution,
// so parts always add up to the total. Both mocks import that one module; the
// node test still compares their generated output single-split by single-split
// (DASH-02), so a drift fails the test instead of showing two numbers.
//
// Every family the viewer mock serves (sales, batch A and B) previews here:
// the figures, the cells and the availability come from the viewer's own
// `periodFigures`, `cellFor` and `availabilityOf` (legend-yf2b), so a builder
// cell never drifts from the report of the same metric.
//
// Nothing is invented: a metric no family has a source figure for, or one the
// API answers `unavailable`, is returned as `null` ("no data", never zero),
// and a split the model cannot break down returns no rows. `day_of_week` is the exact sum of the model's
// own days and lives in the day model, like every other split.
//
// Loaded in Node: bare package imports and relative `.ts` only.
import {
  reportMetricByCode,
  reportResultSchema,
  type ReportBuilderQuery,
  type ReportResult,
} from "@starter/shared/dashboard";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  metricDefinitionRefSchema,
  type MetricAvailability,
  type MetricDefinition,
} from "@starter/shared/metrics";
import {
  BUSINESS_DATE,
  MONTH_START,
  distribute,
  outletSplit,
  splitSpecFor,
  type DateRange,
  type SplitSpec,
} from "../ws11-reports/mock-day-model.ts";
import {
  EXTRA_SPLITS,
  FIGURE_KEYS,
  availabilityOf,
  cellFor,
  periodFigures,
  weightsFor,
  type FigureKey,
  type Figures,
} from "../ws11-reports/mock.ts";

const outlet = cafeLegendFixtures.outlets[0];

// ---- Day model (the shared module above; see the header) ---------------------

function splitFor(key: string, range: DateRange): SplitSpec | null {
  if (key === "outlet") return outletSplit(outlet.id);
  return splitSpecFor(key, range) ?? EXTRA_SPLITS[key] ?? null;
}

// ---- Metric cells (the viewer's own, `ws11-reports/mock.ts`) ------------------

type Cell = ReturnType<typeof cellFor>;

const zeroFigures = (): Figures =>
  Object.fromEntries(FIGURE_KEYS.map((key) => [key, 0])) as Figures;

// ---- Splits, filters and aggregation -----------------------------------------

type Leaf = { values: Record<string, string>; atoms: Figures };

function splitLeaves(
  leaves: readonly Leaf[],
  spec: SplitSpec,
  key: string,
): Leaf[] {
  return leaves.flatMap((leaf) => {
    const columns = Object.fromEntries(
      FIGURE_KEYS.map((figure) => [
        figure,
        distribute(leaf.atoms[figure], weightsFor(figure, spec)),
      ]),
    ) as Record<FigureKey, number[]>;
    return spec.values.map((value, index) => ({
      values: { ...leaf.values, [key]: value },
      atoms: Object.fromEntries(
        FIGURE_KEYS.map((figure) => [figure, columns[figure][index] ?? 0]),
      ) as Figures,
    }));
  });
}

/** Rows of `groupBy` tuples with their summed atoms, in model order. */
function aggregate(
  query: ReportBuilderQuery,
  range: DateRange,
): { dims: string[]; atoms: Figures }[] {
  // Every outlet figure in the model belongs to the first fixture outlet.
  if (query.outletIds !== undefined && !query.outletIds.includes(outlet.id))
    return [];
  const filterKeys = query.filters
    .map((filter) => filter.key)
    .filter((key) => !query.groupBy.includes(key));
  let leaves: Leaf[] = [{ values: {}, atoms: periodFigures(range) }];
  for (const key of [...query.groupBy, ...new Set(filterKeys)]) {
    const spec = splitFor(key, range);
    if (spec === null) return [];
    leaves = splitLeaves(leaves, spec, key);
  }
  leaves = leaves.filter((leaf) =>
    query.filters.every((filter) =>
      filter.values.includes(leaf.values[filter.key] ?? ""),
    ),
  );
  const rows = new Map<string, { dims: string[]; atoms: Figures }>();
  for (const leaf of leaves) {
    const dims = query.groupBy.map((key) => leaf.values[key] ?? "");
    const id = dims.join("\u0000");
    const row = rows.get(id) ?? { dims, atoms: zeroFigures() };
    for (const key of FIGURE_KEYS) row.atoms[key] += leaf.atoms[key];
    rows.set(id, row);
  }
  return [...rows.values()];
}

const DAY_MS = 86_400_000;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Start of the bucket holding `date` (weeks start on Monday, like the API). */
function bucketStartOf(date: string, bucket: ReportBuilderQuery["bucket"]) {
  const time = Date.parse(`${date}T00:00:00Z`);
  const at = new Date(time);
  switch (bucket) {
    case "week":
      return isoDay(time - ((at.getUTCDay() + 6) % 7) * DAY_MS);
    case "month":
      return `${date.slice(0, 7)}-01`;
    case "quarter":
      return `${date.slice(0, 5)}${String(Math.floor(at.getUTCMonth() / 3) * 3 + 1).padStart(2, "0")}-01`;
    case "year":
      return `${date.slice(0, 4)}-01-01`;
    default:
      return date;
  }
}

/** Bucket ranges clipped to the period; `total` is the whole period. */
function bucketRanges(
  range: DateRange,
  bucket: ReportBuilderQuery["bucket"],
): DateRange[] {
  if (bucket === "total") return [range];
  const ranges: DateRange[] = [];
  let startDate = range.startDate;
  while (startDate <= range.endDate) {
    const next = (() => {
      const from = bucketStartOf(startDate, bucket);
      const time = Date.parse(`${from}T00:00:00Z`);
      switch (bucket) {
        case "day":
          return isoDay(time + DAY_MS);
        case "week":
          return isoDay(time + 7 * DAY_MS);
        case "month":
          return isoDay(
            Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 1),
          );
        case "quarter":
          return isoDay(
            Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) + 2, 1),
          );
        default:
          return `${Number(from.slice(0, 4)) + 1}-01-01`;
      }
    })();
    const endDate = isoDay(Date.parse(`${next}T00:00:00Z`) - DAY_MS);
    ranges.push({
      startDate,
      endDate: endDate > range.endDate ? range.endDate : endDate,
    });
    startDate = next;
  }
  return ranges;
}

function cellNumber(cell: Cell): number | null {
  if (cell === null) return null;
  return cell.valueIdr ?? Number(cell.value);
}

function definitionRef(definition: MetricDefinition) {
  return metricDefinitionRefSchema.parse({
    id: definition.id,
    code: definition.code,
    version: definition.version,
    name: definition.name,
    ownerModule: definition.ownerModule,
    formula: definition.formula,
    unit: definition.unit,
    aggregation: definition.aggregation,
    dimensions: definition.dimensions,
    grain: definition.grain,
    officiality: definition.officiality,
    sourceReport: definition.sourceReport,
  });
}

export function buildPreviewResult(
  query: ReportBuilderQuery,
  options: { empty?: boolean; now?: Date } = {},
): ReportResult {
  const definitions = query.metricCodes.map((code) => {
    const definition = reportMetricByCode.get(code);
    if (definition === undefined) throw new Error(`Unknown metric ${code}`);
    return definition;
  });
  const range = {
    startDate: query.period.startDate,
    endDate: query.period.endDate,
  };
  // SH-02, same rule as the service, per bucket: final once the bucket is
  // closed, and for closed-period-only figures once its months are closed.
  const closed = range.endDate < BUSINESS_DATE;
  const accountingClosed = closed && range.endDate < MONTH_START;
  const finalityOf = (bucketEnd: string, officiality: string) =>
    bucketEnd < BUSINESS_DATE &&
    (bucketEnd < MONTH_START || officiality !== "closed_period_only")
      ? ("final" as const)
      : ("estimate" as const);

  // The viewer's availability per metric: the source is not built, or a split
  // the API refuses (the first of the query's splits that it refuses).
  const availability: MetricAvailability[] = definitions.map(
    (definition) =>
      [null, ...query.groupBy]
        .map((key) => availabilityOf(definition.code, key))
        .find((entry) => entry.status === "unavailable") ??
      availabilityOf(definition.code, null),
  );
  const unavailable = new Set(
    availability
      .filter((entry) => entry.status === "unavailable")
      .map((entry) => entry.metricCode),
  );

  const toRow = (
    bucketRange: DateRange,
    row: ReturnType<typeof aggregate>[number],
  ) => ({
    bucketStart: bucketRange.startDate,
    bucketEnd: bucketRange.endDate,
    dimensions: query.groupBy.map((key, position) => ({
      key,
      value: row.dims[position] as string,
    })),
    values: definitions.map((definition) => ({
      metricCode: definition.code,
      value: unavailable.has(definition.code)
        ? null
        : cellFor(definition.code, row.atoms, periodFigures(bucketRange)),
      finality: finalityOf(bucketRange.endDate, definition.officiality),
    })),
  });

  const sortRows = (rows: ReturnType<typeof toRow>[]) => {
    if (query.sort === undefined) return rows;
    const { column, direction } = query.sort;
    const factor = direction === "asc" ? 1 : -1;
    const metricIndex = query.metricCodes.indexOf(column);
    const keyIndex = query.groupBy.indexOf(column);
    return rows.sort((a, b) => {
      if (metricIndex >= 0) {
        const left = cellNumber(a.values[metricIndex]?.value ?? null);
        const right = cellNumber(b.values[metricIndex]?.value ?? null);
        // No data sorts last whatever the direction.
        if (left === null || right === null)
          return left === right ? 0 : left === null ? 1 : -1;
        return factor * (left - right);
      }
      return (
        factor *
        (a.dimensions[keyIndex]?.value ?? "").localeCompare(
          b.dimensions[keyIndex]?.value ?? "",
          "id",
          { numeric: true },
        )
      );
    });
  };

  // Bucket order first, then the sort within each bucket, like the service.
  const rows = options.empty
    ? []
    : bucketRanges(range, query.bucket).flatMap((bucketRange) =>
        sortRows(
          aggregate(query, bucketRange).map((row) => toRow(bucketRange, row)),
        ),
      );

  return reportResultSchema.parse({
    reportCode: null,
    period: {
      startDate: range.startDate,
      endDate: range.endDate,
      bucket: query.bucket,
      status: closed ? "closed" : "open",
      accountingPeriodClosed: accountingClosed,
    },
    bucket: query.bucket,
    outletFilter:
      query.outletIds === undefined
        ? { kind: "all" }
        : { kind: "outlets", outletIds: query.outletIds },
    definitions: definitions.map(definitionRef),
    availability,
    groupBy: query.groupBy,
    // The limit applies after the sort, like the service.
    rows: rows.slice(0, query.limit),
    generatedAt: (options.now ?? new Date()).toISOString(),
    rowLimit: query.limit,
    truncated: rows.length > query.limit,
  });
}
