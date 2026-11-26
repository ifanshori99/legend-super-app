// Metric layer contract (PRD v1.7 §5 "Lapisan metrik baku", §6 J
// metric_definitions + metrics_daily, DASH-01, SH-02).
//
// One registry feeds dashboards, reports, the report builder, Tanya AI and MCP,
// so every number carries the same code, formula, unit, dimensions, grain,
// period and source report link (DASH-01). Official shareholder figures exist
// only for closed periods; anything inside an open period is an estimate
// (SH-02).
//
// PRD §6 storage: `metric_definitions` is global (code, name, formula, unit,
// owner_module) and `metrics_daily` is tenant-scoped (outlet_id, metric_date,
// metric_code, dimension, value). This contract adds version, dimensions,
// grain, source report and officiality so the registry can be evaluated and
// cited. Ids follow @starter/shared/core: UUID for the definition row, business
// dates for metric_date, whole rupiah (Idr) for money, Decimal4 for rates.

import {
  businessDateSchema,
  clientInputSchema,
  cursorPageSchema,
  cursorSchema,
  decimal4Schema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  tenantIdSchema,
  uuidIdSchema,
  z,
} from "../core/index.ts";

// ---- Vocabulary ------------------------------------------------------------

/** Global metric code, stable once shipped ("net_sales", "food_cost_pct"). */
export const metricCodeSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    "Metric codes are lower_snake_case",
  );
export type MetricCode = z.infer<typeof metricCodeSchema>;

/**
 * Unit of the stored value. `idr` is whole rupiah (BIGINT, `valueIdr`);
 * `count` and `seconds` are integers; `percent` and `decimal` are NUMERIC(14,4)
 * decimal strings (Decimal4), never floats.
 */
export const METRIC_UNITS = [
  "idr",
  "count",
  "percent",
  "decimal",
  "seconds",
] as const;
export const metricUnitSchema = z.enum(METRIC_UNITS);
export type MetricUnit = z.infer<typeof metricUnitSchema>;

const safeIntegerSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, "Expected a safe integer");

/** A stored metric value, typed by its unit. */
export const metricValueSchema = z.discriminatedUnion("unit", [
  z.strictObject({ unit: z.literal("idr"), valueIdr: idrSchema }),
  z.strictObject({ unit: z.literal("count"), value: safeIntegerSchema }),
  z.strictObject({ unit: z.literal("percent"), value: decimal4Schema }),
  z.strictObject({ unit: z.literal("decimal"), value: decimal4Schema }),
  z.strictObject({ unit: z.literal("seconds"), value: safeIntegerSchema }),
]);
export type MetricValue = z.infer<typeof metricValueSchema>;

/**
 * Dimension keys a value can be split by. The PRD names per hour, per channel,
 * per menu, per employee, per outlet and per zone (F34-F36, U19). Kept as a
 * validated string, not a closed enum: the report catalog (WS-11 CT) declares
 * which keys each metric actually supports in `MetricDefinition.dimensions`.
 */
export const CORE_METRIC_DIMENSIONS = [
  "outlet",
  "hour",
  "day_of_week",
  "channel",
  "payment_method",
  "menu_item",
  "menu_category",
  "zone",
  "employee",
  "station",
  "customer_tier",
  "supplier",
  "facility",
  "unit",
  "product",
  "promo",
  "legal_entity",
] as const;
export const metricDimensionKeySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    "Dimension keys are lower_snake_case",
  );
export type MetricDimensionKey = z.infer<typeof metricDimensionKeySchema>;

/** Split value of a series (`groupBy` result); null when the series is not split. */
export const metricDimensionValueSchema = z.strictObject({
  key: metricDimensionKeySchema,
  value: z.string().min(1).max(120),
});
export type MetricDimensionValue = z.infer<typeof metricDimensionValueSchema>;

