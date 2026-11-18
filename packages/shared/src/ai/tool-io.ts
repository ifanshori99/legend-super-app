// Tool input/output schemas for TL-01..TL-21 (bead legend-1zxo, WS-12).
// PRD v1.7 §3 Fitur 38 (Jawaban Bersumber), 39 (tool table, MCP-01..05),
// 40 (Input Minimum). One catalog serves Tanya AI and MCP (D32).
//
// Conventions: wire is camelCase, enum values snake_case, strict objects.
// Client INPUT never carries tenantId (tenant comes from token or domain);
// the server intersects outlet filters with the caller's outlet scope.
// Money is whole rupiah (`idrSchema`, a signed safe integer, so P&L lines and
// deltas use it directly). Percent and quantity are Decimal4 strings, as in
// `metrics`. Write tools (TL-13..18) never mutate: they only return an
// action-request receipt linked to an approval request (AIG-03).

import {
  businessDateSchema,
  decimal4Schema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  parseDecimal4,
  timeOfDaySchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import {
  accountCodeSchema,
  distributionRunStatusSchema,
  legalEntityIdSchema,
} from "../accounting/index.ts";
import { facilityIdSchema } from "../facility/ids.ts";
import { employeeIdSchema, shiftAssignmentIdSchema } from "../hris/ids.ts";
import { payslipIdSchema } from "../hris/payroll/ids.ts";
import { approvalRequestIdSchema } from "../identity/ids.ts";
import { approvalRequestStatusSchema } from "../identity/schemas.ts";
import { inventoryItemIdSchema, supplierIdSchema } from "../inventory/index.ts";
import { metricCodeSchema, metricFinalitySchema } from "../metrics/index.ts";
import {
  actionRequestIdSchema,
  actionRequestStatusSchema,
  actionRequestToolCodeSchema,
  knowledgeChunkIdSchema,
} from "./ids.ts";
import type { AiToolCode } from "./ids.ts";

// ---- Limits ----------------------------------------------------------------

/** Hard cap on rows in any tool response (MCP-03, §40 maxRowsPerResponse). */
export const TOOL_MAX_ROWS = 200;
/** Longest period a single read tool call may span, inclusive of both ends. */
export const TOOL_MAX_PERIOD_DAYS = 366;
/** Outlet filter cap, same bound as the write tools' outlet lists. */
export const TOOL_MAX_OUTLET_FILTER = 50;
/**
 * TL-07 privacy floor (§40 Input Minimum): the server merges any segment
 * smaller than this into a neighbour, so a segment never singles out a person.
 */
export const CUSTOMER_SEGMENT_MIN_SIZE = 5;

// ---- Shared pieces ---------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** An outlet id list with no repeated id. */
function uniqueOutletIdsSchema<T extends z.ZodType<readonly string[]>>(
  schema: T,
) {
  return schema.refine((ids) => new Set(ids).size === ids.length, {
    message: "outletIds must be unique",
  });
}

function daysInclusive(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      MS_PER_DAY +
    1
  );
}

/** Day number of a YYYY-MM-DD date (UTC, no timezone drift). NaN if malformed. */
function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return Number.NaN;
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
    MS_PER_DAY
  );
}

/** ISO weekday of a YYYY-MM-DD date: 1 = Monday .. 7 = Sunday. NaN if malformed. */
function isoWeekday(date: string): number {
  const day = new Date(dayNumber(date) * MS_PER_DAY).getUTCDay();
  return day === 0 ? 7 : day;
}

function hasDuplicates(keys: readonly string[]): boolean {
  return new Set(keys).size !== keys.length;
}

/** Business-date range, from <= to, at most 366 days. */
export const toolPeriodSchema = z
  .strictObject({ from: businessDateSchema, to: businessDateSchema })
  .refine((period) => period.from <= period.to, {
    message: "Period start must be on or before its end",
    path: ["to"],
  })
  .refine(
    (period) =>
      period.from > period.to ||
      daysInclusive(period.from, period.to) <= TOOL_MAX_PERIOD_DAYS,
    {
      message: `Period may span at most ${TOOL_MAX_PERIOD_DAYS} days`,
      path: ["to"],
    },
  );
