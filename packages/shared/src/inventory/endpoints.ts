// Inventory endpoint contracts (bead legend-p38). The web app's typed client
// and mock mode, and later the API route validation, read these objects (see
// docs/frontend.md, "Typed endpoints and mock mode"); paths live under
// /api/inventory so they cannot collide with another domain.
//
// Tenant comes from the domain or token, never the body (TEN-02). Outlet ids
// in a query or write ARE client input: the server checks them against the
// caller's outlet scope (TEN-03). Lists use cursor pagination (D-CORE-5);
// writes that create documents carry an idempotency key.

import {
  brandIdSchema,
  businessDateSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  parseDecimal4,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import {
  inventoryItemAlternateIdSchema,
  inventoryItemAlternateSchema,
  inventoryItemIdSchema,
  inventoryItemSchema,
  inventoryItemTypeSchema,
  menuCostSchema,
  menuEngineeringRowSchema,
  nonnegativeDecimal4Schema,
  parLevelSchema,
  positiveDecimal4Schema,
  productionOrderActionSchema,
  productionOrderSchema,
  productionOrderStatusSchema,
  recipeComponentTypeSchema,
  recipeCoverageRowSchema,
  recipeDetailSchema,
  recipeIdSchema,
  recipeSchema,
  recipeWastePctSchema,
  stockBatchSchema,
  stockBalanceSchema,
  stockCountActionSchema,
  stockCountDetailSchema,
  stockCountIdSchema,
  stockCountLineIdSchema,
  stockCountLineSchema,
  stockCountSchema,
  stockCountSheetLineSchema,
  stockCountSheetSchema,
  stockCountStatusSchema,
  stockCountTypeSchema,
  stockLedgerEntrySchema,
  stockLocationIdSchema,
  stockLocationSchema,
  stockLocationTypeSchema,
  stockMovementTypeSchema,
  stockTransferLineSchema,
  stockTransferSchema,
  productionOrderIdSchema,
  uomConversionIdSchema,
  uomConversionSchema,
  uomIdSchema,
  uomSchema,
  wasteLogSchema,
  wasteReasonSchema,
  wasteTargetTypeSchema,
  foodCostComparisonSchema,
  expiryWarningDaysSchema,
  inventorySettingsSchema,
  parLevelIdSchema,
  recipeDeductionModeSchema,
} from "./schemas.ts";

// ---- List queries ---------------------------------------------------------

export const inventoryItemListQuerySchema = cursorPageQuerySchema.extend({
  category: z.string().min(1).max(50).optional(),
  type: inventoryItemTypeSchema.optional(),
});

export const stockLocationListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
});

export const stockLedgerQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
  inventoryItemId: inventoryItemIdSchema.optional(),
  movementType: stockMovementTypeSchema.optional(),
  /** Business dates in the outlet time zone (D-CORE-6). */
  fromDate: businessDateSchema.optional(),
  toDate: businessDateSchema.optional(),
});

export const stockBalanceQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
  inventoryItemId: inventoryItemIdSchema.optional(),
});

export const stockBatchQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
  inventoryItemId: inventoryItemIdSchema.optional(),
  /** Expiring on or before this business date, for the expiry dashboard. */
  expiresOnOrBefore: businessDateSchema.optional(),
});

export const parLevelQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
  inventoryItemId: inventoryItemIdSchema.optional(),
});

export const stockCountQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
  status: stockCountStatusSchema.optional(),
  type: stockCountTypeSchema.optional(),
});

export const wasteLogQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema.optional(),
  reason: wasteReasonSchema.optional(),
  fromDate: businessDateSchema.optional(),
  toDate: businessDateSchema.optional(),
});

export const recipeQuerySchema = cursorPageQuerySchema.extend({
  brandId: brandIdSchema.optional(),
  outputItemId: inventoryItemIdSchema.optional(),
});

export const productionOrderQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  recipeId: recipeIdSchema.optional(),
  status: productionOrderStatusSchema.optional(),
});

export const menuCostQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  menuItemId: uuidSchema.optional(),
});

export const foodCostQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  fromDate: businessDateSchema,
  toDate: businessDateSchema,
});

export const menuEngineeringQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  fromDate: businessDateSchema,
  toDate: businessDateSchema,
});

