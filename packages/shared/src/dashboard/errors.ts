// Report & export error codes, declared next to the schemas. The API error
// handler maps them with reportErrorHttpStatus; the web app maps the stable
// code to catalog text. DASH-04: personal-data exports are refused server-side
// unless an approval request is approved.

import { z } from "../core/index.ts";

export const reportErrorCodeSchema = z.enum([
  /** No catalog entry for the requested report code. */
  "REPORT_NOT_FOUND",
  /** The caller's role lacks the report's permission, or its outlet scope. */
  "REPORT_NOT_PERMITTED",
  /** A group-by / filter dimension is not declared by one of the metrics. */
  "REPORT_FILTER_NOT_SUPPORTED",
  /** The builder query is internally inconsistent (sort, duplicates). */
  "REPORT_QUERY_INVALID",
  /** Saved report not found in this tenant. */
  "SAVED_REPORT_NOT_FOUND",
  /** Schedule settings are contradictory (frequency vs day fields). */
  "REPORT_SCHEDULE_INVALID",
  /** The report does not offer the requested export format. */
  "EXPORT_FORMAT_NOT_SUPPORTED",
  /** DASH-04: personal data cannot be exported without an approved request. */
  "EXPORT_PII_APPROVAL_REQUIRED",
  /** The export file is not generated yet. */
  "EXPORT_NOT_READY",
  /** The export file passed its retention window. */
  "EXPORT_EXPIRED",
]);
export type ReportErrorCode = z.infer<typeof reportErrorCodeSchema>;

export const reportErrorHttpStatus = {
  REPORT_NOT_FOUND: 404,
  REPORT_NOT_PERMITTED: 403,
  REPORT_FILTER_NOT_SUPPORTED: 400,
  REPORT_QUERY_INVALID: 400,
  SAVED_REPORT_NOT_FOUND: 404,
  REPORT_SCHEDULE_INVALID: 400,
  EXPORT_FORMAT_NOT_SUPPORTED: 400,
  EXPORT_PII_APPROVAL_REQUIRED: 403,
  EXPORT_NOT_READY: 409,
  EXPORT_EXPIRED: 410,
} as const satisfies Record<ReportErrorCode, number>;

export const REPORT_ERROR_CODES = reportErrorCodeSchema.options;
