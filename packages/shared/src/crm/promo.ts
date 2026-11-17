// Promo engine contract: one rule DSL shared by POS, QR order and the website
// (PRD v1.7 §3 F18, §3.21 "Promo Engine": percent and nominal discounts, buy X
// get Y, bundle, happy hour, member/tier, channel, minimum spend including a
// facility-access reward, voucher codes, stacking, quota, budget and validity).
// Vouchers are part of the same engine: a code maps to one promotion, and the
// engine decides the discount. Evaluation is pure and deterministic so the
// API, the edge and tests all compute the same price; quota/budget counters
// and voucher uniqueness are enforced transactionally by the service.

import {
  z,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  idrSchema,
  isoDateTimeSchema,
  timeOfDaySchema,
  basisPointsSchema,
  ulidIdSchema,
  clientInputSchema,
  idr,
  applyBasisPoints,
  type Idr,
} from "../core/index.ts";

const safeInt = (value: number) => Number.isSafeInteger(value);
const name = z.string().min(1).max(150);
const description = z.string().max(1000);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const positiveIdr = idrSchema.refine((value) => value > 0);
const positiveInt = z.number().int().positive().refine(safeInt);
const nonnegativeInt = z.number().int().nonnegative().refine(safeInt);
const sha256HexSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 hex digest");
const stackGroupSchema = z
  .string()
  .regex(/^[a-z0-9_]{1,30}$/, "Stack groups are lower_snake_case");

function before(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

/** Sales channels for the promo engine (kept aligned with WS-03 pricing). */
export const promoChannelSchema = z.enum([
  "dine_in",
  "takeaway",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
  "website",
]);
export type PromoChannel = z.infer<typeof promoChannelSchema>;

export const promotionStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "ended",
]);
export type PromotionStatus = z.infer<typeof promotionStatusSchema>;

/**
 * Which outlets a promotion runs at (legend-jh27). `all_except` (default) =
 * every outlet of the tenant unless an outlet has a `promotion_outlets` row
 * with `enabled = false` (opt-out). `only` = only outlets with a row that has
 * `enabled = true` (allowlist); an outlet with no row, or an `enabled = false`
 * row, does not run it.
 */
export const promotionOutletScopeSchema = z.enum(["all_except", "only"]);
export type PromotionOutletScope = z.infer<typeof promotionOutletScopeSchema>;

// ---- Rule DSL: conditions and benefits ------------------------------------

/**
 * Conditions are ANDed. `min_spend` uses the bill value after item discounts
 * and before promo, tax and service charge (owner Q53). The evaluator reads it
 * from `minSpendSubtotalIdr` when the caller supplies it (an outlet whose
 * prices include tax and service, where `subtotalIdr` still carries them), and
 * from `subtotalIdr` otherwise (exclusive pricing, where the two are equal).
 */
export const promotionConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("min_spend"), amountIdr: positiveIdr }),
  z.strictObject({
    kind: z.literal("channel"),
    channels: z.array(promoChannelSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("member"),
    /** Empty = any active member; otherwise the customer's tier must match. */
    tierIds: z.array(uuidSchema),
  }),
  z.strictObject({
    kind: z.literal("time_window"),
    /** 0 = Sunday .. 6 = Saturday, in the outlet's time zone. */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
    /** Happy hour; an end before the start spans midnight. */
    start: timeOfDaySchema,
    end: timeOfDaySchema,
  }),
  z.strictObject({
    kind: z.literal("item_quantity"),
    menuItemIds: z.array(uuidSchema).min(1),
    minQuantity: positiveInt,
  }),
  z.strictObject({
    kind: z.literal("bundle"),
    menuItemIds: z.array(uuidSchema).min(2),
  }),
]);
export type PromotionCondition = z.infer<typeof promotionConditionSchema>;

export const promotionBenefitSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("percent_off"),
    percentBp: basisPointsSchema.refine(
      (value) => value > 0,
      "A percentage discount is above zero",
    ),
    maxDiscountIdr: positiveIdr.nullable(),
  }),
  z.strictObject({ kind: z.literal("nominal_off"), amountIdr: positiveIdr }),
  z.strictObject({
    kind: z.literal("free_items"),
    menuItemIds: z.array(uuidSchema).min(1),
    /** Y in "buy X get Y", per multiple of the item_quantity condition. */
    quantityPerMultiple: positiveInt,
  }),
  z.strictObject({
    kind: z.literal("bundle_price"),
    menuItemIds: z.array(uuidSchema).min(2),
    bundlePriceIdr: nonnegativeIdr,
  }),
  z.strictObject({
    kind: z.literal("facility_entitlement"),
    /** WS-09 facility product; the minimum-spend reward issues access. */
    facilityProductId: uuidSchema,
    quantity: positiveInt,
  }),
]);
export type PromotionBenefit = z.infer<typeof promotionBenefitSchema>;

// ---- Promotion record -----------------------------------------------------