export const recipeCoverageQuerySchema = cursorPageQuerySchema.extend({
  brandId: brandIdSchema.optional(),
});

export const stockTransferListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  /** Matches either side of the transfer (source or destination). */
  locationId: stockLocationIdSchema.optional(),
});

// ---- Write inputs ---------------------------------------------------------

export const createInventoryItemInputSchema = clientInputSchema({
  name: z.string().min(1).max(150),
  category: z.string().min(1).max(50),
  type: inventoryItemTypeSchema,
  baseUomId: uomIdSchema,
  isPerishable: z.boolean(),
  parMin: nonnegativeDecimal4Schema.nullable().optional(),
  parMax: nonnegativeDecimal4Schema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
}).refine(
  (item) =>
    item.parMin === null ||
    item.parMin === undefined ||
    item.parMax === null ||
    item.parMax === undefined ||
    parseDecimal4(item.parMax) >= parseDecimal4(item.parMin),
  { path: ["parMax"], message: "parMax must be at least parMin" },
);

export const updateInventoryItemInputSchema = clientInputSchema({
  name: z.string().min(1).max(150).optional(),
  category: z.string().min(1).max(50).optional(),
  isPerishable: z.boolean().optional(),
  isActive: z.boolean().optional(),
  parMin: nonnegativeDecimal4Schema.nullable().optional(),
  parMax: nonnegativeDecimal4Schema.nullable().optional(),
  /** Optimistic concurrency (CORE PRECONDITION_FAILED on a stale value). */
  expectedUpdatedAt: isoDateTimeSchema,
});

/**
 * Setup writes the back office needs (locations, alternates, conversions,
 * transfers). PRD §16 "Lokasi Stok" ("transfer antarlokasi"), "Item Bahan &
 * Satuan" ("kategori, dan bahan alternatif"), §6.E. Tracked as legend-gjmk.
 */
export const createStockLocationInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  name: z.string().min(1).max(150),
  type: stockLocationTypeSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const updateStockLocationInputSchema = clientInputSchema({
  name: z.string().min(1).max(150).optional(),
  type: stockLocationTypeSchema.optional(),
  isActive: z.boolean().optional(),
});

/**
 * Tenant-defined units. The code is normalized (trimmed, lowercased) and is
 * immutable after creation because edge sync keys on it; only the name can be
 * edited, and never on a system (standard catalog) unit.
 */
export const createUomInputSchema = clientInputSchema({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]{1,10}$/),
  name: z.string().trim().min(1).max(150),
  idempotencyKey: idempotencyKeySchema,
});

export const updateUomInputSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150),
});

export const createInventoryItemAlternateInputSchema = clientInputSchema({
  alternateItemId: inventoryItemIdSchema,
  /** Lower priority wins when a recipe suggests a substitute. */
  priority: z.number().int().nonnegative().default(0),
  idempotencyKey: idempotencyKeySchema,
});

export const createUomConversionInputSchema = clientInputSchema({
  fromUomId: uomIdSchema,
  toUomId: uomIdSchema,
  factor: positiveDecimal4Schema,
  idempotencyKey: idempotencyKeySchema,
}).refine((input) => input.fromUomId !== input.toUomId, {
  path: ["toUomId"],
  message: "A conversion needs two different units",
});

/**
 * Per-location par level (PRD §16 "Par Level & Saran Pembelian"). One level per
 * (location, item); the location must belong to `outletId` (TEN-03).
 */
export const createParLevelInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  parMin: nonnegativeDecimal4Schema,
  parMax: nonnegativeDecimal4Schema,
  idempotencyKey: idempotencyKeySchema,
}).refine((par) => parseDecimal4(par.parMax) >= parseDecimal4(par.parMin), {
  path: ["parMax"],
  message: "parMax must be at least parMin",
});

export const updateParLevelInputSchema = clientInputSchema({
  parMin: nonnegativeDecimal4Schema.optional(),
  parMax: nonnegativeDecimal4Schema.optional(),
})
  .refine((par) => par.parMin !== undefined || par.parMax !== undefined, {
    message: "Send parMin, parMax or both",
  })
  .refine(
    (par) =>
      par.parMin === undefined ||
      par.parMax === undefined ||
      parseDecimal4(par.parMax) >= parseDecimal4(par.parMin),
    { path: ["parMax"], message: "parMax must be at least parMin" },
  );

