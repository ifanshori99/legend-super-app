// Entitlement rules and the append-only ledger (PRD v1.7 §3 F22 "Produk & Hak
// Akses", §6 K entitlement_rules / entitlement_ledger, FAC-04/FAC-05).
//
// Ledger arithmetic is defined here once, so the API, the POS and a report
// cannot disagree about a guest's balance. The balance is the sum of signed
// movements and nothing else:
//   grant   + sessions
//   redeem  − sessions   (one ticket per redemption, 1:1)
//   cancel  − sessions   (source transaction refunded, FAC-04)
//   expire  − sessions   (expiry job, for the sessions nobody used)
// `expiresAt` is the grant's scheduled expiry, not a filter: the job appends
// the matching `expire` movement, so subtracting it twice is impossible and an
// expired-then-redeemed grant can never push the balance negative. Until the job
// runs, a service that is about to redeem must also call `isGrantExpired` on the
// grant it reads.

import { z, isoDateTimeSchema, ulidSchema, uuidSchema } from "../core/index.ts";
import { FacilityError } from "./errors.ts";
import type {
  EntitlementLedgerEntry,
  EntitlementRule,
  EntitlementSource,
  EntitlementValidity,
} from "./schemas.ts";

export const entitlementBalanceSchema = z.strictObject({
  availableSessions: z.number().int().min(0).max(10_000),
  grantedSessions: z.number().int().min(0).max(10_000),
  redeemedSessions: z.number().int().min(0).max(10_000),
  cancelledSessions: z.number().int().min(0).max(10_000),
  /** Sessions removed by the expiry job (`expire` movements). */
  expiredSessions: z.number().int().min(0).max(10_000),
  /** Earliest scheduled expiry still ahead; null when nothing expires. */
  nextExpiresAt: isoDateTimeSchema.nullable(),
});
export type EntitlementBalance = z.infer<typeof entitlementBalanceSchema>;

/**
 * Balance of one customer at one facility: the sum of signed movements
 * (see the header). Throws RangeError for a ledger that went negative — that
 * means a service wrote a redemption or cancellation without a valid grant, and
 * silencing it would grant free sessions.
 */
export function entitlementBalance(
  entries: readonly EntitlementLedgerEntry[],
  input: {
    customerProfileId: string;
    facilityId: string;
    at: Date | string;
  },
): EntitlementBalance {
  const time =
    typeof input.at === "string" ? Date.parse(input.at) : input.at.getTime();
  let granted = 0;
  let expired = 0;
  let redeemed = 0;
  let cancelled = 0;
  let nextExpiresAt: string | null = null;
  for (const entry of entries) {
    if (entry.customerProfileId !== input.customerProfileId) continue;
    if (entry.facilityId !== input.facilityId) continue;
    switch (entry.type) {
      case "grant":
        granted += entry.sessions;
        if (
          entry.expiresAt !== null &&
          Date.parse(entry.expiresAt) > time &&
          (nextExpiresAt === null ||
            Date.parse(entry.expiresAt) < Date.parse(nextExpiresAt))
        )
          nextExpiresAt = entry.expiresAt;
        break;
      case "redeem":
        redeemed += entry.sessions;
        break;
      case "cancel":
        cancelled += entry.sessions;
        break;
      case "expire":
        expired += entry.sessions;
        break;
    }
  }
  const available = granted - redeemed - cancelled - expired;
  if (available < 0)
    throw new RangeError(
      "Entitlement ledger is negative: a redemption, cancellation or expiry was written without a valid grant",
    );
  return entitlementBalanceSchema.parse({
    availableSessions: available,
    grantedSessions: granted,
    redeemedSessions: redeemed,
    cancelledSessions: cancelled,
    expiredSessions: expired,
    nextExpiresAt,
  });
}

/** True once a grant's scheduled expiry passed; the redemption guard (FAC-04). */
export function isGrantExpired(
  grant: EntitlementLedgerEntry,
  at: Date | string,
): boolean {
  if (grant.type !== "grant" || grant.expiresAt === null) return false;
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  return Date.parse(grant.expiresAt) <= time;
}

export function canRedeemEntitlement(
  balance: EntitlementBalance,
  sessions = 1,
): boolean {
  return balance.availableSessions >= sessions;
}

export function assertRedemptionAvailable(
  balance: EntitlementBalance,
  sessions = 1,
): void {
  if (!canRedeemEntitlement(balance, sessions))
    throw new FacilityError(
      "ENTITLEMENT_INSUFFICIENT",
      "Sisa kuota hak akses tidak mencukupi.",
    );
}

