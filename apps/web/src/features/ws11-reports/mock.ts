// Mock mode for the report viewer (`VITE_API_MOCK=true`), so every screen works
// with no API (docs/frontend.md "Typed endpoints and mock mode"). It owns
// GET /api/reports, GET /api/reports/:reportCode and the export endpoints, and
// registers the sales-family report runs through the shared run owner
// (`lib/mock/handlers/report-runs.ts`, bead legend-jzud: one owner per endpoint).
//
// Runs are generated from the shared deterministic day model in
// `mock-day-model.ts`, anchored on the owner dashboard's fixture numbers for
// the open business day 1 Nov 2026 (net sales Rp 7.420.000, 96 transactions,
// 148 guests, the four channels), so the same report with a different split
// always adds up to the same totals (DASH-02), the owner board's own runs
// (skipped here, same key) agree with them, and the report builder's previews
// (features/ws11-report-builder/mock-preview.ts, same module) show the same
// cells. Figures are mock-only, plausible Cafe Legend numbers; nothing is
// predicted.
//
// The other families (menu, payments, tax, inventory, cogs, purchasing,
// finance, loyalty, crm, reservation, attendance, payroll, performance) derive
// their figures from the same atoms: money lines are shares of net sales (and
// of the other atoms, with the owner insights' cost structure per period) and
// balances are the open day's amounts, so a P&L, a payroll cost and a tax
// report of one period always agree with the sales reports of that period and
// with the dashboards (I1/I4). The report builder's previews import these
// figures (`periodFigures`, `cellFor`, `availabilityOf`), so they know every
// family above; a metric no family has a figure for shows "no data".
//
// `?mock=empty` returns runs without rows and an empty catalog;
// `?mock=slow|error|offline` are handled by the runtime.
//
// Loaded in Node by tests/ws11-reports.test.mjs: bare package imports and
// relative `.ts` paths only, no `@/` alias.
import { roleTemplate } from "@starter/shared/access";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  createReportExportEndpoint,
  getReportEndpoint,
  getReportExportEndpoint,
  listReportExportsEndpoint,
  listReportsEndpoint,
  managementDashboardKpiRuns,
  ownerDashboardBoardRuns,
  reportByCode,
  reportCatalog,
  reportErrorHttpStatus,
  reportExportGate,
  reportExportReadyFixture,
  reportExportPendingApprovalFixture,
  reportExportSchema,
  reportMetricByCode,
  type ReportDefinition,
  type ReportExport,
  type ReportResult,
} from "@starter/shared/dashboard";
import {
  METRIC_UNAVAILABLE_MESSAGES,
  metricDefinitionRefSchema,
  type MetricAvailability,
  type MetricUnavailableReason,
} from "@starter/shared/metrics";
import { ApiError } from "../../lib/api/errors.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import {
  hasMockReportRun,
  registerMockReportRuns,
} from "../../lib/mock/handlers/report-runs.ts";
import {
  MONTH_FIGURES,
  ownerMonthIncomes,
} from "../ws11-owner-dashboard/insights-mock.ts";
import { namedPresets, resolvePreset, type DateRange } from "./lib.ts";
import {
  ATOM_KEYS,
  BASE_DAY,
  BUSINESS_DATE,
  LAST_MONTH,
  MONTH_START,
  dayAtoms,
  distribute,
  outletSplit,
  periodAtoms,
  splitSpecFor,
  type AtomKey,
  type Atoms,
  type SplitSpec,
} from "./mock-day-model.ts";
import { type Cell, type DerivedSpec } from "./mock-families/cells.ts";
import * as facility from "./mock-families/facility.ts";
import * as finance from "./mock-families/finance.ts";
import * as hr from "./mock-families/hr.ts";
import * as inventoryPurchasing from "./mock-families/inventory-purchasing.ts";
import * as loyaltyCrm from "./mock-families/loyalty-crm.ts";
import * as menuCogs from "./mock-families/menu-cogs.ts";
import * as paymentsTax from "./mock-families/payments-tax.ts";
import * as reservationDelivery from "./mock-families/reservation-delivery.ts";
import * as sales from "./mock-families/sales.ts";
import * as trafficOperations from "./mock-families/traffic-operations.ts";

