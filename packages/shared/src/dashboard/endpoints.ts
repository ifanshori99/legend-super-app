// Report & dashboard HTTP contracts (defineEndpoint). The FE beads
// (legend-6na6, legend-ik9g, legend-k8fk, legend-gb03, legend-j815, legend-x9r2,
// legend-imfe, legend-9fo4) build screens and mock mode on these; the BE beads
// (legend-cdta, legend-atcu, legend-1ye3, legend-mqds) implement them.
//
// Tenant comes from the session or domain (TEN-02), never from params or
// bodies: every input schema is strict and has no tenantId. Outlet filters are
// intersected with the caller's scope by the service (outletIdsForQuery,
// TEN-03) before any query runs.

import { cursorPageQuerySchema, dataResponseSchema, z } from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { reportCodeSchema } from "../metrics/index.ts";
import {
  reportCatalogPageSchema,
  reportCatalogQuerySchema,
} from "./reports.ts";
import { reportDefinitionSchema } from "./reports.ts";
import {
  createSavedReportInputSchema,
  createReportScheduleInputSchema,
  reportBuilderQuerySchema,
  reportResultSchema,
  reportRunInputSchema,
  reportSchedulePageSchema,
  reportScheduleSchema,
  savedReportPageSchema,
  savedReportSchema,
  updateReportScheduleInputSchema,
  updateSavedReportInputSchema,
} from "./builder.ts";
import {
  createReportExportInputSchema,
  createReportExportResponseSchema,
  reportExportPageSchema,
  reportExportSchema,
} from "./exports.ts";
import {
  dashboardKindSchema,
  dashboardLayoutSchema,
  dashboardQuerySchema,
} from "./dashboards.ts";
import {
  dashboardFacilityScopeQuerySchema,
  dashboardFacilityScopeSchema,
  dashboardQueueRowsQuerySchema,
  dashboardQueueRowsSchema,
  dashboardRowQueueSchema,
  dashboardValuesQuerySchema,
  dashboardValuesSchema,
} from "./tile-values.ts";
import {
  reportExportIdSchema,
  reportScheduleIdSchema,
  savedReportIdSchema,
} from "./ids.ts";

export const listReportsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/reports",
  query: reportCatalogQuerySchema,
  response: reportCatalogPageSchema,
});

export const getReportEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/reports/:reportCode",
  params: z.strictObject({ reportCode: reportCodeSchema }),
  response: dataResponseSchema(reportDefinitionSchema),
});

export const getDashboardEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/dashboards/:dashboard",
  params: z.strictObject({ dashboard: dashboardKindSchema }),
  query: dashboardQuerySchema,
  response: dataResponseSchema(dashboardLayoutSchema),
});

/**
 * Metric tile values for one dashboard: value, target and previous-period
 * comparison per tile, with `finality` on every figure (legend-v3pt, I2).
 */
export const getDashboardValuesEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/dashboards/:dashboardCode/values",
  params: z.strictObject({ dashboardCode: dashboardKindSchema }),
  query: dashboardValuesQuerySchema,
  response: dataResponseSchema(dashboardValuesSchema),
});

/** Rows behind a queue tile (legend-kx94). */
export const getDashboardQueueRowsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/dashboards/queues/:queue/rows",
  params: z.strictObject({ queue: dashboardRowQueueSchema }),
  query: dashboardQueueRowsQuerySchema,
  response: dataResponseSchema(dashboardQueueRowsSchema),
});

/** Facility ids per outlet, so the shower tile can read units (legend-kx94). */
export const getDashboardFacilityScopeEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/dashboards/queues/facility-scope",
  query: dashboardFacilityScopeQuerySchema,
  response: dataResponseSchema(dashboardFacilityScopeSchema),
});

export const runReportEndpoint = defineEndpoint({
  method: "POST",
  path: "/api/reports/run",
  body: reportRunInputSchema,
  response: dataResponseSchema(reportResultSchema),
});

export const previewReportBuilderEndpoint = defineEndpoint({
  method: "POST",
  path: "/api/reports/builder/preview",
  body: reportBuilderQuerySchema,
  response: dataResponseSchema(reportResultSchema),
});

export const listSavedReportsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/reports/saved",
  query: cursorPageQuerySchema,
  response: savedReportPageSchema,
});

export const createSavedReportEndpoint = defineEndpoint({
  method: "POST",
  path: "/api/reports/saved",
  body: createSavedReportInputSchema,
  response: dataResponseSchema(savedReportSchema),
});

export const updateSavedReportEndpoint = defineEndpoint({
  method: "PATCH",
  path: "/api/reports/saved/:savedReportId",
  params: z.strictObject({ savedReportId: savedReportIdSchema }),
  body: updateSavedReportInputSchema,
  response: dataResponseSchema(savedReportSchema),
});

export const listReportSchedulesEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/reports/schedules",
  query: cursorPageQuerySchema,
  response: reportSchedulePageSchema,
});

export const createReportScheduleEndpoint = defineEndpoint({
  method: "POST",
  path: "/api/reports/schedules",
  body: createReportScheduleInputSchema,
  response: dataResponseSchema(reportScheduleSchema),
});

export const updateReportScheduleEndpoint = defineEndpoint({
  method: "PATCH",
  path: "/api/reports/schedules/:reportScheduleId",
  params: z.strictObject({ reportScheduleId: reportScheduleIdSchema }),
  body: updateReportScheduleInputSchema,
  response: dataResponseSchema(reportScheduleSchema),
});

export const listReportExportsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/reports/exports",
  query: cursorPageQuerySchema,
  response: reportExportPageSchema,
});

export const createReportExportEndpoint = defineEndpoint({
  method: "POST",
  path: "/api/reports/exports",
  body: createReportExportInputSchema,
  response: createReportExportResponseSchema,
});

export const getReportExportEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/reports/exports/:reportExportId",
  params: z.strictObject({ reportExportId: reportExportIdSchema }),
  response: dataResponseSchema(reportExportSchema),
});

export const DASHBOARD_ENDPOINTS = {
  listReports: listReportsEndpoint,
  getReport: getReportEndpoint,
  getDashboard: getDashboardEndpoint,
  getDashboardValues: getDashboardValuesEndpoint,
  getDashboardQueueRows: getDashboardQueueRowsEndpoint,
  getDashboardFacilityScope: getDashboardFacilityScopeEndpoint,
  runReport: runReportEndpoint,
  previewReportBuilder: previewReportBuilderEndpoint,
  listSavedReports: listSavedReportsEndpoint,
  createSavedReport: createSavedReportEndpoint,
  updateSavedReport: updateSavedReportEndpoint,
  listReportSchedules: listReportSchedulesEndpoint,
  createReportSchedule: createReportScheduleEndpoint,
  updateReportSchedule: updateReportScheduleEndpoint,
  listReportExports: listReportExportsEndpoint,
  createReportExport: createReportExportEndpoint,
  getReportExport: getReportExportEndpoint,
} as const;
