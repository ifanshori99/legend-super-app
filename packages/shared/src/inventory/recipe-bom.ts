// Recipe/BOM auto-deduction contracts (bead legend-db6): modifier recipe rules,
// recipe deductions (sale, remake, comp, duty meal), per-outlet deduction
// settings, duty-meal input and the `order_issue.recorded` event.
//
// - INV-02: a sale consumes every recipe line through nested recipes, with UOM
//   conversion and waste gross-up; the deduction row records what was drawn.
// - KDS-07: a remake or comp recorded at the KDS consumes stock again, kept
//   apart from sales by `kind`.
//
// Quantities are NUMERIC(14,4) `Decimal4` strings, money is whole IDR
// (docs/plan/contracts.md). Read endpoints for recipes themselves live in
// `endpoints.ts`; this file adds the pieces around deduction.

import {
  businessDateSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import {
  inventoryItemIdSchema,
  nonnegativeDecimal4Schema,
  nonnegativeIdrSchema,
  positiveDecimal4Schema,
  recipeComponentTypeSchema,
  recipeDeductionModeSchema,
  recipeDetailSchema,
  recipeIdSchema,
  recipeWastePctSchema,
  stockLocationIdSchema,
  uomIdSchema,
} from "./schemas.ts";

// ---- Modifier recipe rules ------------------------------------------------

export const modifierRecipeRuleActionSchema = z.enum([
  "add",
  "replace",
  "remove",
]);
export type ModifierRecipeRuleAction = z.infer<
  typeof modifierRecipeRuleActionSchema
>;

const modifierRuleFields = {
  action: modifierRecipeRuleActionSchema,
  /** The top-level base line to drop (`remove`, `replace`). */
  targetComponentType: recipeComponentTypeSchema.nullable(),
  targetComponentId: uuidSchema.nullable(),
  /** The component to draw (`add`, `replace`), per one sold unit. */
  componentType: recipeComponentTypeSchema.nullable(),
  componentId: uuidSchema.nullable(),
  quantity: positiveDecimal4Schema.nullable(),
  uomId: uomIdSchema.nullable(),
  wastePctBp: recipeWastePctSchema,
};

type ModifierRuleShape = {
  action: ModifierRecipeRuleAction;
  targetComponentType: string | null;
  targetComponentId: string | null;
  componentType: string | null;
  componentId: string | null;
  quantity: string | null;
  uomId: string | null;
};

/** add: component only; replace: target and component; remove: target only. */
function refineModifierRuleShape(
  rule: ModifierRuleShape,
  context: z.RefinementCtx,
): void {
  const hasTarget =
    rule.targetComponentType !== null && rule.targetComponentId !== null;
  const noTarget =
    rule.targetComponentType === null && rule.targetComponentId === null;
  const hasComponent =
    rule.componentType !== null &&
    rule.componentId !== null &&
    rule.quantity !== null &&
    rule.uomId !== null;
  const noComponent =
    rule.componentType === null &&
    rule.componentId === null &&
    rule.quantity === null &&
    rule.uomId === null;
  const needsTarget = rule.action !== "add";
  const needsComponent = rule.action !== "remove";
  if (needsTarget ? !hasTarget : !noTarget)
    context.addIssue({
      code: "custom",
      path: ["targetComponentId"],
      message: needsTarget
        ? `A ${rule.action} rule needs a target component`
        : "An add rule must not have a target component",
    });
  if (needsComponent ? !hasComponent : !noComponent)
    context.addIssue({
      code: "custom",
      path: ["componentId"],
      message: needsComponent
        ? `A ${rule.action} rule needs a component, quantity and unit`
        : "A remove rule must not have a component",
    });
}

export const modifierRecipeRuleSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    modifierId: uuidSchema,
    ...modifierRuleFields,
  })
  .superRefine(refineModifierRuleShape);
export type ModifierRecipeRule = z.infer<typeof modifierRecipeRuleSchema>;

export const modifierRecipeRuleInputSchema = z
  .strictObject(modifierRuleFields)
  .superRefine(refineModifierRuleShape);
export type ModifierRecipeRuleInput = z.infer<
  typeof modifierRecipeRuleInputSchema
>;

/** Replaces every rule of one modifier; an empty list clears them. */
export const putModifierRecipeRulesInputSchema = z.strictObject({
  rules: z.array(modifierRecipeRuleInputSchema).max(50),
});
export type PutModifierRecipeRulesInput = z.infer<
  typeof putModifierRecipeRulesInputSchema