/** Module that owns the metric formula (PRD §6 metric_definitions.owner_module). */
export const METRIC_OWNER_MODULES = [
  "menu",
  "pos",
  "kitchen",
  "payments",
  "inventory",
  "accounting",
  "crm",
  "loyalty",
  "reservation",
  "facility",
  "hris",
  "payroll",
  "operations",
  "platform",
  "ai",
] as const;
export const metricOwnerModuleSchema = z.enum(METRIC_OWNER_MODULES);
export type MetricOwnerModule = z.infer<typeof metricOwnerModuleSchema>;

/** Finest aggregation grain stored for a metric. metrics_daily is `day`. */
export const METRIC_GRAINS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
] as const;
export const metricGrainSchema = z.enum(METRIC_GRAINS);
export type MetricGrain = z.infer<typeof metricGrainSchema>;

/** Response bucket: the stored grains plus one value for the whole period. */
export const METRIC_BUCKETS = [...METRIC_GRAINS, "total"] as const;
export const metricBucketSchema = z.enum(METRIC_BUCKETS);
export type MetricBucket = z.infer<typeof metricBucketSchema>;

/**
 * How a period value is derived from stored points:
 * - sum: additive metrics (net sales, pax, transactions).
 * - average: mean of stored points (occupancy, turnover).
 * - latest: the newest point (cash balance, headcount).
 * - ratio: recomputed from the formula over component totals (food cost %,
 *   labor cost %, EBITDA margin). Never sum or average stored percentages.
 */
export const METRIC_AGGREGATIONS = [
  "sum",
  "average",
  "latest",
  "ratio",
] as const;
export const metricAggregationSchema = z.enum(METRIC_AGGREGATIONS);
export type MetricAggregation = z.infer<typeof metricAggregationSchema>;

/**
 * When a metric has official values (SH-02). `closed_period_only` metrics
 * (food cost %, labor cost %, net profit, EBITDA) stay estimates until the
 * covering accounting period is closed; `live` metrics become final when their
 * calendar bucket (day, month, ...) is closed.
 */
export const METRIC_OFFICIALITIES = ["closed_period_only", "live"] as const;
export const metricOfficialitySchema = z.enum(METRIC_OFFICIALITIES);
export type MetricOfficiality = z.infer<typeof metricOfficialitySchema>;

/** Finality label attached to every returned value (SH-02). */
export const METRIC_FINALITIES = ["estimate", "final"] as const;
export const metricFinalitySchema = z.enum(METRIC_FINALITIES);
export type MetricFinality = z.infer<typeof metricFinalitySchema>;

/** Definition lifecycle: only active definitions answer queries. */
export const METRIC_DEFINITION_STATUSES = [
  "draft",
  "active",
  "deprecated",
] as const;
export const metricDefinitionStatusSchema = z.enum(METRIC_DEFINITION_STATUSES);
export type MetricDefinitionStatus = z.infer<
  typeof metricDefinitionStatusSchema
>;

// ---- Registry --------------------------------------------------------------

/** Report code + base route used for DASH-01 drill-down. */
export const reportCodeSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(
    /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/,
    "Report codes are lower_snake_case or dotted",
  );
export type ReportCode = z.infer<typeof reportCodeSchema>;

