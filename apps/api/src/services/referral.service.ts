// Referral service (legend-3zd1, docs/design/ws08-member-loyalty.md §M6 and
// docs/briefs/sub-3zd1-slices.md "Referral"). A member's code is created
// lazily, a signup with a code writes a `pending` referral, and the referee's
// first paid order qualifies and rewards it in the earn transaction. Ledger
// rows go only through `postLedgerEntry`, under `withProfileLock`.

import { createHash, randomInt } from "node:crypto";
import { and, count, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import { memberTenantContext, withProfileLock } from "../db/member-scope.ts";
import {
  customerProfiles,
  customerVisits,
  loyaltyPrograms,
  orders,
  pointLedger,
  referrals,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { recordLoyaltyAnomaly } from "./loyalty-anomaly.service.ts";
import type { EarnStepContext } from "./loyalty-earn-step-context.ts";
import { loadGrantStates } from "./loyalty-expiry.service.ts";
import { postLedgerEntry } from "./point-ledger.service.ts";

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;
const CODE_PATTERN = /^[A-Z0-9]{4,20}$/;
const UNIQUE_VIOLATION = "23505";

function newReferralCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if ((current as { code?: string }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function referralProgram(tx: Tx, tenantId: string) {
  const [program] = await tx
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenantIdSchema.parse(tenantId)));
  return program?.isActive && program.referral.enabled ? program : null;
}

/**
 * The member's own referral code. Creates a random 8-character code when the
 * referral program is on and the profile has none; returns null when the
 * program is off and there is no code yet.
 */
export async function ensureReferralCode(
  tx: Tx,
  tenantId: string,
  profileId: string,
): Promise<string | null> {
  const tenant = tenantIdSchema.parse(tenantId);
  const own = and(
    eq(customerProfiles.tenantId, tenant),
    eq(customerProfiles.id, profileId),
  );
  const [profile] = await tx
    .select({ referralCode: customerProfiles.referralCode })
    .from(customerProfiles)
    .where(own);
  if (!profile) return null;
  if (profile.referralCode) return profile.referralCode;
  if (!(await referralProgram(tx, tenant))) return null;

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = newReferralCode();
    try {
      // Savepoint: a code collision must not abort the caller's transaction.
      const claimed = await tx.transaction(async (savepoint) => {
        const rows = await savepoint
          .update(customerProfiles)
          .set({ referralCode: code, updatedAt: new Date() })
          .where(and(own, sql`${customerProfiles.referralCode} IS NULL`))
          .returning({ referralCode: customerProfiles.referralCode });
        return rows[0]?.referralCode ?? null;
      });
      if (claimed) return claimed;
      // Another writer set a code first.
      const [current] = await tx
        .select({ referralCode: customerProfiles.referralCode })
        .from(customerProfiles)
        .where(own);
      return current?.referralCode ?? null;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error("Could not allocate a referral code");
}

/**
 * The profile id that owns a referral code, or null for an unknown or
 * malformed code. Call it BEFORE the new member's profile GUC is set: the
 * `member_self` policy would hide every profile but their own.
 */
export async function findReferrerByCode(
  tx: Tx,
  tenantId: string,
  code: string,
): Promise<string | null> {
  const tenant = tenantIdSchema.parse(tenantId);
  const normalized = code.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) return null;
  const [referrer] = await tx
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenant),
        eq(customerProfiles.referralCode, normalized),
      ),
    );
  return referrer?.id ?? null;
}

/**
 * Records a `pending` referral for a new member who signed up with a code.
 * An unknown code, an inactive referral program, a self referral or a second
 * referral for the same referee is ignored silently: signup must not fail and
 * codes must not be guessable. `referrerProfileId` is the id already resolved
 * by `findReferrerByCode` (null = unknown code); left undefined, the code is
 * looked up here, which only works without a member profile GUC.
 */
