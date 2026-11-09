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
// break down returns no rows. `day_of_week` is the one computed split the
// viewer does not serve: it is the exact sum of the model's own days.
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
  dayAtoms,
  distribute,
  eachDay,
  outletSplit,
  periodAtoms,
  splitSpecFor,
  weekdayIndex,
  zeroAtoms,
  type AtomKey,
  type Atoms,
  type DateRange,
  type SplitSpec,
} from "../ws11-reports/mock-day-model.ts";

const outlet = cafeLegendFixtures.outlets[0];

// ---- Day model (the shared module above; see the header) ---------------------

/** Weekday split computed from the model's own days (exact, not invented). */
function weekdaySplit(range: DateRange): SplitSpec {
  const sums = Array.from({ length: 7 }, zeroAtoms);
  for (const day of eachDay(range)) {
    const atoms = dayAtoms(day);
    const bucket = sums[weekdayIndex(day)] as Atoms;
    for (const key of ATOM_KEYS) bucket[key] += atoms[key];
  }
  const present = sums
    .map((atoms, index) => ({ atoms, value: String(index + 1) }))
    .filter((item) => item.atoms.net > 0);
  const weights = Object.fromEntries(
    ATOM_KEYS.map((key) => [key, present.map((item) => item.atoms[key])]),
  ) as unknown as SplitSpec["weights"];
  return { values: present.map((item) => item.value), weights };
}

function splitFor(key: string, range: DateRange): SplitSpec | null {
  if (key === "day_of_week") return weekdaySplit(range);
  if (key === "outlet") return outletSplit(outlet.id);
  return splitSpecFor(key, range);
}

// ---- Metric cells (same formulas as the viewer) -------------------------------

type Cell = { unit: string; valueIdr?: number; value?: number | string } | null;

function decimal4(numerator: number, denominator: number): string {
  return ((numerator * 100) / denominator).toFixed(4);
}

function cellFor(metricCode: string, atoms: Atoms): Cell {
  const ratio = (num: number, den: number) =>
    den === 0 ? null : { unit: "percent" as const, value: decimal4(num, den) };
  const idr = (valueIdr: number) => ({ unit: "idr" as const, valueIdr });
  const count = (value: number) => ({ unit: "count" as const, value });
  switch (metricCode) {
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
  // SH-02, same rule as the viewer: final once the period is closed, and for
  // closed-period-only figures once the books of that month are closed.
  const closed = range.endDate < BUSINESS_DATE;
  const accountingClosed = closed && range.endDate < MONTH_START;

  const rows = (options.empty ? [] : aggregate(query, range)).map((row) => ({
    dimensions: query.groupBy.map((key, position) => ({
      key,
      value: row.dims[position] as string,
    })),
    values: definitions.map((definition) => ({
      metricCode: definition.code,
      value: cellFor(definition.code, row.atoms),
      finality:
        closed &&
        (accountingClosed || definition.officiality !== "closed_period_only")
          ? ("final" as const)
          : ("estimate" as const),
    })),
  }));

  if (query.sort !== undefined) {
    const { column, direction } = query.sort;
    const factor = direction === "asc" ? 1 : -1;
    const metricIndex = query.metricCodes.indexOf(column);
    const keyIndex = query.groupBy.indexOf(column);
    rows.sort((a, b) => {
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
  }

  return reportResultSchema.parse({
    reportCode: null,
    period: {
      startDate: range.startDate,
      endDate: range.endDate,
      bucket: query.bucket,
      status: closed ? "closed" : "open",
      accountingPeriodClosed: accountingClosed,
    },
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
  });
}
