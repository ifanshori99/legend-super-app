// Loyalty & membership contracts: customer profile, versioned consents,
// append-only point ledger, loyalty program and tiers, reward catalog and
// atomic redemptions, missions with stamp cards, and referral.
// PRD v1.7 §3 F17, §3.20 (Loyalty & Membership), §6.G (customer_profiles,
// point_ledger, loyalty_programs/loyalty_tiers, rewards/reward_redemptions,
// missions/mission_progress) and LOY-01..04.
// Data contracts only: authorization, concurrency and storage invariants are
// enforced by the API service and the database (see the comments on each
// schema for what the service must guarantee).

import {
  z,
  uuidSchema,
  tenantIdSchema,
  idrSchema,
  isoDateTimeSchema,
  businessDateSchema,
  ulidIdSchema,
} from "../core/index.ts";
import { customerWhatsappHashSchema } from "./customer-hash.ts";

const name = z.string().min(1).max(150);
const description = z.string().max(1000);
const safeInt = (value: number) => Number.isSafeInteger(value);
const pointsAmountSchema = z
  .number()
  .int()
  .refine(safeInt, "Points exceed the safe integer range");
const nonnegativePointsSchema = pointsAmountSchema.refine(
  (value) => value >= 0,
);
const positivePointsSchema = pointsAmountSchema.refine((value) => value > 0);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveIdr = idrSchema.refine((value) => value > 0);

function before(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

// ---- Customer profile (PRD §6.G.18) ---------------------------------------

/**
 * Membership is active only after the WhatsApp number is verified and the
 * loyalty consent is granted (PRD §3.20 "Pendaftaran Member"). The service
 * keeps this status in sync; `isMemberActive` is the single read-side check.
 */
export const membershipStatusSchema = z.enum([
  "pending_verification",
  "active",
  "suspended",
  "closed",
]);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

/** Birth date without a year (CHAR(5)), used for the birthday reward. */
export const birthMonthDaySchema = z
  .string()
  .regex(
    /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/,
    "Expected MM-DD without a year",
  );

/** Referral code: uppercase letters and digits, unique per tenant. */
export const referralCodeSchema = z
  .string()
  .regex(
    /^[A-Z0-9]{4,20}$/,
    "Referral codes use 4-20 uppercase letters/digits",
  );

const customerProfileObjectSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  /** Customer account (WS-01 identity). Null until a member PWA account links. */
  userId: uuidSchema.nullable(),
  /**
   * Keyed digest (HMAC-SHA-256 hex) of the normalized WhatsApp number; the
   * verified identity key (F3). Equals the reservation `contactHash` for the
   * same number (see customer-hash.ts).
   */
  whatsappHash: customerWhatsappHashSchema.nullable(),
  name,
  birthMonthDay: birthMonthDaySchema.nullable(),
  tierId: uuidSchema.nullable(),
  /** Derived from the point ledger (LOY-01); never written directly. */
  pointsBalance: nonnegativePointsSchema,
  lifetimeSpendIdr: nonnegativeIdr,
  visitsCount: z.number().int().nonnegative().refine(safeInt),
  firstVisitAt: isoDateTimeSchema.nullable(),
  lastVisitAt: isoDateTimeSchema.nullable(),
  /** Denormalized cache of the latest marketing consent; consents are the
   * versioned source of truth and the service keeps this flag in sync. */
  marketingOptIn: z.boolean(),
  referralCode: referralCodeSchema.nullable(),
  membershipStatus: membershipStatusSchema,
  whatsappVerifiedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export const customerProfileSchema = customerProfileObjectSchema.superRefine(
  (profile, ctx) => {
    if (
      profile.firstVisitAt !== null &&
      profile.lastVisitAt !== null &&
      before(profile.lastVisitAt, profile.firstVisitAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["lastVisitAt"],
        message: "Last visit cannot precede the first visit",
      });
    // PRD §3.20: active membership requires a verified WhatsApp number.
    if (
      profile.membershipStatus === "active" &&
      profile.whatsappVerifiedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["whatsappVerifiedAt"],
        message: "Active membership requires a verified WhatsApp number",
      });
  },
);
export type CustomerProfile = z.infer<typeof customerProfileSchema>;

