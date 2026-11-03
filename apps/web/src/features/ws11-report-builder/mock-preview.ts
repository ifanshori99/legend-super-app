// Mock-only preview results for the report builder (`VITE_API_MOCK=true`).
//
// DASH-02: a builder cell must be the number the report viewer, the owner
// board and the export show for the same metric, period and split. So this
// file computes from the SAME deterministic day model as the viewer mock
// (features/ws11-reports/mock.ts, owned by the viewer bead and read-only
// here): the open business day 1 Nov 2026 anchored on the owner board
// (net sales Rp 7.420.000, 96 transactions, 148 guests), the same weekday
// factors, the closed-month tie to the books (Rp 412.800.000), the same split
// weights and the same largest-remainder distribution, so parts always add up
// to the total. The constants below are a copy of that model; the node test
// asserts that every single-split preview equals the viewer's run for the
// same key, so a drift fails the test instead of showing two numbers.
//
// Nothing is invented: a metric the day model has no source figure for is
// returned as `null` ("no data", never zero), and a split the model cannot
// break down returns no rows. `day_of_week` is the one computed split the
// viewer does not serve: it is the exact sum of the model's own days.
//
// Loaded in Node: bare package imports and relative `.ts` only.
import {
  cafeLegendManagementLayoutFixture,
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

type DateRange = { startDate: string; endDate: string };

const outlet = cafeLegendFixtures.outlets[0];
const BUSINESS_DATE = cafeLegendManagementLayoutFixture.businessDate;
const MONTH_START = `${BUSINESS_DATE.slice(0, 7)}-01`;
const CLOSED_MONTH_NET_SALES = 412_800_000;
const LAST_MONTH = (() => {
  const end = new Date(`${MONTH_START}T00:00:00Z`);
  end.setUTCDate(0);
  const last = end.toISOString().slice(0, 10);
  return { start: `${last.slice(0, 8)}01`, end: last };
})();

// ---- Day model (copy of the viewer mock; see the header) ---------------------

type Atoms = {
  net: number;
  gross: number;
  discount: number;
  refund: number;
  tx: number;
  pax: number;
  qty: number;
  voided: number;
};
type AtomKey = keyof Atoms;
const ATOM_KEYS: readonly AtomKey[] = [
  "net",
  "gross",
  "discount",
  "refund",
  "tx",
  "pax",
  "qty",
  "voided",
];

const BASE_DAY: Atoms = {
  net: 7_420_000,
  gross: 7_920_000,
  discount: 380_000,
  refund: 120_000,
  tx: 96,
  pax: 148,
  qty: 214,
  voided: 95_000,
};

/** Monday .. Sunday; the business day (Sunday) is 1. */
const WEEKDAY_FACTOR = [0.78, 0.82, 0.85, 0.9, 1.15, 1.3, 1] as const;

function zeroAtoms(): Atoms {
  return {
    net: 0,
    gross: 0,
    discount: 0,
    refund: 0,
    tx: 0,
    pax: 0,
    qty: 0,
    voided: 0,
  };
}

function eachDay(range: DateRange): string[] {
  const days: string[] = [];
  const cursor = new Date(`${range.startDate}T00:00:00Z`);
  const end = new Date(`${range.endDate}T00:00:00Z`);
  while (cursor <= end && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** ISO weekday index 0 (Monday) .. 6 (Sunday). */
function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function dayAtoms(day: string): Atoms {
  const factor = WEEKDAY_FACTOR[weekdayIndex(day)] ?? 1;
  const atoms = zeroAtoms();
  for (const key of ATOM_KEYS) atoms[key] = Math.round(BASE_DAY[key] * factor);
  return atoms;
}

function periodAtoms(range: DateRange): Atoms {
  const total = zeroAtoms();
  for (const day of eachDay(range)) {
    const atoms = dayAtoms(day);
    for (const key of ATOM_KEYS) total[key] += atoms[key];
  }
  if (
    range.startDate === LAST_MONTH.start &&
    range.endDate === LAST_MONTH.end
  ) {
    const scale = CLOSED_MONTH_NET_SALES / total.net;
    for (const key of ATOM_KEYS) total[key] = Math.round(total[key] * scale);
  }
  return total;
}

/** Largest-remainder split, so the parts always add up to the total. */
function distribute(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((weight) => (total * weight) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    parts[index] = (parts[index] ?? 0) + 1;
    left -= 1;
  }
  return parts;
}

type SplitSpec = {
  values: readonly string[];
  weights: Partial<Record<AtomKey, readonly number[]>> & {
    net: readonly number[];
  };
};

const SPLITS: Readonly<Record<string, SplitSpec>> = {
  // The builder names outlets by id (the preview resolves the name).
  outlet: { values: [outlet.id], weights: { net: [1] } },
  channel: {
    values: ["qr", "pos", "gofood", "grabfood"],
    weights: {
      net: [4_150_000, 1_980_000, 780_000, 510_000],
      tx: [52, 28, 10, 6],
      pax: [92, 34, 14, 8],
    },
  },
  hour: {
    values: [
      "08",
      "09",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
    ],
    weights: { net: [2, 3, 5, 8, 12, 11, 7, 6, 7, 9, 12, 10, 6, 3] },
  },
  menu_item: {
    values: [
      "Kopi Susu Aren",
      "Nasi Goreng Kampung",
      "Ayam Geprek",
      "Matcha Latte",
      "Croissant Mentega",
      "Es Teh Lemon",
      "Pisang Goreng Keju",
      "Mie Goreng Seafood",
      "Americano",
      "Roti Bakar Coklat",
    ],
    weights: {
      net: [
        1_260_000, 1_085_000, 945_000, 720_000, 525_000, 640_000, 520_000,
        480_000, 760_000, 485_000,
      ],
      qty: [42, 31, 27, 24, 21, 18, 14, 12, 16, 9],
    },
  },
  menu_category: {
    values: ["Kopi", "Makanan berat", "Nonkopi", "Pastry dan camilan"],
    weights: {
      net: [2_900_000, 2_700_000, 1_120_000, 700_000],
      qty: [78, 62, 41, 33],
    },
  },
  employee: {
    values: ["Rani", "Dimas", "Putri", "Fajar"],
    weights: {
      net: [2_300_000, 2_050_000, 1_760_000, 1_310_000],
      tx: [30, 26, 24, 16],
      voided: [40_000, 25_000, 20_000, 10_000],
    },
  },
  payment_method: {
    values: ["qris", "cash", "debit", "ewallet"],
    weights: {
      net: [3_300_000, 2_200_000, 1_120_000, 800_000],
      tx: [44, 26, 16, 10],
      refund: [60_000, 30_000, 20_000, 10_000],
    },
  },
  promo: {
    values: ["Promo Gajian", "Voucher Member", "Diskon Jam Santai"],
    weights: { net: [200_000, 110_000, 70_000] },
  },
};

/** Single-day open business day: the café has only served until 11.40 WIB. */
const OPEN_DAY_HOURS = ["08", "09", "10", "11"];
const OPEN_DAY_HOUR_WEIGHTS = [2, 3, 5, 8];

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
  const spec = SPLITS[key];
  if (spec === undefined) return null;
  if (
    key === "hour" &&
    range.startDate === BUSINESS_DATE &&
    range.endDate === BUSINESS_DATE
  )
    return { values: OPEN_DAY_HOURS, weights: { net: OPEN_DAY_HOUR_WEIGHTS } };
  return spec;
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
    groupBy: query.groupBy,
    // The limit applies after the sort, like the service.
    rows: rows.slice(0, query.limit),
    generatedAt: (options.now ?? new Date()).toISOString(),
    rowLimit: query.limit,
  });
}