export const promotionObjectSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  name,
  description,
  status: promotionStatusSchema,
  /** SHA-256 of the promo code; the plain code is never stored (PRD §6.G). */
  codeHash: sha256HexSchema.nullable(),
  /** A code promotion applies only when the checkout presents its voucher. */
  voucherRequired: z.boolean(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema.nullable(),
  conditions: z.array(promotionConditionSchema),
  benefit: promotionBenefitSchema,
  /** Promotions in the same group never stack unless the policy allows it. */
  stackGroup: stackGroupSchema,
  /** False = this promotion must be applied alone. */
  stackable: z.boolean(),
  /** Higher priority is considered first; also breaks stacking ties. */
  priority: z.number().int().refine(safeInt),
  /** null = unlimited. */
  quotaTotal: positiveInt.nullable(),
  quotaPerCustomer: positiveInt.nullable(),
  /** Promo budget (PRD §3.21); spent is maintained by the service. */
  budgetIdr: nonnegativeIdr.nullable(),
  spentIdr: nonnegativeIdr,
  /**
   * Opt-out (`all_except`) or allowlist (`only`) per-outlet reading. Absent =
   * `all_except`; the API always returns it. Optional so existing fixtures and
   * evaluator inputs stay valid.
   */
  outletScope: promotionOutletScopeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export const promotionSchema = promotionObjectSchema.superRefine(
  (promotion, ctx) => {
    if (
      promotion.endsAt !== null &&
      !before(promotion.startsAt, promotion.endsAt)
    )
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "Promotion validity must end after it starts",
      });
    if (
      promotion.budgetIdr !== null &&
      promotion.spentIdr > promotion.budgetIdr
    )
      ctx.addIssue({
        code: "custom",
        path: ["spentIdr"],
        message: "Spent budget cannot exceed the budget",
      });
    if (promotion.voucherRequired && promotion.codeHash === null)
      ctx.addIssue({
        code: "custom",
        path: ["codeHash"],
        message: "A voucher promotion needs a code",
      });
  },
);
export type Promotion = z.infer<typeof promotionSchema>;

/**
 * The rules a bill redeemed, as they were at redeem time, keyed by promotion
 * id: conditions, benefit and checkout priority (status, validity, quotas and
 * budgets were already consumed). The partial-refund recheck (owner Q41) reads this
 * snapshot, so editing a promotion later never changes what an already-paid
 * bill earned.
 */
export const promotionRuleSnapshotSchema = z.record(
  uuidSchema,
  z.strictObject({
    conditions: z.array(promotionConditionSchema),
    benefit: promotionBenefitSchema,
    // Absent only on applications redeemed before legend-a4yd.
    priority: z.number().int().refine(safeInt).optional(),
  }),
);
export type PromotionRuleSnapshot = z.infer<typeof promotionRuleSnapshotSchema>;

// ---- Evaluation -----------------------------------------------------------

export const promoLineSchema = z.strictObject({
  menuItemId: uuidSchema,
  quantity: positiveInt,
  unitPriceIdr: nonnegativeIdr,
  lineTotalIdr: nonnegativeIdr,
});
export type PromoLine = z.infer<typeof promoLineSchema>;

export const promoCustomerSchema = z.strictObject({
  customerProfileId: uuidSchema,
  tierId: uuidSchema.nullable(),
  /** Membership is active (verified WhatsApp + loyalty consent). */
  isMember: z.boolean(),
});
export type PromoCustomer = z.infer<typeof promoCustomerSchema>;

export const promoEvaluationInputSchema = z.strictObject({
  /** Server instant; never taken from the client. */
  at: isoDateTimeSchema,
  channel: promoChannelSchema,
  /** Day and time in the outlet's time zone, derived by the server. */
  localDayOfWeek: z.number().int().min(0).max(6),
  localTime: timeOfDaySchema,
  subtotalIdr: nonnegativeIdr,
  /**
   * Bill value after item discounts, before promo, tax and service charge:
   * the `min_spend` basis (owner Q53). Only an outlet whose prices include tax
   * fills it; absent means `subtotalIdr` is already that value. The discount,
   * `paidIdr` and revenue keep using `subtotalIdr`.
   */
  minSpendSubtotalIdr: nonnegativeIdr.optional(),
  lines: z.array(promoLineSchema).min(1),
  customer: promoCustomerSchema.nullable(),
  /** Set when the checkout presented a voucher for this promotion. */
  voucherPromotionId: uuidSchema.nullable(),
});
export type PromoEvaluationInput = z.infer<typeof promoEvaluationInputSchema>;

export const promoUsageSchema = z.strictObject({
  promotionId: uuidSchema,
  totalUses: nonnegativeInt,
  customerUses: nonnegativeInt,
});
export type PromoUsage = z.infer<typeof promoUsageSchema>;

export const promoRejectionReasonSchema = z.enum([
  "not_started",
  "ended",
  "paused",
  "draft",
  "channel_mismatch",
  "member_only",
  "tier_mismatch",
  "min_spend_not_met",
  "item_mismatch",
  "time_window_mismatch",
  "voucher_required",
  "quota_exhausted",
  "budget_exhausted",
  "no_matching_items",
  "not_stackable",
  "not_selected",
]);
export type PromoRejectionReason = z.infer<typeof promoRejectionReasonSchema>;

export const promoFreeItemSchema = z.strictObject({
  menuItemId: uuidSchema,
  quantity: positiveInt,
});
export type PromoFreeItem = z.infer<typeof promoFreeItemSchema>;