/** Client-facing profile: the WhatsApp hash never leaves the server. */
export const customerProfileDtoSchema = customerProfileObjectSchema.omit({
  whatsappHash: true,
});
export type CustomerProfileDto = z.infer<typeof customerProfileDtoSchema>;

// ---- Versioned consents (PRD §2 privacy; LOY-04) --------------------------

/**
 * Separate, versioned consent per purpose (PRD §2 "Persetujuan terpisah dan
 * berversi untuk keanggotaan loyalty, pesan pemasaran, dan pemakaian data
 * oleh AI"). Withdrawing appends `withdrawnAt`; rows are never deleted.
 */
export const consentPurposeSchema = z.enum(["loyalty", "marketing", "ai"]);
export type ConsentPurpose = z.infer<typeof consentPurposeSchema>;
export const consentSourceSchema = z.enum([
  "member_pwa",
  "website",
  "cashier",
  "import",
]);
export const customerConsentSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    customerProfileId: uuidSchema,
    purpose: consentPurposeSchema,
    policyVersion: z.string().min(1).max(20),
    grantedAt: isoDateTimeSchema,
    withdrawnAt: isoDateTimeSchema.nullable(),
    source: consentSourceSchema,
  })
  .superRefine((consent, ctx) => {
    if (
      consent.withdrawnAt !== null &&
      before(consent.withdrawnAt, consent.grantedAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["withdrawnAt"],
        message: "Withdrawal cannot precede the grant",
      });
  });
export type CustomerConsent = z.infer<typeof customerConsentSchema>;

/** True when a consent is granted and not withdrawn at the given instant. */
export function hasActiveConsent(
  consents: readonly CustomerConsent[],
  purpose: ConsentPurpose,
  at: string,
): boolean {
  const instant = Date.parse(at);
  return consents.some(
    (consent) =>
      consent.purpose === purpose &&
      Date.parse(consent.grantedAt) <= instant &&
      (consent.withdrawnAt === null ||
        Date.parse(consent.withdrawnAt) > instant),
  );
}

export const membershipBlockerSchema = z.enum([
  "whatsapp_unverified",
  "loyalty_consent_missing",
  "not_active",
]);
export type MembershipBlocker = z.infer<typeof membershipBlockerSchema>;

/** PRD §3.20: membership needs a verified WhatsApp number + loyalty consent. */
export function membershipBlockers(
  profile: CustomerProfile,
  consents: readonly CustomerConsent[],
  at: string,
): MembershipBlocker[] {
  const blockers: MembershipBlocker[] = [];
  if (profile.whatsappVerifiedAt === null) blockers.push("whatsapp_unverified");
  if (!hasActiveConsent(consents, "loyalty", at))
    blockers.push("loyalty_consent_missing");
  if (profile.membershipStatus !== "active") blockers.push("not_active");
  return blockers;
}

export function isMemberActive(
  profile: CustomerProfile,
  consents: readonly CustomerConsent[],
  at: string,
): boolean {
  return membershipBlockers(profile, consents, at).length === 0;
}

/**
 * LOY-04: a customer without marketing consent never receives a promotional
 * campaign. Campaign sends call this before enqueueing (see crm.ts).
 */
export function isMarketingEligible(
  profile: CustomerProfile,
  consents: readonly CustomerConsent[],
  at: string,
): boolean {
  return (
    profile.membershipStatus === "active" &&
    profile.marketingOptIn &&
    hasActiveConsent(consents, "marketing", at)
  );
}

// ---- Append-only point ledger (PRD §6.G.19; LOY-01/02) --------------------

export const pointEntryTypeSchema = z.enum([
  "earn",
  "redeem",
  "expire",
  "reverse",
  "bonus",
  "adjust",
]);
export type PointEntryType = z.infer<typeof pointEntryTypeSchema>;
export const pointSourceTypeSchema = z.enum([
  "order",
  "mission",
  "referral",
  "birthday",
  "reward_redemption",
  "expiry",
  "refund",
  // legend-111j: a voided final order reverses its points like a refund.
  "void",
  "adjustment",
  // legend-n1mp: a QR table guest claims the points of what they paid.
  "table_claim",
  // 936: points paid as a POS tender (source id = the tender id).
  "pos_tender",
]);
export type PointSourceType = z.infer<typeof pointSourceTypeSchema>;

// legend-111j: names the ledger services use for the same enums.
export type PointLedgerType = PointEntryType;
export type PointLedgerSourceType = PointSourceType;

