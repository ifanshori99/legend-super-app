// CRM contracts: dynamic segments (RFM, tier, favorite menu, outlet, behavior),
// campaigns with consent gating and simple A/B tests, post-meal feedback and
// the Customer 360 view.
// PRD v1.7 §3 F18, §3.21 (Customer 360, Segmentasi, Kampanye, Otomasi, Ulasan
// & Keluhan), §6.G (segments, campaigns/campaign_sends, feedback) and LOY-04.

import {
  z,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  idrSchema,
  isoDateTimeSchema,
  ulidIdSchema,
  basisPointsSchema,
} from "../core/index.ts";
import {
  customerConsentSchema,
  customerProfileSchema,
  customerProfileDtoSchema,
  hasActiveConsent,
  loyaltyProgramSchema,
  loyaltyTierSchema,
  missionProgressSchema,
  missionSchema,
  redemptionCodeSchema,
} from "./loyalty.ts";
import type {
  CustomerConsent,
  CustomerProfile,
  LoyaltyTier,
  TierEvaluationStats,
} from "./loyalty.ts";
import { voucherDtoSchema } from "./promo.ts";

const safeInt = (value: number) => Number.isSafeInteger(value);
const name = z.string().min(1).max(150);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveIdr = idrSchema.refine((value) => value > 0);
const positiveInt = z.number().int().positive().refine(safeInt);
const nonnegativeInt = z.number().int().nonnegative().refine(safeInt);

// ---- Dynamic segments (PRD §3.21 "Segmentasi") ----------------------------

export const segmentRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("rfm_recency"),
    /** Visited within this many days. */
    maxDaysSinceLastVisit: positiveInt,
  }),
  z.strictObject({
    kind: z.literal("rfm_frequency"),
    minVisits: positiveInt,
  }),
  z.strictObject({
    kind: z.literal("rfm_monetary"),
    minSpendIdr: positiveIdr,
  }),
  z.strictObject({
    kind: z.literal("tier"),
    tierIds: z.array(uuidSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("favorite_item"),
    menuItemIds: z.array(uuidSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("outlet"),
    outletIds: z.array(outletIdSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("inactive_days"),
    /** Not visited for at least this many days (e.g. win-back 30). */
    days: positiveInt,
  }),
  z.strictObject({
    kind: z.literal("marketing_opt_in"),
    value: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("birthday_month"),
    month: z.number().int().min(1).max(12),
  }),
]);
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

export const segmentDefinitionSchema = z.strictObject({
  match: z.enum(["all", "any"]),
  rules: z.array(segmentRuleSchema).min(1),
});
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

export const segmentSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  name,
  definition: segmentDefinitionSchema,
  /** Last refresh of the materialized size; null before the first run. */
  refreshedAt: isoDateTimeSchema.nullable(),
  size: nonnegativeInt,
});
export type Segment = z.infer<typeof segmentSchema>;

/** Facts the server derives per customer before matching a definition. */
export const segmentMatchContextSchema = z.strictObject({
  profile: customerProfileSchema,
  daysSinceLastVisit: nonnegativeInt.nullable(),
  favoriteMenuItemIds: z.array(uuidSchema),
  visitedOutletIds: z.array(outletIdSchema),
  birthMonth: z.number().int().min(1).max(12).nullable(),
});
export type SegmentMatchContext = z.infer<typeof segmentMatchContextSchema>;

export function matchesSegment(
  context: SegmentMatchContext,
  definition: SegmentDefinition,
): boolean {
  const results = definition.rules.map((rule): boolean => {
    switch (rule.kind) {
      case "rfm_recency":
        return (
          context.daysSinceLastVisit !== null &&
          context.daysSinceLastVisit <= rule.maxDaysSinceLastVisit
        );
      case "rfm_frequency":
        return context.profile.visitsCount >= rule.minVisits;
      case "rfm_monetary":
        return context.profile.lifetimeSpendIdr >= rule.minSpendIdr;
      case "tier":
        return (
          context.profile.tierId !== null &&
          rule.tierIds.includes(context.profile.tierId)
        );
      case "favorite_item":
        return rule.menuItemIds.some((id) =>
          context.favoriteMenuItemIds.includes(id),
        );
      case "outlet":
        return rule.outletIds.some((id) =>
          context.visitedOutletIds.includes(id),
        );
      case "inactive_days":
        return (
          context.daysSinceLastVisit !== null &&
          context.daysSinceLastVisit >= rule.days
        );
      case "marketing_opt_in":
        return context.profile.marketingOptIn === rule.value;
      case "birthday_month":
        return context.birthMonth === rule.month;
    }
  });
  return definition.match === "all"
    ? results.every(Boolean)
    : results.some(Boolean);
}