export const promoFacilityEntitlementSchema = z.strictObject({
  facilityProductId: uuidSchema,
  quantity: positiveInt,
});
export type PromoFacilityEntitlement = z.infer<
  typeof promoFacilityEntitlementSchema
>;

export const promotionAppliedSchema = z.strictObject({
  applied: z.literal(true),
  promotionId: uuidSchema,
  discountIdr: nonnegativeIdr,
  freeItems: z.array(promoFreeItemSchema),
  facilityEntitlement: promoFacilityEntitlementSchema.nullable(),
});
export const promotionRejectedSchema = z.strictObject({
  applied: z.literal(false),
  promotionId: uuidSchema,
  reason: promoRejectionReasonSchema,
});
export const promotionEvaluationSchema = z.union([
  promotionAppliedSchema,
  promotionRejectedSchema,
]);
export type PromotionEvaluation = z.infer<typeof promotionEvaluationSchema>;

const ZERO_USAGE: PromoUsage = {
  promotionId: "00000000-0000-4000-8000-000000000000",
  totalUses: 0,
  customerUses: 0,
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Day of week (0 = Sunday) and "HH:mm" of an instant in the outlet's IANA time
 * zone: the server derives `localDayOfWeek` / `localTime` with this, never
 * from the client's clock (PRD §6 business dates in the outlet zone).
 */
export function outletLocalClock(
  at: string | Date,
  timeZone: string,
): { localDayOfWeek: number; localTime: string } {
  const instant = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const localDayOfWeek = WEEKDAYS.indexOf(
    part("weekday") as (typeof WEEKDAYS)[number],
  );
  if (localDayOfWeek < 0) throw new RangeError("Unknown weekday");
  return {
    localDayOfWeek,
    localTime: `${part("hour").padStart(2, "0")}:${part("minute")}`,
  };
}

function withinTimeWindow(
  condition: Extract<PromotionCondition, { kind: "time_window" }>,
  day: number,
  time: string,
): boolean {
  if (!condition.daysOfWeek.includes(day)) return false;
  if (condition.start <= condition.end)
    return time >= condition.start && time <= condition.end;
  // Overnight happy hour, e.g. 22:00-02:00.
  return time >= condition.start || time <= condition.end;
}

function conditionFailure(
  promotion: Promotion,
  input: PromoEvaluationInput,
): PromoRejectionReason | null {
  for (const condition of promotion.conditions) {
    switch (condition.kind) {
      case "min_spend":
        if (
          (input.minSpendSubtotalIdr ?? input.subtotalIdr) < condition.amountIdr
        )
          return "min_spend_not_met";
        break;
      case "channel":
        if (!condition.channels.includes(input.channel))
          return "channel_mismatch";
        break;
      case "member":
        if (input.customer === null || !input.customer.isMember)
          return "member_only";
        if (
          condition.tierIds.length > 0 &&
          (input.customer.tierId === null ||
            !condition.tierIds.includes(input.customer.tierId))
        )
          return "tier_mismatch";
        break;
      case "time_window":
        if (!withinTimeWindow(condition, input.localDayOfWeek, input.localTime))
          return "time_window_mismatch";
        break;
      case "item_quantity": {
        const quantity = input.lines
          .filter((line) => condition.menuItemIds.includes(line.menuItemId))
          .reduce((sum, line) => sum + line.quantity, 0);
        if (quantity < condition.minQuantity) return "item_mismatch";
        break;
      }
      case "bundle":
        for (const menuItemId of condition.menuItemIds)
          if (!input.lines.some((line) => line.menuItemId === menuItemId))
            return "item_mismatch";
        break;
    }
  }
  return null;
}

/**
 * What one unit of a line is worth on this bill: its unit price, or less when
 * the line already carries an item-level discount (member price, manual line
 * discount), so `lineTotalIdr < unitPriceIdr * quantity`. Rounded down, so a
 * free or bundled unit can never be valued above what the guest would pay
 * (bead legend-w3zf; PRD §3.21, ORD-03).
 */
function unitValueIdr(line: PromoLine): number {
  if (line.quantity <= 0) return 0;
  return Math.min(
    line.unitPriceIdr,
    Math.floor(line.lineTotalIdr / line.quantity),
  );
}

/**
 * Free units of a "buy X get Y free" promotion (PRD §3.21, ORD-03; bead
 * legend-w3zf, coordinator decision): the CHEAPEST eligible units are freed
 * first, each valued at `unitValueIdr` (line total / quantity, rounded down).
 * Ties are broken by menu item id, then by line position, and units of one
 * menu item are reported as one entry, so the result does not depend on the
 * order the checkout lists its lines.
 *
 * `capIdr` is the amount still discountable (the stack's remaining amount).
 * Only whole units whose total value fits it are freed, so `freeItems` always
 * names exactly what `discountIdr` paid for and never overstates it. Returns
 * an empty list when not even the cheapest unit fits, and null when the bill
 * has no matching units at all.
 *
 * Units already priced Rp0 (comped by an item-level discount) are skipped
 * entirely: they are not a benefit, so they neither consume the free slot nor
 * turn the promotion into a zero-discount redemption (coordinator decision,
 * legend-w3zf follow-up).
 */
function freeItemBenefit(
  promotion: Promotion,
  benefit: Extract<PromotionBenefit, { kind: "free_items" }>,
  input: PromoEvaluationInput,
  capIdr: number,
): { freeItems: PromoFreeItem[]; discountIdr: number } | null {
  const buyCondition = promotion.conditions.find(
    (
      condition,
    ): condition is Extract<PromotionCondition, { kind: "item_quantity" }> =>
      condition.kind === "item_quantity",
  );
  if (!buyCondition) return null;
  const bought = input.lines
    .filter((line) => buyCondition.menuItemIds.includes(line.menuItemId))
    .reduce((sum, line) => sum + line.quantity, 0);
  // A free unit that is also one of the buy items is not a paid unit, so one
  // multiple needs `minQuantity` paid units PLUS the free units it gives away.
  // Otherwise "buy 1 get 1 free" would make a single unit free (100% off) and
  // "buy 2 get 1 free" would free one of only two units. When the free items
  // are different items ("buy 2 coffee, get 1 croissant") they never take a
  // paid unit, so the threshold stays `minQuantity`. A mixed free list is
  // treated conservatively (the free unit may be a buy item) and can only
  // under-award, never over-discount.
  const freeFromBuySet = benefit.menuItemIds.some((menuItemId) =>
    buyCondition.menuItemIds.includes(menuItemId),
  );
  const unitsPerMultiple =
    buyCondition.minQuantity +
    (freeFromBuySet ? benefit.quantityPerMultiple : 0);
  const multiples = Math.floor(bought / unitsPerMultiple);
  if (multiples <= 0) return null;
  const eligible = input.lines
    .map((line, index) => ({ line, index, unitIdr: unitValueIdr(line) }))
    .filter(
      ({ line, unitIdr }) =>
        unitIdr > 0 && benefit.menuItemIds.includes(line.menuItemId),
    )
    .sort(
      (left, right) =>
        left.unitIdr - right.unitIdr ||
        (left.line.menuItemId < right.line.menuItemId
          ? -1
          : left.line.menuItemId > right.line.menuItemId
            ? 1
            : left.index - right.index),
    );
  if (eligible.length === 0) return null;
  const quantities = new Map<string, number>();
  let discountIdr = 0;
  // The allowance (Y per multiple) is shared by every matching line, so two
  // lines of the free item never double it.
  let allowance = multiples * benefit.quantityPerMultiple;
  for (const { line, unitIdr } of eligible) {
    if (allowance <= 0) break;
    const wanted = Math.min(line.quantity, allowance);
    // Units are visited cheapest first, so once one does not fit the cap no
    // later (equal or dearer) unit fits either. Every unit is priced above 0.
    const fits = Math.floor((capIdr - discountIdr) / unitIdr);
    const quantity = Math.max(0, Math.min(wanted, fits));
    if (quantity > 0) {
      allowance -= quantity;
      discountIdr += quantity * unitIdr;
      quantities.set(
        line.menuItemId,
        (quantities.get(line.menuItemId) ?? 0) + quantity,
      );
    }
    if (quantity < wanted) break;
  }
  const freeItems: PromoFreeItem[] = [...quantities].map(
    ([menuItemId, quantity]) => ({ menuItemId, quantity }),
  );
  return { freeItems, discountIdr };
}

function bundleDiscount(
  benefit: Extract<PromotionBenefit, { kind: "bundle_price" }>,
  input: PromoEvaluationInput,
): number | null {
  // One bundle = one unit of each listed item. The number of complete bundles
  // is the smallest available quantity; each is priced at the cheapest unit
  // price of that item on the bill, so extra units stay at full price.
  let bundles = Number.POSITIVE_INFINITY;
  let unitTotal = 0;
  for (const menuItemId of benefit.menuItemIds) {
    const lines = input.lines.filter(
      (entry) => entry.menuItemId === menuItemId,
    );
    if (lines.length === 0) return null;
    bundles = Math.min(
      bundles,
      lines.reduce((sum, line) => sum + line.quantity, 0),
    );
    unitTotal += Math.min(...lines.map((line) => unitValueIdr(line)));
  }
  const discount = bundles * (unitTotal - benefit.bundlePriceIdr);
  return discount > 0 ? discount : null;
}

export type PromoEvaluationOptions = {
  /**
   * Bill amount the benefit is computed on. Stacking passes the amount still
   * discountable after the promotions already chosen, so percentages apply
   * sequentially (owner decision Q20, 2026-11-01). Eligibility conditions
   * always read the full bill in `input`.
   */
  discountableIdr?: Idr;
};

/**
 * Why a promotion is not live at `at`: not active (draft, paused, ended) or
 * outside its period. The one rule behind evaluation and other callers that
 * must refuse a dead promotion (order issue vouchers, legend-c1gnr).
 */
export function promotionAvailability(
  promotion: Pick<Promotion, "status" | "startsAt" | "endsAt">,
  at: string,
): "draft" | "paused" | "ended" | "not_started" | null {
  if (promotion.status === "draft") return "draft";
  if (promotion.status === "paused") return "paused";
  if (promotion.status === "ended") return "ended";
  if (before(at, promotion.startsAt)) return "not_started";
  if (promotion.endsAt !== null && !before(at, promotion.endsAt))
    return "ended";
  return null;
}

/**
 * Evaluates one promotion against a bill. The result is deterministic and
 * side-effect free: quota/budget counters and voucher validity are supplied by
 * the caller (the service locks and increments them in the same transaction
 * that posts the order).
 */
export function evaluatePromotion(
  promotion: Promotion,
  input: PromoEvaluationInput,
  usage: PromoUsage = ZERO_USAGE,
  options: PromoEvaluationOptions = {},
): PromotionEvaluation {
  const rejected = (reason: PromoRejectionReason): PromotionEvaluation => ({
    applied: false,
    promotionId: promotion.id,
    reason,
  });
  const discountableIdr = options.discountableIdr ?? input.subtotalIdr;
  if (
    !Number.isSafeInteger(discountableIdr) ||
    discountableIdr < 0 ||
    discountableIdr > input.subtotalIdr
  )
    throw new RangeError(`Invalid discountable amount: ${discountableIdr}`);
  const unavailable = promotionAvailability(promotion, input.at);
  if (unavailable !== null) return rejected(unavailable);
  if (promotion.voucherRequired && input.voucherPromotionId !== promotion.id)
    return rejected("voucher_required");
  if (promotion.quotaTotal !== null && usage.totalUses >= promotion.quotaTotal)
    return rejected("quota_exhausted");
  // A per-customer quota cannot be counted on an anonymous bill, so it fails
  // closed instead of letting a walk-in reuse a once-per-customer promotion.
  if (promotion.quotaPerCustomer !== null && input.customer === null)
    return rejected("member_only");
  if (
    promotion.quotaPerCustomer !== null &&
    usage.customerUses >= promotion.quotaPerCustomer
  )
    return rejected("quota_exhausted");
  const failure = conditionFailure(promotion, input);
  if (failure !== null) return rejected(failure);

  const benefit = promotion.benefit;
  let discountIdr = 0;
  let freeItems: PromoFreeItem[] = [];
  let facilityEntitlement: PromoFacilityEntitlement | null = null;
  switch (benefit.kind) {
    case "percent_off": {
      discountIdr = applyBasisPoints(
        discountableIdr,
        benefit.percentBp,
        "half_up",
      );
      if (
        benefit.maxDiscountIdr !== null &&
        discountIdr > benefit.maxDiscountIdr
      )
        discountIdr = benefit.maxDiscountIdr;
      break;
    }
    case "nominal_off":
      discountIdr = benefit.amountIdr;
      break;
    case "free_items": {
      // Capped here, not by the generic clamp below, so the free units named
      // on the redemption match the discount actually given (legend-w3zf).
      const result = freeItemBenefit(
        promotion,
        benefit,
        input,
        discountableIdr,
      );
      if (result === null) return rejected("no_matching_items");
      // Not even the cheapest unit fits what is left of the bill.
      if (result.freeItems.length === 0) return rejected("not_selected");
      freeItems = result.freeItems;
      discountIdr = result.discountIdr;
      break;
    }
    case "bundle_price": {
      const discount = bundleDiscount(benefit, input);
      if (discount === null) return rejected("no_matching_items");
      discountIdr = discount;
      break;
    }
    case "facility_entitlement":
      // PRD §3.25 "Titik Masuk": facility access is bound to an identified
      // customer, so the minimum-spend reward needs one.
      if (input.customer === null) return rejected("member_only");
      facilityEntitlement = {
        facilityProductId: benefit.facilityProductId,
        quantity: benefit.quantity,
      };
      break;
  }
  if (discountIdr > discountableIdr) discountIdr = discountableIdr;
  if (
    promotion.budgetIdr !== null &&
    promotion.spentIdr + discountIdr > promotion.budgetIdr
  )
    return rejected("budget_exhausted");
  return {
    applied: true,
    promotionId: promotion.id,
    discountIdr: idr(discountIdr),
    freeItems,
    facilityEntitlement,
  };
}

// ---- Stacking -------------------------------------------------------------

export const promoStackingPolicySchema = z.strictObject({
  /** exclusive = one promotion; stackable = combine up to maxStacked. */
  mode: z.enum(["exclusive", "stackable"]),
  maxStacked: positiveInt.max(10),
  /** Allow two promotions from the same stackGroup to combine. */
  allowSameGroup: z.boolean(),
});
export type PromoStackingPolicy = z.infer<typeof promoStackingPolicySchema>;

/**
 * PRD §3.21 names "aturan tumpang tindih" as tenant configuration but does not
 * fix a default. Until the owner sets one, the safest default applies a single
 * promotion (the best discount), so promotions never combine by accident.
 */
export const defaultPromoStackingPolicy: PromoStackingPolicy = Object.freeze({
  mode: "exclusive",
  maxStacked: 1,
  allowSameGroup: false,
});

export const promotionApplicationResultSchema = z.strictObject({
  evaluations: z.array(promotionEvaluationSchema),
  totalDiscountIdr: nonnegativeIdr,
  /**
   * Stored with the application row only (never in a quote): the `min_spend`
   * basis the order redeemed with, before tax and service (owner Q53). Absent
   * on older rows and on exclusive-price orders: `subtotalIdr` is the basis.
   */
  minSpendSubtotalIdr: nonnegativeIdr.optional(),
});
export type PromotionApplicationResult = z.infer<
  typeof promotionApplicationResultSchema
>;

/**
 * Applies a stacking policy to a candidate list. Automatic promotion selection
 * never picks a voucher-required promotion; pass its id in
 * `input.voucherPromotionId` to apply it explicitly.
 *
 * Stackable promotions are selected by priority (higher first) then id; the
 * chosen stack is then priced item-level first (free items, bundle price),
 * bill-level after (percentage, nominal, facility reward), and a
 * percentage discount is computed on the amount still discountable after the
 * promotions before it, so two percentages compound instead of adding up:
 * 10% then 20% of Rp100.000 is Rp28.000, not Rp30.000 (owner decision Q20,
 * 2026-11-01). Conditions such as minimum spend still use the full bill.
 */
export function applyPromotions(
  promotions: readonly Promotion[],
  input: PromoEvaluationInput,
  usage: readonly PromoUsage[],
  policy: PromoStackingPolicy,
): PromotionApplicationResult {
  const usageById = new Map(usage.map((entry) => [entry.promotionId, entry]));
  const promotionById = new Map(
    promotions.map((promotion) => [promotion.id, promotion] as const),
  );
  const usageOf = (promotionId: string): PromoUsage =>
    usageById.get(promotionId) ?? {
      promotionId,
      totalUses: 0,
      customerUses: 0,
    };
  const candidates = promotions.filter(
    (promotion) =>
      !promotion.voucherRequired || input.voucherPromotionId === promotion.id,
  );
  const evaluations = candidates.map((promotion) =>
    evaluatePromotion(promotion, input, usageOf(promotion.id)),
  );
  const applied = evaluations.filter(
    (
      evaluation,
    ): evaluation is Extract<PromotionEvaluation, { applied: true }> =>
      evaluation.applied,
  );
  const priorityOf = (promotionId: string) =>
    promotionById.get(promotionId)?.priority ?? 0;

  if (policy.mode === "exclusive") {
    let winner: (typeof applied)[number] | null = null;
    for (const evaluation of applied) {
      if (winner === null) {
        winner = evaluation;
        continue;
      }
      const better =
        evaluation.discountIdr > winner.discountIdr ||
        (evaluation.discountIdr === winner.discountIdr &&
          (priorityOf(evaluation.promotionId) >
            priorityOf(winner.promotionId) ||
            (priorityOf(evaluation.promotionId) ===
              priorityOf(winner.promotionId) &&
              evaluation.promotionId < winner.promotionId)));
      if (better) winner = evaluation;
    }
    const result: PromotionEvaluation[] = evaluations.map((evaluation) => {
      if (!evaluation.applied) return evaluation;
      if (winner !== null && evaluation.promotionId === winner.promotionId)
        return evaluation;
      return {
        applied: false,
        promotionId: evaluation.promotionId,
        reason: "not_selected",
      };
    });
    return {
      evaluations: result,
      totalDiscountIdr: idr(winner?.discountIdr ?? 0),
    };
  }

  const ordered = [...applied].sort((left, right) => {
    const priority =
      priorityOf(right.promotionId) - priorityOf(left.promotionId);
    if (priority !== 0) return priority;
    return left.promotionId < right.promotionId ? -1 : 1;
  });
  const chosen = new Map<string, PromotionEvaluation>();
  const usedGroups = new Set<string>();
  let stacked = 0;
  let remaining: number = input.subtotalIdr;
  let exclusiveUsed = false;
  for (const evaluation of ordered) {
    if (stacked >= policy.maxStacked) {
      chosen.set(evaluation.promotionId, {
        applied: false,
        promotionId: evaluation.promotionId,
        reason: "not_selected",
      });
      continue;
    }
    const promotion = promotionById.get(evaluation.promotionId);
    if (!promotion)
      throw new RangeError(
        `Promotion ${evaluation.promotionId} is missing from the candidate list`,
      );
    // A non-stackable promotion cannot join an existing stack; if it comes
    // first (by priority) it becomes the only promotion, so nothing else may
    // join it afterwards either.
    if (exclusiveUsed || (!promotion.stackable && stacked > 0)) {
      chosen.set(evaluation.promotionId, {
        applied: false,
        promotionId: evaluation.promotionId,
        reason: "not_stackable",
      });
      continue;
    }
    const group = promotion.stackGroup;
    if (!policy.allowSameGroup && usedGroups.has(group)) {
      chosen.set(evaluation.promotionId, {
        applied: false,
        promotionId: evaluation.promotionId,
        reason: "not_stackable",
      });
      continue;
    }
    if (remaining <= 0) {
      chosen.set(evaluation.promotionId, {
        applied: false,
        promotionId: evaluation.promotionId,
        reason: "not_selected",
      });
      continue;
    }
    // Sequential pricing: a percentage benefit is recomputed on what is still
    // discountable, while eligibility above used the full bill.
    const sequential = evaluatePromotion(
      promotion,
      input,
      usageOf(promotion.id),
      {
        discountableIdr: idr(remaining),
      },
    );
    if (
      !sequential.applied ||
      (sequential.discountIdr <= 0 &&
        sequential.freeItems.length === 0 &&
        sequential.facilityEntitlement === null)
    ) {
      chosen.set(evaluation.promotionId, {
        applied: false,
        promotionId: evaluation.promotionId,
        reason: "not_selected",
      });
      continue;
    }
    chosen.set(evaluation.promotionId, sequential);
    remaining -= sequential.discountIdr;
    stacked += 1;
    usedGroups.add(group);
    if (!promotion.stackable) exclusiveUsed = true;
  }
  // Application order of the chosen stack (coordinator decision,
  // legend-7x4g): the selection above (who joins, non-stackable, group,
  // maxStacked) follows priority; the amounts are then computed item-level
  // first (free items, bundle price), bill-level after (percentage, nominal,
  // facility reward) on what remains, each tier by priority then id, each step
  // on the amount still discountable (owner Q20).
  const tierOf = (promotion: Promotion) =>
    promotion.benefit.kind === "free_items" ||
    promotion.benefit.kind === "bundle_price"
      ? 0
      : 1;
  const stack = ordered
    .filter((evaluation) => chosen.get(evaluation.promotionId)?.applied)
    .map((evaluation) => promotionById.get(evaluation.promotionId) as Promotion)
    .sort((left, right) => {
      const tier = tierOf(left) - tierOf(right);
      if (tier !== 0) return tier;
      const priority = right.priority - left.priority;
      if (priority !== 0) return priority;
      return left.id < right.id ? -1 : 1;
    });
  let left: number = input.subtotalIdr;
  for (const promotion of stack) {
    const priced =
      left > 0
        ? evaluatePromotion(promotion, input, usageOf(promotion.id), {
            discountableIdr: idr(left),
          })
        : null;
    if (
      priced === null ||
      !priced.applied ||
      (priced.discountIdr <= 0 &&
        priced.freeItems.length === 0 &&
        priced.facilityEntitlement === null)
    ) {
      chosen.set(promotion.id, {
        applied: false,
        promotionId: promotion.id,
        reason: "not_selected",
      });
      continue;
    }
    chosen.set(promotion.id, priced);
    left -= priced.discountIdr;
  }

  let totalDiscountIdr = 0;
  const result: PromotionEvaluation[] = evaluations.map((evaluation) => {
    const decision = chosen.get(evaluation.promotionId) ?? evaluation;
    if (decision.applied) totalDiscountIdr += decision.discountIdr;
    return decision;
  });
  return { evaluations: result, totalDiscountIdr: idr(totalDiscountIdr) };
}

// ---- Promo ROI (PRD §3.21 "ROI Promo") ------------------------------------

export const promotionRoiSchema = z.strictObject({
  promotionId: uuidSchema,
  transactions: nonnegativeInt,
  discountCostIdr: nonnegativeIdr,
  revenueIdr: nonnegativeIdr,
  /** Revenue minus discount cost; negative is possible. */
  netMarginIdr: idrSchema,
  /** Basis points of net margin over discount cost; null without cost. */
  roiBp: z.number().int().refine(safeInt).nullable(),
});
export type PromotionRoi = z.infer<typeof promotionRoiSchema>;

// ---- Vouchers -------------------------------------------------------------

/**
 * Customer-typed code: normalized to uppercase and stripped of hyphens before
 * hashing, so the grouped display form of an apology voucher (LEG-AB12-CD34)
 * redeems like the stored hyphen-less code (legend-4qu).
 */
export const voucherCodeInputSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value.trim().toUpperCase().replaceAll("-", "")
      : value,
  z.string().regex(/^[A-Z0-9]{6,32}$/, "Voucher codes use 6-32 letters/digits"),
);
export type VoucherCode = z.infer<typeof voucherCodeInputSchema>;