const pointLedgerEntryObjectSchema = z.strictObject({
  /** ULID primary key (PRD §6.G.19); time order gives the ledger its order. */
  id: ulidIdSchema<"PointLedgerEntryId">(),
  tenantId: tenantIdSchema,
  customerProfileId: uuidSchema,
  type: pointEntryTypeSchema,
  /** Signed: earn/bonus positive, redeem/expire/reverse negative (LOY-01). */
  points: pointsAmountSchema,
  sourceType: pointSourceTypeSchema,
  /** Order ids are ULIDs, other sources are UUIDs; both travel as text. */
  sourceId: z
    .union([uuidSchema, ulidIdSchema<"PointLedgerSourceId">()])
    .nullable(),
  /** Expiry of the points this row grants; null for rows that consume them. */
  expiresAt: isoDateTimeSchema.nullable(),
  /** Signed liability change for accounting (PRD §3.20 "Liabilitas Poin"). */
  liabilityIdr: idrSchema,
  reason: z.string().max(300).nullable(),
  createdAt: isoDateTimeSchema,
});
export const pointLedgerEntrySchema = pointLedgerEntryObjectSchema.superRefine(
  (entry, ctx) => {
    const reject = (message: string, path: string[] = []) =>
      ctx.addIssue({ code: "custom", path, message });
    // Earn, redeem and reverse rows name their source: the database keeps one
    // row per (tenant, type, sourceType, sourceId) (see pointLedgerDedupeKey),
    // so a replayed payment or refund webhook never books points twice.
    if (
      (entry.type === "earn" ||
        entry.type === "redeem" ||
        entry.type === "reverse") &&
      entry.sourceId === null
    )
      reject("Earn, redeem and reverse rows name their source", ["sourceId"]);
    switch (entry.type) {
      case "earn":
        if (entry.points <= 0) reject("Earn rows are positive");
        if (entry.sourceType !== "order" && entry.sourceType !== "table_claim")
          reject("Earn rows come from a paid order or a table claim", [
            "sourceType",
          ]);
        if (entry.expiresAt === null)
          reject("Earned points need an expiry", ["expiresAt"]);
        break;
      case "bonus":
        if (entry.points <= 0) reject("Bonus rows are positive");
        if (
          !["mission", "referral", "birthday", "adjustment"].includes(
            entry.sourceType,
          )
        )
          reject("Bonus rows come from a mission, referral or birthday", [
            "sourceType",
          ]);
        if (entry.expiresAt === null)
          reject("Bonus points need an expiry", ["expiresAt"]);
        break;
      case "redeem":
        if (entry.points >= 0) reject("Redemption rows are negative");
        if (entry.sourceType !== "reward_redemption")
          reject("Redemption rows consume a reward", ["sourceType"]);
        if (entry.expiresAt !== null)
          reject("Redemption rows grant no points", ["expiresAt"]);
        break;
      case "expire":
        if (entry.points >= 0) reject("Expiry rows are negative");
        if (entry.sourceType !== "expiry")
          reject("Expiry rows come from the expiry job", ["sourceType"]);
        break;
      case "reverse":
        // LOY-02: a refund reverses the points of the paid transaction; a
        // voided final order does the same (legend-111j).
        if (entry.points >= 0) reject("Reversal rows are negative");
        if (entry.sourceType !== "refund" && entry.sourceType !== "void")
          reject("Reversal rows come from a refund or a void", ["sourceType"]);
        break;
      case "adjust":
        if (entry.points === 0) reject("Adjustments must change the balance");
        if (entry.sourceType !== "adjustment")
          reject("Adjustments come from a manual adjustment", ["sourceType"]);
        if (entry.reason === null)
          reject("Adjustments need a reason", ["reason"]);
        break;
    }
    if (entry.points !== 0) {
      if (entry.points > 0 && entry.liabilityIdr <= 0)
        reject("Positive points increase the liability", ["liabilityIdr"]);
      if (entry.points < 0 && entry.liabilityIdr >= 0)
        reject("Negative points reduce the liability", ["liabilityIdr"]);
    }
  },
);
export type PointLedgerEntry = z.infer<typeof pointLedgerEntrySchema>;