export const metricSourceReportSchema = z.strictObject({
  reportCode: reportCodeSchema,
  /** App-relative base path; period and filters are added by metricSourceReportPath. */
  route: z
    .string()
    .min(1)
    .max(300)
    .refine(
      (route) => route.startsWith("/") && !/[?#]/.test(route),
      "Report routes are app-relative paths without a query or fragment",
    ),
});
export type MetricSourceReport = z.infer<typeof metricSourceReportSchema>;

/** Formula reference: stable evaluator id, readable expression and metric inputs. */
export const metricFormulaSchema = z
  .strictObject({
    formulaRef: z
      .string()
      .min(3)
      .max(120)
      .regex(
        /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/,
        "Formula refs are lower_snake_case or dotted",
      ),
    expression: z.string().min(1).max(1000),
    /** Metric codes this formula reads; empty when it reads raw domain data. */
    inputs: z.array(metricCodeSchema).max(20),
  })
  .superRefine((formula, ctx) => {
    if (new Set(formula.inputs).size !== formula.inputs.length)
      ctx.addIssue({
        code: "custom",
        message: "Formula inputs repeat a metric code",
        path: ["inputs"],
      });
  });
export type MetricFormula = z.infer<typeof metricFormulaSchema>;

const metricDefinitionBaseSchema = z.strictObject({
  id: uuidIdSchema<"MetricDefinitionId">(),
  code: metricCodeSchema,
  /** Bumped when the formula changes, so historical reports stay explainable. */
  version: z.number().int().positive().safe(),
  name: z.string().min(1).max(150),
  description: z.string().min(1).max(2000),
  ownerModule: metricOwnerModuleSchema,
  formula: metricFormulaSchema,
  unit: metricUnitSchema,
  aggregation: metricAggregationSchema,
  /** Dimension keys this metric can be split by; empty means no split. */
  dimensions: z.array(metricDimensionKeySchema).max(20),
  grain: metricGrainSchema,
  officiality: metricOfficialitySchema,
  sourceReport: metricSourceReportSchema,
  status: metricDefinitionStatusSchema,
  /** First business date the version applies to. */
  effectiveFrom: businessDateSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/**
 * One registry row (PRD §6 metric_definitions is global, not tenant-scoped).
 * Tenant-specific choices are settings, never a copied definition (TEN-07).
 */
export const metricDefinitionSchema = metricDefinitionBaseSchema.superRefine(
  (definition, ctx) => {
    if (new Set(definition.dimensions).size !== definition.dimensions.length)
      ctx.addIssue({
        code: "custom",
        message: "Definition dimensions repeat a key",
        path: ["dimensions"],
      });
    if (definition.formula.inputs.includes(definition.code))
      ctx.addIssue({
        code: "custom",
        message: "A metric cannot use itself as a formula input",
        path: ["formula", "inputs"],
      });
    // Percentages are never added up across days or outlets: a percent metric
    // is recomputed from its components (ratio), averaged, or read as latest.
    if (definition.unit === "percent" && definition.aggregation === "sum")
      ctx.addIssue({
        code: "custom",
        message: "A percent metric cannot use sum aggregation",
        path: ["aggregation"],
      });
    // A ratio is recomputed over component totals, so its formula must name
    // at least one registered metric it divides by or reads.
    if (
      definition.aggregation === "ratio" &&
      definition.formula.inputs.length === 0
    )
      ctx.addIssue({
        code: "custom",
        message: "A ratio metric lists the metrics it is computed from",
        path: ["formula", "inputs"],
      });
    if (Date.parse(definition.updatedAt) < Date.parse(definition.createdAt))
      ctx.addIssue({
        code: "custom",
        message: "updatedAt must not be before createdAt",
        path: ["updatedAt"],
      });
  },
);
export type MetricDefinition = Readonly<z.infer<typeof metricDefinitionSchema>>;

/** The definition fields every dashboard tile, report row and AI answer cites. */
export const metricDefinitionRefSchema = metricDefinitionBaseSchema.pick({
  id: true,
  code: true,
  version: true,
  name: true,
  ownerModule: true,
  formula: true,
  unit: true,
  aggregation: true,
  dimensions: true,
  grain: true,
  officiality: true,
  sourceReport: true,
});
export type MetricDefinitionRef = z.infer<typeof metricDefinitionRefSchema>;

/** GET /metrics/definitions — registry browsing for the report builder. */
export const metricDefinitionListQuerySchema = clientInputSchema({
  cursor: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  ownerModule: metricOwnerModuleSchema.optional(),
  status: metricDefinitionStatusSchema.optional(),
  unit: metricUnitSchema.optional(),
});
export type MetricDefinitionListQuery = z.infer<
  typeof metricDefinitionListQuerySchema
>;

export const metricDefinitionListResponseSchema = cursorPageSchema(
  metricDefinitionSchema,
);
export type MetricDefinitionListResponse = z.infer<
  typeof metricDefinitionListResponseSchema
>;

/**
 * One `metrics_daily` row (PRD §6 J: outlet_id, metric_date, metric_code,
 * dimension, value). Tenant-scoped by RLS, so the service layer passes the
 * tenant id it resolved from the context (TEN-02); clients never send one.
 * The definition id/version pinned per row keeps old reports explainable after
 * a formula version bump, and `finality` is what makes SH-02 auditable.
 */
export const metricDailyRowSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  metricDate: businessDateSchema,
  metricCode: metricCodeSchema,
  /** Null is the metric total; otherwise the split value stored for the row. */
  dimension: metricDimensionValueSchema.nullable(),
  value: metricValueSchema,
  finality: metricFinalitySchema,
  definitionId: uuidIdSchema<"MetricDefinitionId">(),
  definitionVersion: z.number().int().positive().safe(),
  updatedAt: isoDateTimeSchema,
});
export type MetricDailyRow = z.infer<typeof metricDailyRowSchema>;

// ---- Periods ---------------------------------------------------------------

/**
 * The period a set of values describes.
 * - `status` is the calendar state of the range: `closed` once endDate is
 *   before the outlet's current business date.
 * - `accountingPeriodClosed` is true only when the whole range falls inside
 *   accounting periods that are closed (WS-07 fiscal_period.closed), which is
 *   what makes `closed_period_only` metrics final (SH-02).
 */
export const metricPeriodSchema = z
  .strictObject({
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    bucket: metricBucketSchema,
    status: z.enum(["open", "closed"]),
    accountingPeriodClosed: z.boolean(),
  })
  .superRefine((period, ctx) => {
    if (period.startDate > period.endDate)
      ctx.addIssue({
        code: "custom",
        message: "startDate must not be after endDate",
        path: ["endDate"],
      });
    if (period.status === "open" && period.accountingPeriodClosed)
      ctx.addIssue({
        code: "custom",
        message:
          "An open calendar period cannot have a closed accounting period",
        path: ["accountingPeriodClosed"],
      });
  });
export type MetricPeriod = z.infer<typeof metricPeriodSchema>;

// ---- Query contract --------------------------------------------------------

/** Inclusive business-date range a caller asks for. */
export const metricQueryPeriodSchema = z
  .strictObject({
    startDate: businessDateSchema,
    endDate: businessDateSchema,
  })
  .refine((period) => period.startDate <= period.endDate, {
    message: "startDate must not be after endDate",
    path: ["endDate"],
  });
export type MetricQueryPeriod = z.infer<typeof metricQueryPeriodSchema>;

export const metricDimensionFilterSchema = z.strictObject({
  key: metricDimensionKeySchema,
  values: z.array(z.string().min(1).max(120)).min(1).max(20),
});
export type MetricDimensionFilter = z.infer<typeof metricDimensionFilterSchema>;

/**
 * One query shape for dashboards, reports, report builder, Tanya AI and MCP.
 * The caller never sends tenant fields (TEN-02); outletIds is a request that
 * the server intersects with the role's outlet scope (TEN-03,
 * outletIdsForQuery). `requireFinal` is the shareholder dashboard's
 * official-only switch: the server answers PERIOD_NOT_CLOSED instead of
 * returning estimate figures (SH-02).
 */
export const metricQueryRequestSchema = clientInputSchema({
  metricCodes: z.array(metricCodeSchema).min(1).max(30),
  period: metricQueryPeriodSchema,
  bucket: metricBucketSchema.default("total"),
  outletIds: z.array(outletIdSchema).min(1).max(50).optional(),
  groupBy: metricDimensionKeySchema.optional(),
  filters: z.array(metricDimensionFilterSchema).max(5).optional(),
  comparePrevious: z.boolean().default(false),
  requireFinal: z.boolean().default(false),
});
export type MetricQueryRequest = z.infer<typeof metricQueryRequestSchema>;

/** Outlets the server actually queried, mirroring outletIdsForQuery. */
export const metricOutletFilterSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("outlets"),
    outletIds: z.array(outletIdSchema).min(1).max(100),
  }),
]);
export type MetricOutletFilter = z.infer<typeof metricOutletFilterSchema>;