export const voucherStatusSchema = z.enum([
  "issued",
  "redeemed",
  "expired",
  "cancelled",
]);
export type VoucherStatus = z.infer<typeof voucherStatusSchema>;
export const voucherSourceSchema = z.enum([
  "promo_code",
  "apology",
  "birthday",
  "referral",
  "campaign",
  "manual",
  // legend-m4p5
  "loyalty_reward",
]);
export type VoucherSource = z.infer<typeof voucherSourceSchema>;

export const voucherObjectSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  promotionId: uuidSchema.nullable(),
  /** Null = redeemable by any customer holding the code. */
  customerProfileId: uuidSchema.nullable(),
  /** SHA-256 of the normalized code; the plain code is shown once at issue. */
  codeHash: sha256HexSchema,
  source: voucherSourceSchema,
  status: voucherStatusSchema,
  valueIdr: nonnegativeIdr.nullable(),
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema.nullable(),
  issuedAt: isoDateTimeSchema,
  issuedBy: uuidSchema.nullable(),
  redeemedAt: isoDateTimeSchema.nullable(),
  redeemedOrderId: ulidIdSchema<"OrderId">().nullable(),
  cancelledReason: z.string().max(300).nullable(),
});
export const voucherSchema = voucherObjectSchema.superRefine((voucher, ctx) => {
  if (
    voucher.validUntil !== null &&
    !before(voucher.validFrom, voucher.validUntil)
  )
    ctx.addIssue({
      code: "custom",
      path: ["validUntil"],
      message: "Validity cannot end before it starts",
    });
  if ((voucher.status === "redeemed") !== (voucher.redeemedAt !== null))
    ctx.addIssue({
      code: "custom",
      path: ["redeemedAt"],
      message: "Redemption time must match the status",
    });
  if (voucher.status === "cancelled" && voucher.cancelledReason === null)
    ctx.addIssue({
      code: "custom",
      path: ["cancelledReason"],
      message: "A cancelled voucher needs a reason",
    });
  if (voucher.status !== "cancelled" && voucher.cancelledReason !== null)
    ctx.addIssue({
      code: "custom",
      path: ["cancelledReason"],
      message: "Only a cancelled voucher carries a reason",
    });
});
export type Voucher = z.infer<typeof voucherSchema>;