/**
 * Idempotency key for source-driven ledger rows (earn, redeem, reverse): the
 * service stores it under a unique index per tenant, so the same paid order,
 * redemption or refund books its points exactly once. Null for rows without a
 * single source (bonus without a source id, expiry, manual adjustment).
 */
export function pointLedgerDedupeKey(
  entry: Pick<
    PointLedgerEntry,
    "tenantId" | "type" | "sourceType" | "sourceId"
  >,
): string | null {
  if (entry.sourceId === null) return null;
  return `${entry.tenantId}:${entry.type}:${entry.sourceType}:${entry.sourceId}`;
}

/**
 * LOY-01: the balance always equals the sum of the ledger. Rows are
 * append-only: the database forbids UPDATE and DELETE (trigger + grants).
 */
export function pointBalanceFromLedger(
  entries: readonly Pick<PointLedgerEntry, "points">[],
): number {
  let total = 0;
  for (const entry of entries) total += entry.points;
  return total;
}

/** LOY-01 check used by tests and the service's consistency report. */
export function ledgerMatchesBalance(
  profile: Pick<CustomerProfile, "pointsBalance">,
  entries: readonly Pick<PointLedgerEntry, "points">[],
): boolean {
  return profile.pointsBalance === pointBalanceFromLedger(entries);
}

/**
 * LOY-02: points are booked only for a paid transaction and reversed on
 * refund. This explicit state machine keeps the two rules testable.
 */
export const pointEarnStateSchema = z.enum([
  "pending_payment",
  "booked",
  "reversed",
]);
export type PointEarnState = z.infer<typeof pointEarnStateSchema>;
export const pointEarnEventSchema = z.enum(["payment_paid", "order_refunded"]);
export type PointEarnEvent = z.infer<typeof pointEarnEventSchema>;

const pointEarnTransitions: Record<
  PointEarnState,
  Partial<Record<PointEarnEvent, PointEarnState>>
> = {
  pending_payment: { payment_paid: "booked" },
  booked: { order_refunded: "reversed" },
  reversed: {},
};

export function transitionPointEarn(
  state: PointEarnState,
  event: PointEarnEvent,
): PointEarnState {
  const next = pointEarnTransitions[state][event];
  if (!next)
    throw new RangeError(`Invalid point earn transition: ${state} -> ${event}`);
  return next;
}

// ---- Loyalty program and tiers (PRD §3.20, §6.G) --------------------------

/** Admin-configurable ratio, e.g. Rp10.000 spent = 1 point. */
export const earnRateSchema = z.strictObject({
  spendIdr: positiveIdr,
  points: positivePointsSchema,
});
export type EarnRate = z.infer<typeof earnRateSchema>;

/**
 * Program-level referral rules (legend-a8up). A referral qualifies on the
 * referee's first paid order of at least `minFirstOrderIdr`; the service
 * rejects further referrals once a referrer reaches the monthly cap.
 * Defaults (referral off, 100/50 points, no minimum, 10 per month) apply when
 * the field is omitted.
 */
export const referralRulesSchema = z.strictObject({
  enabled: z.boolean(),
  referrerPoints: nonnegativePointsSchema,
  refereePoints: nonnegativePointsSchema,
  /** The event that qualifies a referral; only the first paid order today. */
  qualifyingEvent: z.literal("first_paid_order"),
  minFirstOrderIdr: nonnegativeIdr,
  maxReferralsPerCustomerPerMonth: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .refine(safeInt),
});
export type ReferralRules = z.infer<typeof referralRulesSchema>;
export const defaultReferralRules: ReferralRules = referralRulesSchema.parse({
  enabled: false,
  referrerPoints: 100,
  refereePoints: 50,
  qualifyingEvent: "first_paid_order",
  minFirstOrderIdr: 0,
  maxReferralsPerCustomerPerMonth: 10,
});

/**
 * Program-level anti-fraud limits (legend-a8up). The service enforces the
 * daily cap when it books earn rows and blocks staff from earning points on
 * their own profile when `employeeSelfServeBan` is on.
 * A null cap means no daily limit. Defaults: 500 points per customer per
 * day, ban on.
 */
export const loyaltyAntiFraudSchema = z.strictObject({
  /** Null = no daily cap. */
  dailyPointCapPerCustomer: positivePointsSchema.nullable(),
  employeeSelfServeBan: z.boolean(),
});
export type LoyaltyAntiFraud = z.infer<typeof loyaltyAntiFraudSchema>;
export const defaultLoyaltyAntiFraud: LoyaltyAntiFraud = {
  dailyPointCapPerCustomer: 500,
  employeeSelfServeBan: true,
};