// ---- Campaigns and automations (PRD §3.21; LOY-04) ------------------------

export const campaignChannelSchema = z.enum([
  "web_push",
  "email",
  "whatsapp_template",
]);
export type CampaignChannel = z.infer<typeof campaignChannelSchema>;

export const campaignStatusSchema = z.enum([
  "draft",
  "scheduled",
  "running",
  "completed",
  "cancelled",
]);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const campaignContentSchema = z.strictObject({
  title: name,
  body: z.string().min(1).max(2000),
  /** Provider template name for WhatsApp; null for free-form channels. */
  templateRef: z.string().min(1).max(100).nullable(),
});
export type CampaignContent = z.infer<typeof campaignContentSchema>;

/** Simple A/B test: B gets splitBp of the recipients (PRD §3.21). */
export const campaignAbTestSchema = z.strictObject({
  variantB: campaignContentSchema,
  splitBp: basisPointsSchema.refine(
    (value) => value > 0 && value < 10_000,
    "A/B split must leave both variants non-empty",
  ),
});
export type CampaignAbTest = z.infer<typeof campaignAbTestSchema>;

export const campaignObjectSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  name,
  segmentId: uuidSchema,
  channel: campaignChannelSchema,
  content: campaignContentSchema,
  abTest: campaignAbTestSchema.nullable(),
  scheduledAt: isoDateTimeSchema.nullable(),
  status: campaignStatusSchema,
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  cancelledAt: isoDateTimeSchema.nullable(),
});
export const campaignSchema = campaignObjectSchema.superRefine(
  (campaign, ctx) => {
    const requiresSchedule =
      campaign.status === "scheduled" || campaign.status === "running";
    if (requiresSchedule && campaign.scheduledAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "A scheduled campaign needs a send time",
      });
    const started =
      campaign.status === "running" || campaign.status === "completed";
    if (started !== (campaign.startedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["startedAt"],
        message: "Start time must match the status",
      });
    if ((campaign.status === "completed") !== (campaign.completedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completion time must match the status",
      });
    if ((campaign.status === "cancelled") !== (campaign.cancelledAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["cancelledAt"],
        message: "Cancellation time must match the status",
      });
  },
);
export type Campaign = z.infer<typeof campaignSchema>;

export const campaignActionSchema = z.enum([
  "schedule",
  "start",
  "complete",
  "cancel",
]);
export type CampaignAction = z.infer<typeof campaignActionSchema>;

const campaignTransitions: Record<
  CampaignStatus,
  Partial<Record<CampaignAction, CampaignStatus>>
> = {
  draft: { schedule: "scheduled", cancel: "cancelled" },
  scheduled: { start: "running", cancel: "cancelled" },
  running: { complete: "completed", cancel: "cancelled" },
  completed: {},
  cancelled: {},
};

export function transitionCampaign(
  status: CampaignStatus,
  action: CampaignAction,
): CampaignStatus {
  const next = campaignTransitions[status][action];
  if (!next)
    throw new RangeError(`Invalid campaign transition: ${status} -> ${action}`);
  return next;
}

export const campaignSendStatusSchema = z.enum([
  "queued",
  "sent",
  "delivered",
  "failed",
  "skipped_no_consent",
]);
export type CampaignSendStatus = z.infer<typeof campaignSendStatusSchema>;

export const campaignSendSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    campaignId: uuidSchema,
    customerProfileId: uuidSchema,
    channel: campaignChannelSchema,
    status: campaignSendStatusSchema,
    costIdr: nonnegativeIdr,
    sentAt: isoDateTimeSchema.nullable(),
    failureReason: z.string().max(300).nullable(),
    /** LOY-04 evidence: when the service checked the marketing consent. */
    consentCheckedAt: isoDateTimeSchema,
  })
  .superRefine((send, ctx) => {
    const sent = send.status === "sent" || send.status === "delivered";
    if (sent !== (send.sentAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["sentAt"],
        message: "Send time must match the status",
      });
    if ((send.status === "failed") !== (send.failureReason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "Only a failed send carries a reason",
      });
  });