/**
 * FAC-05: a redemption is 1:1 — one grant is consumed by one ticket, and one
 * ticket consumes one grant. The database enforces it with unique indexes
 * (`access_tickets.entitlement_ledger_id` and the redemption row's
 * `access_ticket_id`); this mirrors the two unique keys so a service that
 * forgets them fails in a test. Under concurrency the second claim loses the
 * unique-index race and gets ENTITLEMENT_ALREADY_REDEEMED.
 */
export const redemptionClaimSchema = z.strictObject({
  ledgerId: uuidSchema,
  ticketId: ulidSchema,
});
export type RedemptionClaim = z.infer<typeof redemptionClaimSchema>;

export function claimRedemption(
  claim: RedemptionClaim,
  existing: readonly RedemptionClaim[],
): RedemptionClaim {
  const parsed = redemptionClaimSchema.parse(claim);
  for (const other of existing)
    if (
      other.ledgerId === parsed.ledgerId ||
      other.ticketId === parsed.ticketId
    )
      throw new FacilityError(
        "ENTITLEMENT_ALREADY_REDEEMED",
        "Hak akses ini sudah ditukar untuk tiket lain.",
      );
  return parsed;
}

/**
 * Expiry of a newly issued entitlement (FAC-04 validity). `operatingDayEndsAt`
 * is the facility's closing instant for the issuing business day, which the
 * availability service already knows; `billing_period` entitlements expire
 * with the invoice period, so they carry no own instant.
 */
export function entitlementExpiresAt(
  validity: EntitlementValidity,
  input: { issuedAt: string; operatingDayEndsAt: string },
): string | null {
  switch (validity.kind) {
    case "operating_day":
      return isoDateTimeSchema.parse(input.operatingDayEndsAt);
    case "duration_hours": {
      const issued = Date.parse(input.issuedAt);
      if (Number.isNaN(issued)) throw new RangeError("Invalid issuedAt");
      return new Date(issued + validity.hours * 3_600_000).toISOString();
    }
    case "billing_period":
      return null;
  }
}

/**
 * FAC-04: an entitlement is issued only after its condition is met and (for
 * every source backed by a transaction) after that transaction is paid.
 * Tier benefits come from the profile and staff issues are a decision, so they
 * carry no payment; the other four sources do.
 */
export const entitlementIssueCheckSchema = z.strictObject({
  issuable: z.boolean(),
  reason: z.enum(["ok", "unpaid", "conditions_not_met"]),
});
export type EntitlementIssueCheck = z.infer<typeof entitlementIssueCheckSchema>;

export function entitlementIssueCheck(input: {
  source: EntitlementSource;
  paid: boolean;
  conditionsMet: boolean;
}): EntitlementIssueCheck {
  const paymentRequired =
    input.source !== "tier_benefit" && input.source !== "staff_issue";
  if (paymentRequired && !input.paid)
    return { issuable: false, reason: "unpaid" };
  if (!input.conditionsMet)
    return { issuable: false, reason: "conditions_not_met" };
  return { issuable: true, reason: "ok" };
}

/** Same-day F&B spend at or above the rule threshold qualifies (PRD §3 F22). */
export function qualifiesForMinSpend(
  rule: EntitlementRule,
  sameDaySpendIdr: number,
): boolean {
  return (
    rule.isEnabled &&
    rule.type === "min_spend" &&
    sameDaySpendIdr >= rule.condition.minSpendIdr
  );
}

export function qualifiesForTier(
  rule: EntitlementRule,
  tierKey: string,
): boolean {
  return (
    rule.isEnabled &&
    rule.type === "tier_benefit" &&
    rule.condition.tierKeys.includes(tierKey)
  );
}

export function qualifiesForPackage(
  rule: EntitlementRule,
  menuItemId: string,
): boolean {
  return (
    rule.isEnabled &&
    rule.type === "package" &&
    rule.condition.menuItemId === menuItemId
  );
}

/** Enabled rules that qualify for the given context; sum their sessions. */
export function qualifyingEntitlementRules(
  rules: readonly EntitlementRule[],
  context: {
    sameDaySpendIdr?: number;
    tierKey?: string;
    menuItemId?: string;
  },
): EntitlementRule[] {
  return rules.filter((rule) => {
    switch (rule.type) {
      case "min_spend":
        return (
          context.sameDaySpendIdr !== undefined &&
          qualifiesForMinSpend(rule, context.sameDaySpendIdr)
        );
      case "tier_benefit":
        return (
          context.tierKey !== undefined &&
          qualifiesForTier(rule, context.tierKey)
        );
      case "package":
        return (
          context.menuItemId !== undefined &&
          qualifiesForPackage(rule, context.menuItemId)
        );
    }
  });
}