export const loyaltyProgramSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  legalEntityId: uuidSchema.nullable().default(null),
  name,
  earnRate: earnRateSchema,
  /** Points expire N months after they are earned (PRD default 12). */
  expiryMonths: z.number().int().min(1).max(60).refine(safeInt),
  /** Rolling window for tier evaluation (PRD: 12 months). */
  rollingMonths: z.number().int().min(1).max(60).refine(safeInt),
  /** Liability value of one point, used by accounting and the ledger. */
  pointValueIdr: positiveIdr,
  referral: referralRulesSchema.default(defaultReferralRules),
  antiFraud: loyaltyAntiFraudSchema.default(defaultLoyaltyAntiFraud),
  isActive: z.boolean().default(false),
  updatedAt: isoDateTimeSchema,
});
export type LoyaltyProgram = z.infer<typeof loyaltyProgramSchema>;

/**
 * Points earned from an eligible spend: value after discount, before tax and
 * service charge (PRD §3.20 "Poin"), multiplied by the tier multiplier.
 * Integer points, rounded down so the program never over-issues.
 */
export function pointsForSpend(
  program: LoyaltyProgram,
  eligibleSpendIdr: number,
  tierMultiplierBp: number = 10_000,
): number {
  if (!Number.isSafeInteger(eligibleSpendIdr) || eligibleSpendIdr < 0)
    throw new RangeError(`Invalid eligible spend: ${eligibleSpendIdr}`);
  if (!Number.isSafeInteger(tierMultiplierBp) || tierMultiplierBp < 0)
    throw new RangeError(`Invalid tier multiplier: ${tierMultiplierBp}`);
  const base =
    Math.floor(eligibleSpendIdr / program.earnRate.spendIdr) *
    program.earnRate.points;
  return Math.floor((base * tierMultiplierBp) / 10_000);
}

/** Signed liability change for a ledger row (positive grants, negative uses). */
export function liabilityIdrForPoints(
  program: LoyaltyProgram,
  points: number,
): number {
  if (!Number.isSafeInteger(points))
    throw new RangeError(`Invalid points: ${points}`);
  return points * program.pointValueIdr;
}

/**
 * Points multiplier in basis points, where 10.000 = 1x. Unlike a share or tax
 * rate this is not capped at 100%: Gold 15.000 = 1.5x, Platinum 20.000 = 2x.
 */
export const pointsMultiplierBpSchema = z
  .number()
  .int()
  .min(10_000)
  .max(100_000)
  .refine(safeInt);

/** Tier benefits from PRD §3.20: multiplier, birthday, priority, shower quota. */
export const tierBenefitsSchema = z.strictObject({
  /** 10.000 bp = 1x; Gold 15.000 bp = 1.5x. */
  pointsMultiplierBp: pointsMultiplierBpSchema,
  birthdayRewardPoints: nonnegativePointsSchema,
  reservationPriority: z.boolean(),
  exclusivePromotions: z.boolean(),
  /** Free facility (shower) access per month (PRD F23 tier benefit). */
  facilityFreeAccessQuota: z.number().int().nonnegative().refine(safeInt),
});
export type TierBenefits = z.infer<typeof tierBenefitsSchema>;

export const loyaltyTierSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  name,
  /** Higher rank wins when several tiers qualify. */
  rank: z.number().int().positive().refine(safeInt),
  thresholdSpendIdr: nonnegativeIdr,
  thresholdVisits: z.number().int().nonnegative().refine(safeInt),
  benefits: tierBenefitsSchema,
  isActive: z.boolean(),
});
export type LoyaltyTier = z.infer<typeof loyaltyTierSchema>;

export const tierEvaluationStatsSchema = z.strictObject({
  /** Rolling-window spend and visits, derived by the server. */
  rollingSpendIdr: nonnegativeIdr,
  rollingVisits: z.number().int().nonnegative().refine(safeInt),
});
export type TierEvaluationStats = z.infer<typeof tierEvaluationStatsSchema>;

/**
 * PRD §3.20 "Tier": a tier qualifies on spend OR visits in the rolling
 * window; the highest qualifying rank wins. Null means no tier yet.
 */