/**
 * Tenant inventory settings (PRD §16 "Pemotongan Otomatis", "Batch &
 * Kedaluwarsa"). A full replacement; `expectedUpdatedAt` is null for a tenant
 * that has not saved settings yet (optimistic concurrency, PRECONDITION_FAILED).
 */
export const updateInventorySettingsInputSchema = clientInputSchema({
  recipeDeductionMode: recipeDeductionModeSchema,
  expiryWarningDays: expiryWarningDaysSchema,
  expectedUpdatedAt: isoDateTimeSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
});

export const createStockTransferInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  fromLocationId: stockLocationIdSchema,
  toLocationId: stockLocationIdSchema,
  lines: z.array(stockTransferLineSchema).min(1),
  note: z.string().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
}).superRefine((transfer, context) => {
  if (transfer.fromLocationId === transfer.toLocationId)
    context.addIssue({
      code: "custom",
      path: ["toLocationId"],
      message: "A transfer needs two different locations",
    });
  const seen = new Set<string>();
  transfer.lines.forEach((line, index) => {
    if (seen.has(line.inventoryItemId))
      context.addIssue({
        code: "custom",
        path: ["lines", index, "inventoryItemId"],
        message: "An item appears once per transfer",
      });
    seen.add(line.inventoryItemId);
  });
});

export const createStockCountInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  type: stockCountTypeSchema,
  /** PRD §16 "hitung buta": the counter does not see `systemQty`. */
  blind: z.boolean(),
  businessDate: businessDateSchema,
  /** Cycle counts may narrow the item set; a full count snapshots all items. */
  inventoryItemIds: z.array(inventoryItemIdSchema).min(1).optional(),
  note: z.string().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const updateStockCountLineInputSchema = clientInputSchema({
  countedQty: nonnegativeDecimal4Schema,
});

