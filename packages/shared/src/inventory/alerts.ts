// Stock alert, expiry and purchase-suggestion contracts (PRD v1.7 §3 F16 Batch
// & Kedaluwarsa, Par Level; AI-08; bead legend-ugo). Read-only endpoints.

import {
  businessDateSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  decimal4Schema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import {
  inventoryItemIdSchema,
  nonnegativeDecimal4Schema,
  positiveDecimal4Schema,
  stockBatchIdSchema,
  stockBatchSchema,
  stockLocationIdSchema,
  uomIdSchema,
} from "./schemas.ts";

export const expiryAlertSchema = z.strictObject({
  batch: stockBatchSchema,
  status: z.enum(["expired", "expiring_soon"]),
  /** Negative when already expired; 0 = expires today (outlet business date). */
  daysUntilExpiry: z.number().int(),
  availableQty: positiveDecimal4Schema,
  fefoRank: z.number().int().positive(),
  /** The outlet business date the status was computed for (D-CORE-6). */
  asOf: businessDateSchema,
  warnDays: z.number().int().min(1).max(365),
});
export type ExpiryAlert = z.infer<typeof expiryAlertSchema>;
export const expiryAlertQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
  inventoryItemId: inventoryItemIdSchema.optional(),
});

export const stockAlertKindSchema = z.enum([
  "par_critical",
  "expiring_soon",
  "expired",
]);

export const stockAlertSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  batchId: stockBatchIdSchema.nullable(),
  kind: stockAlertKindSchema,
  /** On hand (par) or left in the batch (expiry) when the alert was raised. */
  quantity: decimal4Schema,
  parMin: nonnegativeDecimal4Schema.nullable(),
  expiresOn: businessDateSchema.nullable(),
  raisedAt: isoDateTimeSchema,
});
export type StockAlert = z.infer<typeof stockAlertSchema>;
export const stockAlertQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  kind: stockAlertKindSchema.optional(),
  locationId: stockLocationIdSchema.optional(),
});

export const purchaseSuggestionSchema = z.strictObject({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  baseUomId: uomIdSchema,
  /** May be negative when real-time sale deduction ran ahead of a receipt. */
  onHand: decimal4Schema,
  parMin: nonnegativeDecimal4Schema,
  parMax: nonnegativeDecimal4Schema,
  suggestedQty: positiveDecimal4Schema,
  /** Which par applied: the location override or the item default. */
  parSource: z.enum(["location", "item_default"]),
  /** Rule basis; `forecast` joins once AI-07 lands (legend-hkd4). */
  basis: z.literal("par_level"),
});
export type PurchaseSuggestion = z.infer<typeof purchaseSuggestionSchema>;
export const purchaseSuggestionQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
});

export const listExpiryAlertsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/inventory/expiry-alerts",
  query: expiryAlertQuerySchema,
  response: dataResponseSchema(z.array(expiryAlertSchema)),
});

export const listStockAlertsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/inventory/stock-alerts",
  query: stockAlertQuerySchema,
  response: cursorPageSchema(stockAlertSchema),
});

export const listPurchaseSuggestionsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/inventory/purchase-suggestions",
  query: purchaseSuggestionQuerySchema,
  response: dataResponseSchema(z.array(purchaseSuggestionSchema)),
});

export const inventoryAlertEndpoints = [
  listExpiryAlertsEndpoint,
  listStockAlertsEndpoint,
  listPurchaseSuggestionsEndpoint,
] as const;
