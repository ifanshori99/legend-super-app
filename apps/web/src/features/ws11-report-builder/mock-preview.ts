// Mock-only preview results for the report builder (`VITE_API_MOCK=true`).
// The numbers are plausible Cafe Legend figures derived deterministically from
// the metric code and the dimension values, so the same query always shows the
// same table. Units, dimensions and finality follow the metric registry (no
// invented codes). Loaded in Node: bare package imports and relative `.ts`
// only.
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
  type MetricValue,
} from "@starter/shared/metrics";
import { daysInPeriod } from "./builder.ts";

/** The fixture business day; periods ending before it are closed. */
const FIXTURE_BUSINESS_DATE = "2026-11-01";
/** Books are closed up to this date in the fixtures. */
const FIXTURE_BOOKS_CLOSED_THROUGH = "2026-09-30";

const DIMENSION_VALUES: Readonly<Record<string, readonly string[]>> = {
  channel: ["qr", "pos", "captain", "gofood", "grabfood", "shopeefood"],
  payment_method: ["cash", "qris", "card", "transfer"],
  hour: Array.from({ length: 14 }, (_, i) => String(i + 8).padStart(2, "0")),
  day_of_week: ["1", "2", "3", "4", "5", "6", "7"],
  menu_category: ["Kopi", "Non-kopi", "Makanan berat", "Camilan", "Dessert"],
  menu_item: ["Kopi susu gula aren", "Americano", "Nasi goreng", "Roti bakar"],
  zone: ["Indoor", "Outdoor", "Co-working"],
  employee: ["Karyawan 1", "Karyawan 2", "Karyawan 3"],
  station: ["Bar", "Dapur panas", "Dapur dingin"],
  customer_tier: ["Reguler", "Silver", "Gold"],
  supplier: ["Pemasok 1", "Pemasok 2"],
  facility: ["Shower", "Ruang rapat"],
  promo: ["Promo akhir pekan", "Promo member"],
};

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function valuesFor(key: string, query: ReportBuilderQuery): string[] {
  const filter = query.filters.find((item) => item.key === key);
  if (filter !== undefined) return [...filter.values];
  if (key === "outlet")
    return (
      query.outletIds ?? cafeLegendFixtures.outlets.map((outlet) => outlet.id)
    );
  return [...(DIMENSION_VALUES[key] ?? [key])];
}

/** Share of the whole that filters on keys that are not split keep. */
function filterShare(query: ReportBuilderQuery): number {
  let share = 1;
  for (const filter of query.filters) {
    if (query.groupBy.includes(filter.key)) continue;
    const domain = DIMENSION_VALUES[filter.key]?.length ?? 4;
    share *= Math.min(1, filter.values.length / domain);
  }
  return Math.max(share, 0.05);
}

function valueFor(
  definition: MetricDefinition,
  seed: string,
  weightShare: number,
  days: number,
): MetricValue {
  const base = hash(definition.code);
  const jitter = 0.85 + (hash(seed) % 30) / 100;
  const additive = definition.aggregation === "sum";
  switch (definition.unit) {
    case "idr": {
      const perDay = 1_500_000 + (base % 3_500_000);
      const total = additive
        ? perDay * days * weightShare
        : perDay * 0.04 * jitter;
      return {
        unit: "idr",
        valueIdr: Math.round(total / 1000) * 1000,
      } as MetricValue;
    }
    case "count": {
      const perDay = 40 + (base % 260);
      const total = additive ? perDay * days * weightShare : perDay * jitter;
      return { unit: "count", value: Math.max(1, Math.round(total)) };
    }
    case "percent":
      return {
        unit: "percent",
        value: ((20 + (base % 50)) * jitter).toFixed(4),
      } as MetricValue;
    case "decimal":
      return {
        unit: "decimal",
        value: ((1 + (base % 400) / 100) * jitter).toFixed(4),
      } as MetricValue;
    case "seconds":
      return {
        unit: "seconds",
        value: Math.round((240 + (base % 600)) * jitter),
      };
  }
}

function combinations(columns: string[][]): string[][] {
  return columns.reduce<string[][]>(
    (rows, column) => rows.flatMap((row) => column.map((v) => [...row, v])),
    [[]],
  );
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
  const closed = query.period.endDate < FIXTURE_BUSINESS_DATE;
  const booksClosed =
    closed && query.period.endDate <= FIXTURE_BOOKS_CLOSED_THROUGH;
  const days = daysInPeriod(query.period);
  const share = filterShare(query);

  const combos = options.empty
    ? []
    : combinations(query.groupBy.map((key) => valuesFor(key, query))).slice(
        0,
        query.limit,
      );
  const weights = combos.map((combo) => 1 + (hash(combo.join("|")) % 9));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  const rows = combos.map((combo, index) => ({
    dimensions: query.groupBy.map((key, position) => ({
      key,
      value: combo[position] as string,
    })),
    values: definitions.map((definition) => ({
      metricCode: definition.code,
      value: valueFor(
        definition,
        `${definition.code}|${combo.join("|")}`,
        ((weights[index] ?? 1) / weightSum) * share,
        days,
      ),
      finality:
        booksClosed ||
        (closed && definition.officiality !== "closed_period_only")
          ? ("final" as const)
          : ("estimate" as const),
    })),
  }));

  if (query.sort !== undefined) {
    const { column, direction } = query.sort;
    const factor = direction === "asc" ? 1 : -1;
    const metricIndex = query.metricCodes.indexOf(column);
    const keyIndex = query.groupBy.indexOf(column);
    const numeric = (row: (typeof rows)[number]) => {
      const value = row.values[metricIndex]?.value;
      if (!value) return 0;
      return Number("valueIdr" in value ? value.valueIdr : value.value);
    };
    rows.sort((a, b) =>
      metricIndex >= 0
        ? factor * (numeric(a) - numeric(b))
        : factor *
          (a.dimensions[keyIndex]?.value ?? "").localeCompare(
            b.dimensions[keyIndex]?.value ?? "",
            "id",
            { numeric: true },
          ),
    );
  }

  return reportResultSchema.parse({
    reportCode: null,
    period: {
      startDate: query.period.startDate,
      endDate: query.period.endDate,
      bucket: query.bucket,
      status: closed ? "closed" : "open",
      accountingPeriodClosed: booksClosed,
    },
    outletFilter:
      query.outletIds === undefined
        ? { kind: "all" }
        : { kind: "outlets", outletIds: query.outletIds },
    definitions: definitions.map((definition) =>
      metricDefinitionRefSchema.parse({
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
      }),
    ),
    groupBy: query.groupBy,
    rows,
    generatedAt: (options.now ?? new Date()).toISOString(),
    rowLimit: query.limit,
  });
}