/** Client-facing voucher: the code hash stays on the server. */
export const voucherDtoSchema = voucherObjectSchema.omit({
  codeHash: true,
});
export type VoucherDto = z.infer<typeof voucherDtoSchema>;

export const voucherRejectionReasonSchema = z.enum([
  "not_found",
  "not_started",
  "expired",
  "already_redeemed",
  "cancelled",
  "customer_mismatch",
  "min_spend_not_met",
  "channel_not_allowed",
  "quota_exhausted",
  "not_applicable",
]);
export type VoucherRejectionReason = z.infer<
  typeof voucherRejectionReasonSchema
>;

export type VoucherUsability = {
  readonly customerProfileId: string | null;
  readonly at: string;
};

/**
 * Checks a stored voucher without promotion evaluation. LOY-03: redemption is
 * atomic, so the service re-checks this while holding the voucher row lock.
 */
export function voucherUsability(
  voucher: Voucher,
  context: VoucherUsability,
): VoucherRejectionReason | null {
  if (voucher.status === "redeemed") return "already_redeemed";
  if (voucher.status === "cancelled") return "cancelled";
  if (voucher.status === "expired") return "expired";
  if (before(context.at, voucher.validFrom)) return "not_started";
  if (voucher.validUntil !== null && !before(context.at, voucher.validUntil))
    return "expired";
  if (
    voucher.customerProfileId !== null &&
    voucher.customerProfileId !== context.customerProfileId
  )
    return "customer_mismatch";
  return null;
}

