// Cafe Legend mock data for the dashboard & report contract (FE mock mode +
// contract tests). Report tiles, catalog pages, runs, saved reports, schedules
// and export jobs use the fixed Cafe Legend tenant/outlet ids from
// `@starter/shared/core` so fixtures across contracts line up, and the metric
// references are the registry rows from `@starter/shared/metrics` plus this
// domain's own catalog.

import {
  apiErrorBody,
  cafeLegendFixtures,
  encodeCursor,
} from "../core/index.ts";
import type { z } from "../core/index.ts";
import { eventEnvelopeSchema } from "../events/index.ts";
import {
  cafeLegendMetricDefinitions,
  metricDefinitionRefSchema,
  metricPeriodSchema,
  metricQueryPeriodSchema,
} from "../metrics/index.ts";
import type { MetricDefinitionRef } from "../metrics/index.ts";
import { reportCatalog } from "./catalog.ts";
import { reportCatalogPageSchema } from "./reports.ts";
import type { ReportDefinition } from "./reports.ts";
import {
  createSavedReportInputSchema,
  reportBuilderQuerySchema,
  reportResultSchema,
  reportScheduleSchema,
  savedReportSchema,
} from "./builder.ts";
import {
  createReportExportInputSchema,
  reportExportSchema,
} from "./exports.ts";
import { dashboardLayoutSchema, OWNER_DASHBOARD_TILES } from "./dashboards.ts";

const tenant = cafeLegendFixtures.tenant;
const outlet = cafeLegendFixtures.outlets[0];
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
  const ref = metricRefByCode.get(code);
  if (ref === undefined) throw new Error(`No metric fixture for ${code}`);
  return ref;
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
    generatedAt: "2026-11-01T22:45:00.000Z",
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
  outletFilter: { kind: "outlets", outletIds: [outlet.id] },
  definitions: [metricRef("net_sales"), metricRef("transaction_count")],
  groupBy: ["channel"],
  rows: [
    {
      dimensions: [{ key: "channel", value: "qr" }],
      values: [
        {
          metricCode: "net_sales",
          value: { unit: "idr", valueIdr: 18_450_000 },
          finality: "final",
        },
        {
          metricCode: "transaction_count",
          value: { unit: "count", value: 412 },
          finality: "final",
        },
      ],
    },
    {
      dimensions: [{ key: "channel", value: "pos" }],
      values: [
        {
          metricCode: "net_sales",
          value: { unit: "idr", valueIdr: 26_300_000 },
          finality: "final",
        },
        {
          metricCode: "transaction_count",
          value: { unit: "count", value: 388 },
          finality: "final",
        },
      ],
    },
  ],
  generatedAt: "2026-11-01T22:46:00.000Z",
  rowLimit: 100,
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
  recipients: ["owner@cafelegend.id"],
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
    expiresAt: "2026-11-08T22:47:09.000Z",
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

export const cafeLegendReportFixtures = {
  dashboard: cafeLegendDashboardFixtures,
  catalogPage: reportCatalogPageFixture,
  report: reportDefinitionFixture,
  builderQuery: reportBuilderQueryFixture,
  createSavedReportInput: createSavedReportInputFixture,
  savedReport: savedReportFixture,
  schedule: reportScheduleFixture,
  runResult: reportRunResultFixture,
  createExportInput: createReportExportInputFixture,
  exportPendingApproval: reportExportPendingApprovalFixture,
  exportReady: reportExportReadyFixture,
  generatedEvent: reportGeneratedEventFixture,
  errors: dashboardErrorFixtures,
};