const outlet = cafeLegendFixtures.outlets[0];

// ---- Day model ---------------------------------------------------------------
//
// `mock-day-model.ts` owns the atoms, weekday factors, closed-month scaling and
// split weights; only the outlet label is this feature's own (rows show the
// name, while the builder's query carries the id).

// Splits the shared model does not know (supplier, station, zone, member tier);
// net sales is the fallback weight of every figure.
/** Also the report builder's previews (`ws11-report-builder/mock-preview.ts`). */
export const EXTRA_SPLITS: Readonly<Record<string, SplitSpec>> = {
  customer_tier: {
    values: ["Bronze", "Silver", "Gold", "Platinum"],
    weights: { net: [3_100_000, 2_300_000, 1_500_000, 520_000] },
  },
  supplier: {
    values: [
      "CV Sumber Pangan",
      "UD Kopi Nusantara",
      "PT Susu Segar Lestari",
      "Toko Bahan Kue Maju",
    ],
    weights: { net: [4_200_000, 2_100_000, 900_000, 220_000] },
  },
  station: {
    values: ["Bar", "Dapur panas", "Dapur dingin", "Kasir"],
    weights: { net: [3_000_000, 2_600_000, 1_100_000, 720_000] },
  },
  zone: {
    values: ["Indoor", "Outdoor", "Area merokok", "Ruang VIP"],
    weights: { net: [3_400_000, 2_300_000, 1_200_000, 520_000] },
  },
};

function splitFor(key: string, range: DateRange): SplitSpec | null {
  if (key === "outlet") return outletSplit(outlet.name);
  return splitSpecFor(key, range) ?? EXTRA_SPLITS[key] ?? null;
}

// ---- Derived figures ---------------------------------------------------------
//
// Beyond the sales atoms, every other family's number is a fixed share of one
// atom (`ratio`) or, for a balance, a fixed amount of the open business day
// scaled by the weekday of the period's last day (`snapshot`). Each derived
// column is split with the weights of the atom it derives from, so rows still
// add up to the total whatever the split (DASH-02), and the money lines
// (cogs, payroll, tax, profit) all hang off the same net sales as the sales
// reports (I1/I4).

// Each family owns its derived columns (`mock-families/<family>.ts`).
const DERIVED = {
  ...sales.derived,
  ...trafficOperations.derived,
  ...menuCogs.derived,
  ...paymentsTax.derived,
  ...inventoryPurchasing.derived,
  ...finance.derived,
  ...loyaltyCrm.derived,
  ...reservationDelivery.derived,
  ...hr.derived,
  ...facility.derived,
} as const satisfies Record<string, DerivedSpec>;

type DerivedKey = keyof typeof DERIVED;
const DERIVED_KEYS = Object.keys(DERIVED) as DerivedKey[];
export type Figures = Atoms & Record<DerivedKey, number>;
export type FigureKey = AtomKey | DerivedKey;
export const FIGURE_KEYS: readonly FigureKey[] = [
  ...ATOM_KEYS,
  ...DERIVED_KEYS,
];

/** Weights of one figure in a split: its source atom's, else net sales. */
export function weightsFor(key: FigureKey, spec: SplitSpec): readonly number[] {
  const source = key in DERIVED ? DERIVED[key as DerivedKey].from : key;
  return (
    spec.weights[key as AtomKey] ??
    spec.weights[source as AtomKey] ??
    spec.weights.net
  );
}

/** The weekday scaling of a balance, 1 on the open business day. */
function dayFactor(day: string): number {
  return dayAtoms(day).net / BASE_DAY.net;
}

/**
 * Cost structure of a period. The closed month is the owner insights' and the
 * shareholder board's October (COGS 33,7%, payroll 24,5%, net profit of the
 * October profit-share run, Rp21.000.000 below EBITDA); every other period
 * is the running month's structure (COGS 31,2%, payroll 27,5%), so a report
 * and the dashboard tile of the same period show one number (DASH-02, I4).
 */
type Profile = {
  food: number;
  labor: number;
  waste: number;
  promo: number;
  below: number;
  netProfit: number;
  cash?: number;
  bank?: number;
};