export const transitionStockCountInputSchema = clientInputSchema({
  action: stockCountActionSchema,
  note: z.string().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const createWasteLogInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  locationId: stockLocationIdSchema,
  targetType: wasteTargetTypeSchema,
  targetId: uuidSchema,
  quantity: positiveDecimal4Schema,
  reason: wasteReasonSchema,
  mediaId: uuidSchema.nullable().optional(),
  // No `valueIdr`: the loss value is quantity x the server's moving-average
  // cost (PRD §16 "nilai kerugian"); a client-supplied value is rejected.
  occurredAt: isoDateTimeSchema.optional(),
  note: z.string().max(300).nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const createProductionOrderInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  recipeId: recipeIdSchema,
  plannedQty: positiveDecimal4Schema,
  /** Production location; omitted = the outlet's single active kitchen. */
  locationId: stockLocationIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const transitionProductionOrderInputSchema = clientInputSchema({
  action: productionOrderActionSchema,
  actualQty: positiveDecimal4Schema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).refine(
  (input) => input.action !== "complete" || input.actualQty !== undefined,
  {
    path: ["actualQty"],
    message: "Completing a batch needs its actual output",
  },
);

export const recipeLineInputSchema = z.strictObject({
  componentType: recipeComponentTypeSchema,
  componentId: uuidSchema,
  quantity: positiveDecimal4Schema,
  uomId: uomIdSchema,
  wastePctBp: recipeWastePctSchema,
});

export const createRecipeInputSchema = clientInputSchema({
  brandId: brandIdSchema,
  name: z.string().min(1).max(150),
  /** Null for a menu recipe; set for a semi-finished recipe. */
  outputItemId: inventoryItemIdSchema.nullable().optional(),
  yieldQuantity: positiveDecimal4Schema,
  yieldUomId: uomIdSchema,
  lines: z.array(recipeLineInputSchema).min(1),
  idempotencyKey: idempotencyKeySchema,
});

/** Editing a recipe creates the next version; old versions stay readable. */
export const createRecipeVersionInputSchema = clientInputSchema({
  name: z.string().min(1).max(150).optional(),
  yieldQuantity: positiveDecimal4Schema.optional(),
  yieldUomId: uomIdSchema.optional(),
  lines: z.array(recipeLineInputSchema).min(1),
  changeNote: z.string().max(300).optional(),
  idempotencyKey: idempotencyKeySchema,
});

// ---- Read endpoints -------------------------------------------------------

export const listInventoryItems = defineEndpoint({
  method: "GET",
  path: "/api/inventory/items",
  query: inventoryItemListQuerySchema,
  response: cursorPageSchema(inventoryItemSchema),
});

export const getInventoryItem = defineEndpoint({
  method: "GET",
  path: "/api/inventory/items/:itemId",
  params: z.strictObject({ itemId: inventoryItemIdSchema }),
  response: dataResponseSchema(inventoryItemSchema),
});

export const listUoms = defineEndpoint({
  method: "GET",
  path: "/api/inventory/uoms",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(uomSchema),
});

export const listUomConversions = defineEndpoint({
  method: "GET",
  path: "/api/inventory/items/:itemId/uom-conversions",
  params: z.strictObject({ itemId: inventoryItemIdSchema }),
  response: dataResponseSchema(z.array(uomConversionSchema)),
});

export const listStockLocations = defineEndpoint({
  method: "GET",
  path: "/api/inventory/locations",
  query: stockLocationListQuerySchema,
  response: cursorPageSchema(stockLocationSchema),
});

export const listStockLedger = defineEndpoint({
  method: "GET",
  path: "/api/inventory/stock-ledger",
  query: stockLedgerQuerySchema,
  response: cursorPageSchema(stockLedgerEntrySchema),
});

export const listStockBalances = defineEndpoint({
  method: "GET",
  path: "/api/inventory/balances",
  query: stockBalanceQuerySchema,
  response: cursorPageSchema(stockBalanceSchema),
});

export const listStockBatches = defineEndpoint({
  method: "GET",
  path: "/api/inventory/batches",
  query: stockBatchQuerySchema,
  response: cursorPageSchema(stockBatchSchema),
});

export const listParLevels = defineEndpoint({
  method: "GET",
  path: "/api/inventory/par-levels",
  query: parLevelQuerySchema,
  response: cursorPageSchema(parLevelSchema),
});

export const listStockCounts = defineEndpoint({
  method: "GET",
  path: "/api/inventory/stock-counts",
  query: stockCountQuerySchema,
  response: cursorPageSchema(stockCountSchema),
});

export const getStockCount = defineEndpoint({
  method: "GET",
  path: "/api/inventory/stock-counts/:stockCountId",
  params: z.strictObject({ stockCountId: stockCountIdSchema }),
  response: dataResponseSchema(stockCountDetailSchema),
});

export const listWasteLogs = defineEndpoint({
  method: "GET",
  path: "/api/inventory/waste-logs",
  query: wasteLogQuerySchema,
  response: cursorPageSchema(wasteLogSchema),
});

export const listRecipes = defineEndpoint({
  method: "GET",
  path: "/api/inventory/recipes",
  query: recipeQuerySchema,
  response: cursorPageSchema(recipeSchema),
});

export const getRecipe = defineEndpoint({
  method: "GET",
  path: "/api/inventory/recipes/:recipeId",
  params: z.strictObject({ recipeId: recipeIdSchema }),
  response: dataResponseSchema(recipeDetailSchema),
});

export const listProductionOrders = defineEndpoint({
  method: "GET",
  path: "/api/inventory/production-orders",
  query: productionOrderQuerySchema,
  response: cursorPageSchema(productionOrderSchema),
});

export const listMenuCosts = defineEndpoint({
  method: "GET",
  path: "/api/inventory/menu-costs",
  query: menuCostQuerySchema,
  response: cursorPageSchema(menuCostSchema),
});

export const listFoodCostComparisons = defineEndpoint({
  method: "GET",
  path: "/api/inventory/food-cost",
  query: foodCostQuerySchema,
  response: cursorPageSchema(foodCostComparisonSchema),
});

export const listMenuEngineering = defineEndpoint({
  method: "GET",
  path: "/api/inventory/menu-engineering",
  query: menuEngineeringQuerySchema,
  response: cursorPageSchema(menuEngineeringRowSchema),
});

export const listRecipeCoverage = defineEndpoint({
  method: "GET",
  path: "/api/inventory/recipe-coverage",
  query: recipeCoverageQuerySchema,
  response: cursorPageSchema(recipeCoverageRowSchema),
});

// ---- Write endpoints ------------------------------------------------------

export const createInventoryItem = defineEndpoint({
  method: "POST",
  path: "/api/inventory/items",
  body: createInventoryItemInputSchema,
  response: dataResponseSchema(inventoryItemSchema),
});

export const updateInventoryItem = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/items/:itemId",
  params: z.strictObject({ itemId: inventoryItemIdSchema }),
  body: updateInventoryItemInputSchema,
  response: dataResponseSchema(inventoryItemSchema),
});

// ---- Setup: locations, alternates, conversions, transfers -----------------

export const createStockLocation = defineEndpoint({
  method: "POST",
  path: "/api/inventory/locations",
  body: createStockLocationInputSchema,
  response: dataResponseSchema(stockLocationSchema),
});

export const updateStockLocation = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/locations/:locationId",
  params: z.strictObject({ locationId: stockLocationIdSchema }),
  body: updateStockLocationInputSchema,
  response: dataResponseSchema(stockLocationSchema),
});

