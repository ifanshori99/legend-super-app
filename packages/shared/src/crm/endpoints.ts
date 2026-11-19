// Typed endpoint contracts for the CRM, loyalty and promo surfaces
// (docs/frontend.md "Typed endpoints and mock mode"). The API validates with
// these same objects and the web app's typed client and mock mode read them.
// Request bodies are built with clientInputSchema, so a submitted tenantId is
// rejected (TEN-02); the server derives ids, timestamps, tenant, customer and
// outlet scope.

import {
  z,
  uuidSchema,
  idempotencyKeySchema,
  clientInputSchema,
  cursorPageMetaSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  ulidIdSchema,
  businessDateSchema,
  userIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { memberQrTokenMintInputSchema } from "../validators/member-qr-token.ts";
import {
  consentPurposeSchema,
  customerProfileDtoSchema,
  loyaltyProgramSchema,
  referralRulesSchema,
  loyaltyAntiFraudSchema,
  loyaltyProgramWithTiersSchema,
  loyaltyTierSchema,
  missionObjectSchema,
  missionSchema,
  pointLedgerEntrySchema,
  rewardObjectSchema,
  rewardRedemptionSchema,
  redemptionCodeSchema,
  rewardSchema,
  customerConsentSchema,
  referralCodeSchema,
} from "./loyalty.ts";
import {
  campaignAbTestSchema,
  campaignActionSchema,
  campaignChannelSchema,
  campaignContentSchema,
  campaignResultsSchema,
  campaignSchema,
  campaignStatusSchema,
  customer360Schema,
  customerFavoriteItemSchema,
  customerVisitSchema,
  feedbackActionSchema,
  feedbackKindSchema,
  feedbackSchema,
  feedbackStatusSchema,
  memberOverviewSchema,
  missionWithProgressSchema,
  segmentDefinitionSchema,
  segmentPreviewSchema,
  segmentSchema,
} from "./crm.ts";
import {
  promoEvaluationRequestSchema,
  promoStackingPolicySchema,
  promotionApplicationResultSchema,
  promotionObjectSchema,
  promotionOutletSchema,
  promotionOutletScopeSchema,
  promotionRoiSchema,
  promotionSchema,
  promotionStatusSchema,
  voucherDtoSchema,
  voucherIssuedSchema,
  voucherSourceSchema,
  voucherStatusSchema,
  voucherValidationInputSchema,
  voucherValidationResultSchema,
} from "./promo.ts";

const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const page = <Item extends z.ZodType>(item: Item) => cursorPageSchema(item);
// Generic over the shape so the parsed query keeps its keys (a bare
// `z.ZodRawShape` widened every list query to `{ [key: string]: unknown }`).
const withFilters = <Shape extends z.ZodRawShape>(shape: Shape) =>
  cursorPageQuerySchema.extend(shape);

const customerProfileIdParams = z.strictObject({
  customerProfileId: uuidSchema,
});
const rewardIdParams = z.strictObject({ rewardId: uuidSchema });
// legend-m4p5
const redemptionIdParams = z.strictObject({ redemptionId: uuidSchema });
const tierIdParams = z.strictObject({ tierId: uuidSchema });
const missionIdParams = z.strictObject({ missionId: uuidSchema });
const promotionIdParams = z.strictObject({ promotionId: uuidSchema });
const campaignIdParams = z.strictObject({ campaignId: uuidSchema });
const feedbackIdParams = z.strictObject({ feedbackId: uuidSchema });

// ---- Member PWA (bead legend-c3lm) ---------------------------------------

export const getMemberProfile = defineEndpoint({
  method: "GET",
  path: "/api/member/profile",
  response: dataResponseSchema(customerProfileDtoSchema),
});

export const getMemberOverview = defineEndpoint({
  method: "GET",
  path: "/api/member/overview",
  response: dataResponseSchema(memberOverviewSchema),
});

/** Points about to expire (legend-3zd1); additive, absent on other lists. */
export const memberPointsExpiringSoonSchema = z.strictObject({
  points: z.number().int().min(0),
  earliestExpiresAt: isoDateTimeSchema.nullable(),
});

export const listMemberPoints = defineEndpoint({
  method: "GET",
  path: "/api/member/points",
  query: cursorPageQuerySchema,
  response: z.object({
    data: z.array(pointLedgerEntrySchema),
    meta: cursorPageMetaSchema.extend({
      expiringSoon: memberPointsExpiringSoonSchema.optional(),
    }),
  }),
});

export const listMemberRewards = defineEndpoint({
  method: "GET",
  path: "/api/member/rewards",
  query: cursorPageQuerySchema,
  response: page(rewardSchema),
});

export const redeemRewardInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});