export type CampaignSend = z.infer<typeof campaignSendSchema>;

export type CampaignSendDecision =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: "membership_inactive" | "no_marketing_consent";
    };

/**
 * LOY-04: promotional campaigns go only to customers with active marketing
 * consent. A skipped recipient is recorded as `skipped_no_consent`, never sent.
 */
export function campaignSendDecision(
  profile: CustomerProfile,
  consents: readonly CustomerConsent[],
  at: string,
): CampaignSendDecision {
  if (profile.membershipStatus !== "active")
    return { eligible: false, reason: "membership_inactive" };
  if (!profile.marketingOptIn || !hasActiveConsent(consents, "marketing", at))
    return { eligible: false, reason: "no_marketing_consent" };
  return { eligible: true };
}

export const campaignResultsSchema = z.strictObject({
  campaignId: uuidSchema,
  recipients: nonnegativeInt,
  sent: nonnegativeInt,
  delivered: nonnegativeInt,
  failed: nonnegativeInt,
  skippedNoConsent: nonnegativeInt,
  opened: nonnegativeInt,
  redeemed: nonnegativeInt,
  revenueIdr: nonnegativeIdr,
  costIdr: nonnegativeIdr,
});
export type CampaignResults = z.infer<typeof campaignResultsSchema>;

/** Automation triggers from PRD §3.21 "Otomasi". */
export const campaignAutomationSchema = z.enum([
  "welcome",
  "birthday",
  "win_back",
  "points_expiry_reminder",
]);
export type CampaignAutomation = z.infer<typeof campaignAutomationSchema>;

// ---- Feedback and complaints (PRD §3.21 "Ulasan & Keluhan") ---------------

export const feedbackKindSchema = z.enum(["rating", "complaint"]);
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;
export const feedbackStatusSchema = z.enum([
  "open",
  "in_review",
  "resolved",
  "closed",
]);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

export const feedbackSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    /** WS-03 table session the feedback came from, when it did. */
    tableSessionId: uuidSchema.nullable(),
    customerProfileId: uuidSchema.nullable(),
    orderId: ulidIdSchema<"OrderId">().nullable(),
    kind: feedbackKindSchema,
    rating: z.number().int().min(1).max(5).nullable(),
    comment: z.string().max(2000).nullable(),
    status: feedbackStatusSchema,
    /** Better Auth user id (text, not a uuid); aligned with the user table (legend-ts50). */
    handledBy: z.string().min(1).max(64).nullable(),
    /** Staff note on how the item was handled (legend-ts50). */
    handledNote: z.string().max(2000).nullable().default(null),
    createdAt: isoDateTimeSchema,
    resolvedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((feedback, ctx) => {
    if (feedback.kind === "rating" && feedback.rating === null)
      ctx.addIssue({
        code: "custom",
        path: ["rating"],
        message: "A rating needs a score",
      });
    if (feedback.kind === "complaint" && feedback.comment === null)
      ctx.addIssue({
        code: "custom",
        path: ["comment"],
        message: "A complaint needs a description",
      });
    const resolved =
      feedback.status === "resolved" || feedback.status === "closed";
    if (resolved !== (feedback.resolvedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "Resolution time must match the status",
      });
    const assigned = feedback.status !== "open";
    if (assigned !== (feedback.handledBy !== null))
      ctx.addIssue({
        code: "custom",
        path: ["handledBy"],
        message: "A feedback item is assigned once it leaves the queue",
      });
  });
export type Feedback = z.infer<typeof feedbackSchema>;

export const feedbackActionSchema = z.enum([
  "start_review",
  "resolve",
  "close",
  "dismiss",
]);
export type FeedbackAction = z.infer<typeof feedbackActionSchema>;

const feedbackTransitions: Record<
  FeedbackStatus,
  Partial<Record<FeedbackAction, FeedbackStatus>>
> = {
  open: { start_review: "in_review", dismiss: "closed" },
  in_review: { resolve: "resolved", dismiss: "closed" },
  resolved: { close: "closed" },
  closed: {},
};

export function transitionFeedback(
  status: FeedbackStatus,
  action: FeedbackAction,
): FeedbackStatus {
  const next = feedbackTransitions[status][action];
  if (!next)
    throw new RangeError(`Invalid feedback transition: ${status} -> ${action}`);
  return next;
}

