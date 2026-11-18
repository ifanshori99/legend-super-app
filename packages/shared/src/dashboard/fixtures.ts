// Cafe Legend mock data for the dashboard & report contract (FE mock mode +
// contract tests). Report tiles, catalog pages, runs, saved reports, schedules
// and export jobs use the fixed Cafe Legend tenant/outlet ids from
// `@starter/shared/core` so fixtures across contracts line up, and the metric
// references are the registry rows from `@starter/shared/metrics` plus this
// domain's own catalog.

import { fixtureTimeAfter } from "../core/fixture-clock.ts";
import {
  apiErrorBody,
  cafeLegendFixtures,
  encodeCursor,
} from "../core/index.ts";
import type { z } from "../core/index.ts";
import { eventEnvelopeSchema } from "../events/index.ts";
import {
  cafeLegendMetricDefinitions,
  METRIC_UNAVAILABLE_MESSAGES,
  metricDefinitionRefSchema,
  metricPeriodSchema,
  metricQueryPeriodSchema,
} from "../metrics/index.ts";
import type { MetricDefinitionRef } from "../metrics/index.ts";
import { reportCatalog, reportByCode } from "./catalog.ts";
import { reportMetricByCode } from "./metric-catalog.ts";
import { reportCatalogPageSchema } from "./reports.ts";
import type { ReportDefinition } from "./reports.ts";
import {
  createSavedReportInputSchema,
  reportBuilderQuerySchema,
  reportResultSchema,
  reportScheduleSchema,
  savedReportSchema,
} from "./builder.ts";
import type { ReportResult } from "./builder.ts";
import {
  createReportExportInputSchema,
  reportExportSchema,
} from "./exports.ts";
import {
  dashboardLayoutSchema,
  MANAGEMENT_DASHBOARD_TILES,
  OWNER_DASHBOARD_TILES,
} from "./dashboards.ts";

const tenant = cafeLegendFixtures.tenant;
const outlet = cafeLegendFixtures.outlets[0];

/** 11:40 WIB on the fixture business day; the kitchen board uses the same day. */
export const ownerBoardGeneratedAt = "2026-11-01T04:40:00.000Z";
const userId = "9b3f0f2e-2f5a-4d6c-8e44-2a1d7c9b0e11";

const metricRefByCode = new Map<string, MetricDefinitionRef>(
  cafeLegendMetricDefinitions.map((definition) => [
    definition.code,
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
  ]),
);

