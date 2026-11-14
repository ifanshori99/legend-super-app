// Referral service (legend-3zd1, docs/design/ws08-member-loyalty.md §M6 and
// docs/briefs/sub-3zd1-slices.md "Referral"). A member's code is created
// lazily, a signup with a code writes a `pending` referral, and the referee's
// first paid order qualifies and rewards it in the earn transaction. Ledger
// rows go only through `postLedgerEntry`, under `withProfileLock`.

import { createHash, randomInt } from "node:crypto";
import { and, count, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
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
  // Founder Q6 (14 Nov 2026): an order paid fully with points (no cash part)
  // never triggers the bonus, whatever minFirstOrderIdr is.
  if (order.eligibleSpendIdr <= 0) return;
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
  /**
   * Order issue ids of the rejected refunds of this order (the earn record's
   * `reject:<id>` entries). Each names the restore lot a rejection gave back
   * (see `restoreReferralBonusForRejectedRefund`), so what expired from that
   * lot counts as expired from the bonus.
   */
  rejectedIssueIds?: readonly string[];
};

/** Stable UUID (v5-shaped) per refund or void and bonus row, so a replay is a no-op. */
function referralReverseSourceId(sourceId: string, entryId: string): string {
  const hex = createHash("sha256")
    .update(`referral_reversal:${sourceId}:${entryId}`)
    .digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Reason of the `adjust` row that gives back a bonus; names the bonus row it restores. */
function referralRestoreReason(bonusId: string): string {
  return `Refund ditolak (ORD-09): bonus referral dipulihkan [${bonusId}]`;
}

/** Source id of the `adjust` lot that gives back a bonus row for one rejected refund. */
function referralRestoreSourceId(issueId: string, bonusId: string): string {
  return referralReverseSourceId(`restore:${issueId}`, bonusId);
}

/**
 * Ids of the restore lots of one bonus row: `adjust` rows whose source id is
 * derived from the bonus row and a rejected refund's issue id.
 */
async function restoreLotIds(
  tx: Tx,
  tenant: ReturnType<typeof tenantIdSchema.parse>,
  profileId: string,
  bonusId: string,
  rejectedIssueIds: readonly string[],
): Promise<string[]> {
  if (rejectedIssueIds.length === 0) return [];
  const rows = await tx
    .select({ id: pointLedger.id })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenant),
        eq(pointLedger.customerProfileId, profileId),
        eq(pointLedger.type, "adjust"),
        inArray(
          pointLedger.sourceId,
          rejectedIssueIds.map((issueId) =>
            referralRestoreSourceId(issueId, bonusId),
          ),
        ),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Points of a bonus row that stay taken back: its `reverse` rows minus the
 * `adjust` rows that gave them back after a rejected refund (restore).
 */
async function netReversedOfBonus(
  tx: Tx,
  tenant: ReturnType<typeof tenantIdSchema.parse>,
  profileId: string,
  bonusId: string,
): Promise<number> {
  const [reversed] = await tx
    .select({
      total: sql<string>`COALESCE(-SUM(${pointLedger.points}), 0)`,
    })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenant),
        eq(pointLedger.type, "reverse"),
        eq(pointLedger.reversesEntryId, bonusId),
      ),
    );
  const [restored] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${pointLedger.points}), 0)`,
    })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenant),
        eq(pointLedger.customerProfileId, profileId),
        eq(pointLedger.type, "adjust"),
        eq(pointLedger.sourceType, "adjustment"),
        eq(pointLedger.reason, referralRestoreReason(bonusId)),
      ),
    );
  return Math.max(
    0,
    Number(reversed?.total ?? 0) - Number(restored?.total ?? 0),
  );
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
    // legend-sbxr0: a reverse a rejected refund gave back no longer counts.
    const taken = await netReversedOfBonus(
      tx,
      tenant,
      side.profile.id,
      bonus.id,
    );
    const remaining = Math.max(0, bonus.points - taken);
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
    // The points a rejected refund gave back sit in their own `adjust` lot (id
    // from its derivable source id): what expired from it expired from the bonus.
    const restoreIds = await restoreLotIds(
      tx,
      tenant,
      side.profile.id,
      bonus.id,
      input.rejectedIssueIds ?? [],
    );
    let expireRowCount = grant?.expireRowCount ?? 0;
    let expiredPoints = grant?.expiredPoints ?? 0;
    if (restoreIds.length > 0)
      for (const lot of await loadGrantStates(tx, tenant, side.profile.id)) {
        if (!restoreIds.includes(lot.id)) continue;
        expireRowCount += lot.expireRowCount;
        expiredPoints += lot.expiredPoints;
      }
    const grantLeft =
      expireRowCount > 0
        ? Math.max(0, bonus.points - expiredPoints - taken)
        : Number.POSITIVE_INFINITY;
    // Points that expired are gone, not a shortfall: only what the grant still
    // holds can fall short of the balance.
    const cappedRemaining = Math.min(remaining, grantLeft);
    const posted = Math.min(
      cappedRemaining,
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
    if (cappedRemaining > posted)
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
          deltaPoints: cappedRemaining,
          postedPoints: posted,
          shortfallPoints: cappedRemaining - posted,
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

/** The rejected refund (ORD-09) whose referral bonus reversal is undone. */
export type ReferralRestoreInput = {
  tenantId: string;
  orderId: string;
  /** The referee: the earn record's profile (a full refund removed the visit row). */
  refereeProfileId: string;
  outletId: string;
  businessDate: string;
  /** The rejected refund's order issue id: the idempotency key of the restore. */
  sourceId: string;
};

/**
 * A refund that took back the referral bonus is rejected (ORD-09): gives back
 * exactly what that refund reversed, once. Only an `expired` referral without
 * a first order (what the reversal leaves) is touched, and each side gets at
 * most its own `reverse` rows of this refund, never more than the bonus held.
 * A bonus that already lapsed is not restored, and then neither side is (the
 * limiting choice: no half restore). Neither side is restored when the referrer
 * is no longer active or the monthly referral cap of the bonus month is full.
 * The restore row has a deterministic
 * dedupe key and a side that already has it is skipped, so a retry or a
 * concurrent call adds nothing. When a side is restored the referral turns
 * `rewarded` again, so a later full refund can take the bonus back once more
 * (the reversal counts the restore rows off). Call in the transaction of the
 * caller, which holds the referee's profile lock.
 */
export async function restoreReferralBonusForRejectedRefund(
  tx: Tx,
  input: ReferralRestoreInput,
  now: Date = new Date(),
): Promise<void> {
  const tenant = tenantIdSchema.parse(input.tenantId);

  // Same lock order as the reversal: referee profile, referral, referrer.
  const referee = await withProfileLock(tx, tenant, input.refereeProfileId);
  const [referral] = await tx
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.tenantId, tenant),
        eq(referrals.refereeProfileId, referee.id),
        eq(referrals.status, "expired"),
        sql`${referrals.firstOrderId} IS NULL`,
      ),
    )
    .for("update");
  if (!referral) return;
  const referrer = await withProfileLock(
    tx,
    tenant,
    referral.referrerProfileId,
  );

  // Limiting choice (decision for the CTO): an inactive referrer gets nothing
  // back, and neither does the referee.
  if (referrer.membershipStatus !== "active") return;
  const program = await referralProgram(tx, tenant);
  if (!program) return;

  const context = memberTenantContext(tenant);
  const sides = [
    { profile: referrer, sourceIds: [referral.id] },
    {
      profile: referee,
      sourceIds: [input.orderId, ulidToUuid(input.orderId)],
    },
  ];
  let firstBonusAt: Date | null = null;
  const restores: {
    profileId: string;
    bonusId: string;
    points: number;
    expiresAt: Date | null;
  }[] = [];
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
    if (firstBonusAt === null || bonus.createdAt < firstBonusAt)
      firstBonusAt = bonus.createdAt;

    const restoreSourceId = referralRestoreSourceId(input.sourceId, bonus.id);
    const [done] = await tx
      .select({ id: pointLedger.id })
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenant),
          eq(pointLedger.customerProfileId, side.profile.id),
          eq(pointLedger.sourceId, restoreSourceId),
        ),
      )
      .limit(1);
    if (done) continue;

    const [totals] = await tx
      .select({
        mine: sql<string>`COALESCE(-SUM(${pointLedger.points}), 0)`,
      })
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenant),
          eq(pointLedger.type, "reverse"),
          eq(pointLedger.reversesEntryId, bonus.id),
          eq(
            pointLedger.sourceId,
            referralReverseSourceId(input.sourceId, bonus.id),
          ),
        ),
      );
    const mine = Math.min(Number(totals?.mine ?? 0), bonus.points);
    if (mine <= 0) continue;
    // A lapsed bonus is not given back, and then no side is.
    if (bonus.expiresAt !== null && bonus.expiresAt <= now) return;
    restores.push({
      profileId: side.profile.id,
      bonusId: bonus.id,
      points: mine,
      expiresAt: bonus.expiresAt,
    });
  }
  if (restores.length === 0 || firstBonusAt === null) return;

  // Monthly cap (as `qualifyReferral`) of the month the bonus was first paid in
  // (Asia/Jakarta): when the referrer's other rewarded referrals of that month
  // already fill it, the restore would pay above the cap, so neither side is
  // restored (limiting choice, decision for the CTO).
  const bonusMonth = sql`timezone('Asia/Jakarta', ${firstBonusAt.toISOString()}::timestamptz)`;
  const monthStart = sql`timezone('Asia/Jakarta', date_trunc('month', ${bonusMonth}))`;
  const nextMonthStart = sql`timezone('Asia/Jakarta', date_trunc('month', ${bonusMonth}) + interval '1 month')`;
  const [rewardedThatMonth] = await tx
    .select({ total: count() })
    .from(referrals)
    .where(
      and(
        eq(referrals.tenantId, tenant),
        eq(referrals.referrerProfileId, referrer.id),
        eq(referrals.status, "rewarded"),
        ne(referrals.id, referral.id),
        gte(referrals.rewardedAt, monthStart),
        lt(referrals.rewardedAt, nextMonthStart),
      ),
    );
  if (
    Number(rewardedThatMonth?.total ?? 0) >=
    program.referral.maxReferralsPerCustomerPerMonth
  )
    return;

  for (const restore of restores) {
    await postLedgerEntry(
      tx,
      context,
      {
        tenantId: tenant,
        customerProfileId: restore.profileId,
        outletId: input.outletId,
        type: "adjust",
        points: restore.points,
        sourceType: "adjustment",
        sourceId: referralRestoreSourceId(input.sourceId, restore.bonusId),
        expiresAt: restore.expiresAt,
        businessDate: input.businessDate,
        reason: referralRestoreReason(restore.bonusId),
      },
      now,
    );
  }

  await tx
    .update(referrals)
    // referrals_{first_order,qualified_at,rewarded_at}_check: a rewarded row
    // keeps its order and both timestamps.
    .set({
      status: "rewarded",
      firstOrderId: input.orderId,
      qualifiedAt: firstBonusAt,
      rewardedAt: firstBonusAt,
    })
    .where(
      and(
        eq(referrals.tenantId, tenant),
        eq(referrals.id, referral.id),
        eq(referrals.status, "expired"),
      ),
    );
}
