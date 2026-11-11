// HTTP contracts for tax configuration, calculation preview and the PBJT recap
// (defineEndpoint pattern, see api/example.ts). Tenant always comes from the
// trusted context (TEN-02); bodies are clientInputSchema (tenant fields refused).

import {
  z,
  businessDateSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  outletIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  ruleCodeSchema,
  ruleVersionStatusSchema,
  pbjtMonthlyRecapSchema,
  serviceChargeRuleFields,
  serviceChargeRuleIdSchema,
  serviceChargeRuleSchema,
  settingsFields,
  taxCalculationInputSchema,
  taxCalculationResultSchema,
  taxChannelSchema,
  taxPeriodSchema,
  taxRuleFields,
  taxRuleIdSchema,
  taxRuleSchema,
  taxSettingsIdSchema,
  taxSettingsSchema,
} from "./schemas.ts";

const listQuery = cursorPageQuerySchema.extend({
  outletId: outletIdSchema.optional(),
  status: ruleVersionStatusSchema.optional(),
  code: ruleCodeSchema.optional(),
});
const publishBody = clientInputSchema({ idempotencyKey: idempotencyKeySchema });
/** Archiving a draft carries no fields; it is naturally idempotent. */
const archiveBody = clientInputSchema({});

// ---- Tax rules --------------------------------------------------------------

/** Creates a draft version (new code, or next version of an existing code). */
export const createTaxRuleInputSchema = clientInputSchema({
  outletId: outletIdSchema.nullable(),
  code: ruleCodeSchema,
  ...taxRuleFields,
  /** Omitted = inherit the tenant/outlet `pricesIncludeTax` setting, so a new
   * rule is exclusive unless the tenant opted into inclusive prices. */
  priceIncludesTax: taxRuleFields.priceIncludesTax.optional(),
  effectiveFrom: businessDateSchema,
});
/** Draft edits only (TAX_RULE_IMMUTABLE otherwise). */
export const updateTaxRuleInputSchema = clientInputSchema({
  ...taxRuleFields,
  effectiveFrom: businessDateSchema,
}).partial();

export const listTaxRules = defineEndpoint({
  method: "GET",
  path: "/api/tax/rules",
  query: listQuery,
  response: cursorPageSchema(taxRuleSchema),
});

const taxRuleConflictSideSchema = z.strictObject({
  id: taxRuleIdSchema,
  code: ruleCodeSchema,
  version: z.number().int().positive().safe(),
  outletId: outletIdSchema.nullable(),
});
/** Two published rules that tie in `resolveTaxRule` (legend-de3b). */
export const taxRuleConflictSchema = z.strictObject({
  ruleA: taxRuleConflictSideSchema,
  ruleB: taxRuleConflictSideSchema,
  /** Null = tenant-wide view. */
  outletId: outletIdSchema.nullable(),
  channel: taxChannelSchema,
  regionCode: z.string().nullable(),
  level: z.enum(["item", "category", "itemClass"]),
  key: z.string(),
  effectiveDate: businessDateSchema,
});
export type TaxRuleConflict = z.infer<typeof taxRuleConflictSchema>;

/** Lists existing published ties so the owner can switch one rule off. */
export const listTaxRuleConflicts = defineEndpoint({
  method: "GET",
  path: "/api/tax/rules/conflicts",
  query: z.strictObject({ outletId: outletIdSchema.optional() }),
  response: z.strictObject({ conflicts: z.array(taxRuleConflictSchema) }),
});
export const createTaxRule = defineEndpoint({
  method: "POST",
  path: "/api/tax/rules",
  body: createTaxRuleInputSchema,
  response: dataResponseSchema(taxRuleSchema),
});
export const updateTaxRule = defineEndpoint({
  method: "PATCH",
  path: "/api/tax/rules/:taxRuleId",
  params: z.strictObject({ taxRuleId: taxRuleIdSchema }),
  body: updateTaxRuleInputSchema,
  response: dataResponseSchema(taxRuleSchema),
});
export const publishTaxRule = defineEndpoint({
  method: "POST",
  path: "/api/tax/rules/:taxRuleId/publish",
  params: z.strictObject({ taxRuleId: taxRuleIdSchema }),
  body: publishBody,
  response: dataResponseSchema(taxRuleSchema),
});
/**
 * Discards a draft (draft -> archived, `archiveRuleVersion`). A published or
 * already archived version is refused (TAX_RULE_IMMUTABLE /
 * TAX_INVALID_TRANSITION): published history is never rewritten (R21).
 */
export const archiveTaxRule = defineEndpoint({
  method: "POST",
  path: "/api/tax/rules/:taxRuleId/archive",
  params: z.strictObject({ taxRuleId: taxRuleIdSchema }),
  body: archiveBody,
  response: dataResponseSchema(taxRuleSchema),
});