function metricRef(code: string): MetricDefinitionRef {
  const base = metricRefByCode.get(code);
  if (base !== undefined) return base;
  // Codes this contract adds (DASH-01) live in the full registry.
  const definition = reportMetricByCode.get(code);
  if (definition === undefined)
    throw new Error(`No metric fixture for ${code}`);
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

function reportFixture(code: string): ReportDefinition {
  const report = reportCatalog.find((entry) => entry.code === code);
  if (report === undefined) throw new Error(`No report fixture for ${code}`);
  return report;
}

export const cafeLegendDashboardFixtures = {
  ownerLayout: dashboardLayoutSchema.parse({
    dashboard: "owner",
    title: "Dashboard Owner",
    businessDate: "2026-11-01",
    availableOutlets: [outlet.id],
    tiles: OWNER_DASHBOARD_TILES,
    // Same fixture instant as the owner board report runs, so the header's
    // "Diperbarui" line and the business date describe one moment.
    generatedAt: ownerBoardGeneratedAt,
    monitoringPeriod: {
      startDate: "2026-11-01",
      endDate: "2026-11-01",
      bucket: "day",
      status: "open",
      accountingPeriodClosed: false,
    },
  }),
  businessDate: "2026-11-01",
};

/**
 * Management home layout (PRD §3.36 "Beranda per Role", bead legend-6na6): the
 * whole management tile catalog for one Cafe Legend outlet. The BE dashboard
 * API (legend-1ye3) resolves this per caller role and outlet scope; mock mode
 * serves it as-is so every role's composed home can be reviewed, and the web
 * kit narrows it per role with `dashboardTilesFor`.
 */
export const cafeLegendManagementLayoutFixture = dashboardLayoutSchema.parse({
  dashboard: "management",
  title: "Dashboard Manajemen",
  businessDate: "2026-11-01",
  availableOutlets: [outlet.id],
  tiles: MANAGEMENT_DASHBOARD_TILES,
  // Same instant as the owner board: both describe 1 Nov at 11:40 WIB.
  generatedAt: ownerBoardGeneratedAt,
  monitoringPeriod: {
    startDate: "2026-11-01",
    endDate: "2026-11-01",
    bucket: "day",
    status: "open",
    accountingPeriodClosed: false,
  },
});

/**
 * Metrics of the owner board and the role KPI runs that the API answers `unavailable` / `source_not_built` (the metric
 * registry, apps/api/src/services/metric-sources): those runs show no
 * number for them. apps/api/src/test/ws11-mock-drift.test.ts reads the
 * registry and fails when this list drifts from it.
 */
const OWNER_BOARD_UNAVAILABLE: ReadonlySet<string> = new Set([
  "avg_spend_per_pax",
  "table_occupancy_pct",
  "sold_out_menu_count",
  "shower_revenue",
  "active_subscriptions",
  "shower_fnb_conversion_pct",
  "shower_sessions_with_fnb",
  "wifi_quota_used",
  "wifi_sessions",
]);

/** One total row for a role KPI report (DASH-02: the tile runs this report). */
function kpiRun(
  reportCode: string,
  period: { readonly startDate: string; readonly endDate: string },
  cells: readonly {
    readonly metricCode: string;
    readonly value: unknown;
  }[],
): ReportResult {
  return reportResultSchema.parse({
    reportCode,
    period: {
      startDate: period.startDate,
      endDate: period.endDate,
      bucket: "total",
      status: "open",
      accountingPeriodClosed: false,
    },
    bucket: "total",
    outletFilter: { kind: "outlets", outletIds: [outlet.id] },
    definitions: cells.map((cell) => metricRef(cell.metricCode)),
    availability: cells.map((cell) =>
      OWNER_BOARD_UNAVAILABLE.has(cell.metricCode)
        ? {
            metricCode: cell.metricCode,
            status: "unavailable",
            reason: "source_not_built",
            message: METRIC_UNAVAILABLE_MESSAGES.source_not_built,
          }
        : { metricCode: cell.metricCode, status: "available" },
    ),
    groupBy: [],
    rows: [
      {
        bucketStart: period.startDate,
        bucketEnd: period.endDate,
        dimensions: [],
        values: cells.map((cell) => ({
          metricCode: cell.metricCode,
          value: OWNER_BOARD_UNAVAILABLE.has(cell.metricCode)
            ? null
            : cell.value,
          // The fixture period is open: every figure is an estimate (SH-02).
          finality: "estimate",
        })),
      },
    ],
    generatedAt: ownerBoardGeneratedAt,
    rowLimit: 100,
    truncated: false,
  });
}

/** The business day the management home fixture describes. */
const managementDayPeriod = {
  startDate: "2026-11-01",
  endDate: "2026-11-01",
} as const;

/**
 * Role KPI runs of the management home (PRD §3.36 "Beranda per Role", bead
 * legend-6na6). Each role's KPI tile cites one source report; running that
 * report for the same period, outlets and (unsplit) total is the number the
 * tile shows, so the tile and its drill-down can never disagree (DASH-02).
 * Purchasing's tile is a month-to-date figure (catalog period `this_month`).
 */
export const managementDashboardKpiRuns: Readonly<
  Record<string, ReportResult>
> = Object.freeze({
  "sales.per_channel": kpiRun("sales.per_channel", managementDayPeriod, [
    { metricCode: "net_sales", value: { unit: "idr", valueIdr: 7_420_000 } },
    { metricCode: "pax", value: { unit: "count", value: 148 } },
    { metricCode: "transaction_count", value: { unit: "count", value: 96 } },
  ]),
  "operations.table_turnover": kpiRun(
    "operations.table_turnover",
    managementDayPeriod,
    [
      {
        // Same unsplit run, period and outlet as the owner board's
        // operations.table_turnover, so the two dashboards agree (DASH-02).
        metricCode: "table_occupancy_pct",
        value: { unit: "percent", value: "62.5000" },
      },
      {
        metricCode: "table_turnover",
        value: { unit: "decimal", value: "1.8400" },
      },
    ],
  ),
  "operations.kitchen_queue": kpiRun(
    "operations.kitchen_queue",
    managementDayPeriod,
    [
      {
        metricCode: "avg_serving_time",
        value: { unit: "seconds", value: 780 },
      },
      { metricCode: "order_queue_count", value: { unit: "count", value: 12 } },
    ],
  ),
  "purchasing.supplier_due": kpiRun(
    "purchasing.supplier_due",
    managementDayPeriod,
    [
      {
        metricCode: "supplier_due",
        value: { unit: "idr", valueIdr: 12_400_000 },
      },
      {
        metricCode: "purchase_total",
        // One business day: 35% of the day's net sales (7.420.000), the same
        // figure the report viewer's purchasing reports give for 1 Nov.
        value: { unit: "idr", valueIdr: 2_597_000 },
      },
    ],
  ),
  "finance.cash_position": kpiRun(
    "finance.cash_position",
    managementDayPeriod,
    [
      {
        metricCode: "cash_balance",
        value: { unit: "idr", valueIdr: 8_250_000 },
      },
      {
        metricCode: "bank_balance",
        value: { unit: "idr", valueIdr: 96_500_000 },
      },
    ],
  ),
  "attendance.by_station": kpiRun(
    "attendance.by_station",
    managementDayPeriod,
    [
      {
        metricCode: "attendance_late_count",
        value: { unit: "count", value: 3 },
      },
      {
        metricCode: "overtime_hours",
        value: { unit: "decimal", value: "6.5000" },
      },
    ],
  ),
  "loyalty.members": kpiRun("loyalty.members", managementDayPeriod, [
    { metricCode: "new_customers", value: { unit: "count", value: 24 } },
    { metricCode: "active_members", value: { unit: "count", value: 1_320 } },
  ]),
});

export const reportCatalogPageFixture = reportCatalogPageSchema.parse({
  data: reportCatalog.slice(0, 5),
  meta: {
    limit: 25,
    nextCursor: encodeCursor([reportCatalog[4].code]),
  },
});

export const reportDefinitionFixture = reportFixture("sales.daily");

export const reportQueryPeriodFixture = metricQueryPeriodSchema.parse({
  startDate: "2026-10-01",
  endDate: "2026-10-31",
});

export const reportRunResultFixture = reportResultSchema.parse({
  reportCode: "sales.daily",
  period: metricPeriodSchema.parse({
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    bucket: "total",
    status: "closed",
    accountingPeriodClosed: true,
  }),
  bucket: "total",
  outletFilter: { kind: "outlets", outletIds: [outlet.id] },
  definitions: [metricRef("net_sales"), metricRef("transaction_count")],
  availability: [
    { metricCode: "net_sales", status: "available" },
    { metricCode: "transaction_count", status: "available" },
  ],
  groupBy: ["channel"],
  rows: [
    {
      bucketStart: "2026-10-01",
      bucketEnd: "2026-10-31",
      dimensions: [{ key: "channel", value: "qr" }],
      values: [
        {
          metricCode: "net_sales",
          value: { unit: "idr", valueIdr: 230_878_706 },
          finality: "final",
        },
        {
          metricCode: "transaction_count",
          value: { unit: "count", value: 2_893 },
          finality: "final",
        },
      ],
    },
    {
      bucketStart: "2026-10-01",
      bucketEnd: "2026-10-31",
      dimensions: [{ key: "channel", value: "pos" }],
      values: [
        {
          metricCode: "net_sales",
          value: { unit: "idr", valueIdr: 110_154_178 },
          finality: "final",
        },
        {
          metricCode: "transaction_count",
          value: { unit: "count", value: 1_558 },
          finality: "final",
        },
      ],
    },
    {
      bucketStart: "2026-10-01",
      bucketEnd: "2026-10-31",
      dimensions: [{ key: "channel", value: "gofood" }],
      values: [
        {
          metricCode: "net_sales",
          value: { unit: "idr", valueIdr: 43_394_070 },
          finality: "final",
        },
        {
          metricCode: "transaction_count",
          value: { unit: "count", value: 556 },
          finality: "final",
        },
      ],
    },
    {
      bucketStart: "2026-10-01",
      bucketEnd: "2026-10-31",
      dimensions: [{ key: "channel", value: "grabfood" }],
      values: [
        {
          metricCode: "net_sales",
          value: { unit: "idr", valueIdr: 28_373_046 },
          finality: "final",
        },
        {
          metricCode: "transaction_count",
          value: { unit: "count", value: 334 },
          finality: "final",
        },
      ],
    },
  ],
  generatedAt: "2026-11-01T22:46:00.000Z",
  rowLimit: 100,
  truncated: false,
});

export const reportBuilderQueryFixture = reportBuilderQuerySchema.parse({
  metricCodes: ["net_sales", "pax"],
  period: { startDate: "2026-10-01", endDate: "2026-10-31" },
  outletIds: [outlet.id],
  groupBy: ["hour"],
  filters: [{ key: "channel", values: ["qr", "pos"] }],
  bucket: "day",
  sort: { column: "net_sales", direction: "desc" },
  limit: 100,
});

export const savedReportIdFixture = "5eab8043-6f7d-4c9b-8d53-8a9f0e1b2c34";
export const reportScheduleIdFixture = "4d9a7f32-5e6c-4b8a-9c42-7f8e9d0a1b23";
export const reportExportPendingIdFixture =
  "2b7e5d10-3c4a-4f68-9a20-5d6c7b8e9f01";
export const reportExportReadyIdFixture =
  "3c8f6e21-4d5b-4a79-8b31-6e7d8c9f0a12";

export const createSavedReportInputFixture = createSavedReportInputSchema.parse(
  {
    name: "Omzet per jam",
    description: "Omzet dan tamu per jam untuk evaluasi jam ramai.",
    query: reportBuilderQueryFixture,
  },
);

export const savedReportFixture = savedReportSchema.parse({
  id: savedReportIdFixture,
  tenantId: tenant.id,
  name: "Omzet per jam",
  description: "Omzet dan tamu per jam untuk evaluasi jam ramai.",
  query: reportBuilderQueryFixture,
  ownerUserId: userId,
  status: "active",
  lastRunAt: null,
  createdAt: "2026-10-25T02:00:00.000Z",
  updatedAt: "2026-10-25T02:00:00.000Z",
});

export const reportScheduleFixture = reportScheduleSchema.parse({
  id: reportScheduleIdFixture,
  tenantId: tenant.id,
  savedReportId: savedReportIdFixture,
  frequency: "weekly",
  timeOfDay: "07:30",
  dayOfWeek: 1,
  dayOfMonth: null,
  format: "pdf",
  recipientUserIds: [userId],
  isEnabled: true,
  nextRunAt: "2026-11-09T00:30:00.000Z",
  lastRunAt: null,
  createdAt: "2026-10-25T02:05:00.000Z",
  updatedAt: "2026-10-25T02:05:00.000Z",
});

/** DASH-04: a personal-data export waits for approval; no file exists yet. */
export const reportExportPendingApprovalFixture = reportExportSchema.parse({
  id: reportExportPendingIdFixture,
  tenantId: tenant.id,
  reportCode: "crm.customers",
  savedReportId: null,
  format: "xlsx",
  query: {
    period: { startDate: "2026-10-01", endDate: "2026-10-31" },
    outletIds: [outlet.id],
    groupBy: ["customer_tier"],
    filters: [],
    bucket: "total",
  },
  containsPersonalData: true,
  approvalRequestId: null,
  status: "pending_approval",
  requestedBy: userId,
  requestedAt: "2026-11-01T22:48:00.000Z",
  startedAt: null,
  completedAt: null,
  file: null,
  errorCode: null,
});

export const reportExportReadyFixture = reportExportSchema.parse({
  id: reportExportReadyIdFixture,
  tenantId: tenant.id,
  reportCode: "sales.daily",
  savedReportId: null,
  format: "csv",
  query: {
    period: { startDate: "2026-10-01", endDate: "2026-10-31" },
    outletIds: [outlet.id],
    groupBy: ["channel"],
    filters: [],
    bucket: "total",
  },
  containsPersonalData: false,
  approvalRequestId: null,
  status: "ready",
  requestedBy: userId,
  requestedAt: "2026-11-01T22:47:00.000Z",
  startedAt: "2026-11-01T22:47:05.000Z",
  completedAt: "2026-11-01T22:47:09.000Z",
  file: {
    downloadPath: `/api/reports/exports/${reportExportReadyIdFixture}/file`,
    sizeBytes: 18_432,
    rowCount: 24,
    expiresAt: fixtureTimeAfter(
      { days: 7, hours: 18, minutes: 7, seconds: 9 },
      ownerBoardGeneratedAt,
    ),
  },
  errorCode: null,
});

export const createReportExportInputFixture =
  createReportExportInputSchema.parse({
    reportCode: "sales.daily",
    format: "csv",
    query: {
      period: { startDate: "2026-10-01", endDate: "2026-10-31" },
      outletIds: [outlet.id],
      groupBy: ["channel"],
      filters: [],
      bucket: "total",
    },
  });

export const reportGeneratedEventFixture = {
  id: "01JBQ7Z8K0A1B2C3D4E5F6G7HB",
  tenantId: tenant.id,
  outletId: outlet.id,
  name: "report.generated",
  version: 1,
  aggregateType: "report",
  aggregateId: "6f1d2c3b-4a59-4e8f-9d70-1b2c3d4e5f60",
  sequence: 1,
  occurredAt: "2026-11-01T22:47:09.000Z",
  actor: { type: "user", id: userId },
  idempotencyKey: "report-export-2026-10-31-bdg-01",
  payloadSchemaRef: "report.generated.v1",
  payload: {
    reportCode: "sales.daily",
    trigger: "export",
    format: "csv",
    period: { startDate: "2026-10-01", endDate: "2026-10-31" },
    outletIds: [outlet.id],
    rowCount: 24,
    containsPersonalData: false,
    finality: "final",
    savedReportId: null,
    exportId: reportExportReadyIdFixture,
    durationMs: 4_120,
  },
} satisfies z.input<typeof eventEnvelopeSchema>;

export const dashboardErrorFixtures = {
  reportNotFound: apiErrorBody(
    "REPORT_NOT_FOUND",
    "Laporan tidak ditemukan di katalog.",
  ),
  reportNotPermitted: apiErrorBody(
    "REPORT_NOT_PERMITTED",
    "Role Anda tidak memiliki izin untuk laporan ini.",
  ),
  piiApprovalRequired: apiErrorBody(
    "EXPORT_PII_APPROVAL_REQUIRED",
    "Ekspor data pribadi memerlukan approval (DASH-04).",
  ),
  exportNotReady: apiErrorBody(
    "EXPORT_NOT_READY",
    "File ekspor belum selesai dibuat.",
  ),
};

// ---- Owner dashboard part 1 (bead legend-k8fk) ------------------------------
//
// One run result per report the owner dashboard's part-1 sections cite (PRD
// §3 F34 Ringkasan Real-time, Operasional, Shower Room, Kursi & WFC). Every
// row is the report's own metric set, so a tile and its source report read the
// same numbers (DASH-02). 1 November 2026 is the open business day in the
// fixture calendar, so every value is an estimate (SH-02).

const ownerBoardPeriod = metricPeriodSchema.parse({
  startDate: "2026-11-01",
  endDate: "2026-11-01",
  bucket: "total",
  status: "open",
  accountingPeriodClosed: false,
});

type OwnerBoardCell =
  | { unit: "idr"; valueIdr: number }
  | { unit: "count"; value: number }
  | { unit: "seconds"; value: number }
  | { unit: "percent"; value: string }
  | { unit: "decimal"; value: string };

type OwnerBoardRowSeed = {
  dims?: ReadonlyArray<readonly [string, string]>;
  values: Readonly<Record<string, OwnerBoardCell>>;
};

function ownerBoardMetricRef(code: string): MetricDefinitionRef {
  const definition = reportMetricByCode.get(code);
  if (definition === undefined)
    throw new Error(`No registry row for owner board metric ${code}`);
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

function ownerBoardRun(
  code: string,
  groupBy: readonly string[],
  rows: readonly OwnerBoardRowSeed[],
): ReportResult {
  const report = reportByCode(code);
  if (report === undefined)
    throw new Error(`No report catalog entry for owner board ${code}`);
  return reportResultSchema.parse({
    reportCode: code,
    period: ownerBoardPeriod,
    bucket: "total",
    outletFilter: { kind: "outlets", outletIds: [outlet.id] },
    definitions: report.metrics.map(ownerBoardMetricRef),
    availability: report.metrics.map((metricCode) =>
      OWNER_BOARD_UNAVAILABLE.has(metricCode)
        ? {
            metricCode,
            status: "unavailable",
            reason: "source_not_built",
            message: METRIC_UNAVAILABLE_MESSAGES.source_not_built,
          }
        : { metricCode, status: "available" },
    ),
    groupBy,
    rows: rows.map((row) => ({
      bucketStart: ownerBoardPeriod.startDate,
      bucketEnd: ownerBoardPeriod.endDate,
      dimensions: (row.dims ?? []).map(([key, value]) => ({ key, value })),
      values: report.metrics.map((metricCode) => ({
        metricCode,
        value: row.values[metricCode] ?? null,
        finality: "estimate",
      })),
    })),
    generatedAt: ownerBoardGeneratedAt,
    rowLimit: 100,
    truncated: false,
  });
}

/** Run results for the part-1 owner dashboard, keyed by report code. */
export const ownerDashboardBoardRuns: Readonly<Record<string, ReportResult>> =
  Object.freeze({
    // Ringkasan real-time (PRD §3 F34 "Ringkasan Real-time").
    "sales.target": ownerBoardRun(
      "sales.target",
      [],
      [
        {
          values: {
            net_sales: { unit: "idr", valueIdr: 7_420_000 },
            sales_target: { unit: "idr", valueIdr: 24_000_000 },
            target_achievement_pct: { unit: "percent", value: "30.9167" },
          },
        },
      ],
    ),
    "traffic.pax": ownerBoardRun(
      "traffic.pax",
      [],
      [
        {
          values: {
            pax: { unit: "count", value: 148 },
          },
        },
      ],
    ),
    "sales.transactions": ownerBoardRun(
      "sales.transactions",
      [],
      [
        {
          values: {
            transaction_count: { unit: "count", value: 96 },
            avg_ticket: { unit: "idr", valueIdr: 77_292 },
            net_sales: { unit: "idr", valueIdr: 7_420_000 },
          },
        },
      ],
    ),
    "operations.table_turnover": ownerBoardRun(
      "operations.table_turnover",
      [],
      [
        {
          values: {
            table_turnover: { unit: "decimal", value: "1.8400" },
          },
        },
      ],
    ),
    "sales.per_channel": ownerBoardRun(
      "sales.per_channel",
      ["channel"],
      [
        {
          dims: [["channel", "qr"]],
          values: {
            net_sales: { unit: "idr", valueIdr: 4_150_000 },
            transaction_count: { unit: "count", value: 52 },
            pax: { unit: "count", value: 92 },
          },
        },
        {
          dims: [["channel", "pos"]],
          values: {
            net_sales: { unit: "idr", valueIdr: 1_980_000 },
            transaction_count: { unit: "count", value: 28 },
            pax: { unit: "count", value: 34 },
          },
        },
        {
          dims: [["channel", "gofood"]],
          values: {
            net_sales: { unit: "idr", valueIdr: 780_000 },
            transaction_count: { unit: "count", value: 10 },
            pax: { unit: "count", value: 14 },
          },
        },
        {
          dims: [["channel", "grabfood"]],
          values: {
            net_sales: { unit: "idr", valueIdr: 510_000 },
            transaction_count: { unit: "count", value: 6 },
            pax: { unit: "count", value: 8 },
          },
        },
      ],
    ),

    // Operasional (PRD §3 F34 "Operasional").
    "operations.serving_time": ownerBoardRun(
      "operations.serving_time",
      ["station"],
      [
        {
          dims: [["station", "Dapur"]],
          values: { avg_serving_time: { unit: "seconds", value: 718 } },
        },
        {
          dims: [["station", "Kopi"]],
          values: { avg_serving_time: { unit: "seconds", value: 452 } },
        },
        {
          dims: [["station", "Nonkopi"]],
          values: { avg_serving_time: { unit: "seconds", value: 310 } },
        },
        {
          dims: [["station", "Pastry"]],
          values: { avg_serving_time: { unit: "seconds", value: 260 } },
        },
      ],
    ),
    "operations.kitchen_queue": ownerBoardRun(
      "operations.kitchen_queue",
      ["station"],
      [
        {
          dims: [["station", "Dapur"]],
          values: {
            order_queue_count: { unit: "count", value: 6 },
            avg_serving_time: { unit: "seconds", value: 718 },
          },
        },
        {
          dims: [["station", "Kopi"]],
          values: {
            order_queue_count: { unit: "count", value: 3 },
            avg_serving_time: { unit: "seconds", value: 452 },
          },
        },
        {
          dims: [["station", "Nonkopi"]],
          values: {
            order_queue_count: { unit: "count", value: 2 },
            avg_serving_time: { unit: "seconds", value: 310 },
          },
        },
        {
          dims: [["station", "Pastry"]],
          values: {
            order_queue_count: { unit: "count", value: 1 },
            avg_serving_time: { unit: "seconds", value: 260 },
          },
        },
      ],
    ),
    "menu.best_sellers": ownerBoardRun(
      "menu.best_sellers",
      ["menu_item"],
      [
        {
          dims: [["menu_item", "Kopi Susu Aren"]],
          values: {
            menu_sold_qty: { unit: "count", value: 42 },
            net_sales: { unit: "idr", valueIdr: 1_260_000 },
          },
        },
        {
          dims: [["menu_item", "Nasi Goreng Kampung"]],
          values: {
            menu_sold_qty: { unit: "count", value: 31 },
            net_sales: { unit: "idr", valueIdr: 1_085_000 },
          },
        },
        {
          dims: [["menu_item", "Ayam Geprek"]],
          values: {
            menu_sold_qty: { unit: "count", value: 27 },
            net_sales: { unit: "idr", valueIdr: 945_000 },
          },
        },
        {
          dims: [["menu_item", "Matcha Latte"]],
          values: {
            menu_sold_qty: { unit: "count", value: 24 },
            net_sales: { unit: "idr", valueIdr: 720_000 },
          },
        },
        {
          dims: [["menu_item", "Croissant Mentega"]],
          values: {
            menu_sold_qty: { unit: "count", value: 21 },
            net_sales: { unit: "idr", valueIdr: 525_000 },
          },
        },
      ],
    ),
    "menu.sold_out": ownerBoardRun("menu.sold_out", [], [{ values: {} }]),
    "operations.waiter_calls": ownerBoardRun(
      "operations.waiter_calls",
      ["zone"],
      [
        {
          dims: [["zone", "Indoor Reguler"]],
          values: { waiter_call_count: { unit: "count", value: 2 } },
        },
        {
          dims: [["zone", "Taman Outdoor"]],
          values: { waiter_call_count: { unit: "count", value: 1 } },
        },
        {
          dims: [["zone", "WFC Corner"]],
          values: { waiter_call_count: { unit: "count", value: 1 } },
        },
      ],
    ),
    "crm.reviews": ownerBoardRun(
      "crm.reviews",
      [],
      [
        {
          values: {
            review_rating: { unit: "decimal", value: "4.6000" },
            review_count: { unit: "count", value: 10 },
          },
        },
      ],
    ),

    // Shower room (PRD §3 F34 "Shower Room").
    "facility.occupancy": ownerBoardRun(
      "facility.occupancy",
      [],
      [
        {
          values: {
            shower_occupancy_pct: { unit: "percent", value: "56.2500" },
            shower_sessions: { unit: "count", value: 18 },
          },
        },
      ],
    ),
    "facility.revenue": ownerBoardRun(
      "facility.revenue",
      [],
      [
        {
          values: {
            shower_sessions: { unit: "count", value: 18 },
          },
        },
      ],
    ),
    "facility.subscriptions": ownerBoardRun(
      "facility.subscriptions",
      [],
      [
        {
          values: {},
        },
      ],
    ),
    "facility.fnb_conversion": ownerBoardRun(
      "facility.fnb_conversion",
      [],
      [
        {
          values: {},
        },
      ],
    ),

    // Kursi & WFC (PRD §3 F34 "Kursi & WFC").
    "facility.revpash": ownerBoardRun(
      "facility.revpash",
      ["zone"],
      [
        {
          dims: [["zone", "Indoor Reguler"]],
          values: {
            revpash: { unit: "idr", valueIdr: 18500 },
            seat_occupancy_pct: { unit: "percent", value: "68.7500" },
          },
        },
        {
          dims: [["zone", "Taman Outdoor"]],
          values: {
            revpash: { unit: "idr", valueIdr: 9200 },
            seat_occupancy_pct: { unit: "percent", value: "42.5000" },
          },
        },
        {
          dims: [["zone", "Private Room Nusantara"]],
          values: {
            revpash: { unit: "idr", valueIdr: 26400 },
            seat_occupancy_pct: { unit: "percent", value: "75.0000" },
          },
        },
        {
          dims: [["zone", "WFC Corner"]],
          values: {
            revpash: { unit: "idr", valueIdr: 12800 },
            seat_occupancy_pct: { unit: "percent", value: "55.0000" },
          },
        },
      ],
    ),
    "traffic.dwell_time": ownerBoardRun(
      "traffic.dwell_time",
      ["zone"],
      [
        {
          dims: [["zone", "Indoor Reguler"]],
          values: {
            avg_dwell_minutes: { unit: "decimal", value: "68.5000" },
            table_turnover: { unit: "decimal", value: "1.9000" },
          },
        },
        {
          dims: [["zone", "Taman Outdoor"]],
          values: {
            avg_dwell_minutes: { unit: "decimal", value: "82.0000" },
            table_turnover: { unit: "decimal", value: "1.6000" },
          },
        },
        {
          dims: [["zone", "Private Room Nusantara"]],
          values: {
            avg_dwell_minutes: { unit: "decimal", value: "96.5000" },
            table_turnover: { unit: "decimal", value: "1.2000" },
          },
        },
        {
          dims: [["zone", "WFC Corner"]],
          values: {
            avg_dwell_minutes: { unit: "decimal", value: "110.0000" },
            table_turnover: { unit: "decimal", value: "1.1000" },
          },
        },
      ],
    ),
    "facility.wifi": ownerBoardRun(
      "facility.wifi",
      [],
      [
        {
          values: {},
        },
      ],
    ),
  } satisfies Record<string, ReportResult>);

export const cafeLegendReportFixtures = {
  dashboard: cafeLegendDashboardFixtures,
  managementLayout: cafeLegendManagementLayoutFixture,
  managementKpiRuns: managementDashboardKpiRuns,
  catalogPage: reportCatalogPageFixture,
  report: reportDefinitionFixture,
  builderQuery: reportBuilderQueryFixture,
  createSavedReportInput: createSavedReportInputFixture,
  savedReport: savedReportFixture,
  schedule: reportScheduleFixture,
  runResult: reportRunResultFixture,
  ownerBoardRuns: ownerDashboardBoardRuns,
  createExportInput: createReportExportInputFixture,
  exportPendingApproval: reportExportPendingApprovalFixture,
  exportReady: reportExportReadyFixture,
  generatedEvent: reportGeneratedEventFixture,
  errors: dashboardErrorFixtures,
};