export async function applyReferralAtSignup(
  tx: Tx,
  input: {
    tenantId: string;
    refereeProfileId: string;
    code: string;
    referrerProfileId?: string | null;
  },
): Promise<void> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const code = input.code.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) return;
  const program = await referralProgram(tx, tenant);
  if (!program) return;
  const referrerId =
    input.referrerProfileId === undefined
      ? await findReferrerByCode(tx, tenant, code)
      : input.referrerProfileId;
  if (!referrerId || referrerId === input.refereeProfileId) return;
  await tx
    .insert(referrals)
    .values({
      tenantId: tenant,
      referrerProfileId: referrerId,
      refereeProfileId: input.refereeProfileId,
      code,
      status: "pending",
      referrerPoints: program.referral.referrerPoints,
      refereePoints: program.referral.refereePoints,
    })
    .onConflictDoNothing();
}

function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Runs after the visit row of a paid order is written, under the referee's
 * profile lock. Qualifies the referee's pending referral on the first paid
 * order and rewards both sides, or marks it `expired` without a bonus when a
 * guard rejects it. Locks the referrer's profile after the referee's.
 */
export async function qualifyReferral(context: EarnStepContext): Promise<void> {
  const { tx, program, profile, order, record } = context;
  if (!program.isActive || !program.referral.enabled) return;
  // Only an order that earns (or earned up to the cap) can qualify; a blocked
  // or skipped one must not pay a bonus.
  if (record.state !== "booked" && record.state !== "capped") return;
  const tenant = tenantIdSchema.parse(context.tenantId);

  const [referral] = await tx
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.tenantId, tenant),
        eq(referrals.refereeProfileId, profile.id),
        eq(referrals.status, "pending"),
      ),
    )
    .for("update");
  if (!referral) return;

  // Only the referee's first paid order qualifies (the visit row of this
  // order is already written).
  const [others] = await tx
    .select({ total: count() })
    .from(customerVisits)
    .where(
      and(
        eq(customerVisits.tenantId, tenant),
        eq(customerVisits.customerProfileId, profile.id),
        ne(customerVisits.orderId, order.id),
      ),
    );
  if (Number(others?.total ?? 0) > 0) return;
  if (order.eligibleSpendIdr < program.referral.minFirstOrderIdr) return;

  const now = new Date();
  const referrer = await withProfileLock(
    tx,
    context.tenantId,
    referral.referrerProfileId,
  );

  const expire = async (): Promise<void> => {
    await tx
      .update(referrals)
      .set({ status: "expired" })
      .where(
        and(eq(referrals.tenantId, tenant), eq(referrals.id, referral.id)),
      );
  };

  if (referrer.id === profile.id || referrer.membershipStatus !== "active")
    return expire();

  if (profile.whatsappHash !== null) {
    const [shared] = await tx
      .select({ id: customerProfiles.id })
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenant),
          eq(customerProfiles.whatsappHash, profile.whatsappHash),
          ne(customerProfiles.id, profile.id),
        ),
      )
      .limit(1);
    if (shared) return expire();
  }

  // Monthly cap: rewarded referrals of this referrer in the current calendar
  // month of Asia/Jakarta.
  const monthStart = sql`timezone('Asia/Jakarta', date_trunc('month', timezone('Asia/Jakarta', ${now.toISOString()}::timestamptz)))`;
  const [rewarded] = await tx
    .select({ total: count() })
    .from(referrals)
    .where(
      and(
        eq(referrals.tenantId, tenant),
        eq(referrals.referrerProfileId, referrer.id),
        eq(referrals.status, "rewarded"),
        gte(referrals.rewardedAt, monthStart),
      ),
    );
  if (
    Number(rewarded?.total ?? 0) >=
    program.referral.maxReferralsPerCustomerPerMonth
  )
    return expire();

  await tx
    .update(referrals)
    .set({
      status: "rewarded",
      firstOrderId: order.id,
      qualifiedAt: now,
      rewardedAt: now,
    })
    .where(and(eq(referrals.tenantId, tenant), eq(referrals.id, referral.id)));

  const ledger = memberTenantContext(context.tenantId);
  const expiresAt = addMonthsUtc(order.paidAt, program.expiryMonths);
  if (referral.referrerPoints > 0)
    await postLedgerEntry(
      tx,
      ledger,
      {
        tenantId: context.tenantId,
        customerProfileId: referrer.id,
        outletId: order.outletId,
        type: "bonus",
        points: referral.referrerPoints,
        sourceType: "referral",
        sourceId: referral.id,
        expiresAt,
        businessDate: order.businessDate,
      },
      now,
    );
  if (referral.refereePoints > 0)
    await postLedgerEntry(
      tx,
      ledger,
      {
        tenantId: context.tenantId,
        customerProfileId: profile.id,
        outletId: order.outletId,
        type: "bonus",
        points: referral.refereePoints,
        sourceType: "referral",
        sourceId: order.id,
        expiresAt,
        businessDate: order.businessDate,
      },
      now,
    );
}

