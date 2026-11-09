// Report builder, run result, saved report and email schedule contracts
// (WS-11 CT, bead legend-mmjb; PRD v1.7 §3.36 "Report Builder", "Laporan";
// §5 "Lapisan metrik baku"; DASH-01/DASH-02).
//
// The builder picks metrics, dimensions, filters and a period from the metric
// registry, then saves the query and schedules an email. A saved report and a
// schedule are tenant-scoped rows: `tenantId` is never accepted from the
// client (TEN-02), and saved queries are strict so an unknown field fails
// instead of silently changing a shared definition. The result contract is
// table-shaped: one row per dimension combination, one typed value per metric
// definition, so the viewer, the PDF/CSV export and Tanya AI read the same
// numbers (DASH-02).

import { defineEndpoint } from "../api/endpoint.ts";
import {
  businessDateSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import {
  metricAvailabilitySchema,
  metricBucketSchema,
  metricCodeSchema,
  metricDefinitionRefSchema,
  metricDimensionFilterSchema,
  metricDimensionKeySchema,
  metricDimensionValueSchema,
  metricFinalitySchema,
  metricOutletFilterSchema,
  metricPeriodSchema,
  metricQueryPeriodSchema,
  metricValueSchema,
  reportCodeSchema,
} from "../metrics/index.ts";
import type { MetricDefinition } from "../metrics/index.ts";
import { reportExportFormatSchema } from "./reports.ts";
import { reportByCode } from "./catalog.ts";
import { reportMetricByCode } from "./metric-catalog.ts";
import type { ReportExportFormat } from "./reports.ts";
import { savedReportIdSchema, reportScheduleIdSchema } from "./ids.ts";

/** Builder limits: enough for a real query, small enough to stay fast. */
export const REPORT_BUILDER_MAX_METRICS = 10;
export const REPORT_BUILDER_MAX_DIMENSIONS = 3;
export const REPORT_BUILDER_MAX_FILTERS = 10;
export const REPORT_BUILDER_MAX_ROWS = 1000;
export const REPORT_BUILDER_DEFAULT_ROWS = 100;

/**
 * Split dimensions a report run answers besides `outlet` (legend-hdfd2).
 * `metrics_daily` stores one dimension per row, so a second split (channel and
 * hour together, say) cannot be read back; going deeper needs a schema change.
 * The schema does not refuse a longer `groupBy`: the run answers 200 with
 * `unavailable` / `dimension_not_supported`, as it does for any unreadable split.
 */
export const REPORT_RUN_MAX_SPLIT_DIMENSIONS = 1;

export const REPORT_SORT_DIRECTIONS = ["asc", "desc"] as const;
export const reportSortDirectionSchema = z.enum(REPORT_SORT_DIRECTIONS);
export type ReportSortDirection = z.infer<typeof reportSortDirectionSchema>;

/**
 * Sort one column: a metric code (`net_sales`) or a group-by dimension key
 * (`hour`). The server checks the column is one of the two; the schema only
 * bounds its shape.
 */
export const reportBuilderSortSchema = z.strictObject({
  column: z.string().min(1).max(60),
  direction: reportSortDirectionSchema,
});
export type ReportBuilderSort = z.infer<typeof reportBuilderSortSchema>;

const reportSelectionShape = {
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
  sort: reportBuilderSortSchema.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(REPORT_BUILDER_MAX_ROWS)
    .default(REPORT_BUILDER_DEFAULT_ROWS),
};

/**
 * Outlets are chosen only through `outletIds`, which the server intersects
 * with the caller's scope (TEN-03, outletIdsForQuery). An `outlet` dimension
 * filter would be a second, unchecked outlet selector, so it is refused.
 */
export function refineOutletFilter(
  filters: readonly { key: string }[],
  ctx: z.RefinementCtx,
): void {
  for (const [index, filter] of filters.entries())
    if (filter.key === "outlet")
      ctx.addIssue({
        code: "custom",
        message: "Filter outlets with outletIds, not an outlet filter (TEN-03)",
        path: ["filters", index, "key"],
      });
}

/**
 * Every group-by/filter key must be one the source offers (DASH-01/DASH-02):
 * the report's own dimensions, or the dimensions all builder metrics declare.
 */
export function refineSelectionDimensions(
  selection: {
    groupBy: readonly string[];
    filters: readonly { key: string }[];
  },
  allowed: readonly string[],
  ctx: z.RefinementCtx,
): void {
  for (const [index, key] of selection.groupBy.entries())
    if (!allowed.includes(key))
      ctx.addIssue({
        code: "custom",
        message: `groupBy ${key} is not offered by the source`,
        path: ["groupBy", index],
      });
  for (const [index, filter] of selection.filters.entries())
    if (!allowed.includes(filter.key))
      ctx.addIssue({
        code: "custom",
        message: `filter ${filter.key} is not offered by the source`,
        path: ["filters", index, "key"],
      });
}

function refineSelection(
  selection: {
    groupBy: readonly string[];
    filters: readonly { key: string }[];
    sort?: { column: string } | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  refineOutletFilter(selection.filters, ctx);
  if (new Set(selection.groupBy).size !== selection.groupBy.length)
    ctx.addIssue({
      code: "custom",
      message: "groupBy repeats a dimension key",
      path: ["groupBy"],
    });
  if (
    new Set(selection.filters.map((filter) => filter.key)).size !==
    selection.filters.length
  )
    ctx.addIssue({
      code: "custom",
      message: "filters repeat a dimension key",
      path: ["filters"],
    });
}

/**
 * Builder query: metrics + dimensions + filters + period (PRD §3.36). Multiple
 * group-by dimensions are supported here; the single-metric API query in
 * `@starter/shared/metrics` stays the low-level primitive. Metric codes must
 * be registry rows and every split must be declared by all selected metrics,
 * so the builder cannot carry an arbitrary field name (DASH-01/DASH-02).
 */
export const reportBuilderQuerySchema = clientInputSchema({
  metricCodes: z.array(metricCodeSchema).min(1).max(REPORT_BUILDER_MAX_METRICS),
  ...reportSelectionShape,
}).superRefine((query, ctx) => {
  refineSelection(query, ctx);
  if (new Set(query.metricCodes).size !== query.metricCodes.length)
    ctx.addIssue({
      code: "custom",
      message: "metricCodes repeat a code",
      path: ["metricCodes"],
    });
  if (
    query.sort !== undefined &&
    !query.metricCodes.includes(query.sort.column) &&
    !query.groupBy.includes(query.sort.column)
  )
    ctx.addIssue({
      code: "custom",
      message: "sort.column must be one of metricCodes or groupBy",
      path: ["sort", "column"],
    });
  const definitions: MetricDefinition[] = [];
  for (const [index, code] of query.metricCodes.entries()) {
    const definition = reportMetricByCode.get(code);
    if (definition === undefined)
      ctx.addIssue({
        code: "custom",
        message: `Unknown metric ${code}`,
        path: ["metricCodes", index],
      });
    else definitions.push(definition);
  }
  const [first] = definitions;
  if (first !== undefined && definitions.length === query.metricCodes.length) {
    const shared = first.dimensions.filter((key) =>
      definitions.every((definition) => definition.dimensions.includes(key)),
    );
    refineSelectionDimensions(query, shared, ctx);
  }
});
export type ReportBuilderQuery = z.infer<typeof reportBuilderQuerySchema>;

/** POST /api/reports/run — run one catalog report with the viewer filters. */
export const reportRunInputSchema = clientInputSchema({
  reportCode: reportCodeSchema,
  ...reportSelectionShape,
}).superRefine((input, ctx) => {
  refineSelection(input, ctx);
  const report = reportByCode(input.reportCode);
  if (report === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `Unknown report ${input.reportCode}`,
      path: ["reportCode"],
    });
    return;
  }
  refineSelectionDimensions(input, report.dimensions, ctx);
  if (
    input.sort !== undefined &&
    !report.metrics.includes(input.sort.column) &&
    !input.groupBy.includes(input.sort.column)
  )
    ctx.addIssue({
      code: "custom",
      message: "sort.column must be one of the report metrics or groupBy",
      path: ["sort", "column"],
    });
});
export type ReportRunInput = z.infer<typeof reportRunInputSchema>;