// ---- Customer 360 (PRD §3.21 "Customer 360") ------------------------------

export const customerVisitSchema = z.strictObject({
  orderId: ulidIdSchema<"OrderId">(),
  outletId: outletIdSchema,
  visitedAt: isoDateTimeSchema,
  spendIdr: nonnegativeIdr,
  itemCount: nonnegativeInt,
});
export type CustomerVisit = z.infer<typeof customerVisitSchema>;

export const customerFavoriteItemSchema = z.strictObject({
  menuItemId: uuidSchema,
  name,
  quantity: positiveInt,
  lastOrderedAt: isoDateTimeSchema,
});
export type CustomerFavoriteItem = z.infer<typeof customerFavoriteItemSchema>;

/**
 * Progress toward the next tier, in basis points (10.000 = reached). Display
 * only; the authoritative tier comes from `evaluateTier` in loyalty.ts.
 */
export function tierProgressBp(
  stats: TierEvaluationStats,
  nextTier: LoyaltyTier | null,
): number {
  if (nextTier === null) return 10_000;
  // Integer math, rounded down (D-CORE-2): no float ratios.
  const spendBp =
    nextTier.thresholdSpendIdr > 0
      ? Math.floor(
          (stats.rollingSpendIdr * 10_000) / nextTier.thresholdSpendIdr,
        )
      : 0;
  const visitBp =
    nextTier.thresholdVisits > 0
      ? Math.floor((stats.rollingVisits * 10_000) / nextTier.thresholdVisits)
      : 0;
  return Math.min(10_000, Math.max(spendBp, visitBp));
}

export const customer360Schema = z.strictObject({
  profile: customerProfileDtoSchema,
  consents: z.array(customerConsentSchema),
  currentTier: loyaltyTierSchema.nullable(),
  nextTier: loyaltyTierSchema.nullable(),
  tierProgressBp: basisPointsSchema,
  rollingSpendIdr: nonnegativeIdr,
  rollingVisits: nonnegativeInt,
  recentVisits: z.array(customerVisitSchema),
  favoriteItems: z.array(customerFavoriteItemSchema),
  recentFeedback: z.array(feedbackSchema),
  activeVouchers: z.array(voucherDtoSchema),
  /**
   * WhatsApp number (legend-ts50). Masked (maskWhatsAppNumber: first 4 and last 3 digits) unless the caller
   * holds crm.customer.pii.read; every full reveal is audited. Optional so
   * older fixtures stay valid.
   */
  whatsapp: z
    .strictObject({ number: z.string().nullable(), masked: z.boolean() })
    .optional(),
});
export type Customer360 = z.infer<typeof customer360Schema>;

/**
 * Member PWA read model (PRD §3.20 "Halaman Member"): the signed-in customer's
 * own profile, tier progress, rolling tier-evaluation stats and versioned
 * consents. Staff-only fields (Customer 360 feedback, segments) stay out; the
 * server derives every value for the customer in session, never from a body.
 */
export const memberOverviewSchema = z.strictObject({
  profile: customerProfileDtoSchema,
  /** Earn ratio, expiry and point value, for the points screen's explainer. */
  program: loyaltyProgramSchema,
  currentTier: loyaltyTierSchema.nullable(),
  nextTier: loyaltyTierSchema.nullable(),
  /** Display progress toward `nextTier` (10.000 = reached), from tierProgressBp. */
  tierProgressBp: basisPointsSchema,
  rollingSpendIdr: nonnegativeIdr,
  rollingVisits: nonnegativeInt,
  consents: z.array(customerConsentSchema),
});
export type MemberOverview = z.infer<typeof memberOverviewSchema>;

/** One mission with the member's progress, for the member PWA. */
export const missionWithProgressSchema = z.strictObject({
  mission: missionSchema,
  progress: missionProgressSchema.nullable(),
  // legend-m4p5
  voucherCode: redemptionCodeSchema.nullable(),
});
export type MissionWithProgress = z.infer<typeof missionWithProgressSchema>;

/** Dynamic-segment preview: matched count plus a bounded sample. */
export const segmentPreviewSchema = z.strictObject({
  size: nonnegativeInt,
  sample: z.array(customerProfileDtoSchema).max(20),
});
export type SegmentPreview = z.infer<typeof segmentPreviewSchema>;