export function evaluateTier(
  tiers: readonly LoyaltyTier[],
  stats: TierEvaluationStats,
): LoyaltyTier | null {
  let best: LoyaltyTier | null = null;
  for (const tier of tiers) {
    if (!tier.isActive) continue;
    const qualifies =
      stats.rollingSpendIdr >= tier.thresholdSpendIdr ||
      stats.rollingVisits >= tier.thresholdVisits;
    if (qualifies && (best === null || tier.rank > best.rank)) best = tier;
  }
  return best;
}

// ---- Reward catalog and redemptions (PRD §3.20; LOY-03) -------------------

export const rewardTypeSchema = z.enum([
  "free_item",
  "item_upgrade",
  "voucher",
]);
export type RewardType = z.infer<typeof rewardTypeSchema>;

export const rewardObjectSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  name,
  description,
  type: rewardTypeSchema,
  pointsCost: positivePointsSchema,
  /** null = unlimited stock. */
  stock: z.number().int().nonnegative().refine(safeInt).nullable(),
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema.nullable(),
  menuItemId: uuidSchema.nullable(),
  voucherValueIdr: positiveIdr.nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int().refine(safeInt),
  // legend-m4p5
  /** null = no per-customer limit. */
  perCustomerLimit: z.number().int().positive().refine(safeInt).nullable(),
  redemptionValidDays: z.number().int().min(1).max(365),
});
export const rewardSchema = rewardObjectSchema.superRefine((reward, ctx) => {
  if (reward.validUntil !== null && before(reward.validUntil, reward.validFrom))
    ctx.addIssue({
      code: "custom",
      path: ["validUntil"],
      message: "Validity cannot end before it starts",
    });
  if (reward.type === "voucher") {
    if (reward.menuItemId !== null)
      ctx.addIssue({
        code: "custom",
        path: ["menuItemId"],
        message: "A voucher reward does not name a menu item",
      });
    if (reward.voucherValueIdr === null)
      ctx.addIssue({
        code: "custom",
        path: ["voucherValueIdr"],
        message: "A voucher reward needs a value",
      });
  } else {
    if (reward.menuItemId === null)
      ctx.addIssue({
        code: "custom",
        path: ["menuItemId"],
        message: "Item rewards name the menu item",
      });
    if (reward.voucherValueIdr !== null)
      ctx.addIssue({
        code: "custom",
        path: ["voucherValueIdr"],
        message: "Item rewards carry no voucher value",
      });
  }
});
export type Reward = z.infer<typeof rewardSchema>;

/**
 * LOY-03: redemption is atomic and a reward cannot be redeemed twice under
 * concurrency. The service locks the reward row (SELECT ... FOR UPDATE),
 * checks stock and balance in the same transaction, and inserts one
 * redemption per idempotency key; the database enforces the unique keys.
 */
export const rewardRedemptionStatusSchema = z.enum([
  "pending",
  "fulfilled",
  "cancelled",
  "expired",
]);
export type RewardRedemptionStatus = z.infer<
  typeof rewardRedemptionStatusSchema
>;
export const redemptionCodeSchema = z
  .string()
  .regex(
    /^[A-Z0-9]{6,32}$/,
    "Redemption codes use 6-32 uppercase letters/digits",
  );

export const rewardRedemptionSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    rewardId: uuidSchema,
    customerProfileId: uuidSchema,
    orderId: ulidIdSchema<"OrderId">().nullable(),
    pointsSpent: positivePointsSchema,
    status: rewardRedemptionStatusSchema,
    redemptionCode: redemptionCodeSchema,
    // legend-m4p5
    rewardType: rewardTypeSchema,
    expiresAt: isoDateTimeSchema,
    voucherId: uuidSchema.nullable(),
    fulfilledOutletId: uuidSchema.nullable(),
    idempotencyKey: z.string().min(8).max(100),
    redeemedAt: isoDateTimeSchema,
    fulfilledAt: isoDateTimeSchema.nullable(),
    cancelledAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((redemption, ctx) => {
    if (
      (redemption.status === "fulfilled") !==
      (redemption.fulfilledAt !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["fulfilledAt"],
        message: "Fulfilment time must match the status",
      });
    if (
      (redemption.status === "cancelled") !==
      (redemption.cancelledAt !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["cancelledAt"],
        message: "Cancellation time must match the status",
      });
  });