export const redeemReward = defineEndpoint({
  method: "POST",
  path: "/api/member/rewards/:rewardId/redemptions",
  params: rewardIdParams,
  body: redeemRewardInputSchema,
  response: dataResponseSchema(rewardRedemptionSchema),
});

// legend-m4p5
export const listMemberRedemptions = defineEndpoint({
  method: "GET",
  path: "/api/member/redemptions",
  query: cursorPageQuerySchema,
  response: page(rewardRedemptionSchema),
});

// legend-m4p5
export const cancelMemberRedemption = defineEndpoint({
  method: "POST",
  path: "/api/member/redemptions/:redemptionId/cancel",
  params: redemptionIdParams,
  response: dataResponseSchema(rewardRedemptionSchema),
});

export const listMemberMissions = defineEndpoint({
  method: "GET",
  path: "/api/member/missions",
  response: dataResponseSchema(z.array(missionWithProgressSchema)),
});

export const listMemberVouchers = defineEndpoint({
  method: "GET",
  path: "/api/member/vouchers",
  query: cursorPageQuerySchema,
  response: page(voucherDtoSchema),
});

export const listMemberVisits = defineEndpoint({
  method: "GET",
  path: "/api/member/visits",
  query: cursorPageQuerySchema,
  response: page(customerVisitSchema),
});

export const listMemberFavorites = defineEndpoint({
  method: "GET",
  path: "/api/member/favorites",
  response: dataResponseSchema(z.array(customerFavoriteItemSchema)),
});

export const updateMemberConsentInputSchema = clientInputSchema({
  purpose: consentPurposeSchema,
  granted: z.boolean(),
  policyVersion: z.string().min(1).max(20),
  /** Referral code typed at signup (legend-3zd1); unknown codes are ignored. */
  referralCode: referralCodeSchema.optional(),
});

export const updateMemberConsent = defineEndpoint({
  method: "POST",
  path: "/api/member/consents",
  body: updateMemberConsentInputSchema,
  response: dataResponseSchema(customerConsentSchema),
});

// ---- Consent policies, member QR, order customer, anomalies (legend-111j) --

/** Active consent policy versions the member PWA shows before a grant. */
export const consentPolicyVersionSchema = z.strictObject({
  purpose: consentPurposeSchema,
  version: z.string().min(1).max(20),
  publishedAt: isoDateTimeSchema,
});
export type ConsentPolicyVersion = z.infer<typeof consentPolicyVersionSchema>;

export const listMemberConsentPolicies = defineEndpoint({
  method: "GET",
  path: "/api/member/consent-policies",
  response: dataResponseSchema(z.array(consentPolicyVersionSchema)),
});

/** Short-lived (120 s) signed token the cashier scans to attach a member. */
export const memberQrTokenSchema = z.strictObject({
  token: z.string().min(1).max(500),
  expiresAt: isoDateTimeSchema,
});
export type MemberQrToken = z.infer<typeof memberQrTokenSchema>;

export const issueMemberQrToken = defineEndpoint({
  method: "POST",
  path: "/api/member/qr-token",
  body: memberQrTokenMintInputSchema,
  response: dataResponseSchema(memberQrTokenSchema),
});

export const orderCustomerAttachViaSchema = z.enum([
  "member_qr",
  "phone_lookup",
  "pwa_session",
  "receipt_claim",
]);
export type OrderCustomerAttachVia = z.infer<
  typeof orderCustomerAttachViaSchema