/**
 * One row: the bucket it belongs to, the dimension values in `groupBy` order,
 * then one value per metric. For bucket `total` the bucket is the whole period.
 */
export const reportResultRowSchema = z
  .strictObject({
    bucketStart: businessDateSchema,
    bucketEnd: businessDateSchema,
    dimensions: z
      .array(metricDimensionValueSchema)
      .max(REPORT_BUILDER_MAX_DIMENSIONS),
    values: z
      .array(
        z.strictObject({
          metricCode: metricCodeSchema,
          /** Null means no data for the row; never reported as zero. */
          value: metricValueSchema.nullable(),
          finality: metricFinalitySchema,
        }),
      )
      .min(1)
      .max(REPORT_BUILDER_MAX_METRICS),
  })
  .superRefine((row, ctx) => {
    if (row.bucketStart > row.bucketEnd)
      ctx.addIssue({
        code: "custom",
        message: "bucketStart must not be after bucketEnd",
        path: ["bucketEnd"],
      });
    const codes = row.values.map((value) => value.metricCode);
    if (new Set(codes).size !== codes.length)
      ctx.addIssue({
        code: "custom",
        message: "Row values repeat a metric code",
        path: ["values"],
      });
    const dimensionKeys = row.dimensions.map((dimension) => dimension.key);
    if (new Set(dimensionKeys).size !== dimensionKeys.length)
      ctx.addIssue({
        code: "custom",
        message: "Row dimensions repeat a key",
        path: ["dimensions"],
      });
  });
