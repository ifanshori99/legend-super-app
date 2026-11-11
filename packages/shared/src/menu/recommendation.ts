// AI-01 menu recommendation contract: the query, the response and the per
// outlet rules. A recommendation is a suggestion only; nothing here changes a
// price, a discount or an order total.
import {
  z,
  uuidSchema,
  outletIdSchema,
  idrSchema,
  basisPointsSchema,
  isoDateTimeSchema,
} from "../core/index.ts";

/** Menu item and member ids are UUIDs in this domain (menu_items, customer_profiles). */
export const menuRecommendationQuerySchema = z.strictObject({
  outletId: outletIdSchema,
  anchorItemIds: z.array(uuidSchema).max(10).default([]),
  memberId: uuidSchema.optional(),
  /** Evaluation instant for the outlet-local hour window; the service uses now when absent. */
  at: isoDateTimeSchema.optional(),
});
export type MenuRecommendationQuery = z.infer<
  typeof menuRecommendationQuerySchema
>;

export const menuRecommendationReasonSchema = z.enum([
  "pair",
  "member_history",
  "popular",
]);
export type MenuRecommendationReason = z.infer<
  typeof menuRecommendationReasonSchema
>;

export const menuRecommendationSourceSchema = z.enum([
  "cooccurrence",
  "member_history",
  "popular_fallback",
  "none",
]);
export type MenuRecommendationSource = z.infer<
  typeof menuRecommendationSourceSchema
>;

export const menuRecommendationItemSchema = z.strictObject({
  menuItemId: uuidSchema,
  name: z.string().min(1).max(150),
  priceIdr: idrSchema,
  /** Null unless the caller holds recipe.cost.view. */
  marginBps: basisPointsSchema.nullable(),
  reason: menuRecommendationReasonSchema,
  /** Rank only: n for the top suggestion down to 1; never a raw count. */
  score: z.number().nonnegative(),
});
export type MenuRecommendationItem = z.infer<
  typeof menuRecommendationItemSchema
>;

export const menuRecommendationResponseSchema = z.strictObject({
  items: z.array(menuRecommendationItemSchema).max(20),
  source: menuRecommendationSourceSchema,
});
export type MenuRecommendationResponse = z.infer<
  typeof menuRecommendationResponseSchema
>;

const hour = z.number().int().min(0).max(23);

/** Both hours null = all day; window is [hourFrom, hourTo) in outlet-local hours, may wrap midnight. */
export const menuRecommendationItemRuleSchema = z
  .strictObject({
    menuItemId: uuidSchema,
    blocked: z.boolean(),
    hourFrom: hour.nullable(),
    hourTo: hour.nullable(),
  })
  .refine((rule) => (rule.hourFrom === null) === (rule.hourTo === null), {
    message: "hourFrom and hourTo must both be set or both be null",
    path: ["hourTo"],
  });
export type MenuRecommendationItemRule = z.infer<
  typeof menuRecommendationItemRuleSchema
>;

const rulesFields = {
  minMarginBps: basisPointsSchema,
  excludeOutOfStock: z.boolean(),
  maxSuggestions: z.number().int().min(1).max(20),
  /** k-anonymity: a pair must appear in at least this many distinct orders. */
  minPairSupport: z.number().int().min(2),
  lookbackDays: z.number().int().min(7).max(365),
  memberHistoryEnabled: z.boolean(),
  enabled: z.boolean(),
};

export const menuRecommendationRulesSchema = z.strictObject({
  outletId: outletIdSchema,
  ...rulesFields,
  itemRules: z.array(menuRecommendationItemRuleSchema).max(500),
});
export type MenuRecommendationRules = z.infer<
  typeof menuRecommendationRulesSchema
>;

export const menuRecommendationRulesUpdateSchema = z.strictObject({
  minMarginBps: rulesFields.minMarginBps.optional(),
  excludeOutOfStock: rulesFields.excludeOutOfStock.optional(),
  maxSuggestions: rulesFields.maxSuggestions.optional(),
  minPairSupport: rulesFields.minPairSupport.optional(),
  lookbackDays: rulesFields.lookbackDays.optional(),
  memberHistoryEnabled: rulesFields.memberHistoryEnabled.optional(),
  enabled: rulesFields.enabled.optional(),
  itemRules: z.array(menuRecommendationItemRuleSchema).max(500).optional(),
});
export type MenuRecommendationRulesUpdate = z.infer<
  typeof menuRecommendationRulesUpdateSchema
>;