>;

/**
 * Attach a member to an unpaid order by QR token or WhatsApp number, or detach
 * with `customerProfileId: null`. The server derives who attached and when.
 */
/**
 * Exactly one of: `memberToken` (rotating member QR), `whatsappNumber`
 * (cashier lookup, capped per cashier per day) or `customerProfileId: null`
 * (detach). One object, not a union, so the endpoint body keeps its shape.
 */
export const setOrderCustomerInputSchema = clientInputSchema({
  memberToken: z.string().min(1).max(500).optional(),
  whatsappNumber: z.string().min(6).max(20).optional(),
  customerProfileId: z.null().optional(),
}).superRefine((value, ctx) => {
  const given = [
    value.memberToken !== undefined,
    value.whatsappNumber !== undefined,
    value.customerProfileId !== undefined,
  ].filter(Boolean).length;
  if (given !== 1)
    ctx.addIssue({
      code: "custom",
      message:
        "Send exactly one of memberToken, whatsappNumber or customerProfileId: null.",
    });
});
export type SetOrderCustomerInput = z.infer<typeof setOrderCustomerInputSchema>;

export const orderCustomerSummarySchema = z.strictObject({
  orderId: ulidIdSchema<"OrderId">(),
  customerProfileId: uuidSchema.nullable(),
  customerName: z.string().min(1).max(150).nullable(),
  attachedVia: orderCustomerAttachViaSchema.nullable(),
  attachedAt: isoDateTimeSchema.nullable(),
});
export type OrderCustomerSummary = z.infer<typeof orderCustomerSummarySchema>;

export const setOrderCustomer = defineEndpoint({
  method: "PUT",
  path: "/api/pos/orders/:orderId/customer",
  params: z.strictObject({ orderId: ulidIdSchema<"OrderId">() }),
  body: setOrderCustomerInputSchema,
  response: dataResponseSchema(orderCustomerSummarySchema),
});

export const loyaltyAnomalyKindSchema = z.enum([
  "daily_cap_hit",
  "self_serve_blocked",
  "refund_after_redeem",
  "phone_lookup_attach",
  "phone_lookup_cap_hit",
  "balance_mismatch",
]);
export type LoyaltyAnomalyKind = z.infer<typeof loyaltyAnomalyKindSchema>;

export const loyaltyAnomalySchema = z.strictObject({
  id: uuidSchema,
  kind: loyaltyAnomalyKindSchema,
  outletId: outletIdSchema.nullable(),
  customerProfileId: uuidSchema.nullable(),
  orderId: ulidIdSchema<"OrderId">().nullable(),
  actorUserId: userIdSchema.nullable(),
  businessDate: businessDateSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
});
export type LoyaltyAnomaly = z.infer<typeof loyaltyAnomalySchema>;

export const listLoyaltyAnomaliesQuerySchema = withFilters({
  kind: loyaltyAnomalyKindSchema.optional(),
});

export const listLoyaltyAnomalies = defineEndpoint({
  method: "GET",
  path: "/api/loyalty/anomalies",
  query: listLoyaltyAnomaliesQuerySchema,
  response: page(loyaltyAnomalySchema),
});

export const submitFeedbackInputSchema = clientInputSchema({
  kind: feedbackKindSchema,
  rating: z.number().int().min(1).max(5).nullable(),
  comment: z.string().max(2000).nullable(),
  tableSessionId: uuidSchema.nullable(),
  orderId: ulidIdSchema<"OrderId">().nullable(),
});

export const submitFeedback = defineEndpoint({
  method: "POST",
  path: "/api/member/feedback",
  body: submitFeedbackInputSchema,
  response: dataResponseSchema(feedbackSchema),
});

// ---- Customer 360 and point ledger (bead legend-i026) --------------------

export const listCustomersQuerySchema = withFilters({
  q: z.string().trim().min(1).max(100).optional(),
  tierId: uuidSchema.optional(),
  membershipStatus: z
    .enum(["pending_verification", "active", "suspended", "closed"])
    .optional(),
});

