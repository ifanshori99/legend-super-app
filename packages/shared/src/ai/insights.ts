// AI insights contract (WS-12 wave 3; beads legend-hkd4, legend-lely): demand
// forecast (AI-07), purchase suggestion (AI-08), roster inputs (AI-13),
// anomaly alerts (AI-09), daily summary (AI-10), promo copy draft (AI-12) and
// expense account suggestion (AI-14). Same style as `endpoints.ts`.
//
// Tenant comes from the domain or token, never the body (TEN-02). Every
// `outletId` here IS client input: the server checks it against the caller's
// outlet scope (TEN-03).
//
// Permissions (enforced by the API, not by these schemas):
//   forecasts, daily summaries                       -> report.sales.view
//   purchase suggestions     -> purchasing.request.create OR inventory.stock.view
//   roster inputs                                    -> hr.schedule.manage
//   anomaly alerts, acknowledge                      -> report.operational.view
//   promo copy draft  -> (promo.manage OR campaign.manage OR menu.item.manage) AND ai.ask
//   expense account suggestion
//                  -> (accounting.expense.request OR accounting.journal.view) AND ai.ask

import {
  businessDateSchema,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";

/** Draft outputs always carry this label (AI-12, AI-14). */
export const aiAssistedLabel = "Dibantu AI" as const;

const MAX_QUERY_DAYS = 31;
const MS_PER_DAY = 86_400_000;

/** Inclusive day count between two YYYY-MM-DD dates (UTC, so DST-free). */
function daySpan(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / MS_PER_DAY + 1;
}

// ---- Forecast (AI-07) -----------------------------------------------------

export const forecastMetricCodes = ["sales_idr", "orders", "covers"] as const;
export const forecastMetricCodeSchema = z.enum(forecastMetricCodes);
export type ForecastMetricCode = z.infer<typeof forecastMetricCodeSchema>;

export const forecastModelVersionSchema = z.literal("rule-v1");

export const forecastRowSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  targetDate: businessDateSchema,
  hour: z.number().int().min(0).max(23),
  metricCode: forecastMetricCodeSchema,
  value: z.number().min(0),
  modelVersion: forecastModelVersionSchema,
  generatedAt: isoDateTimeSchema,
});
export type ForecastRow = z.infer<typeof forecastRowSchema>;

export const listForecastsQuerySchema = z
  .strictObject({
    outletId: outletIdSchema,
    from: businessDateSchema,
    to: businessDateSchema,
    metricCode: forecastMetricCodeSchema.optional(),
  })
  .refine((query) => query.to >= query.from, {
    message: "`to` must not be before `from`",
    path: ["to"],
  })
  .refine((query) => daySpan(query.from, query.to) <= MAX_QUERY_DAYS, {
    message: `The range is at most ${MAX_QUERY_DAYS} days`,
    path: ["to"],
  });

// ---- Purchase suggestion (AI-08) ------------------------------------------

export const purchaseSuggestionReasonSchema = z.enum([
  "below_min",
  "below_max",
]);

export const purchaseSuggestionSchema = z.strictObject({
  inventoryItemId: uuidSchema,
  itemName: z.string().min(1).max(200),
  locationId: uuidSchema,
  locationName: z.string().min(1).max(200),
  unit: z.string().min(1).max(30),
  onHand: z.number(),
  parMin: z.number().min(0),
  parMax: z.number().min(0),
  suggestedQty: z.number().positive(),
  reason: purchaseSuggestionReasonSchema,
});
export type PurchaseSuggestion = z.infer<typeof purchaseSuggestionSchema>;

export const listPurchaseSuggestionsQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Roster inputs (AI-13) ------------------------------------------------

export const defaultCoversPerStaff = 12;

export const rosterHourSchema = z.strictObject({
  hour: z.number().int().min(0).max(23),
  forecastCovers: z.number().min(0),
  forecastOrders: z.number().min(0),
  suggestedHeadcount: z.number().int().min(0),
});

export const rosterInputSchema = z.strictObject({
  outletId: outletIdSchema,
  date: businessDateSchema,
  hours: z.array(rosterHourSchema).max(24),
  coversPerStaff: z.number().int().min(1).max(100),
  basis: z.enum(["forecast", "rule_baseline"]),
});
export type RosterInput = z.infer<typeof rosterInputSchema>;

export const rosterInputsQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  date: businessDateSchema,
  coversPerStaff: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(defaultCoversPerStaff),
});

// ---- Anomaly alerts (AI-09) -----------------------------------------------

export const anomalyKindSchema = z.enum([
  "void",
  "discount",
  "refund",
  "waste",
]);
export const anomalyAlertSeveritySchema = z.enum(["warn", "high"]);
export const anomalyStatusSchema = z.enum(["open", "acknowledged"]);

export const anomalyAlertSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  businessDate: businessDateSchema,
  kind: anomalyKindSchema,
  observedIdr: idrSchema,
  baselineIdr: idrSchema,
  ratio: z.number().min(0),
  severity: anomalyAlertSeveritySchema,
  status: anomalyStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type AnomalyAlert = z.infer<typeof anomalyAlertSchema>;