export const voucherValidationInputSchema = clientInputSchema({
  code: voucherCodeInputSchema,
  /** Preview only: the discount actually applied is recomputed from the
   * server-priced bill when the order is posted. */
  subtotalIdr: nonnegativeIdr,
  channel: promoChannelSchema,
});
export type VoucherValidationInput = z.infer<
  typeof voucherValidationInputSchema
>;

export const voucherValidationResultSchema = z.union([
  z.strictObject({
    valid: z.literal(true),
    voucherId: uuidSchema,
    promotionId: uuidSchema.nullable(),
    discountPreviewIdr: nonnegativeIdr,
  }),
  z.strictObject({
    valid: z.literal(false),
    reason: voucherRejectionReasonSchema,
  }),
]);
export type VoucherValidationResult = z.infer<
  typeof voucherValidationResultSchema
>;

/** A voucher is redeemable at most once; the service flips it to redeemed in
 * the same transaction that applies the discount (LOY-03). */
export const voucherRedemptionSchema = z.strictObject({
  voucherId: uuidSchema,
  orderId: ulidIdSchema<"OrderId">(),
  customerProfileId: uuidSchema.nullable(),
  redeemedAt: isoDateTimeSchema,
});
export type VoucherRedemption = z.infer<typeof voucherRedemptionSchema>;