// The owner insights' month table (`MONTH_FIGURES`) is the one source of the
// cost structure of the closed October and of the running month, so a report,
// the owner board and the shareholder board never keep their own copy
// (legend-3nuv, DASH-02).
const OCTOBER = MONTH_FIGURES[
  ownerMonthIncomes.findIndex((month) => month.startDate === LAST_MONTH.start)
] as (typeof MONTH_FIGURES)[number];
const RUNNING = MONTH_FIGURES[
  MONTH_FIGURES.length - 1
] as (typeof MONTH_FIGURES)[number];

function profileOf(range: DateRange, atoms: Atoms): Profile {
  const closedMonth =
    range.startDate === LAST_MONTH.start && range.endDate === LAST_MONTH.end;
  // Any range inside the closed October is final, so it carries October's cost
  // structure (COGS 33,7%), scaled by its share of the month's net sales; the
  // whole month is exactly the owner insights' figures.
  if (range.startDate >= LAST_MONTH.start && range.endDate <= LAST_MONTH.end) {
    const share = closedMonth ? 1 : atoms.net / OCTOBER.netSales;
    const atMonthEnd = range.endDate === LAST_MONTH.end;
    return {
      food: OCTOBER.food / 100,
      labor: OCTOBER.labor / 100,
      waste: Math.round(OCTOBER.waste * share),
      promo: Math.round(OCTOBER.promo * share),
      below: Math.round(21_000_000 * share),
      netProfit: Math.round(OCTOBER.net * share),
      // Balances are the month-end ones, only on the month's last day.
      ...(atMonthEnd ? { cash: 34_600_000, bank: 512_300_000 } : {}),
    };
  }
  const share = atoms.net / BASE_DAY.net;
  return {
    food: RUNNING.food / 100,
    labor: RUNNING.labor / 100,
    waste: Math.round(RUNNING.waste * share),
    promo: Math.round(RUNNING.promo * (atoms.discount / BASE_DAY.discount)),
    below: Math.round(atoms.net * 0.04),
    netProfit: Math.round(RUNNING.net * share),
  };
}

/** Exported for tests/ws11-fixture-reconcile.test.mjs. */
export function periodFigures(range: DateRange): Figures {
  const atoms = periodAtoms(range);
  const figures = { ...atoms } as Figures;
  for (const key of DERIVED_KEYS) {
    const spec: DerivedSpec = DERIVED[key];
    figures[key] =
      spec.snapshot !== undefined
        ? Math.round(
            spec.snapshot *
              dayFactor(key === "members" ? BUSINESS_DATE : range.endDate),
          )
        : Math.round(atoms[spec.from] * (spec.ratio ?? 0));
  }
  const profile = profileOf(range, atoms);
  figures.cogs = Math.round(atoms.net * profile.food);
  figures.labor = Math.round(atoms.net * profile.labor);
  figures.waste = profile.waste;
  figures.promo = profile.promo;
  figures.below = profile.below;
  // Operating expenses are what is left between EBITDA and the books' profit.
  figures.opex =
    atoms.net -
    figures.cogs -
    figures.labor -
    (profile.netProfit + profile.below);
  if (profile.cash !== undefined) figures.cash = profile.cash;
  if (profile.bank !== undefined) figures.bank = profile.bank;
  return figures;
}

// ---- Metric cells ------------------------------------------------------------

/** Each family owns the cells of its metrics (`mock-families/<family>.ts`). */
const FAMILY_CELLS: readonly ((
  metricCode: string,
  atoms: Figures,
  totals: Figures,
) => Cell | undefined)[] = [
  sales.cellFor,
  trafficOperations.cellFor,
  menuCogs.cellFor,
  paymentsTax.cellFor,
  inventoryPurchasing.cellFor,
  finance.cellFor,
  loyaltyCrm.cellFor,
  reservationDelivery.cellFor,
  hr.cellFor,
  facility.cellFor,
];

export function cellFor(
  metricCode: string,
  atoms: Figures,
  totals: Figures,
): Cell {
  for (const familyCell of FAMILY_CELLS) {
    const cell = familyCell(metricCode, atoms, totals);
    if (cell !== undefined) return cell;
  }
  return null;
}