export const listCustomers = defineEndpoint({
  method: "GET",
  path: "/api/customers",
  query: listCustomersQuerySchema,
  response: page(customerProfileDtoSchema),
});

export const getCustomer360 = defineEndpoint({
  method: "GET",
  path: "/api/customers/:customerProfileId",
  params: customerProfileIdParams,
  response: dataResponseSchema(customer360Schema),
});

export const listCustomerPoints = defineEndpoint({
  method: "GET",
  path: "/api/customers/:customerProfileId/points",
  params: customerProfileIdParams,
  query: cursorPageQuerySchema,
  response: page(pointLedgerEntrySchema),
});

// ---- Loyalty admin (bead legend-m8ow) ------------------------------------

export const getLoyaltyProgram = defineEndpoint({
  method: "GET",
  path: "/api/loyalty/program",
  response: dataResponseSchema(loyaltyProgramWithTiersSchema),
});

/**
 * Update input. `referral` and `antiFraud` are optional WITHOUT defaults:
 * omitted keeps the stored value (so a form that does not edit them never
 * resets them); a sent object replaces that whole block. The response schema
 * keeps the defaults for rows that predate the fields.
 */
export const updateLoyaltyProgramInputSchema = clientInputSchema({
  ...loyaltyProgramSchema.omit({
    id: true,
    tenantId: true,
    updatedAt: true,
    referral: true,
    antiFraud: true,
    legalEntityId: true,
  }).shape,
  legalEntityId: uuidSchema.nullable().optional(),
  referral: referralRulesSchema.optional(),
  antiFraud: loyaltyAntiFraudSchema.optional(),
});

export const updateLoyaltyProgram = defineEndpoint({
  method: "PUT",
  path: "/api/loyalty/program",
  body: updateLoyaltyProgramInputSchema,
  response: dataResponseSchema(loyaltyProgramSchema),
});

export const listLoyaltyTiers = defineEndpoint({
  method: "GET",
  path: "/api/loyalty/tiers",
  response: dataResponseSchema(z.array(loyaltyTierSchema)),
});

export const createLoyaltyTierInputSchema = clientInputSchema(
  loyaltyTierSchema.omit({ id: true, tenantId: true }).shape,
);

export const createLoyaltyTier = defineEndpoint({
  method: "POST",
  path: "/api/loyalty/tiers",
  body: createLoyaltyTierInputSchema,
  response: dataResponseSchema(loyaltyTierSchema),
});

export const updateLoyaltyTierInputSchema =
  createLoyaltyTierInputSchema.partial();

export const updateLoyaltyTier = defineEndpoint({
  method: "PATCH",
  path: "/api/loyalty/tiers/:tierId",
  params: tierIdParams,
  body: updateLoyaltyTierInputSchema,
  response: dataResponseSchema(loyaltyTierSchema),
});

export const listRewardsQuerySchema = withFilters({
  active: z.enum(["true", "false"]).optional(),
});

export const listRewards = defineEndpoint({
  method: "GET",
  path: "/api/loyalty/rewards",
  query: listRewardsQuerySchema,
  response: page(rewardSchema),
});

export const createRewardInputSchema = clientInputSchema({
  ...rewardObjectSchema.omit({ id: true, tenantId: true }).shape,
  // legend-m4p5
  perCustomerLimit: rewardObjectSchema.shape.perCustomerLimit.optional(),
  redemptionValidDays: rewardObjectSchema.shape.redemptionValidDays.optional(),
});

// legend-m4p5
export const fulfilRedemptionInputSchema = clientInputSchema({
  redemptionCode: redemptionCodeSchema,
  outletId: uuidSchema,
  orderId: ulidIdSchema<"OrderId">().optional(),
});

// legend-m4p5
export const fulfilRedemption = defineEndpoint({
  method: "POST",
  path: "/api/loyalty/redemptions/fulfil",
  body: fulfilRedemptionInputSchema,
  response: dataResponseSchema(rewardRedemptionSchema),
});