/** Facility reward issued by a minimum-spend promotion (PRD F23). */
export const facilityRewardSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  promotionId: uuidSchema,
  customerProfileId: uuidSchema,
  facilityProductId: uuidSchema,
  quantity: positiveInt,
  sourceOrderId: ulidIdSchema<"OrderId">(),
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.nullable(),
  /** WS-09 entitlement id once the facility contract issues it. */
  entitlementId: uuidSchema.nullable(),
});
export type FacilityReward = z.infer<typeof facilityRewardSchema>;

/** Outlet-scoped promo availability (an outlet may switch a promotion off). */
export const promotionOutletSchema = z.strictObject({
  promotionId: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  enabled: z.boolean(),
});
export type PromotionOutlet = z.infer<typeof promotionOutletSchema>;

/** A cart line as the client sends it: item and quantity, never a price. */
export const promoRequestLineSchema = z.strictObject({
  menuItemId: uuidSchema,
  quantity: positiveInt,
});
export type PromoRequestLine = z.infer<typeof promoRequestLineSchema>;

/**
 * Checkout request for the promo engine. The server derives `at`, the outlet
 * day/time, the member context, the voucher lookup and every price (unit
 * prices, line totals and the subtotal come from the channel price list, so a
 * tampered client price can never inflate a discount); the client never sends
 * a tenant, a customer id, a time or an amount.
 */
export const promoEvaluationRequestSchema = clientInputSchema({
  channel: promoChannelSchema,
  lines: z.array(promoRequestLineSchema).min(1),
  voucherCode: voucherCodeInputSchema.nullable(),
});
export type PromoEvaluationRequest = z.infer<
  typeof promoEvaluationRequestSchema
>;

/** A newly issued voucher: the plain code is returned once, never stored. */
export const voucherIssuedSchema = z.strictObject({
  voucher: voucherDtoSchema,
  code: voucherCodeInputSchema,
});
export type VoucherIssued = z.infer<typeof voucherIssuedSchema>;
