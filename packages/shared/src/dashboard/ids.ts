// Branded ids for the WS-11 dashboard & report contract (PRD v1.7 §3.34–3.36,
// §6 J, DASH-01/DASH-02/DASH-04). The report catalog itself is a global,
// code-keyed registry (like `metric_definitions`); the tenant-scoped rows
// below are saved reports, schedules and export jobs, which every service
// loads under RLS with the server-resolved tenant (TEN-02).

import { uuidIdSchema } from "../core/index.ts";

export const savedReportIdSchema = uuidIdSchema<"SavedReportId">();
export type SavedReportId = ReturnType<typeof savedReportIdSchema.parse>;

export const reportScheduleIdSchema = uuidIdSchema<"ReportScheduleId">();
export type ReportScheduleId = ReturnType<typeof reportScheduleIdSchema.parse>;

export const reportExportIdSchema = uuidIdSchema<"ReportExportId">();
export type ReportExportId = ReturnType<typeof reportExportIdSchema.parse>;

/** One execution of a report, whether ad hoc, saved or an export job. */
export const reportRunIdSchema = uuidIdSchema<"ReportRunId">();
export type ReportRunId = ReturnType<typeof reportRunIdSchema.parse>;