/** Previous-period comparison; units always match the point's unit. */
export const metricComparisonSchema = z.strictObject({
  previousValue: metricValueSchema,
  changeValue: metricValueSchema,
  /**
   * Relative change in percent (Decimal4), against the absolute previous value
   * so a smaller loss reads as an improvement. Null when the previous value was
   * zero.
   */
  changePercent: decimal4Schema.nullable(),
});
export type MetricComparison = z.infer<typeof metricComparisonSchema>;

export const metricPointSchema = z
  .strictObject({
    bucketStart: businessDateSchema,
    bucketEnd: businessDateSchema,
    /** Null means no data for the bucket; never report a blank as zero. */
    value: metricValueSchema.nullable(),
    finality: metricFinalitySchema,
    comparison: metricComparisonSchema.nullable(),
  })
  .superRefine((point, ctx) => {
    if (point.bucketStart > point.bucketEnd)
      ctx.addIssue({
        code: "custom",
        message: "bucketStart must not be after bucketEnd",
        path: ["bucketEnd"],
      });
  });
export type MetricPoint = z.infer<typeof metricPointSchema>;

export const metricSeriesSchema = z
  .strictObject({
    metricCode: metricCodeSchema,
    definition: metricDefinitionRefSchema,
    dimension: metricDimensionValueSchema.nullable(),
    points: z.array(metricPointSchema).max(2000),
  })
  .superRefine((series, ctx) => {
    if (series.definition.code !== series.metricCode)
      ctx.addIssue({
        code: "custom",
        message: "Series definition does not match the metric code",
        path: ["definition", "code"],
      });
    for (const [index, point] of series.points.entries()) {
      if (point.value !== null && point.value.unit !== series.definition.unit)
        ctx.addIssue({
          code: "custom",
          message: `Point value unit must be ${series.definition.unit}`,
          path: ["points", index, "value", "unit"],
        });
      if (
        point.comparison !== null &&
        (point.comparison.previousValue.unit !== series.definition.unit ||
          point.comparison.changeValue.unit !== series.definition.unit)
      )
        ctx.addIssue({
          code: "custom",
          message: "Comparison values must use the series unit",
          path: ["points", index, "comparison"],
        });
    }
  });