export const createReward = defineEndpoint({
  method: "POST",
  path: "/api/loyalty/rewards",
  body: createRewardInputSchema,
  response: dataResponseSchema(rewardSchema),
});

export const updateRewardInputSchema = createRewardInputSchema.partial();

export const updateReward = defineEndpoint({
  method: "PATCH",
  path: "/api/loyalty/rewards/:rewardId",
  params: rewardIdParams,
  body: updateRewardInputSchema,
  response: dataResponseSchema(rewardSchema),
});

export const listMissionsQuerySchema = withFilters({
  active: z.enum(["true", "false"]).optional(),
});

export const listMissions = defineEndpoint({
  method: "GET",
  path: "/api/loyalty/missions",
  query: listMissionsQuerySchema,
  response: page(missionSchema),
});

export const createMissionInputSchema = clientInputSchema(
  missionObjectSchema.omit({ id: true, tenantId: true }).shape,
);

export const createMission = defineEndpoint({
  method: "POST",
  path: "/api/loyalty/missions",
  body: createMissionInputSchema,
  response: dataResponseSchema(missionSchema),
});

export const updateMissionInputSchema = createMissionInputSchema.partial();

export const updateMission = defineEndpoint({
  method: "PATCH",
  path: "/api/loyalty/missions/:missionId",
  params: missionIdParams,
  body: updateMissionInputSchema,
  response: dataResponseSchema(missionSchema),
});

// ---- Promo engine admin and checkout (beads legend-oadp, legend-8sh) -----

export const listPromotionsQuerySchema = withFilters({
  status: promotionStatusSchema.optional(),
});

export const listPromotions = defineEndpoint({
  method: "GET",
  path: "/api/promotions",
  query: listPromotionsQuerySchema,
  response: page(promotionSchema),
});

const promotionInputShape = promotionObjectSchema.omit({
  id: true,
  tenantId: true,
  spentIdr: true,
  createdAt: true,
  updatedAt: true,
}).shape;

/** `outletScope` defaults to `all_except` on create only (never on PATCH). */
export const createPromotionInputSchema = clientInputSchema({
  ...promotionInputShape,
  outletScope: promotionOutletScopeSchema.default("all_except"),
});

export const createPromotion = defineEndpoint({
  method: "POST",
  path: "/api/promotions",
  body: createPromotionInputSchema,
  response: dataResponseSchema(promotionSchema),
});

export const updatePromotionInputSchema =
  clientInputSchema(promotionInputShape).partial();

export const updatePromotion = defineEndpoint({
  method: "PATCH",
  path: "/api/promotions/:promotionId",
  params: promotionIdParams,
  body: updatePromotionInputSchema,
  response: dataResponseSchema(promotionSchema),
});

export const evaluatePromotions = defineEndpoint({
  method: "POST",
  path: "/api/promotions/evaluate",
  body: promoEvaluationRequestSchema,
  response: dataResponseSchema(promotionApplicationResultSchema),
});

export const getPromotionRoi = defineEndpoint({
  method: "GET",
  path: "/api/promotions/:promotionId/roi",
  params: promotionIdParams,
  response: dataResponseSchema(promotionRoiSchema),
});

/**
 * Per-outlet promotion switch (contract PromotionOutlet, bead legend-e5it).
 * A promotion runs at every outlet of the tenant unless an outlet switches it
 * off (`enabled: false`). The list answers every outlet of the tenant with its
 * effective state; PUT sets one outlet.
 */
export const listPromotionOutlets = defineEndpoint({
  method: "GET",
  path: "/api/promotions/:promotionId/outlets",
  params: promotionIdParams,
  response: dataResponseSchema(z.array(promotionOutletSchema)),
});

export const setPromotionOutletInputSchema = clientInputSchema({
  enabled: z.boolean(),
});

export const setPromotionOutlet = defineEndpoint({
  method: "PUT",
  path: "/api/promotions/:promotionId/outlets/:outletId",
  params: z.strictObject({
    promotionId: uuidSchema,
    outletId: outletIdSchema,
  }),
  body: setPromotionOutletInputSchema,
  response: dataResponseSchema(promotionOutletSchema),
});