>;

// ---- Recipe deductions ----------------------------------------------------

export const recipeDeductionKindSchema = z.enum([
  "sale",
  "remake",
  "comp",
  "duty_meal",
]);
export type RecipeDeductionKind = z.infer<typeof recipeDeductionKindSchema>;

export const recipeDeductionStatusSchema = z.enum([
  "pending",
  "posted",
  "skipped",
  "reversed",
]);
export type RecipeDeductionStatus = z.infer<typeof recipeDeductionStatusSchema>;

export const recipeDeductionSkipReasonSchema = z.enum([
  "no_recipe",
  "no_sale_location",
  "recipe_inactive",
  "recipe_error",
]);
export type RecipeDeductionSkipReason = z.infer<
  typeof recipeDeductionSkipReasonSchema
>;

/** Why a sale deduction was reversed (legend-9w46). */
export const recipeDeductionReversalReasonSchema = z.enum(["void", "refund"]);
export type RecipeDeductionReversalReason = z.infer<
  typeof recipeDeductionReversalReasonSchema
>;

export const recipeDeductionSourceTypeSchema = z.enum([
  "order",
  "order_issue",
  "duty_meal",
]);
export type RecipeDeductionSourceType = z.infer<
  typeof recipeDeductionSourceTypeSchema
>;

/**
 * One item drawn by a deduction, in the item's base UOM. `unitCostIdr` and
 * `ledgerEntryId` stay null until the deduction is posted (and `unitCostIdr`
 * is hidden from callers without `inventory.cost.view`).
 */
export const recipeDeductionLineSchema = z.strictObject({
  inventoryItemId: inventoryItemIdSchema,
  locationId: stockLocationIdSchema,
  quantity: positiveDecimal4Schema,
  unitCostIdr: nonnegativeDecimal4Schema.nullable(),
  ledgerEntryId: z.string().min(1).max(64).nullable(),
});
export type RecipeDeductionLine = z.infer<typeof recipeDeductionLineSchema>;

export const recipeDeductionSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  kind: recipeDeductionKindSchema,
  status: recipeDeductionStatusSchema,
  /** The deduction mode in force when the deduction was recorded. */
  mode: recipeDeductionModeSchema,
  sourceType: recipeDeductionSourceTypeSchema,
  /** Order ULID, order-issue UUID or duty-meal deduction id. */
  sourceId: z.string().min(1).max(64),
  businessDate: businessDateSchema,
  costIdr: nonnegativeIdrSchema.nullable(),
  skipReason: recipeDeductionSkipReasonSchema.nullable(),
  reason: z.string().max(200).nullable(),
  recordedBy: userIdSchema.nullable(),
  /** Who ate the duty meal; null for other kinds. */
  beneficiaryUserId: userIdSchema.nullable(),
  shiftId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  postedAt: isoDateTimeSchema.nullable(),
  /** Set once when the order was voided after payment or fully refunded. */
  reversedAt: isoDateTimeSchema.nullable(),
  reversalReason: recipeDeductionReversalReasonSchema.nullable(),
  lines: z.array(recipeDeductionLineSchema),
});
export type RecipeDeduction = z.infer<typeof recipeDeductionSchema>;

export const recipeDeductionQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  businessDate: businessDateSchema.optional(),
  kind: recipeDeductionKindSchema.optional(),
});

// ---- Outlet deduction settings --------------------------------------------

/** `recipeDeductionMode` null = follow the tenant setting. */
export const outletDeductionSettingsSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  recipeDeductionMode: recipeDeductionModeSchema.nullable(),
  effectiveMode: recipeDeductionModeSchema,
  /** Location every sale draws from; null = deductions are skipped. */
  saleLocationId: stockLocationIdSchema.nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type OutletDeductionSettings = z.infer<
  typeof outletDeductionSettingsSchema
>;

export const putOutletDeductionSettingsInputSchema = z.strictObject({
  recipeDeductionMode: recipeDeductionModeSchema.nullable(),
  saleLocationId: stockLocationIdSchema.nullable(),
});
export type PutOutletDeductionSettingsInput = z.infer<
  typeof putOutletDeductionSettingsInputSchema
>;

// ---- Duty meal ------------------------------------------------------------