export const createUom = defineEndpoint({
  method: "POST",
  path: "/api/inventory/uoms",
  body: createUomInputSchema,
  response: dataResponseSchema(uomSchema),
});

export const updateUom = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/uoms/:uomId",
  params: z.strictObject({ uomId: uomIdSchema }),
  body: updateUomInputSchema,
  response: dataResponseSchema(uomSchema),
});

export const listInventoryItemAlternates = defineEndpoint({
  method: "GET",
  path: "/api/inventory/items/:itemId/alternates",
  params: z.strictObject({ itemId: inventoryItemIdSchema }),
  response: dataResponseSchema(z.array(inventoryItemAlternateSchema)),
});

export const createInventoryItemAlternate = defineEndpoint({
  method: "POST",
  path: "/api/inventory/items/:itemId/alternates",
  params: z.strictObject({ itemId: inventoryItemIdSchema }),
  body: createInventoryItemAlternateInputSchema,
  response: dataResponseSchema(inventoryItemAlternateSchema),
});

export const deleteInventoryItemAlternate = defineEndpoint({
  method: "DELETE",
  path: "/api/inventory/items/:itemId/alternates/:alternateId",
  params: z.strictObject({
    itemId: inventoryItemIdSchema,
    alternateId: inventoryItemAlternateIdSchema,
  }),
});

export const createUomConversion = defineEndpoint({
  method: "POST",
  path: "/api/inventory/items/:itemId/uom-conversions",
  params: z.strictObject({ itemId: inventoryItemIdSchema }),
  body: createUomConversionInputSchema,
  response: dataResponseSchema(uomConversionSchema),
});

export const deleteUomConversion = defineEndpoint({
  method: "DELETE",
  path: "/api/inventory/items/:itemId/uom-conversions/:conversionId",
  params: z.strictObject({
    itemId: inventoryItemIdSchema,
    conversionId: uomConversionIdSchema,
  }),
});

export const createParLevel = defineEndpoint({
  method: "POST",
  path: "/api/inventory/par-levels",
  body: createParLevelInputSchema,
  response: dataResponseSchema(parLevelSchema),
});

export const updateParLevel = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/par-levels/:parLevelId",
  params: z.strictObject({ parLevelId: parLevelIdSchema }),
  body: updateParLevelInputSchema,
  response: dataResponseSchema(parLevelSchema),
});

export const deleteParLevel = defineEndpoint({
  method: "DELETE",
  path: "/api/inventory/par-levels/:parLevelId",
  params: z.strictObject({ parLevelId: parLevelIdSchema }),
});

export const getInventorySettings = defineEndpoint({
  method: "GET",
  path: "/api/inventory/settings",
  response: dataResponseSchema(inventorySettingsSchema),
});

export const updateInventorySettings = defineEndpoint({
  method: "PUT",
  path: "/api/inventory/settings",
  body: updateInventorySettingsInputSchema,
  response: dataResponseSchema(inventorySettingsSchema),
});

export const listStockTransfers = defineEndpoint({
  method: "GET",
  path: "/api/inventory/transfers",
  query: stockTransferListQuerySchema,
  response: cursorPageSchema(stockTransferSchema),
});

export const createStockTransfer = defineEndpoint({
  method: "POST",
  path: "/api/inventory/transfers",
  body: createStockTransferInputSchema,
  response: dataResponseSchema(stockTransferSchema),
});