/**
 * Tenant stacking policy ("aturan tumpang tindih", PRD §3.21). Until a tenant
 * saves one, the API answers `defaultPromoStackingPolicy` (exclusive). Bead
 * legend-7x4g: without it, stacked promotions (owner decision Q20) could never
 * be switched on.
 */
export const getPromoStackingPolicy = defineEndpoint({
  method: "GET",
  path: "/api/promotions/stacking-policy",
  response: dataResponseSchema(promoStackingPolicySchema),
});

export const updatePromoStackingPolicyInputSchema = clientInputSchema(
  promoStackingPolicySchema.shape,
);

export const updatePromoStackingPolicy = defineEndpoint({
  method: "PUT",
  path: "/api/promotions/stacking-policy",
  body: updatePromoStackingPolicyInputSchema,
  response: dataResponseSchema(promoStackingPolicySchema),
});

export const validateVoucher = defineEndpoint({
  method: "POST",
  path: "/api/vouchers/validate",
  body: voucherValidationInputSchema,
  response: dataResponseSchema(voucherValidationResultSchema),
});

export const issueVoucherInputSchema = clientInputSchema({
  promotionId: uuidSchema.nullable(),
  customerProfileId: uuidSchema.nullable(),
  source: voucherSourceSchema,
  valueIdr: nonnegativeIdr.nullable(),
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema.nullable(),
});

export const issueVoucher = defineEndpoint({
  method: "POST",
  path: "/api/vouchers",
  body: issueVoucherInputSchema,
  response: dataResponseSchema(voucherIssuedSchema),
});

export const listVouchersQuerySchema = withFilters({
  status: voucherStatusSchema.optional(),
  customerProfileId: uuidSchema.optional(),
});

export const listVouchers = defineEndpoint({
  method: "GET",
  path: "/api/vouchers",
  query: listVouchersQuerySchema,
  response: page(voucherDtoSchema),
});

// ---- Segments and campaigns (bead legend-hbad) ---------------------------

export const listSegments = defineEndpoint({
  method: "GET",
  path: "/api/segments",
  query: cursorPageQuerySchema,
  response: page(segmentSchema),
});

export const createSegmentInputSchema = clientInputSchema({
  name: z.string().min(1).max(150),
  definition: segmentDefinitionSchema,
});

export const createSegment = defineEndpoint({
  method: "POST",
  path: "/api/segments",
  body: createSegmentInputSchema,
  response: dataResponseSchema(segmentSchema),
});

export const previewSegmentInputSchema = clientInputSchema({
  definition: segmentDefinitionSchema,
});

export const previewSegment = defineEndpoint({
  method: "POST",
  path: "/api/segments/preview",
  body: previewSegmentInputSchema,
  response: dataResponseSchema(segmentPreviewSchema),
});

export const listCampaignsQuerySchema = withFilters({
  status: campaignStatusSchema.optional(),
});

export const listCampaigns = defineEndpoint({
  method: "GET",
  path: "/api/campaigns",
  query: listCampaignsQuerySchema,
  response: page(campaignSchema),
});

export const createCampaignInputSchema = clientInputSchema({
  name: z.string().min(1).max(150),
  segmentId: uuidSchema,
  channel: campaignChannelSchema,
  content: campaignContentSchema,
  abTest: campaignAbTestSchema.nullable(),
  scheduledAt: isoDateTimeSchema.nullable(),
});

export const createCampaign = defineEndpoint({
  method: "POST",
  path: "/api/campaigns",
  body: createCampaignInputSchema,
  response: dataResponseSchema(campaignSchema),
});

export const updateCampaignInputSchema = clientInputSchema({
  action: campaignActionSchema.optional(),
  scheduledAt: isoDateTimeSchema.nullable().optional(),
  content: campaignContentSchema.optional(),
  abTest: campaignAbTestSchema.nullable().optional(),
});