export type MetricSeries = z.infer<typeof metricSeriesSchema>;

/** Stable key for a (metric, dimension value) series. */
export function metricSeriesKey(
  series: Pick<MetricSeries, "metricCode" | "dimension">,
): string {
  return series.dimension === null
    ? series.metricCode
    : `${series.metricCode}|${series.dimension.key}=${series.dimension.value}`;
}

/** Book state of one calendar month in a metric query (`meta`). */
export const metricAccountingPeriodSchema = z.strictObject({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period is YYYY-MM"),
  accountingVersion: z.number().int().nonnegative().safe(),
  /** Every legal entity with books in the month closed it (SH-02). */
  closed: z.boolean(),
});
export type MetricAccountingPeriod = z.infer<
  typeof metricAccountingPeriodSchema
>;

// ---- Availability ----------------------------------------------------------

/** Why a metric has no value: its source or dimension is not built yet. */
export const METRIC_UNAVAILABLE_REASONS = [
  "source_not_built",
  "dimension_not_supported",
] as const;
export const metricUnavailableReasonSchema = z.enum(METRIC_UNAVAILABLE_REASONS);
export type MetricUnavailableReason = z.infer<
  typeof metricUnavailableReasonSchema
>;

/** One entry per requested metric: available, or unavailable with a reason. */
export const metricAvailabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    metricCode: metricCodeSchema,
    status: z.literal("available"),
    /** A caveat of the figure, e.g. EBITDA roles an entity has not mapped. */
    note: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({
    metricCode: metricCodeSchema,
    status: z.literal("unavailable"),
    reason: metricUnavailableReasonSchema,
    message: z.string().min(1).max(200),
  }),
]);
export type MetricAvailability = z.infer<typeof metricAvailabilitySchema>;

