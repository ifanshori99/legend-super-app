// Mock mode for the report viewer (`VITE_API_MOCK=true`), so every screen works
// with no API (docs/frontend.md "Typed endpoints and mock mode"). It owns
// GET /api/reports, GET /api/reports/:reportCode and the export endpoints, and
// registers the sales-family report runs through the shared run owner
// (`lib/mock/handlers/report-runs.ts`, bead legend-jzud: one owner per endpoint).
//
// Runs are generated from one deterministic day model anchored on the owner
// dashboard's fixture numbers for the open business day 1 Nov 2026 (net sales
// Rp 7.420.000, 96 transactions, 148 guests, the four channels), so the same
// report with a different split always adds up to the same totals (DASH-02),
// and the owner board's own runs (skipped here, same key) agree with them.
// Figures are mock-only, plausible Cafe Legend numbers; nothing is predicted.
//
// `?mock=empty` returns runs without rows and an empty catalog;
// `?mock=slow|error|offline` are handled by the runtime.
//
// Loaded in Node by tests/ws11-reports.test.mjs: bare package imports and
// relative `.ts` paths only, no `@/` alias.
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  cafeLegendManagementLayoutFixture,
  createReportExportEndpoint,
  getReportEndpoint,
  getReportExportEndpoint,
  listReportExportsEndpoint,
  listReportsEndpoint,
  managementDashboardKpiRuns,
  ownerDashboardBoardRuns,
  reportByCode,
  reportCatalog,
  reportExportContainsPersonalData,
  reportExportReadyFixture,
  reportExportPendingApprovalFixture,
  reportExportSchema,
  reportMetricByCode,
  type ReportDefinition,
  type ReportExport,
  type ReportResult,
} from "@starter/shared/dashboard";
import { metricDefinitionRefSchema } from "@starter/shared/metrics";
import { ApiError } from "../../lib/api/errors.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { registerMockReportRuns } from "../../lib/mock/handlers/report-runs.ts";
import { namedPresets, resolvePreset, type DateRange } from "./lib.ts";

const outlet = cafeLegendFixtures.outlets[0];
const BUSINESS_DATE = cafeLegendManagementLayoutFixture.businessDate;
const MONTH_START = `${BUSINESS_DATE.slice(0, 7)}-01`;

// ---- Day model ---------------------------------------------------------------

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

/** The open business day (a Sunday), anchored on the owner board's figures. */
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