export const updateCampaign = defineEndpoint({
  method: "PATCH",
  path: "/api/campaigns/:campaignId",
  params: campaignIdParams,
  body: updateCampaignInputSchema,
  response: dataResponseSchema(campaignSchema),
});

export const getCampaignResults = defineEndpoint({
  method: "GET",
  path: "/api/campaigns/:campaignId/results",
  params: campaignIdParams,
  response: dataResponseSchema(campaignResultsSchema),
});

// ---- Feedback queue (bead legend-i026) -----------------------------------

export const listFeedbackQuerySchema = withFilters({
  status: feedbackStatusSchema.optional(),
  kind: feedbackKindSchema.optional(),
  outletId: outletIdSchema.optional(),
});

export const listFeedback = defineEndpoint({
  method: "GET",
  path: "/api/feedback",
  query: listFeedbackQuerySchema,
  response: page(feedbackSchema),
});

export const updateFeedbackInputSchema = clientInputSchema({
  action: feedbackActionSchema,
  // legend-ts50: catatan penanganan staf, opsional.
  handledNote: z.string().trim().min(1).max(2000).optional(),
});

export const updateFeedback = defineEndpoint({
  method: "PATCH",
  path: "/api/feedback/:feedbackId",
  params: feedbackIdParams,
  body: updateFeedbackInputSchema,
  response: dataResponseSchema(feedbackSchema),
});

/** Every CRM endpoint, for route registration and mock coverage checks. */
export const crmEndpoints = [
  getMemberProfile,
  getMemberOverview,
  listMemberPoints,
  listMemberRewards,
  redeemReward,
  // legend-m4p5
  listMemberRedemptions,
  cancelMemberRedemption,
  listMemberMissions,
  listMemberVouchers,
  listMemberVisits,
  listMemberFavorites,
  updateMemberConsent,
  submitFeedback,
  // legend-111j
  listMemberConsentPolicies,
  issueMemberQrToken,
  setOrderCustomer,
  listLoyaltyAnomalies,
  listCustomers,
  getCustomer360,
  listCustomerPoints,
  getLoyaltyProgram,
  updateLoyaltyProgram,
  listLoyaltyTiers,
  createLoyaltyTier,
  updateLoyaltyTier,
  listRewards,
  createReward,
  updateReward,
  // legend-m4p5
  fulfilRedemption,
  listMissions,
  createMission,
  updateMission,
  listPromotions,
  createPromotion,
  updatePromotion,
  evaluatePromotions,
  getPromotionRoi,
  validateVoucher,
  issueVoucher,
  listVouchers,
  listSegments,
  createSegment,
  previewSegment,
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaignResults,
  listFeedback,
  updateFeedback,
] as const;

/** Convenience aliases used by feature mocks and query keys. */
export const memberEndpoints = {
  getMemberProfile,
  getMemberOverview,
  listMemberPoints,
  listMemberRewards,
  redeemReward,
  // legend-m4p5
  listMemberRedemptions,
  cancelMemberRedemption,
  listMemberMissions,
  listMemberVouchers,
  listMemberVisits,
  listMemberFavorites,
  updateMemberConsent,
  submitFeedback,
  // legend-111j
  listMemberConsentPolicies,
  issueMemberQrToken,
} as const;

export const crmAdminEndpoints = {
  listCustomers,
  getCustomer360,
  listCustomerPoints,
  getLoyaltyProgram,
  updateLoyaltyProgram,
  listLoyaltyTiers,
  createLoyaltyTier,
  updateLoyaltyTier,
  listRewards,
  createReward,
  updateReward,
  // legend-m4p5
  fulfilRedemption,
  listMissions,
  createMission,
  updateMission,
  listPromotions,
  createPromotion,
  updatePromotion,
  evaluatePromotions,
  getPromotionRoi,
  validateVoucher,
  issueVoucher,
  listVouchers,
  listSegments,
  createSegment,
  previewSegment,
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaignResults,
  listFeedback,
  updateFeedback,
  // legend-111j
  listLoyaltyAnomalies,
} as const;