export const listAnomalyAlertsQuerySchema = z.strictObject({
  outletId: outletIdSchema.optional(),
  status: anomalyStatusSchema.optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});

export const anomalyAlertParamsSchema = z.strictObject({ id: uuidSchema });

// ---- Daily summary (AI-10) ------------------------------------------------

export const dailySummaryMetricsSchema = z.strictObject({
  salesIdr: idrSchema,
  orders: z.number().int().min(0),
  voidIdr: idrSchema,
  discountIdr: idrSchema,
  refundIdr: idrSchema,
  wasteIdr: idrSchema,
});
export type DailySummaryMetrics = z.infer<typeof dailySummaryMetricsSchema>;

export const dailySummarySchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  businessDate: businessDateSchema,
  text: z.string().min(1).max(2000),
  aiAssisted: z.boolean(),
  metrics: dailySummaryMetricsSchema,
  createdAt: isoDateTimeSchema,
});
export type DailySummary = z.infer<typeof dailySummarySchema>;

export const listDailySummariesQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});

// ---- Promo / menu copy draft (AI-12) --------------------------------------

export const promoCopyKindSchema = z.enum([
  "menu_description",
  "banner",
  "campaign",
]);
export const promoCopyToneSchema = z.enum(["santai", "formal"]);

export const promoCopyDraftInputSchema = z.strictObject({
  kind: promoCopyKindSchema,
  menuItemIds: z.array(uuidSchema).max(10).optional(),
  brief: z.string().trim().min(1).max(500),
  tone: promoCopyToneSchema.optional(),
});
export type PromoCopyDraftInput = z.infer<typeof promoCopyDraftInputSchema>;

export const promoCopyDraftOutputSchema = z.strictObject({
  drafts: z.array(z.string().min(1).max(1000)).min(1).max(3),
  aiAssisted: z.literal(true),
  label: z.literal(aiAssistedLabel),
});
export type PromoCopyDraftOutput = z.infer<typeof promoCopyDraftOutputSchema>;

// ---- Expense account suggestion (AI-14) -----------------------------------

export const expenseAccountSuggestInputSchema = z.strictObject({
  description: z.string().trim().min(1).max(300),
  amountIdr: idrSchema.optional(),
  /** Required when the tenant has charts for more than one legal entity. */
  legalEntityId: uuidSchema.optional(),
});
export type ExpenseAccountSuggestInput = z.infer<
  typeof expenseAccountSuggestInputSchema
>;

export const expenseAccountSuggestionSchema = z.strictObject({
  accountId: uuidSchema,
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(200),
  confidence: z.enum(["high", "medium", "low"]),
});

export const expenseAccountSuggestOutputSchema = z.strictObject({
  suggestions: z.array(expenseAccountSuggestionSchema).max(3),
  aiAssisted: z.literal(true),
  label: z.literal(aiAssistedLabel),
});
export type ExpenseAccountSuggestOutput = z.infer<
  typeof expenseAccountSuggestOutputSchema
>;

// ---- Endpoints ------------------------------------------------------------

export const listAiForecasts = defineEndpoint({
  method: "GET",
  path: "/api/ai/forecasts",
  query: listForecastsQuerySchema,
  response: dataResponseSchema(z.array(forecastRowSchema)),
});

export const listAiPurchaseSuggestions = defineEndpoint({
  method: "GET",
  path: "/api/ai/purchase-suggestions",
  query: listPurchaseSuggestionsQuerySchema,
  response: dataResponseSchema(z.array(purchaseSuggestionSchema)),
});

export const getAiRosterInputs = defineEndpoint({
  method: "GET",
  path: "/api/ai/roster-inputs",
  query: rosterInputsQuerySchema,
  response: dataResponseSchema(rosterInputSchema),
});

export const listAiAnomalyAlerts = defineEndpoint({
  method: "GET",
  path: "/api/ai/anomalies",
  query: listAnomalyAlertsQuerySchema,
  response: dataResponseSchema(z.array(anomalyAlertSchema)),
});

export const acknowledgeAiAnomalyAlert = defineEndpoint({
  method: "POST",
  path: "/api/ai/anomalies/:id/acknowledge",
  params: anomalyAlertParamsSchema,
  response: dataResponseSchema(anomalyAlertSchema),
});

export const listAiDailySummaries = defineEndpoint({
  method: "GET",
  path: "/api/ai/daily-summaries",
  query: listDailySummariesQuerySchema,
  response: dataResponseSchema(z.array(dailySummarySchema)),
});

export const draftAiPromoCopy = defineEndpoint({
  method: "POST",
  path: "/api/ai/drafts/promo-copy",
  body: promoCopyDraftInputSchema,
  response: dataResponseSchema(promoCopyDraftOutputSchema),
});

export const suggestAiExpenseAccount = defineEndpoint({
  method: "POST",
  path: "/api/ai/drafts/expense-account",
  body: expenseAccountSuggestInputSchema,
  response: dataResponseSchema(expenseAccountSuggestOutputSchema),
});