/** A refund or void that takes back the referral bonus of its order. */
export type ReferralReversalInput = {
  tenantId: string;
  orderId: string;
  outletId: string;
  businessDate: string;
  sourceType: "refund" | "void";
  /** The refund or void id: the idempotency key of the reverse rows. */
  sourceId: string;
  /**
   * Eligible amount refunded so far (cumulative); null = a void. Only a void
   * or a refund of the whole eligible amount reverses; a partial refund does
   * not (decision for the CTO: the bonus stays, the referee did pay).
   */
  refundEligibleIdr: number | null;
  /**
   * The earn record says the eligible spend is refunded in full. That spend
   * excludes the part paid with points, so it can sit below the order's
   * eligible amount; then this flag still makes the refund a full one.
   */
  fullRefund?: boolean;
};

/** Stable UUID (v5-shaped) per refund or void and bonus row, so a replay is a no-op. */
function referralReverseSourceId(sourceId: string, entryId: string): string {
  const hex = createHash("sha256")
    .update(`referral_reversal:${sourceId}:${entryId}`)
    .digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Takes back the bonus of the referral whose first paid order is voided or
 * fully refunded, then marks the referral `expired` so it cannot qualify
 * again. Each side's `reverse` row names its bonus row and is limited to the
 * smaller of what is still unreversed, what the bonus grant still holds
 * (legend-4frkf: expired points count, redeemed ones do not) and the profile's
 * balance, so no balance goes negative; any shortfall is a
 * `refund_after_redeem` anomaly. Idempotent: the reverse rows have a
 * deterministic dedupe key and a second call finds the referral `expired`.
 * A referral still `pending` (first order under the minimum) paid nothing and
 * is left alone. Call in the refund or void transaction.
 */
export async function reverseReferralForOrder(
  tx: Tx,
  input: ReferralReversalInput,
  now: Date = new Date(),
): Promise<void> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const byOrder = and(
    eq(referrals.tenantId, tenant),
    eq(referrals.firstOrderId, input.orderId),
    inArray(referrals.status, ["rewarded", "qualified"]),
  );
  const [found] = await tx
    .select({ id: referrals.id, refereeProfileId: referrals.refereeProfileId })
    .from(referrals)
    .where(byOrder);
  if (!found) return;

  if (input.refundEligibleIdr !== null && input.fullRefund !== true) {
    const [order] = await tx
      .select({
        // Same base the earn used: gross sales minus discount.
        eligible: sql<string>`GREATEST(0, CASE WHEN ${orders.pricesIncludeTax}
          THEN ${orders.subtotalIdr} - ${orders.serviceChargeIdr} - ${orders.taxIdr}
          ELSE ${orders.subtotalIdr} END - ${orders.discountIdr})`,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenant), eq(orders.id, input.orderId)))
      .limit(1);
    // Unknown order: keep the bonus (the limiting choice for the member, but
    // never a payment above what was earned).
    if (!order || input.refundEligibleIdr < Number(order.eligible)) return;
  }

  // Same lock order as `qualifyReferral`: referee profile, referral, referrer.
  const referee = await withProfileLock(tx, tenant, found.refereeProfileId);
  const [referral] = await tx
    .select()
    .from(referrals)
    .where(and(byOrder, eq(referrals.id, found.id)))
    .for("update");
  // Another reversal got here first.
  if (!referral) return;
  const referrer = await withProfileLock(
    tx,
    tenant,
    referral.referrerProfileId,
  );

  const context = memberTenantContext(tenant);
  const sides = [
    {
      profile: referrer,
      sourceIds: [referral.id],
    },
    {
      profile: referee,
      sourceIds: [input.orderId, ulidToUuid(input.orderId)],
    },
  ];
  for (const side of sides) {
    const [bonus] = await tx
      .select()
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenant),
          eq(pointLedger.customerProfileId, side.profile.id),
          eq(pointLedger.type, "bonus"),
          eq(pointLedger.sourceType, "referral"),
          inArray(pointLedger.sourceId, side.sourceIds),
        ),
      )
      .limit(1);
    if (!bonus || bonus.points <= 0) continue;
    const [taken] = await tx
      .select({
        total: sql<string>`COALESCE(-SUM(${pointLedger.points}), 0)`,
      })
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenant),
          eq(pointLedger.type, "reverse"),
          eq(pointLedger.reversesEntryId, bonus.id),
        ),
      );
    const remaining = Math.max(0, bonus.points - Number(taken?.total ?? 0));
    if (remaining <= 0) continue;

    const grant = (await loadGrantStates(tx, tenant, side.profile.id)).find(
      (state) => state.id === bonus.id,
    );
    // A grant without `expires_at` is not listed: only the balance limits it.
    // A grant that already expired (wholly or in part) is limited to what is
    // left of it: the member lost those points once, they are not taken again
    // from other grants (legend-4frkf). Points a redeem used still count as
    // the grant's: like an earn reversal they are taken back from the balance
    // (no payout on a void).
    const grantLeft =
      grant && grant.expireRowCount > 0
        ? Math.max(
            0,
            bonus.points - grant.expiredPoints - Number(taken?.total ?? 0),
          )
        : Number.POSITIVE_INFINITY;
    const posted = Math.min(
      remaining,
      grantLeft,
      Math.max(0, Number(side.profile.pointsBalance)),
    );
    const reverseSourceId = referralReverseSourceId(input.sourceId, bonus.id);
    if (posted > 0)
      await postLedgerEntry(
        tx,
        context,
        {
          tenantId: tenant,
          customerProfileId: side.profile.id,
          outletId: input.outletId,
          type: "reverse",
          points: -posted,
          sourceType: input.sourceType,
          sourceId: reverseSourceId,
          reversesEntryId: bonus.id,
          businessDate: input.businessDate,
        },
        now,
      );
    if (remaining > posted)
      await recordLoyaltyAnomaly(tx, {
        tenantId: tenant,
        kind: "refund_after_redeem",
        outletId: input.outletId,
        customerProfileId: side.profile.id,
        orderId: input.orderId,
        businessDate: input.businessDate,
        details: {
          sourceType: input.sourceType,
          sourceId: reverseSourceId,
          deltaPoints: remaining,
          postedPoints: posted,
          shortfallPoints: remaining - posted,
        },
      });
  }

  await tx
    .update(referrals)
    // referrals_{first_order,qualified_at,rewarded_at}_check: only qualified or
    // rewarded rows keep an order and its timestamps (the ledger keeps the audit).
    .set({
      status: "expired",
      firstOrderId: null,
      qualifiedAt: null,
      rewardedAt: null,
    })
    .where(and(eq(referrals.tenantId, tenant), eq(referrals.id, referral.id)));
}