export type ToolPeriod = z.infer<typeof toolPeriodSchema>;

/** Optional outlet filter. The server intersects it with the caller's scope (TEN-03). */
export const toolOutletFilterSchema = z.strictObject({
  outletIds: z.array(outletIdSchema).max(TOOL_MAX_OUTLET_FILTER).optional(),
});
export type ToolOutletFilter = z.infer<typeof toolOutletFilterSchema>;

/** App-relative link to the source report. Rejects absolute and protocol-relative URLs. */
export const toolLinkSchema = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)\S*$/, "Link must be a relative app path starting with '/'");
export type ToolLink = z.infer<typeof toolLinkSchema>;

/** "Jawaban Bersumber" (§3 Fitur 38): metric, period and report link for numbers. */
export const toolSourceSchema = z.strictObject({
  metricCode: metricCodeSchema.optional(),
  label: z.string().trim().min(1).max(120),
  period: toolPeriodSchema,
  finality: metricFinalitySchema,
  link: toolLinkSchema,
});
export type ToolSource = z.infer<typeof toolSourceSchema>;

/** Every read output that returns numbers carries at least one source. */
const sourcesSchema = z.array(toolSourceSchema).min(1).max(20);
const truncatedSchema = z.boolean();
const rowKeySchema = z.string().trim().min(1).max(120);
const rowLabelSchema = z.string().trim().min(1).max(200);
const countSchema = z.number().int().nonnegative();
const noteSchema = z.string().trim().min(1).max(500);
const reasonSchema = z.string().trim().min(1).max(300);
const stationSchema = z.string().trim().min(1).max(80);

function rows<T extends z.ZodType>(row: T) {
  return z.array(row).max(TOOL_MAX_ROWS);
}

const positiveDecimal4Schema = decimal4Schema.refine(
  (value) => parseDecimal4(value) > 0n,
  "Quantity must be greater than zero",
);
const nonZeroDecimal4Schema = decimal4Schema.refine(
  (value) => parseDecimal4(value) !== 0n,
  "Quantity change must not be zero",
);
const nonNegativeDecimal4Schema = decimal4Schema.refine(
  (value) => parseDecimal4(value) >= 0n,
  "Value must not be negative",
);

// ---- Write receipt (TL-13..TL-18) ------------------------------------------

/** AIG-03: a write tool only creates a pending action request awaiting approval. */
export const actionRequestReceiptSchema = z.strictObject({
  actionRequestId: actionRequestIdSchema,
  approvalRequestId: approvalRequestIdSchema,
  toolCode: actionRequestToolCodeSchema,
  status: z.literal("pending"),
  summary: z.string().trim().min(1).max(280),
});
export type ActionRequestReceipt = z.infer<typeof actionRequestReceiptSchema>;

// ---- TL-01 get_sales_summary -----------------------------------------------

export const SALES_GROUP_BY = ["day", "outlet", "channel"] as const;
export const salesGroupBySchema = z.enum(SALES_GROUP_BY);

export const getSalesSummaryInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
  groupBy: salesGroupBySchema.default("day"),
});
export type GetSalesSummaryInput = z.infer<typeof getSalesSummaryInputSchema>;

export const salesSummaryRowSchema = z.strictObject({
  key: rowKeySchema,
  label: rowLabelSchema,
  netSalesIdr: idrSchema,
  grossSalesIdr: idrSchema,
  transactionCount: countSchema,
  pax: countSchema,
  avgSpendPerPaxIdr: idrSchema,
});
export const getSalesSummaryOutputSchema = z.strictObject({
  groupBy: salesGroupBySchema,
  rows: rows(salesSummaryRowSchema),
  totals: z.strictObject({
    netSalesIdr: idrSchema,
    grossSalesIdr: idrSchema,
    transactionCount: countSchema,
    pax: countSchema,
    avgSpendPerPaxIdr: idrSchema,
  }),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetSalesSummaryOutput = z.infer<typeof getSalesSummaryOutputSchema>;

// ---- TL-02 get_menu_performance --------------------------------------------

export const MENU_SORT_BY = ["qty", "revenue", "margin"] as const;
export const menuSortBySchema = z.enum(MENU_SORT_BY);

export const getMenuPerformanceInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
  sortBy: menuSortBySchema.default("revenue"),
  limit: z.number().int().min(1).max(50).default(10),
});
export type GetMenuPerformanceInput = z.infer<
  typeof getMenuPerformanceInputSchema
