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
// with the dashboards (I1/I4). The report builder's previews only
// know the sales metrics; the other families show "no data" there.
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
import { metricDefinitionRefSchema } from "@starter/shared/metrics";
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

const outlet = cafeLegendFixtures.outlets[0];

// ---- Day model ---------------------------------------------------------------
//
// `mock-day-model.ts` owns the atoms, weekday factors, closed-month scaling and
// split weights; only the outlet label is this feature's own (rows show the
// name, while the builder's query carries the id).

// Splits the shared model does not know (supplier, station, zone, member tier);
// net sales is the fallback weight of every figure.
const EXTRA_SPLITS: Readonly<Record<string, SplitSpec>> = {
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

type DerivedSpec = {
  from: AtomKey;
  ratio?: number;
  /** Amount on the open business day; scaled by weekday for other days. */
  snapshot?: number;
};

const DERIVED = {
  // Cost and profit lines of the day.
  cogs: { from: "net", ratio: 0.34 },
  labor: { from: "net", ratio: 0.27 },
  opex: { from: "net", ratio: 0.22 },
  below: { from: "net", ratio: 0.04 },
  // Tax, fees and settlement.
  tax: { from: "net", ratio: 0.1 },
  service: { from: "net", ratio: 0.05 },
  fee: { from: "net", ratio: 0.007 },
  edc: { from: "net", ratio: 0.15 },
  gateway: { from: "net", ratio: 0.55 },
  cashVariance: { from: "net", ratio: 25_000 / 7_420_000 },
  promo: { from: "discount", ratio: 0.55 },
  // Purchasing and stock.
  // Purchases of a business day are about a third of its net sales; 1 Nov is
  // Rp2.597.000, the management KPI strip's figure (I4).
  purchase: { from: "net", ratio: 0.35 },
  waste: { from: "net", ratio: 0.02 },
  // Counts of the day.
  newMembers: { from: "pax", ratio: 24 / 148 },
  returning: { from: "pax", ratio: 0.46 },
  reviews: { from: "tx", ratio: 0.1 },
  points: { from: "tx", ratio: 35 },
  bookings: { from: "tx", ratio: 0.2 },
  noShows: { from: "tx", ratio: 0.02 },
  late: { from: "tx", ratio: 3 / 96 },
  overtimeTenths: { from: "tx", ratio: 65 / 96 },
  failedPayments: { from: "tx", ratio: 0.03 },
  failedItems: { from: "tx", ratio: 3 / 96 },
  remakes: { from: "tx", ratio: 4 / 96 },
  comps: { from: "tx", ratio: 2 / 96 },
  // Balances on the last day of the period (the management KPI strip's day).
  cash: { from: "net", snapshot: 8_250_000 },
  bank: { from: "net", snapshot: 96_500_000 },
  pendingSettlement: { from: "net", snapshot: 2_915_000 },
  supplierDue: { from: "net", snapshot: 12_400_000 },
  stockValue: { from: "net", snapshot: 18_900_000 },
  members: { from: "pax", snapshot: 1_320 },
  criticalStock: { from: "net", snapshot: 4 },
  soldOut: { from: "net", snapshot: 3 },
  queue: { from: "net", snapshot: 12 },
} as const satisfies Record<string, DerivedSpec>;

type DerivedKey = keyof typeof DERIVED;
const DERIVED_KEYS = Object.keys(DERIVED) as DerivedKey[];
type Figures = Atoms & Record<DerivedKey, number>;
type FigureKey = AtomKey | DerivedKey;
const FIGURE_KEYS: readonly FigureKey[] = [...ATOM_KEYS, ...DERIVED_KEYS];

/** Weights of one figure in a split: its source atom's, else net sales. */
function weightsFor(key: FigureKey, spec: SplitSpec): readonly number[] {
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
        ? Math.round(spec.snapshot * dayFactor(range.endDate))
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

function decimal4(numerator: number, denominator: number): string {
  return ((numerator * 100) / denominator).toFixed(4);
}

// Plain wire values; the registry and the node test validate them against the
// branded schema, so no brand is faked here.
type Cell = { unit: string; valueIdr?: number; value?: number | string } | null;

/** Mock-only averages: nothing in the day model moves them. */
const AVERAGE_SERVING_SECONDS = 780;
const AVERAGE_REVIEW_RATING = "4.6000";
const CHECKLIST_COMPLIANCE_PCT = "87.5000";

function cellFor(metricCode: string, atoms: Figures, totals: Figures): Cell {
  const ratio = (num: number, den: number) =>
    den === 0 ? null : { unit: "percent" as const, value: decimal4(num, den) };
  const idr = (valueIdr: number) => ({ unit: "idr" as const, valueIdr });
  const count = (value: number) => ({ unit: "count" as const, value });
  const grossProfit = atoms.net - atoms.cogs;
  const ebitda = grossProfit - atoms.labor - atoms.opex;
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
    // Cost, profit and payroll: net sales less the day's cost lines.
    case "cogs":
      return idr(atoms.cogs);
    case "menu_gross_margin":
    case "gross_profit":
      return idr(grossProfit);
    case "ebitda":
      return idr(ebitda);
    case "net_profit":
      return idr(ebitda - atoms.below);
    case "gross_payroll":
      return idr(atoms.labor);
    case "food_cost_pct":
      return ratio(atoms.cogs, atoms.net);
    case "gross_margin_pct":
      return ratio(grossProfit, atoms.net);
    case "labor_cost_pct":
      return ratio(atoms.labor, atoms.net);
    case "prime_cost_pct":
      return ratio(atoms.cogs + atoms.labor, atoms.net);
    // Tax, payments and settlement.
    case "tax_collected":
    case "tax_payable":
      return idr(atoms.tax);
    case "service_charge_collected":
      return idr(atoms.service);
    case "payment_fee":
      return idr(atoms.fee);
    case "edc_settlement":
      return idr(atoms.edc);
    case "gateway_settlement":
      return idr(atoms.gateway);
    case "cash_variance":
      return idr(atoms.cashVariance);
    case "failed_payment_count":
      return count(atoms.failedPayments);
    case "pending_settlement":
      return idr(atoms.pendingSettlement);
    case "promo_cost":
      return idr(atoms.promo);
    // Purchasing, stock and balances.
    case "purchase_total":
      return idr(atoms.purchase);
    case "supplier_due":
      return idr(atoms.supplierDue);
    case "stock_value":
      return idr(atoms.stockValue);
    case "waste_cost":
      return idr(atoms.waste);
    case "waste_cost_pct":
      return ratio(atoms.waste, atoms.net);
    case "critical_stock_count":
      return count(atoms.criticalStock);
    case "sold_out_menu_count":
      return count(atoms.soldOut);
    case "cash_balance":
      return idr(atoms.cash);
    case "bank_balance":
      return idr(atoms.bank);
    case "menu_popularity_pct":
      return ratio(atoms.qty, totals.qty);
    // Members, reservations, staff and service.
    case "new_customers":
      return count(atoms.newMembers);
    case "active_members":
      return count(atoms.members);
    case "returning_customers":
      return count(atoms.returning);
    case "review_count":
      return count(atoms.reviews);
    case "review_rating":
      return { unit: "decimal", value: AVERAGE_REVIEW_RATING };
    case "points_redeemed":
      return count(atoms.points);
    case "reservation_count":
      return count(atoms.bookings);
    case "no_show_reservations":
      return count(atoms.noShows);
    case "reservation_no_show_pct":
      return ratio(atoms.noShows, atoms.bookings);
    case "attendance_late_count":
      return count(atoms.late);
    case "overtime_hours":
      return { unit: "decimal", value: (atoms.overtimeTenths / 10).toFixed(4) };
    case "failed_item_count":
      return count(atoms.failedItems);
    case "remake_count":
      return count(atoms.remakes);
    case "comp_count":
      return count(atoms.comps);
    case "order_queue_count":
      return count(atoms.queue);
    case "avg_serving_time":
      return { unit: "seconds", value: AVERAGE_SERVING_SECONDS };
    case "checklist_compliance_pct":
      return { unit: "percent", value: CHECKLIST_COMPLIANCE_PCT };
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
  const totals = periodFigures(range);
  const closed = range.endDate < BUSINESS_DATE;
  const accountingClosed = closed && range.endDate < MONTH_START;
  const refs = report.metrics.map(metricRef);

  function row(
    dims: readonly (readonly [string, string])[],
    atoms: Figures,
  ): LooseRow {
    return {
      dimensions: dims.map(([key, value]) => ({ key, value })),
      values: refs.map((ref) => {
        const value = cellFor(ref.code, atoms, totals);
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
    outletFilter: { kind: "outlets", outletIds: [outlet.id] },
    definitions: refs,
    groupBy: groupBy === null ? [] : [groupBy],
    rows,
    generatedAt: "2026-11-01T04:40:00.000Z",
    rowLimit: 100,
  } as unknown as ReportResult;
}

// ---- Run registration --------------------------------------------------------

/**
 * Reports this feature serves runs for: the sales family, batch A (menu,
 * payments, tax, inventory, cogs, purchasing) and batch B (finance, loyalty,
 * crm, reservation, attendance, payroll, performance). Each has a route file
 * (); the rest of the catalog adds its own.
 */
const SALES_REPORTS = [
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

const SERVED_REPORTS: readonly string[] = [
  ...SALES_REPORTS,
  "menu.best_sellers",
  "menu.category_sales",
  "menu.engineering",
  "menu.margin",
  "menu.recipe_cost",
  "menu.slow_movers",
  "menu.sold_out",
  "payments.cash_variance",
  "payments.edc_settlement",
  "payments.failed",
  "payments.fees",
  "payments.gateway_settlement",
  "payments.methods",
  "tax.by_rule",
  "tax.pbjt",
  "tax.receivable",
  "tax.service_charge",
  "inventory.critical_stock",
  "inventory.food_cost",
  "inventory.movement",
  "inventory.stock_usage",
  "inventory.stock_value",
  "inventory.waste",
  "inventory.waste_by_category",
  "cogs.per_menu",
  "cogs.production",
  "cogs.recipe",
  "cogs.trend",
  "purchasing.orders",
  "purchasing.price_history",
  "purchasing.receipts",
  "purchasing.requests",
  "purchasing.supplier_due",
  "finance.cash_position",
  "finance.ebitda",
  "finance.gross_margin",
  "finance.income_statement",
  "finance.pending_settlement",
  "finance.prime_cost",
  "finance.profit_trend",
  "finance.supplier_due",
  "loyalty.members",
  "loyalty.new_members",
  "loyalty.points",
  "loyalty.tier_mix",
  "loyalty.visits",
  "crm.campaign_performance",
  "crm.customers",
  "crm.promo_cost",
  "crm.repeat_visit",
  "crm.reviews",
  "crm.segments",
  "reservation.bookings",
  "reservation.by_zone",
  "reservation.no_show",
  "reservation.peak_hours",
  "attendance.by_station",
  "attendance.daily",
  "attendance.late",
  "attendance.overtime",
  "payroll.cost_trend",
  "payroll.gross",
  "payroll.labor_cost",
  "payroll.overtime",
  "performance.checklist",
  "performance.employee",
  "performance.service_quality",
  "performance.station",
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