export type ReportResultRow = z.infer<typeof reportResultRowSchema>;

/**
 * Table result of one run. `bucket` is the period's bucket: one block of rows
 * per bucket, in bucket order, then dimension order; `limit` counts all rows.
 * `groupBy` and every row's dimensions share one
 * order; every row carries exactly the requested definitions in order, so a
 * cell always resolves to a registry row (DASH-01). `finality` is per value:
 * an open period is an estimate, a closed one final (SH-02).
 */
export const reportResultSchema = z
  .strictObject({
    /** Null for an ad hoc builder preview; set for a catalog report. */
    reportCode: reportCodeSchema.nullable(),
    period: metricPeriodSchema,
    bucket: metricBucketSchema,
    outletFilter: metricOutletFilterSchema,
    definitions: z
      .array(metricDefinitionRefSchema)
      .min(1)
      .max(REPORT_BUILDER_MAX_METRICS),
    /** One entry per definition, same order. */
    availability: z
      .array(metricAvailabilitySchema)
      .min(1)
      .max(REPORT_BUILDER_MAX_METRICS),
    groupBy: z
      .array(metricDimensionKeySchema)
      .max(REPORT_BUILDER_MAX_DIMENSIONS),
    rows: z.array(reportResultRowSchema).max(REPORT_BUILDER_MAX_ROWS),
    generatedAt: isoDateTimeSchema,
    rowLimit: z.number().int().min(1).max(REPORT_BUILDER_MAX_ROWS),
    /** True when `rowLimit` cut rows off; false when every row is here. */
    truncated: z.boolean(),
  })
  .superRefine((result, ctx) => {
    const report =
      result.reportCode === null ? null : reportByCode(result.reportCode);
    if (report === undefined)
      ctx.addIssue({
        code: "custom",
        message: "reportCode is not in the catalog",
        path: ["reportCode"],
      });
    if (result.bucket !== result.period.bucket)
      ctx.addIssue({
        code: "custom",
        message: "bucket must match the period bucket",
        path: ["bucket"],
      });
    if (result.rows.length > result.rowLimit)
      ctx.addIssue({
        code: "custom",
        message: "rows must not exceed rowLimit",
        path: ["rows"],
      });
    if (result.truncated && result.rows.length !== result.rowLimit)
      ctx.addIssue({
        code: "custom",
        message: "A truncated result fills rowLimit",
        path: ["truncated"],
      });
    const codes = result.definitions.map((definition) => definition.code);
    if (new Set(codes).size !== codes.length)
      ctx.addIssue({
        code: "custom",
        message: "Definitions repeat a metric code",
        path: ["definitions"],
      });
    if (
      result.availability.length !== codes.length ||
      result.availability.some(
        (entry, position) => entry.metricCode !== codes[position],
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Availability must list the definitions in the same order",
        path: ["availability"],
      });
    const unavailable = new Set(
      result.availability
        .filter((entry) => entry.status === "unavailable")
        .map((entry) => entry.metricCode),
    );
    const byCode = new Map(
      result.definitions.map((definition) => [definition.code, definition]),
    );
    let previousBucketStart: string | null = null;
    const endOfBucket = new Map<string, string>();
    for (const [index, row] of result.rows.entries()) {
      if (result.bucket === "day" && row.bucketStart !== row.bucketEnd)
        ctx.addIssue({
          code: "custom",
          message: "A day row starts and ends on the same date",
          path: ["rows", index, "bucketEnd"],
        });
      const knownEnd = endOfBucket.get(row.bucketStart);
      if (knownEnd !== undefined && knownEnd !== row.bucketEnd)
        ctx.addIssue({
          code: "custom",
          message: "Rows of one bucket share its end date",
          path: ["rows", index, "bucketEnd"],
        });
      endOfBucket.set(row.bucketStart, row.bucketEnd);
      if (
        row.bucketStart < result.period.startDate ||
        row.bucketEnd > result.period.endDate
      )
        ctx.addIssue({
          code: "custom",
          message: "Row bucket must lie inside the period",
          path: ["rows", index, "bucketStart"],
        });
      if (
        result.bucket === "total" &&
        (row.bucketStart !== result.period.startDate ||
          row.bucketEnd !== result.period.endDate)
      )
        ctx.addIssue({
          code: "custom",
          message: "A total row covers the whole period",
          path: ["rows", index, "bucketStart"],
        });
      if (previousBucketStart !== null && row.bucketStart < previousBucketStart)
        ctx.addIssue({
          code: "custom",
          message: "Rows must be ordered by bucket",
          path: ["rows", index, "bucketStart"],
        });
      previousBucketStart = row.bucketStart;
      const columnKeys = row.dimensions.map((dimension) => dimension.key);
      if (
        columnKeys.length !== result.groupBy.length ||
        columnKeys.some((key, position) => key !== result.groupBy[position])
      )
        ctx.addIssue({
          code: "custom",
          message: "Row dimensions must follow groupBy order",
          path: ["rows", index, "dimensions"],
        });
      if (row.values.length !== result.definitions.length)
        ctx.addIssue({
          code: "custom",
          message: "Every row carries one value per definition",
          path: ["rows", index, "values"],
        });
      for (const [position, cell] of row.values.entries()) {
        const definition = byCode.get(cell.metricCode);
        if (definition === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "Row value metric is missing from definitions",
            path: ["rows", index, "values", position, "metricCode"],
          });
          continue;
        }
        if (cell.metricCode !== result.definitions[position]?.code)
          ctx.addIssue({
            code: "custom",
            message: "Row values must follow definitions order",
            path: ["rows", index, "values", position, "metricCode"],
          });
        if (cell.value !== null && unavailable.has(cell.metricCode))
          ctx.addIssue({
            code: "custom",
            message: "An unavailable metric carries only null values",
            path: ["rows", index, "values", position, "value"],
          });
        if (cell.value !== null && cell.value.unit !== definition.unit)
          ctx.addIssue({
            code: "custom",
            message: `Cell value unit must be ${definition.unit}`,
            path: ["rows", index, "values", position, "value", "unit"],
          });
        // SH-02: a figure is final only when its bucket is closed and, for
        // closed-period-only metrics or reports, its books are closed too.
        // A total bucket is the whole period, so the period decides. A split
        // bucket is ruled by the engine per bucket (a closed month can sit in
        // a longer period); the schema only knows the last bucket of an open
        // period is still running.
        if (cell.finality === "final") {
          const wholePeriod = result.bucket === "total";
          const running =
            result.period.status === "open" &&
            (wholePeriod || row.bucketEnd >= result.period.endDate);
          const booksOpen =
            wholePeriod &&
            !result.period.accountingPeriodClosed &&
            (definition.officiality === "closed_period_only" ||
              report?.closedPeriodOnly === true);
          if (running || booksOpen)
            ctx.addIssue({
              code: "custom",
              message:
                "An open or not-yet-closed bucket can only report estimates (SH-02)",
              path: ["rows", index, "values", position, "finality"],
            });
        }
      }
    }
  });