export const createStockCount = defineEndpoint({
  method: "POST",
  path: "/api/inventory/stock-counts",
  body: createStockCountInputSchema,
  response: dataResponseSchema(stockCountDetailSchema),
});

export const updateStockCountLine = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/stock-counts/:stockCountId/lines/:lineId",
  params: z.strictObject({
    stockCountId: stockCountIdSchema,
    lineId: stockCountLineIdSchema,
  }),
  body: updateStockCountLineInputSchema,
  response: dataResponseSchema(stockCountLineSchema),
});

export const getStockCountSheet = defineEndpoint({
  method: "GET",
  path: "/api/inventory/stock-counts/:stockCountId/sheet",
  params: z.strictObject({ stockCountId: stockCountIdSchema }),
  response: dataResponseSchema(stockCountSheetSchema),
});

export const updateStockCountSheetLine = defineEndpoint({
  method: "PATCH",
  path: "/api/inventory/stock-counts/:stockCountId/sheet/lines/:lineId",
  params: z.strictObject({
    stockCountId: stockCountIdSchema,
    lineId: stockCountLineIdSchema,
  }),
  body: updateStockCountLineInputSchema,
  response: dataResponseSchema(stockCountSheetLineSchema),
});

export const postStockCountTransition = defineEndpoint({
  method: "POST",
  path: "/api/inventory/stock-counts/:stockCountId/transitions",
  params: z.strictObject({ stockCountId: stockCountIdSchema }),
  body: transitionStockCountInputSchema,
  response: dataResponseSchema(stockCountSchema),
});

export const createWasteLog = defineEndpoint({
  method: "POST",
  path: "/api/inventory/waste-logs",
  body: createWasteLogInputSchema,
  response: dataResponseSchema(wasteLogSchema),
});

export const createProductionOrder = defineEndpoint({
  method: "POST",
  path: "/api/inventory/production-orders",
  body: createProductionOrderInputSchema,
  response: dataResponseSchema(productionOrderSchema),
});

export const postProductionOrderTransition = defineEndpoint({
  method: "POST",
  path: "/api/inventory/production-orders/:productionOrderId/transitions",
  params: z.strictObject({
    productionOrderId: productionOrderIdSchema,
  }),
  body: transitionProductionOrderInputSchema,
  response: dataResponseSchema(productionOrderSchema),
});

export const createRecipe = defineEndpoint({
  method: "POST",
  path: "/api/inventory/recipes",
  body: createRecipeInputSchema,
  response: dataResponseSchema(recipeDetailSchema),
});

export const createRecipeVersion = defineEndpoint({
  method: "POST",
  path: "/api/inventory/recipes/:recipeId/versions",
  params: z.strictObject({ recipeId: recipeIdSchema }),
  body: createRecipeVersionInputSchema,
  response: dataResponseSchema(recipeDetailSchema),
});

/**
 * Every inventory endpoint in one list, for API route registration, FE mock
 * discovery and contract tests: ids are unique and paths live under
 * /api/inventory.
 */
export const inventoryEndpoints = [
  listInventoryItems,
  getInventoryItem,
  listUoms,
  listUomConversions,
  listStockLocations,
  listStockLedger,
  listStockBalances,
  listStockBatches,
  listParLevels,
  listStockCounts,
  getStockCount,
  listWasteLogs,
  listRecipes,
  getRecipe,
  listProductionOrders,
  listMenuCosts,
  listFoodCostComparisons,
  listMenuEngineering,
  listRecipeCoverage,
  createInventoryItem,
  updateInventoryItem,
  createStockLocation,
  updateStockLocation,
  createUom,
  updateUom,
  listInventoryItemAlternates,
  createInventoryItemAlternate,
  deleteInventoryItemAlternate,
  createUomConversion,
  deleteUomConversion,
  createParLevel,
  updateParLevel,
  deleteParLevel,
  getInventorySettings,
  updateInventorySettings,
  listStockTransfers,
  createStockTransfer,
  createStockCount,
  updateStockCountLine,
  getStockCountSheet,
  updateStockCountSheetLine,
  postStockCountTransition,
  createWasteLog,
  createProductionOrder,
  postProductionOrderTransition,
  createRecipe,
  createRecipeVersion,
] as const;