export type RewardRedemption = z.infer<typeof rewardRedemptionSchema>;

const rewardRedemptionTransitions: Record<
  RewardRedemptionStatus,
  readonly RewardRedemptionStatus[]
> = {
  pending: ["fulfilled", "cancelled", "expired"],
  fulfilled: [],
  cancelled: [],
  expired: [],
};

export function canTransitionRedemption(
  from: RewardRedemptionStatus,
  to: RewardRedemptionStatus,
): boolean {
  return rewardRedemptionTransitions[from].includes(to);
}

export const rewardRejectionReasonSchema = z.enum([
  "reward_inactive",
  "not_started",
  "expired",
  "out_of_stock",
  "insufficient_points",
  "limit_reached",
]);
export type RewardRejectionReason = z.infer<typeof rewardRejectionReasonSchema>;

export const rewardRedemptionCheckInputSchema = z.strictObject({
  isActive: z.boolean(),
  stock: z.number().int().nonnegative().nullable(),
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema.nullable(),
  pointsCost: positivePointsSchema,
  pointsBalance: nonnegativePointsSchema,
  /** Redemptions already pending/fulfilled for this customer and reward. */
  existingRedemptions: z.number().int().nonnegative().refine(safeInt),
  perCustomerLimit: z.number().int().positive().refine(safeInt).nullable(),
  at: isoDateTimeSchema,
});
export type RewardRedemptionCheckInput = z.infer<
  typeof rewardRedemptionCheckInputSchema
>;

export type RewardRedemptionDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RewardRejectionReason };

/** Pre-flight check inside the locked transaction (LOY-03). */
export function rewardRedemptionCheck(
  input: RewardRedemptionCheckInput,
): RewardRedemptionDecision {
  if (!input.isActive) return { ok: false, reason: "reward_inactive" };
  if (before(input.at, input.validFrom))
    return { ok: false, reason: "not_started" };
  if (input.validUntil !== null && !before(input.at, input.validUntil))
    return { ok: false, reason: "expired" };
  if (input.stock !== null && input.stock <= 0)
    return { ok: false, reason: "out_of_stock" };
  if (input.pointsBalance < input.pointsCost)
    return { ok: false, reason: "insufficient_points" };
  if (
    input.perCustomerLimit !== null &&
    input.existingRedemptions >= input.perCustomerLimit
  )
    return { ok: false, reason: "limit_reached" };
  return { ok: true };
}

// ---- Missions and stamp cards (PRD §3.20 "Mission") -----------------------

export const missionTypeSchema = z.enum([
  "visit_count",
  "try_new_item",
  "weekday_visit",
  "stamp_card",
]);
export type MissionType = z.infer<typeof missionTypeSchema>;

export const missionRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("visit_count"),
    targetVisits: z.number().int().positive().refine(safeInt),
  }),
  z.strictObject({
    kind: z.literal("try_new_item"),
    targetItems: z.number().int().positive().refine(safeInt),
    /** Empty = any item the customer has not ordered before. */
    menuItemIds: z.array(uuidSchema),
  }),
  z.strictObject({
    kind: z.literal("weekday_visit"),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    targetVisits: z.number().int().positive().refine(safeInt),
  }),
  z.strictObject({
    kind: z.literal("stamp_card"),
    stampsRequired: z.number().int().positive().refine(safeInt),
  }),
]);
export type MissionRule = z.infer<typeof missionRuleSchema>;

export const missionRewardSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("points"), points: positivePointsSchema }),
  z.strictObject({
    kind: z.literal("voucher"),
    valueIdr: positiveIdr,
    validDays: z.number().int().positive().max(365).refine(safeInt),
  }),
]);
export type MissionReward = z.infer<typeof missionRewardSchema>;

export const missionPeriodSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("monthly") }),
  z.strictObject({ kind: z.literal("weekly") }),
  z.strictObject({
    kind: z.literal("date_range"),
    start: businessDateSchema,
    end: businessDateSchema,
  }),
]);
export type MissionPeriod = z.infer<typeof missionPeriodSchema>;