// ---- Service-charge rules ---------------------------------------------------

export const createServiceChargeRuleInputSchema = clientInputSchema({
  outletId: outletIdSchema.nullable(),
  code: ruleCodeSchema,
  ...serviceChargeRuleFields,
  effectiveFrom: businessDateSchema,
});
export const updateServiceChargeRuleInputSchema = clientInputSchema({
  ...serviceChargeRuleFields,
  effectiveFrom: businessDateSchema,
}).partial();

export const listServiceChargeRules = defineEndpoint({
  method: "GET",
  path: "/api/tax/service-charge-rules",
  query: listQuery,
  response: cursorPageSchema(serviceChargeRuleSchema),
});
export const createServiceChargeRule = defineEndpoint({
  method: "POST",
  path: "/api/tax/service-charge-rules",
  body: createServiceChargeRuleInputSchema,
  response: dataResponseSchema(serviceChargeRuleSchema),
});
export const updateServiceChargeRule = defineEndpoint({
  method: "PATCH",
  path: "/api/tax/service-charge-rules/:serviceChargeRuleId",
  params: z.strictObject({ serviceChargeRuleId: serviceChargeRuleIdSchema }),
  body: updateServiceChargeRuleInputSchema,
  response: dataResponseSchema(serviceChargeRuleSchema),
});
export const publishServiceChargeRule = defineEndpoint({
  method: "POST",
  path: "/api/tax/service-charge-rules/:serviceChargeRuleId/publish",
  params: z.strictObject({ serviceChargeRuleId: serviceChargeRuleIdSchema }),
  body: publishBody,
  response: dataResponseSchema(serviceChargeRuleSchema),
});

// ---- Calculation settings ---------------------------------------------------

export const createTaxSettingsInputSchema = clientInputSchema({
  outletId: outletIdSchema.nullable(),
  ...settingsFields,
  effectiveFrom: businessDateSchema,
});
/** Draft edits only (TAX_RULE_IMMUTABLE otherwise). */
export const updateTaxSettingsInputSchema = clientInputSchema({
  ...settingsFields,
  effectiveFrom: businessDateSchema,
}).partial();
export const listTaxSettings = defineEndpoint({
  method: "GET",
  path: "/api/tax/settings",
  query: listQuery.omit({ code: true }),
  response: cursorPageSchema(taxSettingsSchema),
});
export const createTaxSettings = defineEndpoint({
  method: "POST",
  path: "/api/tax/settings",
  body: createTaxSettingsInputSchema,
  response: dataResponseSchema(taxSettingsSchema),
});
export const updateTaxSettings = defineEndpoint({
  method: "PATCH",
  path: "/api/tax/settings/:taxSettingsId",
  params: z.strictObject({ taxSettingsId: taxSettingsIdSchema }),
  body: updateTaxSettingsInputSchema,
  response: dataResponseSchema(taxSettingsSchema),
});
/** Discards a settings draft (draft -> archived only). */
export const archiveTaxSettings = defineEndpoint({
  method: "POST",
  path: "/api/tax/settings/:taxSettingsId/archive",
  params: z.strictObject({ taxSettingsId: taxSettingsIdSchema }),
  body: archiveBody,
  response: dataResponseSchema(taxSettingsSchema),
});
export const publishTaxSettings = defineEndpoint({
  method: "POST",
  path: "/api/tax/settings/:taxSettingsId/publish",
  params: z.strictObject({ taxSettingsId: taxSettingsIdSchema }),
  body: publishBody,
  response: dataResponseSchema(taxSettingsSchema),
});

// ---- Preview + report -------------------------------------------------------

/** Server-side preview for the config screen and POS (ORD-03: the server's
 * numbers are the only ones that count). */
export const previewTaxCalculation = defineEndpoint({
  method: "POST",
  path: "/api/tax/preview",
  body: taxCalculationInputSchema,
  response: dataResponseSchema(taxCalculationResultSchema),
});

export const getPbjtMonthlyRecap = defineEndpoint({
  method: "GET",
  path: "/api/tax/reports/pbjt",
  query: z.strictObject({ outletId: outletIdSchema, period: taxPeriodSchema }),
  response: dataResponseSchema(pbjtMonthlyRecapSchema),
});

export const taxEndpoints = [
  listTaxRules,
  listTaxRuleConflicts,
  createTaxRule,
  updateTaxRule,
  publishTaxRule,
  archiveTaxRule,
  listServiceChargeRules,
  createServiceChargeRule,
  updateServiceChargeRule,
  publishServiceChargeRule,
  listTaxSettings,
  createTaxSettings,
  updateTaxSettings,
  archiveTaxSettings,
  publishTaxSettings,
  previewTaxCalculation,
  getPbjtMonthlyRecap,
] as const;