export const recordDutyMealInputSchema = z.strictObject({
  outletId: outletIdSchema,
  employeeUserId: userIdSchema,
  shiftId: uuidSchema.nullable(),
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  modifierIds: z.array(uuidSchema).max(20),
  quantity: z.number().int().min(1).max(20),
  note: z.string().max(200).nullable(),
  idempotencyKey: z.string().min(8).max(100),
});
export type RecordDutyMealInput = z.infer<typeof recordDutyMealInputSchema>;

// ---- order_issue.recorded (KDS-07) ----------------------------------------

export const orderIssueTypeSchema = z.enum(["remake", "comp"]);
export type OrderIssueType = z.infer<typeof orderIssueTypeSchema>;

export const orderIssueReasonSchema = z.enum([
  "wrong_order",
  "quality",
  "late",
  "complaint",
]);
export type OrderIssueReason = z.infer<typeof orderIssueReasonSchema>;

/**
 * A remake (kitchen cooks the line again) or comp (line given free) recorded
 * for one order line. Carries the menu selection so the inventory consumer
 * does not read the order. Emitter: KDS follow-up; inventory consumes it.
 */
export const orderIssueRecordedPayloadSchema = z.strictObject({
  issueId: uuidSchema,
  orderId: orderIdSchema,
  orderItemId: z.string().min(1).max(64),
  outletId: outletIdSchema,
  businessDate: businessDateSchema,
  type: orderIssueTypeSchema,
  reason: orderIssueReasonSchema,
  stationId: uuidSchema.nullable(),
  recordedBy: userIdSchema,
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  modifierIds: z.array(uuidSchema).max(20),
  quantity: z.number().int().min(1),
  occurredAt: isoDateTimeSchema,
});
export type OrderIssueRecordedPayload = z.infer<
  typeof orderIssueRecordedPayloadSchema
>;

export const orderIssueRecordedEvent = defineDomainEvent({
  name: "order_issue.recorded",
  payload: orderIssueRecordedPayloadSchema as z.ZodType<
    Record<string, unknown>
  >,
});

// ---- Endpoints ------------------------------------------------------------

const recipeIdParams = z.strictObject({ recipeId: recipeIdSchema });
const outletIdParams = z.strictObject({ outletId: outletIdSchema });

export const deactivateRecipe = defineEndpoint({
  method: "POST",
  path: "/api/inventory/recipes/:recipeId/deactivate",
  params: recipeIdParams,
  response: dataResponseSchema(recipeDetailSchema),
});

export const listModifierRecipeRules = defineEndpoint({
  method: "GET",
  path: "/api/inventory/modifiers/:modifierId/recipe-rules",
  params: z.strictObject({ modifierId: uuidSchema }),
  response: dataResponseSchema(z.array(modifierRecipeRuleSchema)),
});

export const putModifierRecipeRules = defineEndpoint({
  method: "PUT",
  path: "/api/inventory/modifiers/:modifierId/recipe-rules",
  params: z.strictObject({ modifierId: uuidSchema }),
  body: putModifierRecipeRulesInputSchema,
  response: dataResponseSchema(z.array(modifierRecipeRuleSchema)),
});

export const getOutletDeductionSettings = defineEndpoint({
  method: "GET",
  path: "/api/inventory/outlets/:outletId/deduction-settings",
  params: outletIdParams,
  response: dataResponseSchema(outletDeductionSettingsSchema),
});

export const putOutletDeductionSettings = defineEndpoint({
  method: "PUT",
  path: "/api/inventory/outlets/:outletId/deduction-settings",
  params: outletIdParams,
  body: putOutletDeductionSettingsInputSchema,
  response: dataResponseSchema(outletDeductionSettingsSchema),
});

export const recordDutyMeal = defineEndpoint({
  method: "POST",
  path: "/api/inventory/duty-meals",
  body: recordDutyMealInputSchema,
  response: dataResponseSchema(recipeDeductionSchema),
});

export const listRecipeDeductions = defineEndpoint({
  method: "GET",
  path: "/api/inventory/recipe-deductions",
  query: recipeDeductionQuerySchema,
  response: cursorPageSchema(recipeDeductionSchema),
});

export const recipeBomEndpoints = [
  deactivateRecipe,
  listModifierRecipeRules,
  putModifierRecipeRules,
  getOutletDeductionSettings,
  putOutletDeductionSettings,
  recordDutyMeal,
  listRecipeDeductions,
] as const;
