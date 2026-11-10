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
// Nothing is invented: a metric the day model has no source figure for is
// returned as `null` ("no data", never zero), and a split the model cannot
// break down returns no rows. `day_of_week` is the exact sum of the model's
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
  type MetricDefinition,
} from "@starter/shared/metrics";
import {
  ATOM_KEYS,
  BUSINESS_DATE,
  MONTH_START,
  distribute,
  outletSplit,
  periodAtoms,
  splitSpecFor,
  zeroAtoms,
  type AtomKey,
  type Atoms,
  type DateRange,
  type SplitSpec,
} from "../ws11-reports/mock-day-model.ts";

const outlet = cafeLegendFixtures.outlets[0];

// ---- Day model (the shared module above; see the header) ---------------------

function splitFor(key: string, range: DateRange): SplitSpec | null {
  if (key === "outlet") return outletSplit(outlet.id);
  return splitSpecFor(key, range);
}

// ---- Metric cells (same formulas as the viewer) -------------------------------

type Cell = { unit: string; valueIdr?: number; value?: number | string } | null;

function decimal4(numerator: number, denominator: number): string {
  return ((numerator * 100) / denominator).toFixed(4);
}

// Same ratio as the viewer's derived `salesTarget` (mock-families/sales.ts).
const SALES_TARGET_RATIO = 1.05;

function cellFor(metricCode: string, atoms: Atoms): Cell {
  const ratio = (num: number, den: number) =>
    den === 0 ? null : { unit: "percent" as const, value: decimal4(num, den) };
  const idr = (valueIdr: number) => ({ unit: "idr" as const, valueIdr });
  const count = (value: number) => ({ unit: "count" as const, value });
  switch (metricCode) {
    case "sales_target":
      return idr(Math.round(atoms.net * SALES_TARGET_RATIO));
    case "target_achievement_pct":
      return ratio(atoms.net, Math.round(atoms.net * SALES_TARGET_RATIO));
    case "net_sales":
      return idr(atoms.net);
    case "gross_sales":
      return idr(atoms.gross);
    case "discount_amount":
      return idr(atoms.discount);
    case "refund_amount":
      return idr(atoms.refund);
    case "void_amount":
      return idr(atoms.voided);
    case "transaction_count":
      return count(atoms.tx);
    case "pax":
      return count(atoms.pax);
    case "menu_sold_qty":
      return count(atoms.qty);
    case "avg_ticket":
      return atoms.tx === 0 ? null : idr(Math.round(atoms.net / atoms.tx));
    case "avg_spend_per_pax":
      return atoms.pax === 0 ? null : idr(Math.round(atoms.net / atoms.pax));
    case "discount_rate_pct":
      return ratio(atoms.discount, atoms.gross);
    case "refund_rate_pct":
      return ratio(atoms.refund, atoms.net);
    case "void_rate_pct":
      return ratio(atoms.voided, atoms.net);
    default:
      // No source figure in the mock model: no data, never a made-up number.
      return null;
  }
}

/** Metric codes the mock model has figures for (the rest preview as "—"). */
export const MOCK_PREVIEW_METRIC_CODES: readonly string[] = Object.freeze([
  "sales_target",
  "target_achievement_pct",
  "net_sales",
  "gross_sales",
  "discount_amount",
  "refund_amount",
  "void_amount",
  "transaction_count",
  "pax",
  "menu_sold_qty",
  "avg_ticket",
  "avg_spend_per_pax",
  "discount_rate_pct",
  "refund_rate_pct",
  "void_rate_pct",
]);

// ---- Splits, filters and aggregation -----------------------------------------

type Leaf = { values: Record<string, string>; atoms: Atoms };

function splitLeaves(
  leaves: readonly Leaf[],
  spec: SplitSpec,
  key: string,
): Leaf[] {
  return leaves.flatMap((leaf) => {
    const columns = Object.fromEntries(
      ATOM_KEYS.map((atom) => [
        atom,
        distribute(leaf.atoms[atom], spec.weights[atom] ?? spec.weights.net),
      ]),
    ) as Record<AtomKey, number[]>;
    return spec.values.map((value, index) => ({
      values: { ...leaf.values, [key]: value },
      atoms: Object.fromEntries(
        ATOM_KEYS.map((atom) => [atom, columns[atom][index] ?? 0]),
      ) as Atoms,
    }));
  });
}

/** Rows of `groupBy` tuples with their summed atoms, in model order. */
function aggregate(
  query: ReportBuilderQuery,
  range: DateRange,
): { dims: string[]; atoms: Atoms }[] {
  // Every outlet figure in the model belongs to the first fixture outlet.
  if (query.outletIds !== undefined && !query.outletIds.includes(outlet.id))
    return [];
  const filterKeys = query.filters
    .map((filter) => filter.key)
    .filter((key) => !query.groupBy.includes(key));
  let leaves: Leaf[] = [{ values: {}, atoms: periodAtoms(range) }];
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
  const rows = new Map<string, { dims: string[]; atoms: Atoms }>();
  for (const leaf of leaves) {
    const dims = query.groupBy.map((key) => leaf.values[key] ?? "");
    const id = dims.join("\u0000");
    const row = rows.get(id) ?? { dims, atoms: zeroAtoms() };
    for (const key of ATOM_KEYS) row.atoms[key] += leaf.atoms[key];
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
      value: cellFor(definition.code, row.atoms),
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
    availability: definitions
      .map((definition) => definition.code)
      .map((metricCode) => ({
        metricCode,
        status: "available",
      })),
    groupBy: query.groupBy,
    // The limit applies after the sort, like the service.
    rows: rows.slice(0, query.limit),
    generatedAt: (options.now ?? new Date()).toISOString(),
    rowLimit: query.limit,
    truncated: rows.length > query.limit,
  });
}