function periodAtoms(range: DateRange): Atoms {
  const total: Atoms = {
    net: 0,
    gross: 0,
    discount: 0,
    refund: 0,
    tx: 0,
    pax: 0,
    qty: 0,
    voided: 0,
  };
  for (const day of eachDay(range)) {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    const factor = WEEKDAY_FACTOR[weekday] ?? 1;
    for (const key of Object.keys(total) as AtomKey[])
      total[key] += Math.round(BASE_DAY[key] * factor);
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
  /** Weights per atom; `net` is the fallback for atoms without their own. */
  weights: Partial<Record<AtomKey, readonly number[]>> & {
    net: readonly number[];
  };
};

const SPLITS: Readonly<Record<string, SplitSpec>> = {
  outlet: { values: [outlet.name], weights: { net: [1] } },
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

function splitFor(key: string, range: DateRange): SplitSpec | null {
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

// ---- Metric cells ------------------------------------------------------------

function decimal4(numerator: number, denominator: number): string {
  return ((numerator * 100) / denominator).toFixed(4);
}

// Plain wire values; the registry and the node test validate them against the
// branded schema, so no brand is faked here.
type Cell = { unit: string; valueIdr?: number; value?: number | string } | null;

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
      return null;
  }
}

function metricRef(code: string) {
  const definition = reportMetricByCode.get(code);
  if (definition === undefined)
    throw new Error(`No registry row for report metric ${code}`);
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

type LooseRow = {
  dimensions: { key: string; value: string }[];
  values: { metricCode: string; value: Cell; finality: "final" | "estimate" }[];
};

function buildRun(
  report: ReportDefinition,
  groupBy: string | null,
  range: DateRange,
): ReportResult | null {
  const totals = periodAtoms(range);
  const closed = range.endDate < BUSINESS_DATE;
  const accountingClosed = closed && range.endDate < MONTH_START;
  const refs = report.metrics.map(metricRef);

  function row(
    dims: readonly (readonly [string, string])[],
    atoms: Atoms,
  ): LooseRow {
    return {
      dimensions: dims.map(([key, value]) => ({ key, value })),
      values: refs.map((ref) => {
        const value = cellFor(ref.code, atoms);
        // SH-02: final only for a closed period, and for closed-period-only
        // figures only once the books of that period are closed.
        const official =
          closed &&
          (accountingClosed ||
            (ref.officiality !== "closed_period_only" &&
              !report.closedPeriodOnly));
        return {
          metricCode: ref.code,
          value,
          finality: official ? ("final" as const) : ("estimate" as const),
        };
      }),
    };
  }

  let rows: LooseRow[];
  if (groupBy === null) rows = [row([], totals)];
  else {
    const spec = splitFor(groupBy, range);
    if (spec === null) return null;
    const atomKeys = Object.keys(totals) as AtomKey[];
    const columns = Object.fromEntries(
      atomKeys.map((key) => [
        key,
        distribute(totals[key], spec.weights[key] ?? spec.weights.net),
      ]),
    ) as Record<AtomKey, number[]>;
    rows = spec.values.map((value, index) =>
      row(
        [[groupBy, value]],
        Object.fromEntries(
          atomKeys.map((key) => [key, columns[key][index] ?? 0]),
        ) as Atoms,
      ),
    );
  }

  return {
    reportCode: report.code,
    period: {
      startDate: range.startDate,
      endDate: range.endDate,
      bucket: "total",
      status: closed ? "closed" : "open",
      accountingPeriodClosed: accountingClosed,
    },
    outletFilter: { kind: "outlets", outletIds: [outlet.id] },
    definitions: refs,
    groupBy: groupBy === null ? [] : [groupBy],
    rows,
    generatedAt: "2026-11-01T04:40:00.000Z",
    rowLimit: 100,
  } as unknown as ReportResult;
}

// ---- Run registration --------------------------------------------------------

/** Sales reports this feature serves runs for (catalog families add theirs). */
const SERVED_REPORTS = [
  "sales.daily",
  "sales.per_hour",
  "sales.per_channel",
  "sales.per_menu",
  "sales.per_employee",
  "sales.transactions",
  "sales.per_pax",
  "sales.void",
  "sales.discount",
  "sales.refund",
] as const;

function runKey(result: ReportResult): string {
  return `${result.reportCode}|${result.groupBy.join(",")}|${result.period.startDate}|${result.period.endDate}`;
}

function periodsOf(report: ReportDefinition): DateRange[] {
  const seen = new Set<string>();
  const periods: DateRange[] = [];
  for (const preset of namedPresets(report)) {
    const range = resolvePreset(preset, BUSINESS_DATE);
    if (range === null) continue;
    const key = `${range.startDate}|${range.endDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    periods.push(range);
  }
  return periods;
}

/** Runs another owner already serves (owner board, management KPIs) stay theirs. */
const OTHER_OWNERS = new Set(
  [
    ...Object.values(ownerDashboardBoardRuns),
    ...Object.values(managementDashboardKpiRuns),
  ].map(runKey),
);

export function buildSalesRuns(): ReportResult[] {
  const runs: ReportResult[] = [];
  for (const code of SERVED_REPORTS) {
    const report = reportByCode(code);
    if (report === undefined) continue;
    for (const range of periodsOf(report))
      for (const groupBy of [null, ...report.dimensions]) {
        const run = buildRun(report, groupBy, range);
        if (run !== null && !OTHER_OWNERS.has(runKey(run))) runs.push(run);
      }
  }
  return runs;
}

registerMockReportRuns(
  Object.fromEntries(buildSalesRuns().map((run) => [runKey(run), run])),
);

// ---- Catalog -----------------------------------------------------------------

registerMock(listReportsEndpoint, ({ query, scenario }) => {
  const term = query.search?.toLowerCase();
  return paginateFixture(
    reportCatalog.filter(
      (report) =>
        (query.family === undefined || report.family === query.family) &&
        (query.ownerModule === undefined ||
          report.ownerModule === query.ownerModule) &&
        (term === undefined ||
          report.name.toLowerCase().includes(term) ||
          report.description.toLowerCase().includes(term)),
    ),
    query,
    (report) => report.code,
    scenario,
  );
});

registerMock(getReportEndpoint, ({ params }) => {
  const report = reportByCode(params.reportCode);
  if (report === undefined)
    throw new ApiError(
      404,
      "REPORT_NOT_FOUND",
      "Laporan tidak ditemukan di katalog.",
    );
  return { data: report };
});

// ---- Exports (DASH-04) -------------------------------------------------------
//
// An aggregate export moves queued -> generating -> ready with the clock; a
// personal-data export stays pending_approval, because nothing leaves the
// server until the approval inbox approves it (that flow is WS-01's).

type ExportEntry = { fixed: ReportExport } | { draft: ExportDraft };
type ExportDraft = {
  id: string;
  createdMs: number;
  input: {
    reportCode: string;
    format: ReportExport["format"];
    query: ReportExport["query"];
  };
  personal: boolean;
};

const exportStore = createMockStore<{
  entries: ExportEntry[];
  keys: Map<string, string>;
  counter: number;
}>(() => ({
  entries: [
    { fixed: reportExportPendingApprovalFixture },
    { fixed: reportExportReadyFixture },
  ],
  keys: new Map(),
  counter: 0,
}));

const iso = (ms: number) => new Date(ms).toISOString();

function materialize(draft: ExportDraft, nowMs: number): ReportExport {
  const age = nowMs - draft.createdMs;
  const base = {
    id: draft.id,
    tenantId: cafeLegendFixtures.tenant.id,
    reportCode: draft.input.reportCode,
    savedReportId: null,
    format: draft.input.format,
    query: draft.input.query,
    containsPersonalData: draft.personal,
    approvalRequestId: null,
    requestedBy: reportExportReadyFixture.requestedBy,
    requestedAt: iso(draft.createdMs),
  };
  if (draft.personal)
    return reportExportSchema.parse({
      ...base,
      status: "pending_approval",
      startedAt: null,
      completedAt: null,
      file: null,
      errorCode: null,
    });
  if (age < 1_000)
    return reportExportSchema.parse({
      ...base,
      status: "queued",
      startedAt: null,
      completedAt: null,
      file: null,
      errorCode: null,
    });
  const startedAt = iso(draft.createdMs + 200);
  if (age < 2_500)
    return reportExportSchema.parse({
      ...base,
      status: "generating",
      startedAt,
      completedAt: null,
      file: null,
      errorCode: null,
    });
  const completedMs = draft.createdMs + 2_400;
  return reportExportSchema.parse({
    ...base,
    status: "ready",
    startedAt,
    completedAt: iso(completedMs),
    file: {
      downloadPath: `/api/reports/exports/${draft.id}/file`,
      sizeBytes: 14_336,
      rowCount: 18,
      expiresAt: iso(completedMs + 7 * 24 * 3_600_000),
    },
    errorCode: null,
  });
}

function materializeEntry(entry: ExportEntry): ReportExport {
  return "fixed" in entry ? entry.fixed : materialize(entry.draft, Date.now());
}

registerMock(createReportExportEndpoint, ({ body, scenario }) => {
  const state = exportStore.get();
  if (body.reportCode === undefined)
    throw new ApiError(
      400,
      "REPORT_QUERY_INVALID",
      "Pengaturan laporan tidak valid.",
    );
  const report = reportByCode(body.reportCode);
  if (report === undefined)
    throw new ApiError(
      404,
      "REPORT_NOT_FOUND",
      "Laporan tidak ditemukan di katalog.",
    );
  if (!report.exportFormats.includes(body.format))
    throw new ApiError(
      400,
      "EXPORT_FORMAT_NOT_SUPPORTED",
      "Format ekspor ini tidak tersedia.",
    );
  // An idempotent retry returns the job it already created.
  const known = body.idempotencyKey
    ? state.keys.get(body.idempotencyKey)
    : undefined;
  if (known !== undefined) {
    const entry = state.entries.find(
      (item) => "draft" in item && item.draft.id === known,
    );
    if (entry !== undefined) return { data: materializeEntry(entry) };
  }
  state.counter += 1;
  const draft: ExportDraft = {
    id: `5a7e0000-0000-4000-8000-${state.counter.toString(16).padStart(12, "0")}`,
    createdMs: Date.now(),
    input: {
      reportCode: report.code,
      format: body.format,
      query: body.query,
    },
    personal: reportExportContainsPersonalData({
      report,
      query: body.query,
    }),
  };
  state.entries.unshift({ draft });
  if (body.idempotencyKey) state.keys.set(body.idempotencyKey, draft.id);
  void scenario;
  return { data: materialize(draft, draft.createdMs) };
});

registerMock(listReportExportsEndpoint, ({ query, scenario }) =>
  paginateFixture(
    exportStore.get().entries.map(materializeEntry),
    query,
    (job) => job.id,
    scenario,
  ),
);

registerMock(getReportExportEndpoint, ({ params }) => {
  const entry = exportStore
    .get()
    .entries.find(
      (item) => materializeEntry(item).id === params.reportExportId,
    );
  if (entry === undefined)
    throw new ApiError(404, "NOT_FOUND", "Ekspor tidak ditemukan.");
  return { data: materializeEntry(entry) };
});