export type ReportResult = z.infer<typeof reportResultSchema>;

// ---- Saved reports ---------------------------------------------------------

export const SAVED_REPORT_STATUSES = ["active", "archived"] as const;
export const savedReportStatusSchema = z.enum(SAVED_REPORT_STATUSES);
export type SavedReportStatus = z.infer<typeof savedReportStatusSchema>;

/**
 * A builder query saved by one user (PRD §3.36 "Report Builder ... simpan").
 * PRD is silent on sharing, so the safest option is kept: a saved report is
 * private to its owner (`ownerUserId`) and only visible to roles that already
 * hold the builder permissions; sharing is a follow-up, not a silent default.
 */
export const savedReportSchema = z
  .strictObject({
    id: savedReportIdSchema,
    tenantId: tenantIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(500).nullable(),
    query: reportBuilderQuerySchema,
    ownerUserId: userIdSchema,
    status: savedReportStatusSchema,
    lastRunAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((report, ctx) => {
    if (Date.parse(report.updatedAt) < Date.parse(report.createdAt))
      ctx.addIssue({
        code: "custom",
        message: "updatedAt must not be before createdAt",
        path: ["updatedAt"],
      });
  });
export type SavedReport = Readonly<z.infer<typeof savedReportSchema>>;

export const createSavedReportInputSchema = clientInputSchema({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500).optional(),
  query: reportBuilderQuerySchema,
});
export type CreateSavedReportInput = z.infer<
  typeof createSavedReportInputSchema
>;

export const updateSavedReportInputSchema = clientInputSchema({
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(500).nullable().optional(),
  query: reportBuilderQuerySchema.optional(),
  status: savedReportStatusSchema.optional(),
}).superRefine((patch, ctx) => {
  if (Object.keys(patch).length === 0)
    ctx.addIssue({
      code: "custom",
      message: "Send at least one field to update",
      path: [],
    });
});
export type UpdateSavedReportInput = z.infer<
  typeof updateSavedReportInputSchema
>;

export const savedReportListQuerySchema = cursorPageQuerySchema;
export const savedReportPageSchema = cursorPageSchema(savedReportSchema);
export type SavedReportPage = z.infer<typeof savedReportPageSchema>;

// ---- Email schedules -------------------------------------------------------

export const REPORT_SCHEDULE_FREQUENCIES = [
  "daily",
  "weekly",
  "monthly",
] as const;
export const reportScheduleFrequencySchema = z.enum(
  REPORT_SCHEDULE_FREQUENCIES,
);
export type ReportScheduleFrequency = z.infer<
  typeof reportScheduleFrequencySchema
>;

const timeOfDaySchema = z
  .string()
  .regex(
    /^([01]\d|2[0-3]):[0-5]\d$/,
    "timeOfDay is HH:MM in the outlet time zone",
  );

const scheduleSettingsShape = {
  frequency: reportScheduleFrequencySchema,
  /** Local delivery time in the outlet time zone (business dates). */
  timeOfDay: timeOfDaySchema,
  /** ISO weekday 1 (Monday) .. 7 (Sunday); weekly only. */
  dayOfWeek: z.number().int().min(1).max(7).nullable().default(null),
  /** Day of month 1..28 keeps every month valid; monthly only. */
  dayOfMonth: z.number().int().min(1).max(28).nullable().default(null),
  format: reportExportFormatSchema,
  /**
   * Recipients are tenant users, never typed addresses (PRD §3.36 says email:
   * the server resolves each user's email and keeps only users holding the
   * report's permissions, so no external address can receive a report).
   */
  recipientUserIds: z.array(z.uuid()).min(1).max(20),
};

function refineScheduleSettings(
  settings: {
    frequency: ReportScheduleFrequency;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    recipientUserIds: readonly string[];
  },
  ctx: z.RefinementCtx,
): void {
  if (settings.frequency === "daily") {
    if (settings.dayOfWeek !== null)
      ctx.addIssue({
        code: "custom",
        message: "A daily schedule has no dayOfWeek",
        path: ["dayOfWeek"],
      });
    if (settings.dayOfMonth !== null)
      ctx.addIssue({
        code: "custom",
        message: "A daily schedule has no dayOfMonth",
        path: ["dayOfMonth"],
      });
  }
  if (settings.frequency === "weekly") {
    if (settings.dayOfWeek === null)
      ctx.addIssue({
        code: "custom",
        message: "A weekly schedule needs dayOfWeek",
        path: ["dayOfWeek"],
      });
    if (settings.dayOfMonth !== null)
      ctx.addIssue({
        code: "custom",
        message: "A weekly schedule has no dayOfMonth",
        path: ["dayOfMonth"],
      });
  }
  if (settings.frequency === "monthly") {
    if (settings.dayOfMonth === null)
      ctx.addIssue({
        code: "custom",
        message: "A monthly schedule needs dayOfMonth",
        path: ["dayOfMonth"],
      });
    if (settings.dayOfWeek !== null)
      ctx.addIssue({
        code: "custom",
        message: "A monthly schedule has no dayOfWeek",
        path: ["dayOfWeek"],
      });
  }
  const normalized = settings.recipientUserIds.map((id) => id.toLowerCase());
  if (new Set(normalized).size !== normalized.length)
    ctx.addIssue({
      code: "custom",
      message: "recipientUserIds repeat a user",
      path: ["recipientUserIds"],
    });
}

/**
 * Email delivery of one saved report (PRD §3.36 "jadwalkan pengiriman via
 * email"). The server computes `nextRunAt` from the outlet time zone and
 * stops the schedule on repeated provider failures.
 */
export const reportScheduleSchema = z
  .strictObject({
    id: reportScheduleIdSchema,
    tenantId: tenantIdSchema,
    savedReportId: savedReportIdSchema,
    ...scheduleSettingsShape,
    isEnabled: z.boolean(),
    nextRunAt: isoDateTimeSchema.nullable(),
    lastRunAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((schedule, ctx) => {
    refineScheduleSettings(schedule, ctx);
    if (Date.parse(schedule.updatedAt) < Date.parse(schedule.createdAt))
      ctx.addIssue({
        code: "custom",
        message: "updatedAt must not be before createdAt",
        path: ["updatedAt"],
      });
  });
export type ReportSchedule = Readonly<z.infer<typeof reportScheduleSchema>>;

export const createReportScheduleInputSchema = clientInputSchema({
  savedReportId: savedReportIdSchema,
  ...scheduleSettingsShape,
}).superRefine(refineScheduleSettings);
export type CreateReportScheduleInput = z.infer<
  typeof createReportScheduleInputSchema
>;

/** Full replace of the settings plus the enable switch. */
export const updateReportScheduleInputSchema = clientInputSchema({
  ...scheduleSettingsShape,
  isEnabled: z.boolean(),
}).superRefine(refineScheduleSettings);
export type UpdateReportScheduleInput = z.infer<
  typeof updateReportScheduleInputSchema
>;

export const reportSchedulePageSchema = cursorPageSchema(reportScheduleSchema);
export type ReportSchedulePage = z.infer<typeof reportSchedulePageSchema>;

/** Format a schedule sends; mirrors the export formats. */
export const REPORT_SCHEDULE_FORMATS = [
  "csv",
  "xlsx",
  "pdf",
] as const satisfies readonly ReportExportFormat[];

/**
 * A tenant user a schedule can be sent to. Name and role only: the email stays
 * on the server, which resolves it from the user id (DASH-04 keeps addresses
 * out of the client and out of saved schedules).
 */
export const reportScheduleRecipientSchema = z.strictObject({
  userId: z.uuid(),
  name: z.string().min(1).max(150),
  roleName: z.string().min(1).max(100),
});
export type ReportScheduleRecipient = z.infer<
  typeof reportScheduleRecipientSchema
>;

export const reportScheduleRecipientPageSchema = cursorPageSchema(
  reportScheduleRecipientSchema,
);
export type ReportScheduleRecipientPage = z.infer<
  typeof reportScheduleRecipientPageSchema
>;

/**
 * GET /api/reports/schedule-recipients: the users the schedule form offers.
 * The server lists only users of the caller's tenant who hold the permissions
 * of reports they may schedule; never an external address.
 */
export const listReportScheduleRecipientsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/reports/schedule-recipients",
  query: cursorPageQuerySchema,
  response: reportScheduleRecipientPageSchema,
});