// ---- Availability ------------------------------------------------------------
//
// What the API answers `unavailable`, per family (`unavailableMetrics`, kept
// exact by apps/api/src/test/ws11-mock-drift.test.ts) and per split
// (`unsupportedSplits`): the run carries the same availability entry and no
// number for it, never a mock figure for what the API cannot compute.

const UNAVAILABLE_METRICS: ReadonlySet<string> = new Set([
  ...sales.unavailableMetrics,
  ...trafficOperations.unavailableMetrics,
  ...menuCogs.unavailableMetrics,
  ...paymentsTax.unavailableMetrics,
  ...inventoryPurchasing.unavailableMetrics,
  ...finance.unavailableMetrics,
  ...loyaltyCrm.unavailableMetrics,
  ...reservationDelivery.unavailableMetrics,
  ...hr.unavailableMetrics,
  ...facility.unavailableMetrics,
]);

const UNSUPPORTED_SPLITS: Readonly<Record<string, readonly string[]>> =
  paymentsTax.unsupportedSplits;

export function availabilityOf(
  metricCode: string,
  groupBy: string | null,
): MetricAvailability {
  const reason: MetricUnavailableReason | null = UNAVAILABLE_METRICS.has(
    metricCode,
  )
    ? "source_not_built"
    : groupBy !== null && UNSUPPORTED_SPLITS[metricCode]?.includes(groupBy)
      ? "dimension_not_supported"
      : null;
  return reason === null
    ? { metricCode, status: "available" }
    : {
        metricCode,
        status: "unavailable",
        reason,
        message: METRIC_UNAVAILABLE_MESSAGES[reason],
      };
}