>;

export const menuPerformanceItemSchema = z.strictObject({
  menuItemId: uuidSchema,
  name: rowLabelSchema,
  qtySold: countSchema,
  revenueIdr: idrSchema,
  /** Null when the caller lacks cost permission (margin reveals cost). */
  marginIdr: idrSchema.nullable(),
});
export const getMenuPerformanceOutputSchema = z.strictObject({
  items: rows(menuPerformanceItemSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetMenuPerformanceOutput = z.infer<
  typeof getMenuPerformanceOutputSchema
>;

// ---- TL-03 get_stock_levels ------------------------------------------------

export const STOCK_LEVEL_STATUSES = ["ok", "low", "critical", "out"] as const;
export const stockLevelStatusSchema = z.enum(STOCK_LEVEL_STATUSES);

export const getStockLevelsInputSchema = z.strictObject({
  ...toolOutletFilterSchema.shape,
  onlyBelowPar: z.boolean().optional(),
  search: z.string().trim().min(1).max(80).optional(),
});
export type GetStockLevelsInput = z.infer<typeof getStockLevelsInputSchema>;

export const stockLevelItemSchema = z.strictObject({
  inventoryItemId: inventoryItemIdSchema,
  name: rowLabelSchema,
  unit: z.string().trim().min(1).max(20),
  onHandQty: decimal4Schema,
  parLevelQty: decimal4Schema.nullable(),
  status: stockLevelStatusSchema,
});
export const getStockLevelsOutputSchema = z.strictObject({
  items: rows(stockLevelItemSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetStockLevelsOutput = z.infer<typeof getStockLevelsOutputSchema>;

// ---- TL-04 get_food_cost ---------------------------------------------------

export const getFoodCostInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
});
export type GetFoodCostInput = z.infer<typeof getFoodCostInputSchema>;

export const foodCostRowSchema = z.strictObject({
  outletId: outletIdSchema,
  outletName: rowLabelSchema,
  foodCostIdr: idrSchema,
  netSalesIdr: idrSchema,
  /** Decimal4 percent, e.g. "31.2500" (same unit as metric food_cost_pct). */
  foodCostPct: decimal4Schema,
});
export const getFoodCostOutputSchema = z.strictObject({
  foodCostIdr: idrSchema,
  netSalesIdr: idrSchema,
  foodCostPct: decimal4Schema,
  rows: rows(foodCostRowSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetFoodCostOutput = z.infer<typeof getFoodCostOutputSchema>;

// ---- TL-05 get_labor_summary -----------------------------------------------

export const getLaborSummaryInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
});
export type GetLaborSummaryInput = z.infer<typeof getLaborSummaryInputSchema>;

/**
 * Aggregate only: no individual salary or employee field (§40 Input Minimum).
 * Labor cost and its percent are null (never 0) when the caller lacks payroll
 * permission, filtered by outlet, or no frozen payroll run covers the period.
 */
export const getLaborSummaryOutputSchema = z.strictObject({
  laborCostIdr: idrSchema.nullable(),
  laborCostPct: decimal4Schema.nullable(),
  scheduledHours: nonNegativeDecimal4Schema,
  workedHours: nonNegativeDecimal4Schema,
  overtimeHours: nonNegativeDecimal4Schema,
  headcount: countSchema,
  sources: sourcesSchema,
});
export type GetLaborSummaryOutput = z.infer<typeof getLaborSummaryOutputSchema>;

// ---- TL-06 get_financial_statement -----------------------------------------

export const FINANCIAL_STATEMENT_KINDS = [
  "profit_loss",
  "balance_sheet",
  "cash_flow",
] as const;
export const financialStatementKindSchema = z.enum(FINANCIAL_STATEMENT_KINDS);

export const getFinancialStatementInputSchema = z.strictObject({
  statement: financialStatementKindSchema,
  period: toolPeriodSchema,
  legalEntityId: legalEntityIdSchema.optional(),
});
export type GetFinancialStatementInput = z.infer<
  typeof getFinancialStatementInputSchema
>;

export const financialStatementLineSchema = z.strictObject({
  accountCode: accountCodeSchema,
  label: rowLabelSchema,
  /** Signed whole rupiah: losses and contra accounts are negative. */
  amountIdr: idrSchema,
});
export const getFinancialStatementOutputSchema = z.strictObject({
  statement: financialStatementKindSchema,
  lines: rows(financialStatementLineSchema),
  /** True when every month in the period is closed (final), else estimate. */
  periodClosed: z.boolean(),
  finality: metricFinalitySchema,
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetFinancialStatementOutput = z.infer<
  typeof getFinancialStatementOutputSchema
>;

// ---- TL-07 get_customer_segments -------------------------------------------

export const CUSTOMER_SEGMENT_BY = [
  "tier",
  "recency",
  "frequency",
  "spend",
] as const;
export const customerSegmentBySchema = z.enum(CUSTOMER_SEGMENT_BY);

export const getCustomerSegmentsInputSchema = z.strictObject({
  segmentBy: customerSegmentBySchema,
});
export type GetCustomerSegmentsInput = z.infer<
  typeof getCustomerSegmentsInputSchema
>;

/** Aggregate only: no customer identity or contact field (§40 Input Minimum). */
export const customerSegmentSchema = z.strictObject({
  code: rowKeySchema,
  label: rowLabelSchema,
  customerCount: z.number().int().min(CUSTOMER_SEGMENT_MIN_SIZE),
  avgSpendIdr: idrSchema,
});
export const getCustomerSegmentsOutputSchema = z.strictObject({
  segmentBy: customerSegmentBySchema,
  segments: rows(customerSegmentSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetCustomerSegmentsOutput = z.infer<
  typeof getCustomerSegmentsOutputSchema
>;

// ---- TL-08 get_shift_schedule ----------------------------------------------

export const getShiftScheduleInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
  /**
   * For `own` (employee-level) access the server rejects any value other than
   * the caller with AI_TOOL_FORBIDDEN. It never silently widens or rewrites it.
   */
  employeeId: employeeIdSchema.optional(),
});
export type GetShiftScheduleInput = z.infer<typeof getShiftScheduleInputSchema>;

export const shiftScheduleRowSchema = z.strictObject({
  shiftId: shiftAssignmentIdSchema,
  employeeId: employeeIdSchema,
  employeeName: rowLabelSchema,
  outletId: outletIdSchema,
  date: businessDateSchema,
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
  station: stationSchema.optional(),
});
export const getShiftScheduleOutputSchema = z.strictObject({
  shifts: rows(shiftScheduleRowSchema),
  truncated: truncatedSchema,
});
export type GetShiftScheduleOutput = z.infer<
  typeof getShiftScheduleOutputSchema
>;

// ---- TL-09 get_my_payslip --------------------------------------------------

/** "YYYY-MM". */
export const payrollMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Payroll month is YYYY-MM");

/** No employee id input: the payslip is always the caller's own (PRD TL-09). */
export const getMyPayslipInputSchema = z.strictObject({
  payrollMonth: payrollMonthSchema,
});
export type GetMyPayslipInput = z.infer<typeof getMyPayslipInputSchema>;

export const payslipLineSchema = z.strictObject({
  code: rowKeySchema,
  label: rowLabelSchema,
  amountIdr: idrSchema,
});
export const getMyPayslipOutputSchema = z.strictObject({
  payslipId: payslipIdSchema,
  month: payrollMonthSchema,
  grossIdr: idrSchema,
  deductionsIdr: idrSchema,
  netIdr: idrSchema,
  lines: rows(payslipLineSchema),
  sources: sourcesSchema,
});
export type GetMyPayslipOutput = z.infer<typeof getMyPayslipOutputSchema>;

// ---- TL-10 search_sop ------------------------------------------------------

export const searchSopInputSchema = z.strictObject({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(10).default(5),
});
export type SearchSopInput = z.infer<typeof searchSopInputSchema>;

export const sopSearchResultSchema = z.strictObject({
  knowledgeChunkId: knowledgeChunkIdSchema,
  title: rowLabelSchema,
  snippet: z.string().trim().min(1).max(500),
  sourceVersion: z.string().trim().min(1).max(60),
  link: toolLinkSchema,
});
export const searchSopOutputSchema = z.strictObject({
  results: z.array(sopSearchResultSchema).max(10),
  truncated: truncatedSchema,
});
export type SearchSopOutput = z.infer<typeof searchSopOutputSchema>;

// ---- TL-11 get_anomalies ---------------------------------------------------

export const ANOMALY_TYPES = [
  "void",
  "discount",
  "refund",
  "cash_variance",
  "ingredient_usage",
] as const;
export const anomalyTypeSchema = z.enum(ANOMALY_TYPES);
export const ANOMALY_SEVERITIES = ["low", "medium", "high"] as const;
export const anomalySeveritySchema = z.enum(ANOMALY_SEVERITIES);

export const getAnomaliesInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
  types: z.array(anomalyTypeSchema).min(1).max(ANOMALY_TYPES.length).optional(),
});
export type GetAnomaliesInput = z.infer<typeof getAnomaliesInputSchema>;

export const anomalyRowSchema = z.strictObject({
  type: anomalyTypeSchema,
  outletId: outletIdSchema,
  detectedAt: isoDateTimeSchema,
  severity: anomalySeveritySchema,
  /** Unit depends on `type` (count, rupiah or quantity); Decimal4 string. */
  observedValue: decimal4Schema,
  baselineValue: decimal4Schema,
  description: noteSchema,
  link: toolLinkSchema,
});
export const getAnomaliesOutputSchema = z.strictObject({
  anomalies: rows(anomalyRowSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetAnomaliesOutput = z.infer<typeof getAnomaliesOutputSchema>;

// ---- TL-12 get_my_profit_share ---------------------------------------------

/** Own distributions only; no other shareholder field (SH-01). */
export const getMyProfitShareInputSchema = z.strictObject({
  year: z.number().int().min(2000).max(2100).optional(),
});
export type GetMyProfitShareInput = z.infer<typeof getMyProfitShareInputSchema>;

export const profitShareDistributionRowSchema = z.strictObject({
  periodLabel: rowLabelSchema,
  sharePct: decimal4Schema,
  amountIdr: idrSchema,
  status: distributionRunStatusSchema,
});
export const getMyProfitShareOutputSchema = z.strictObject({
  distributions: rows(profitShareDistributionRowSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetMyProfitShareOutput = z.infer<
  typeof getMyProfitShareOutputSchema
>;

// ---- TL-13 draft_purchase_order --------------------------------------------

export const draftPurchaseOrderInputSchema = z
  .strictObject({
    outletId: outletIdSchema,
    supplierId: supplierIdSchema,
    /** One line per inventoryItemId. */
    lines: z
      .array(
        z.strictObject({
          inventoryItemId: inventoryItemIdSchema,
          qty: positiveDecimal4Schema,
          /** Per-unit cost is NUMERIC(14,4) (a Decimal4 string), as in inventory. */
          unitCostIdr: nonNegativeDecimal4Schema.optional(),
        }),
      )
      .min(1)
      .max(50),
    neededBy: businessDateSchema.optional(),
    note: noteSchema.optional(),
  })
  .refine(
    (input) => !hasDuplicates(input.lines.map((line) => line.inventoryItemId)),
    {
      message: "Each inventory item may appear on one line only",
      path: ["lines"],
    },
  );
export type DraftPurchaseOrderInput = z.infer<
  typeof draftPurchaseOrderInputSchema
>;
export const draftPurchaseOrderOutputSchema = actionRequestReceiptSchema;
export type DraftPurchaseOrderOutput = ActionRequestReceipt;

// ---- TL-14 draft_stock_adjustment ------------------------------------------

export const draftStockAdjustmentInputSchema = z
  .strictObject({
    outletId: outletIdSchema,
    /** One line per inventoryItemId. */
    lines: z
      .array(
        z.strictObject({
          inventoryItemId: inventoryItemIdSchema,
          qtyDelta: nonZeroDecimal4Schema,
          reason: reasonSchema,
        }),
      )
      .min(1)
      .max(50),
    note: noteSchema.optional(),
  })
  .refine(
    (input) => !hasDuplicates(input.lines.map((line) => line.inventoryItemId)),
    {
      message: "Each inventory item may appear on one line only",
      path: ["lines"],
    },
  );
export type DraftStockAdjustmentInput = z.infer<
  typeof draftStockAdjustmentInputSchema
>;
export const draftStockAdjustmentOutputSchema = actionRequestReceiptSchema;
export type DraftStockAdjustmentOutput = ActionRequestReceipt;

// ---- TL-15 draft_promotion -------------------------------------------------

export const promotionDiscountSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("percent"),
    /** Decimal4 percent in (0, 100]. */
    percent: positiveDecimal4Schema.refine(
      (value) => parseDecimal4(value) <= 1_000_000n,
      "Percent must not exceed 100",
    ),
  }),
  z.strictObject({
    kind: z.literal("amount"),
    amountIdr: idrSchema.refine(
      (value) => value > 0,
      "Amount must be positive",
    ),
  }),
]);
export type PromotionDiscount = z.infer<typeof promotionDiscountSchema>;

export const draftPromotionInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    outletIds: uniqueOutletIdsSchema(z.array(outletIdSchema).min(1).max(50)),
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    discount: promotionDiscountSchema,
    menuItemIds: z.array(uuidSchema).min(1).max(100).optional(),
    description: noteSchema.optional(),
  })
  .refine((input) => Date.parse(input.startsAt) < Date.parse(input.endsAt), {
    message: "Promotion must start before it ends",
    path: ["endsAt"],
  });
export type DraftPromotionInput = z.infer<typeof draftPromotionInputSchema>;
export const draftPromotionOutputSchema = actionRequestReceiptSchema;
export type DraftPromotionOutput = ActionRequestReceipt;

// ---- TL-16 draft_shift_schedule --------------------------------------------

/**
 * `weekStart` is the Monday of an ISO week. Every shift date falls within
 * weekStart..weekStart+6. `startTime` and `endTime` must differ; an `endTime`
 * earlier than `startTime` means the shift runs overnight into the next day.
 * An employee has at most one shift per (date, startTime).
 */
export const draftShiftScheduleInputSchema = z
  .strictObject({
    outletId: outletIdSchema,
    weekStart: businessDateSchema,
    shifts: z
      .array(
        z.strictObject({
          employeeId: employeeIdSchema,
          date: businessDateSchema,
          startTime: timeOfDaySchema,
          endTime: timeOfDaySchema,
          station: stationSchema.optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((input, ctx) => {
    if (isoWeekday(input.weekStart) !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Week start must be a Monday",
        path: ["weekStart"],
      });
    }
    const weekStartDay = dayNumber(input.weekStart);
    const seen = new Set<string>();
    input.shifts.forEach((shift, index) => {
      const offset = dayNumber(shift.date) - weekStartDay;
      if (!(offset >= 0 && offset <= 6)) {
        ctx.addIssue({
          code: "custom",
          message: "Shift date must fall within the week starting at weekStart",
          path: ["shifts", index, "date"],
        });
      }
      if (shift.startTime === shift.endTime) {
        ctx.addIssue({
          code: "custom",
          message: "Shift start and end time must differ",
          path: ["shifts", index, "endTime"],
        });
      }
      const key = `${shift.employeeId}|${shift.date}|${shift.startTime}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate shift for the same employee, date and start time",
          path: ["shifts", index],
        });
      }
      seen.add(key);
    });
  });
export type DraftShiftScheduleInput = z.infer<
  typeof draftShiftScheduleInputSchema
>;
export const draftShiftScheduleOutputSchema = actionRequestReceiptSchema;
export type DraftShiftScheduleOutput = ActionRequestReceipt;

// ---- TL-17 draft_price_change ----------------------------------------------

export const draftPriceChangeInputSchema = z
  .strictObject({
    /** Absent means every outlet the caller may manage; when present, at least one. */
    outletIds: uniqueOutletIdsSchema(
      z.array(outletIdSchema).min(1).max(50),
    ).optional(),
    /** One change per menuItemId. */
    changes: z
      .array(
        z.strictObject({
          menuItemId: uuidSchema,
          newPriceIdr: idrSchema.refine(
            (value) => value > 0,
            "Price must be greater than zero",
          ),
        }),
      )
      .min(1)
      .max(100),
    /** The server checks that this is not in the past (needs the current time). */
    effectiveAt: isoDateTimeSchema,
  })
  .refine(
    (input) => !hasDuplicates(input.changes.map((change) => change.menuItemId)),
    {
      message: "Each menu item may appear in one change only",
      path: ["changes"],
    },
  );
export type DraftPriceChangeInput = z.infer<typeof draftPriceChangeInputSchema>;
export const draftPriceChangeOutputSchema = actionRequestReceiptSchema;
export type DraftPriceChangeOutput = ActionRequestReceipt;

// ---- TL-18 draft_menu_availability -----------------------------------------

export const draftMenuAvailabilityInputSchema = z.strictObject({
  outletId: outletIdSchema,
  items: z
    .array(z.strictObject({ menuItemId: uuidSchema, available: z.boolean() }))
    .min(1)
    .max(100),
  until: isoDateTimeSchema.optional(),
  reason: reasonSchema,
});
export type DraftMenuAvailabilityInput = z.infer<
  typeof draftMenuAvailabilityInputSchema
>;
export const draftMenuAvailabilityOutputSchema = actionRequestReceiptSchema;
export type DraftMenuAvailabilityOutput = ActionRequestReceipt;

// ---- TL-19 get_action_request_status ---------------------------------------

export const getActionRequestStatusInputSchema = z.strictObject({
  actionRequestId: actionRequestIdSchema,
});
export type GetActionRequestStatusInput = z.infer<
  typeof getActionRequestStatusInputSchema
>;

export const getActionRequestStatusOutputSchema = z.strictObject({
  actionRequestId: actionRequestIdSchema,
  toolCode: actionRequestToolCodeSchema,
  status: actionRequestStatusSchema,
  approvalStatus: approvalRequestStatusSchema,
  decidedAt: isoDateTimeSchema.nullable(),
  resultRef: z.string().trim().min(1).max(200).nullable(),
  failureReason: z.string().trim().min(1).max(500).nullable(),
});
export type GetActionRequestStatusOutput = z.infer<
  typeof getActionRequestStatusOutputSchema
>;

// ---- TL-20 get_facility_utilization ----------------------------------------

export const getFacilityUtilizationInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
  facilityId: facilityIdSchema.optional(),
});
export type GetFacilityUtilizationInput = z.infer<
  typeof getFacilityUtilizationInputSchema
>;

export const facilityUtilizationRowSchema = z.strictObject({
  facilityId: facilityIdSchema,
  name: rowLabelSchema,
  sessions: countSchema,
  /** Decimal4 percent of available slot time. */
  utilizationPct: decimal4Schema,
  revenueIdr: idrSchema,
});
export const getFacilityUtilizationOutputSchema = z.strictObject({
  rows: rows(facilityUtilizationRowSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetFacilityUtilizationOutput = z.infer<
  typeof getFacilityUtilizationOutputSchema
>;

// ---- TL-21 get_review_summary ----------------------------------------------

/** Fixed theme lexicon keys (AI-11). Matching runs in the database. */
export const REVIEW_THEMES = [
  "makanan",
  "pelayanan",
  "harga",
  "kebersihan",
  "waktu_tunggu",
] as const;
export const reviewThemeSchema = z.enum(REVIEW_THEMES);
export type ReviewTheme = z.infer<typeof reviewThemeSchema>;

export const getReviewSummaryInputSchema = z.strictObject({
  period: toolPeriodSchema,
  ...toolOutletFilterSchema.shape,
});
export type GetReviewSummaryInput = z.infer<typeof getReviewSummaryInputSchema>;

export const reviewSummaryRowSchema = z.strictObject({
  outletId: outletIdSchema,
  outletName: rowLabelSchema,
  reviewCount: countSchema,
  /** Decimal4 average of ratings 1..5. */
  averageRating: decimal4Schema,
  /** Review count per star rating, keyed "1".."5". */
  ratingDistribution: z.strictObject({
    "1": countSchema,
    "2": countSchema,
    "3": countSchema,
    "4": countSchema,
    "5": countSchema,
  }),
  /** Number of reviews that mention each theme; no review text. */
  themes: z
    .array(z.strictObject({ theme: reviewThemeSchema, mentions: countSchema }))
    .max(REVIEW_THEMES.length),
});
export const getReviewSummaryOutputSchema = z.strictObject({
  rows: rows(reviewSummaryRowSchema),
  truncated: truncatedSchema,
  sources: sourcesSchema,
});
export type GetReviewSummaryOutput = z.infer<
  typeof getReviewSummaryOutputSchema
>;

// ---- Map -------------------------------------------------------------------

/** Input and output schema per tool code, one entry for each of TL-01..TL-21. */
export const AI_TOOL_IO = {
  "TL-01": {
    input: getSalesSummaryInputSchema,
    output: getSalesSummaryOutputSchema,
  },
  "TL-02": {
    input: getMenuPerformanceInputSchema,
    output: getMenuPerformanceOutputSchema,
  },
  "TL-03": {
    input: getStockLevelsInputSchema,
    output: getStockLevelsOutputSchema,
  },
  "TL-04": { input: getFoodCostInputSchema, output: getFoodCostOutputSchema },
  "TL-05": {
    input: getLaborSummaryInputSchema,
    output: getLaborSummaryOutputSchema,
  },
  "TL-06": {
    input: getFinancialStatementInputSchema,
    output: getFinancialStatementOutputSchema,
  },
  "TL-07": {
    input: getCustomerSegmentsInputSchema,
    output: getCustomerSegmentsOutputSchema,
  },
  "TL-08": {
    input: getShiftScheduleInputSchema,
    output: getShiftScheduleOutputSchema,
  },
  "TL-09": {
    input: getMyPayslipInputSchema,
    output: getMyPayslipOutputSchema,
  },
  "TL-10": { input: searchSopInputSchema, output: searchSopOutputSchema },
  "TL-11": {
    input: getAnomaliesInputSchema,
    output: getAnomaliesOutputSchema,
  },
  "TL-12": {
    input: getMyProfitShareInputSchema,
    output: getMyProfitShareOutputSchema,
  },
  "TL-13": {
    input: draftPurchaseOrderInputSchema,
    output: draftPurchaseOrderOutputSchema,
  },
  "TL-14": {
    input: draftStockAdjustmentInputSchema,
    output: draftStockAdjustmentOutputSchema,
  },
  "TL-15": {
    input: draftPromotionInputSchema,
    output: draftPromotionOutputSchema,
  },
  "TL-16": {
    input: draftShiftScheduleInputSchema,
    output: draftShiftScheduleOutputSchema,
  },
  "TL-17": {
    input: draftPriceChangeInputSchema,
    output: draftPriceChangeOutputSchema,
  },
  "TL-18": {
    input: draftMenuAvailabilityInputSchema,
    output: draftMenuAvailabilityOutputSchema,
  },
  "TL-19": {
    input: getActionRequestStatusInputSchema,
    output: getActionRequestStatusOutputSchema,
  },
  "TL-20": {
    input: getFacilityUtilizationInputSchema,
    output: getFacilityUtilizationOutputSchema,
  },
  "TL-21": {
    input: getReviewSummaryInputSchema,
    output: getReviewSummaryOutputSchema,
  },
} as const satisfies Record<
  AiToolCode,
  { input: z.ZodType; output: z.ZodType }
>;
