// Report export contract (WS-11 CT, bead legend-mmjb; PRD v1.7 §3.36 "Ekspor",
// DASH-04). CSV, XLSX and PDF exports are allowed by permission; an export that
// contains personal data is refused at the server until an approval request is
// approved and is recorded in the audit log (DASH-04).
//
// An export job is tenant-scoped and starts either `pending_approval` (the
// server requested an approval on the caller's behalf, no rows have left the
// database) or `queued` for an aggregate report. Only the transition
// `pending_approval -> queued` after approval may start generation; the state
// machine in `transitions.ts` enforces it and the resource invariant below
// makes an unapproved personal-data job unrepresentable.

import {
  clientInputSchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import {
  metricBucketSchema,
  metricDimensionFilterSchema,
  metricDimensionKeySchema,
  metricQueryPeriodSchema,
  reportCodeSchema,
} from "../metrics/index.ts";
import {
  REPORT_BUILDER_MAX_DIMENSIONS,
  REPORT_BUILDER_MAX_FILTERS,
  refineOutletFilter,
  refineSelectionDimensions,
} from "./builder.ts";
import {
  REPORT_EXPORT_FORMATS,
  reportExportFormatSchema,
  selectionContainsPersonalData,
} from "./reports.ts";
import type { ReportDefinition, ReportExportFormat } from "./reports.ts";
import {
  builderQueryPermittedFor,
  reportByCode,
  reportPermittedFor,
} from "./catalog.ts";
import { reportExportIdSchema, savedReportIdSchema } from "./ids.ts";
import { reportErrorCodeSchema } from "./errors.ts";
import type { ReportErrorCode } from "./errors.ts";

/** Approvals the server resolved for the export (WS-01 approval contract). */
export const REPORT_EXPORT_APPROVAL_STATUSES = [
  "none",
  "pending",
  "approved",
  "rejected",
] as const;
export const reportExportApprovalStatusSchema = z.enum(
  REPORT_EXPORT_APPROVAL_STATUSES,
);
export type ReportExportApprovalStatus = z.infer<
  typeof reportExportApprovalStatusSchema
>;

export const REPORT_EXPORT_STATUSES = [
  "pending_approval",
  "queued",
  "generating",
  "ready",
  "failed",
  "rejected",
  "expired",
  "cancelled",
] as const;
export const reportExportStatusSchema = z.enum(REPORT_EXPORT_STATUSES);
export type ReportExportStatus = z.infer<typeof reportExportStatusSchema>;

/** Filters an export applies; the same shape the viewer sends to a report. */
export const reportExportQuerySchema = z
  .strictObject({
    period: metricQueryPeriodSchema,
    outletIds: z.array(outletIdSchema).min(1).max(50).optional(),
    groupBy: z
      .array(metricDimensionKeySchema)
      .max(REPORT_BUILDER_MAX_DIMENSIONS)
      .default([]),
    filters: z
      .array(metricDimensionFilterSchema)
      .max(REPORT_BUILDER_MAX_FILTERS)
      .default([]),
    bucket: metricBucketSchema.default("total"),
  })
  .superRefine((query, ctx) => {
    refineOutletFilter(query.filters, ctx);
    if (new Set(query.groupBy).size !== query.groupBy.length)
      ctx.addIssue({
        code: "custom",
        message: "groupBy repeats a dimension key",
        path: ["groupBy"],
      });
    if (
      new Set(query.filters.map((filter) => filter.key)).size !==
      query.filters.length
    )
      ctx.addIssue({
        code: "custom",
        message: "filters repeat a dimension key",
        path: ["filters"],
      });
  });
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

/**
 * POST /api/reports/exports — exactly one source: a catalog report or a saved
 * builder query. The client cannot claim `containsPersonalData`; the server
 * derives it from the report/query and gates the job (DASH-04).
 */
export const createReportExportInputSchema = clientInputSchema({
  reportCode: reportCodeSchema.optional(),
  savedReportId: savedReportIdSchema.optional(),
  format: reportExportFormatSchema,
  query: reportExportQuerySchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).superRefine((request, ctx) => {
  if (
    (request.reportCode === undefined) ===
    (request.savedReportId === undefined)
  )
    ctx.addIssue({
      code: "custom",
      message: "Send exactly one of reportCode or savedReportId",
      path: ["reportCode"],
    });
  if (request.reportCode !== undefined) {
    const report = reportByCode(request.reportCode);
    if (report === undefined)
      ctx.addIssue({
        code: "custom",
        message: `Unknown report ${request.reportCode}`,
        path: ["reportCode"],
      });
    else refineSelectionDimensions(request.query, report.dimensions, ctx);
  }
});

/**
 * DASH-04: whether an export's output is personal data, derived only from the
 * catalog definition and the export's own group-by/filters — never from a
 * client flag. A saved builder query (`report: null`) is personal exactly when
 * it splits or filters by a person-level dimension.
 */
export function reportExportContainsPersonalData(input: {
  readonly report: Pick<ReportDefinition, "containsPersonalData"> | null;
  readonly query: {
    readonly groupBy: readonly string[];
    readonly filters: readonly { readonly key: string }[];
  };
}): boolean {
  return (
    input.report?.containsPersonalData === true ||
    selectionContainsPersonalData(input.query)
  );
}
export type CreateReportExportInput = z.infer<
  typeof createReportExportInputSchema
>;

export const reportExportFileSchema = z.strictObject({
  /** App-relative download route, e.g. /api/reports/exports/:id/file. */
  downloadPath: z
    .string()
    .min(1)
    .max(300)
    .refine(
      (path) =>
        path.startsWith("/api/") &&
        !path.startsWith("//") &&
        !path.includes("\\") &&
        !/[?#]/.test(path),
      "Download paths are /api/ paths without a query, fragment, or backslash",
    ),
  sizeBytes: z
    .number()
    .int()
    .min(0)
    .refine(Number.isSafeInteger, "Expected a safe integer"),
  rowCount: z
    .number()
    .int()
    .min(0)
    .refine(Number.isSafeInteger, "Expected a safe integer"),
  /** Storage retention window; an expired file is deleted (cost control). */
  expiresAt: isoDateTimeSchema,
});
export type ReportExportFile = z.infer<typeof reportExportFileSchema>;

/**
 * One export job. The invariant below is DASH-04 at the data layer: a job that
 * contains personal data can only leave `pending_approval`/`rejected`/
 * `cancelled`/`expired` with an `approvalRequestId`, so no code path can
 * generate a personal-data file without an approval on record.
 */
export const reportExportSchema = z
  .strictObject({
    id: reportExportIdSchema,
    tenantId: tenantIdSchema,
    reportCode: reportCodeSchema.nullable(),
    savedReportId: savedReportIdSchema.nullable(),
    format: reportExportFormatSchema,
    query: reportExportQuerySchema,
    containsPersonalData: z.boolean(),
    approvalRequestId: z.uuid().nullable(),
    status: reportExportStatusSchema,
    requestedBy: userIdSchema,
    requestedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    /** Set exactly when the file exists (`ready`). */
    file: reportExportFileSchema.nullable(),
    /** Set exactly when generation failed. */
    errorCode: reportErrorCodeSchema.nullable(),
  })
  .superRefine((reportExport, ctx) => {
    if (
      (reportExport.reportCode === null) ===
      (reportExport.savedReportId === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "An export names exactly one report or saved report",
        path: ["reportCode"],
      });
    // DASH-04: the personal-data flag is derived, never trusted. A catalog
    // export must match its definition plus its splits; a saved-query export
    // that splits by a person is personal whatever was stored.
    const report =
      reportExport.reportCode === null
        ? null
        : reportByCode(reportExport.reportCode);
    if (report === undefined)
      ctx.addIssue({
        code: "custom",
        message: "reportCode is not in the catalog",
        path: ["reportCode"],
      });
    else {
      const derived = reportExportContainsPersonalData({
        report,
        query: reportExport.query,
      });
      if (
        report === null
          ? derived && !reportExport.containsPersonalData
          : derived !== reportExport.containsPersonalData
      )
        ctx.addIssue({
          code: "custom",
          message:
            "containsPersonalData must follow the report and its splits (DASH-04)",
          path: ["containsPersonalData"],
        });
    }
    const status = reportExport.status;

    // DASH-04: nothing personal leaves before approval.
    const generationStarted =
      status !== "pending_approval" &&
      status !== "rejected" &&
      status !== "cancelled" &&
      status !== "expired";
    if (reportExport.containsPersonalData && generationStarted)
      if (reportExport.approvalRequestId === null)
        ctx.addIssue({
          code: "custom",
          message:
            "Personal-data exports need an approved approval request (DASH-04)",
          path: ["approvalRequestId"],
        });
    if (
      !reportExport.containsPersonalData &&
      reportExport.approvalRequestId !== null
    )
      ctx.addIssue({
        code: "custom",
        message: "An aggregate export needs no approval request",
        path: ["approvalRequestId"],
      });
    if (status === "pending_approval" && !reportExport.containsPersonalData)
      ctx.addIssue({
        code: "custom",
        message: "Only personal-data exports wait for approval",
        path: ["status"],
      });
    if (status === "rejected" && reportExport.approvalRequestId === null)
      ctx.addIssue({
        code: "custom",
        message: "A rejected export names the approval it came from",
        path: ["approvalRequestId"],
      });

    // File and timestamps follow the status.
    if ((status === "ready") !== (reportExport.file !== null))
      ctx.addIssue({
        code: "custom",
        message: "file is set exactly when the export is ready",
        path: ["file"],
      });
    if ((status === "failed") !== (reportExport.errorCode !== null))
      ctx.addIssue({
        code: "custom",
        message: "errorCode is set exactly when the export failed",
        path: ["errorCode"],
      });
    const started =
      status === "generating" ||
      status === "ready" ||
      status === "failed" ||
      status === "expired";
    if (started !== (reportExport.startedAt !== null))
      ctx.addIssue({
        code: "custom",
        message: "startedAt is set exactly when generation started",
        path: ["startedAt"],
      });
    const completed =
      status === "ready" || status === "failed" || status === "expired";
    if (completed !== (reportExport.completedAt !== null))
      ctx.addIssue({
        code: "custom",
        message: "completedAt is set exactly when generation ended",
        path: ["completedAt"],
      });

    const requestedAt = Date.parse(reportExport.requestedAt);
    if (
      reportExport.startedAt !== null &&
      Date.parse(reportExport.startedAt) < requestedAt
    )
      ctx.addIssue({
        code: "custom",
        message: "startedAt must not be before requestedAt",
        path: ["startedAt"],
      });
    if (
      reportExport.startedAt !== null &&
      reportExport.completedAt !== null &&
      Date.parse(reportExport.completedAt) < Date.parse(reportExport.startedAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "completedAt must not be before startedAt",
        path: ["completedAt"],
      });
    if (
      reportExport.file !== null &&
      reportExport.completedAt !== null &&
      Date.parse(reportExport.file.expiresAt) <=
        Date.parse(reportExport.completedAt)
    )
      ctx.addIssue({
        code: "custom",
        message: "The file must expire after it was generated",
        path: ["file", "expiresAt"],
      });
  });
export type ReportExport = Readonly<z.infer<typeof reportExportSchema>>;

/** POST /api/reports/exports → 202 with the pending/queued job. */
export const createReportExportResponseSchema =
  dataResponseSchema(reportExportSchema);
export type CreateReportExportResponse = z.infer<
  typeof createReportExportResponseSchema
>;

export const reportExportPageSchema = cursorPageSchema(reportExportSchema);
export type ReportExportPage = z.infer<typeof reportExportPageSchema>;

/** Export jobs never leave the storage retention window. */
export const REPORT_EXPORT_RETENTION_DAYS = 7;

/** Permission to export aggregate data (access catalog, `bulk_export`). */
export const REPORT_EXPORT_PERMISSION = "export.data.run";
/** Permission to request a personal-data export (access catalog, DASH-04). */
export const REPORT_PERSONAL_DATA_EXPORT_PERMISSION =
  "export.personal_data.request";
/** WS-01 approval action type a personal-data export routes through. */
export const REPORT_EXPORT_APPROVAL_ACTION = "personal_data_export";

/**
 * Decision the service applies before it creates/queues an export (DASH-04).
 * `containsPersonalData` is what the service stores on the job.
 */
export type ReportExportGateDecision =
  | { readonly action: "queue"; readonly containsPersonalData: boolean }
  | { readonly action: "request_approval"; readonly containsPersonalData: true }
  | { readonly action: "reject"; readonly code: ReportErrorCode };

export type ReportExportGateInput = {
  /** The catalog definition the server loaded; null for a saved builder query. */
  readonly report: ReportDefinition | null;
  /** The export's group-by/filters, after schema validation. */
  readonly query: {
    readonly metricCodes?: readonly string[];
    readonly groupBy: readonly string[];
    readonly filters: readonly { readonly key: string }[];
  };
  readonly format: ReportExportFormat;
  /** Permission codes the server resolved for the caller (RBAC). */
  readonly permissions: ReadonlySet<string>;
  /** Status of this job's own `personal_data_export` approval request. */
  readonly approval: ReportExportApprovalStatus;
};

/**
 * Server-side export gate. Order matters: report permission, then export
 * permission, then format, then the personal-data approval rule, then the
 * approval outcome. The personal-data flag is derived here from the report
 * and the splits, so no request field can turn the gate off (DASH-04).
 * `request_approval` creates the approval request and leaves the job in
 * `pending_approval` — no file and no rows leave the server.
 */
export function reportExportGate(
  input: ReportExportGateInput,
): ReportExportGateDecision {
  const containsPersonalData = reportExportContainsPersonalData(input);
  if (
    input.report !== null &&
    !reportPermittedFor(input.report, input.permissions)
  )
    return { action: "reject", code: "REPORT_NOT_PERMITTED" };
  // A saved builder query (`report === null`) has no definition to check, so
  // its splits and metrics are checked here: an aggregate-only caller never
  // exports a person split or a metric of a report it cannot open (SH-01).
  if (!builderQueryPermittedFor(input.query, input.permissions))
    return { action: "reject", code: "REPORT_NOT_PERMITTED" };
  if (
    !input.permissions.has(
      containsPersonalData
        ? REPORT_PERSONAL_DATA_EXPORT_PERMISSION
        : REPORT_EXPORT_PERMISSION,
    )
  )
    return { action: "reject", code: "REPORT_NOT_PERMITTED" };
  const supportedFormats: readonly ReportExportFormat[] =
    input.report?.exportFormats ?? REPORT_EXPORT_FORMATS;
  if (!supportedFormats.includes(input.format))
    return { action: "reject", code: "EXPORT_FORMAT_NOT_SUPPORTED" };
  if (!containsPersonalData) return { action: "queue", containsPersonalData };
  switch (input.approval) {
    case "approved":
      return { action: "queue", containsPersonalData };
    case "rejected":
      return { action: "reject", code: "EXPORT_PII_APPROVAL_REQUIRED" };
    case "none":
    case "pending":
      return { action: "request_approval", containsPersonalData };
  }
}

/**
 * DASH-04 for email schedules: a scheduled delivery is a file leaving the
 * server with no per-run approval, so a report that is personal data cannot be
 * scheduled: a saved query that splits or filters by an identity (employee,
 * customer, member), or a catalog report flagged `containsPersonalData`
 * (pass its definition as `report`; null for a builder query). PRD is silent
 * on standing approvals; refusing is the fail-closed choice until the owner
 * decides otherwise.
 */
export function reportScheduleGate(
  query: {
    readonly groupBy: readonly string[];
    readonly filters: readonly { readonly key: string }[];
  },
  report: Pick<ReportDefinition, "containsPersonalData"> | null = null,
): ReportExportGateDecision {
  if (reportExportContainsPersonalData({ report, query }))
    return { action: "reject", code: "EXPORT_PII_APPROVAL_REQUIRED" };
  return { action: "queue", containsPersonalData: false };
}
