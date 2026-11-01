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
  createTaxRule,
  updateTaxRule,
  publishTaxRule,
  listServiceChargeRules,
  createServiceChargeRule,
  updateServiceChargeRule,
  publishServiceChargeRule,
  listTaxSettings,
  createTaxSettings,
  publishTaxSettings,
  previewTaxCalculation,
  getPbjtMonthlyRecap,
] as const;