/** Indonesian user-facing sentence per unavailable reason. */
export const METRIC_UNAVAILABLE_MESSAGES: Record<
  MetricUnavailableReason,
  string
> = {
  source_not_built: "Data metrik ini belum tersedia.",
  dimension_not_supported: "Metrik ini belum bisa dirinci menurut dimensi itu.",
};

/** Residual row of a ledger-controlled split (DASH-02). */
export const METRIC_LEDGER_ADJUSTMENT = "__ledger_adjustment__";

export const metricQueryResponseSchema = z.strictObject({
  data: z
    .strictObject({
      period: metricPeriodSchema,
      outletFilter: metricOutletFilterSchema,
      /** One entry per requested metric, including metrics without data. */
      definitions: z.array(metricDefinitionRefSchema).min(1).max(30),
      series: z.array(metricSeriesSchema).max(3000),
      /** One entry per definition, same order. */
      availability: z.array(metricAvailabilitySchema).min(1).max(30),
    })
    .superRefine((data, ctx) => {
      const definitionCodes = data.definitions.map(
        (definition) => definition.code,
      );
      if (new Set(definitionCodes).size !== definitionCodes.length)
        ctx.addIssue({
          code: "custom",
          message: "Definitions repeat a metric code",
          path: ["definitions"],
        });
      const byCode = new Map(
        data.definitions.map((definition) => [definition.code, definition]),
      );
      if (
        data.availability.length !== definitionCodes.length ||
        data.availability.some(
          (entry, position) => entry.metricCode !== definitionCodes[position],
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Availability must list the definitions in the same order",
          path: ["availability"],
        });
      const unavailable = new Set(
        data.availability
          .filter((entry) => entry.status === "unavailable")
          .map((entry) => entry.metricCode),
      );
      const seriesKeys = data.series.map((series) => metricSeriesKey(series));
      if (new Set(seriesKeys).size !== seriesKeys.length)
        ctx.addIssue({
          code: "custom",
          message: "Series repeat a metric and dimension value",
          path: ["series"],
        });
      for (const [index, series] of data.series.entries()) {
        const definition = byCode.get(series.metricCode);
        if (definition === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "Series metric is missing from definitions",
            path: ["series", index, "metricCode"],
          });
          continue;
        }
        if (
          unavailable.has(series.metricCode) &&
          series.points.some((point) => point.value !== null)
        )
          ctx.addIssue({
            code: "custom",
            message: "An unavailable metric carries only null points",
            path: ["series", index, "points"],
          });
        if (
          series.definition.code !== definition.code ||
          series.definition.version !== definition.version ||
          series.definition.unit !== definition.unit
        )
          ctx.addIssue({
            code: "custom",
            message: "Series definition differs from the registry entry",
            path: ["series", index, "definition"],
          });
      }
    }),
  meta: z.strictObject({
    generatedAt: isoDateTimeSchema,
    /** Latest business date with data in the queried scope. */
    dataThrough: businessDateSchema,
    /**
     * Book state of every calendar month the period touches, read in the same
     * snapshot as the values. `accountingVersion` is the sum of the month's
     * fiscal period versions over all legal entities (0 without books): it
     * grows on every close, reopen and newly opened book, so a cached figure
     * whose version differs is stale. Optional for fixtures made before it.
     */
    accountingPeriods: z
      .array(metricAccountingPeriodSchema)
      .max(2000)
      .optional(),
  }),
});
export type MetricQueryResponse = z.infer<typeof metricQueryResponseSchema>;