function metricRef(code: string) {
  const definition = reportMetricByCode.get(code);
  if (definition === undefined)
    throw new Error(`No registry row for report metric ${code}`);
  return metricDefinitionRefSchema.parse({
    id: definition.id,
    code: definition.code,
    version: definition.version,
    name:
      code === "active_members"
        ? `${definition.name} (saat ini)`
        : definition.name,
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
  bucketStart: string;
  bucketEnd: string;
  dimensions: { key: string; value: string }[];
  values: { metricCode: string; value: Cell; finality: "final" | "estimate" }[];
};

function buildRun(
  report: ReportDefinition,
  groupBy: string | null,
  range: DateRange,
): ReportResult | null {
  const totals = periodFigures(range);
  const closed = range.endDate < BUSINESS_DATE;
  const accountingClosed = closed && range.endDate < MONTH_START;
  const refs = report.metrics.map(metricRef);
  const availability = report.metrics.map((metricCode) =>
    availabilityOf(metricCode, groupBy),
  );
  const unavailable = new Set(
    availability
      .filter((entry) => entry.status === "unavailable")
      .map((entry) => entry.metricCode),
  );

  function row(
    dims: readonly (readonly [string, string])[],
    atoms: Figures,
  ): LooseRow {
    return {
      bucketStart: range.startDate,
      bucketEnd: range.endDate,
      dimensions: dims.map(([key, value]) => ({ key, value })),
      values: refs.map((ref) => {
        const value = unavailable.has(ref.code)
          ? null
          : cellFor(ref.code, atoms, totals);
        // SH-02: final only for a closed period, and for closed-period-only
        // figures only once the books of that period are closed.
        const official =
          ref.code !== "active_members" &&
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
    const columns = Object.fromEntries(
      FIGURE_KEYS.map((key) => [
        key,
        distribute(totals[key], weightsFor(key, spec)),
      ]),
    ) as Record<FigureKey, number[]>;
    rows = spec.values.map((value, index) =>
      row(
        [[groupBy, value]],
        Object.fromEntries(
          FIGURE_KEYS.map((key) => [key, columns[key][index] ?? 0]),
        ) as Figures,
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
    bucket: "total",
    outletFilter: { kind: "outlets", outletIds: [outlet.id] },
    definitions: refs,
    availability,
    groupBy: groupBy === null ? [] : [groupBy],
    rows,
    generatedAt: "2026-11-01T04:40:00.000Z",
    rowLimit: 100,
    truncated: false,
  } as unknown as ReportResult;
}

// ---- Run registration --------------------------------------------------------

/**
 * Reports this feature serves runs for: the sales family, batch A (menu,
 * payments, tax, inventory, cogs, purchasing) and batch B (finance, loyalty,
 * crm, reservation, attendance, payroll, performance). Each has a route file
 * (); the rest of the catalog adds its own.
 */
const SALES_REPORTS = sales.SALES_REPORTS;

const SERVED_REPORTS: readonly string[] = [
  ...SALES_REPORTS,
  ...menuCogs.reportsByPrefix.menu,
  ...paymentsTax.reportsByPrefix.payments,
  ...paymentsTax.reportsByPrefix.tax,
  ...inventoryPurchasing.reportsByPrefix.inventory,
  ...menuCogs.reportsByPrefix.cogs,
  ...inventoryPurchasing.reportsByPrefix.purchasing,
  ...finance.reportsByPrefix.finance,
  ...loyaltyCrm.reportsByPrefix.loyalty,
  ...loyaltyCrm.reportsByPrefix.crm,
  ...reservationDelivery.reportsByPrefix.reservation,
  ...reservationDelivery.reportsByPrefix.delivery,
  ...hr.reportsByPrefix.attendance,
  ...hr.reportsByPrefix.payroll,
  ...hr.reportsByPrefix.performance,
  ...trafficOperations.reportsByPrefix.traffic,
  ...trafficOperations.reportsByPrefix.operations,
];

/**
 * One run per report, split, period and outlet scope: two outlets are two
 * questions (legend-3nuv), so a run another owner serves for one outlet never
 * hides this feature's run for another.
 */
export function runKey(result: ReportResult): string {
  const outlets =
    result.outletFilter.kind === "outlets"
      ? [...result.outletFilter.outletIds].sort().join(",")
      : "*";
  return `${result.reportCode}|${result.groupBy.join(",")}|${result.period.startDate}|${result.period.endDate}|${outlets}`;
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

function buildRuns(codes: readonly string[]): ReportResult[] {
  const runs: ReportResult[] = [];
  for (const code of codes) {
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

/**
 * The sales runs; the report builder's previews know exactly these metrics
 * and tests compare them run by run (DASH-02).
 */
export function buildSalesRuns(): ReportResult[] {
  return buildRuns(SALES_REPORTS);
}

/** Every run this feature serves: sales plus batch A and B. */
export function buildReportRuns(): ReportResult[] {
  return buildRuns(SERVED_REPORTS);
}

// A run another screen registered first (the owner insights, the facility
// report) stays theirs, like the owner board's and the management KPIs' runs.
registerMockReportRuns(
  Object.fromEntries(
    buildReportRuns()
      .filter(
        (run) =>
          run.reportCode !== null &&
          !hasMockReportRun(
            run.reportCode,
            run.groupBy,
            run.period,
            run.outletFilter.kind === "outlets"
              ? run.outletFilter.outletIds
              : undefined,
          ),
      )
      .map((run) => [runKey(run), run]),
  ),
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

/** Permissions of the mock session's user (the owner, ws01-auth mock). */
const MOCK_CALLER_PERMISSIONS: ReadonlySet<string> = new Set(
  roleTemplate("owner").permissions,
);

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
  // DASH-04: the same gate the service runs. The mock session is the owner
  // (ws01-auth mock), so the caller holds the owner template's permissions;
  // a new job has no approval yet. Personal data is derived from the report
  // and the split here, never from anything the client sends.
  const gate = reportExportGate({
    report,
    query: body.query,
    format: body.format,
    permissions: MOCK_CALLER_PERMISSIONS,
    approval: "none",
  });
  if (gate.action === "reject")
    throw new ApiError(
      reportErrorHttpStatus[gate.code],
      gate.code,
      gate.code === "EXPORT_FORMAT_NOT_SUPPORTED"
        ? "Format ekspor ini tidak tersedia."
        : "Role Anda tidak memiliki izin untuk ekspor ini.",
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
    personal: gate.action === "request_approval",
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