export const missionObjectSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  name,
  description,
  type: missionTypeSchema,
  rule: missionRuleSchema,
  reward: missionRewardSchema,
  period: missionPeriodSchema,
  isActive: z.boolean(),
  startsAt: isoDateTimeSchema.nullable(),
  endsAt: isoDateTimeSchema.nullable(),
});
export const missionSchema = missionObjectSchema.superRefine((mission, ctx) => {
  if (mission.rule.kind !== mission.type)
    ctx.addIssue({
      code: "custom",
      path: ["rule", "kind"],
      message: "The rule kind must match the mission type",
    });
  if (
    mission.startsAt !== null &&
    mission.endsAt !== null &&
    !before(mission.startsAt, mission.endsAt)
  )
    ctx.addIssue({
      code: "custom",
      path: ["endsAt"],
      message: "Mission validity must end after it starts",
    });
});
export type Mission = z.infer<typeof missionSchema>;

export const missionProgressSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    missionId: uuidSchema,
    customerProfileId: uuidSchema,
    progress: z.number().int().nonnegative().refine(safeInt),
    target: z.number().int().positive().refine(safeInt),
    completedAt: isoDateTimeSchema.nullable(),
    rewardIssuedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((progress, ctx) => {
    if (
      progress.progress >= progress.target !==
      (progress.completedAt !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Completion time must match the target",
      });
    if (progress.rewardIssuedAt !== null && progress.completedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["rewardIssuedAt"],
        message: "A reward cannot be issued before completion",
      });
  });
export type MissionProgress = z.infer<typeof missionProgressSchema>;

// ---- Referral (PRD §3.20 "Ulang Tahun & Referral") ------------------------

export const referralStatusSchema = z.enum([
  "pending",
  "qualified",
  "rewarded",
  "expired",
]);
export type ReferralStatus = z.infer<typeof referralStatusSchema>;

export const referralSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    referrerProfileId: uuidSchema,
    /** Null while the invited person has not signed up yet. */
    refereeProfileId: uuidSchema.nullable(),
    code: referralCodeSchema,
    status: referralStatusSchema,
    /** Set when the referee's first paid transaction qualifies the referral. */
    firstOrderId: ulidIdSchema<"OrderId">().nullable(),
    referrerPoints: positivePointsSchema,
    refereePoints: positivePointsSchema,
    createdAt: isoDateTimeSchema,
    qualifiedAt: isoDateTimeSchema.nullable(),
    rewardedAt: isoDateTimeSchema.nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((referral, ctx) => {
    if (referral.referrerProfileId === referral.refereeProfileId)
      ctx.addIssue({
        code: "custom",
        path: ["refereeProfileId"],
        message: "A customer cannot refer themselves",
      });
    const qualified =
      referral.status === "qualified" || referral.status === "rewarded";
    if (qualified !== (referral.firstOrderId !== null))
      ctx.addIssue({
        code: "custom",
        path: ["firstOrderId"],
        message: "Only a qualified referral has a first order",
      });
    if (qualified !== (referral.qualifiedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["qualifiedAt"],
        message: "Only a qualified referral has a qualification time",
      });
    if ((referral.status === "rewarded") !== (referral.rewardedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["rewardedAt"],
        message: "Reward time must match the status",
      });
  });
export type Referral = z.infer<typeof referralSchema>;

export const referralEventSchema = z.enum([
  "referee_first_paid_order",
  "reward_issued",
  "expired",
]);
export type ReferralEvent = z.infer<typeof referralEventSchema>;

const referralTransitions: Record<
  ReferralStatus,
  Partial<Record<ReferralEvent, ReferralStatus>>
> = {
  pending: { referee_first_paid_order: "qualified", expired: "expired" },
  qualified: { reward_issued: "rewarded", expired: "expired" },
  rewarded: {},
  expired: {},
};

/** Points are paid to both sides only after the referee's first transaction. */
export function transitionReferral(
  status: ReferralStatus,
  event: ReferralEvent,
): ReferralStatus {
  const next = referralTransitions[status][event];
  if (!next)
    throw new RangeError(`Invalid referral transition: ${status} -> ${event}`);
  return next;
}

/** Program plus its ordered tier ladder, as the loyalty admin reads it. */
export const loyaltyProgramWithTiersSchema = z.strictObject({
  program: loyaltyProgramSchema,
  tiers: z.array(loyaltyTierSchema),
});
export type LoyaltyProgramWithTiers = z.infer<
  typeof loyaltyProgramWithTiersSchema
>;
