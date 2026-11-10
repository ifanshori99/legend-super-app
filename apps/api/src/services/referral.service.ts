// Referral service (legend-3zd1, docs/design/ws08-member-loyalty.md §M6 and
// docs/briefs/sub-3zd1-slices.md "Referral"). A member's code is created
// lazily, a signup with a code writes a `pending` referral, and the referee's
// first paid order qualifies and rewards it in the earn transaction. Ledger
// rows go only through `postLedgerEntry`, under `withProfileLock`.

import { randomInt } from "node:crypto";
import { and, count, eq, gte, ne, sql } from "drizzle-orm";
import { tenantIdSchema } from "@starter/shared/core";
import { memberTenantContext, withProfileLock } from "../db/member-scope.ts";
import {
  customerProfiles,
  customerVisits,
  loyaltyPrograms,
  referrals,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import type { EarnStepContext } from "./loyalty-earn-step-context.ts";
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
