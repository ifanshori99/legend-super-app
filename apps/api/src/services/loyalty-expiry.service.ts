// Point expiry and birthday bonus (legend-3zd1, docs/design/ws08-member-loyalty.md
// §M5 B13, docs/briefs/sub-3zd1-slices.md potongan 3). Every ledger write goes
// through `postLedgerEntry` under `withProfileLock`; `points_balance` is never
// written here.
//
// Expiry: grants (earn, bonus, positive adjust without `reverses_entry_id`)
// are consumed oldest `expires_at` first by redeems, manual negative adjusts
// and reversals; what is left past `expires_at` and not yet expired becomes one
// `expire` row per grant (`reverses_entry_id` = the grant). A rerun without new
// data writes nothing.

import { createHash } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { businessDateOf, tenantIdSchema } from "@starter/shared/core";
import { customerProfiles, loyaltyPrograms } from "../db/schema/crm-member";
import { pointLedger } from "../db/schema/crm-ledger";
import { loyaltyTiers } from "../db/schema/crm-tiers";
import { memberTenantContext, withProfileLock } from "../db/member-scope";
import { loyaltyConsentActive } from "./member-profile.service";
import { postLedgerEntry } from "./point-ledger.service";
import type { Tx } from "./permission-resolver";

const TIME_ZONE = "Asia/Jakarta";
const DAY_CLOCK = { timeZone: TIME_ZONE, cutoff: "00:00" } as const;

/** Namespace of the UUIDv5 ledger source ids written by this file. */
const SOURCE_ID_NAMESPACE = Buffer.from(
  "3b7e1c52a9d44f0e8c6a2d5f10b47e93",
  "hex",
);

/** Deterministic UUID version 5 of `name` (same pattern as payment intents). */
function sourceUuid(name: string): string {
  const bytes = createHash("sha1")
    .update(SOURCE_ID_NAMESPACE)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

type GrantState = {
  id: string;
  expiresAt: Date;
  /**
   * Grant points still alive: after reversals and expire rows already written
   * against this grant, minus the FIFO share of redemptions.
   */
  unused: number;
  expireRowCount: number;
};

/** Grant states in FIFO order (`expires_at`, then id) from the whole ledger. */
async function loadGrantStates(
  tx: Tx,
  tenantId: string,
  profileId: string,
): Promise<GrantState[]> {
  const rows = await tx
    .select({
      id: pointLedger.id,
      type: pointLedger.type,
      points: pointLedger.points,
      reversesEntryId: pointLedger.reversesEntryId,
      expiresAt: pointLedger.expiresAt,
    })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenantIdSchema.parse(tenantId)),
        eq(pointLedger.customerProfileId, profileId),
      ),
    );
  const redeemIds = new Set(
    rows.filter((row) => row.type === "redeem").map((row) => row.id),
  );
  const grants = rows
    .filter(
      (row) =>
        (row.type === "earn" ||
          row.type === "bonus" ||
          (row.type === "adjust" && row.points > 0)) &&
        row.reversesEntryId === null &&
        row.expiresAt !== null,
    )
    .sort((a, b) => {
      const byExpiry = a.expiresAt!.getTime() - b.expiresAt!.getTime();
      return byExpiry !== 0 ? byExpiry : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const reversed = new Map<string, number>();
  const expired = new Map<string, number>();
  const expireRows = new Map<string, number>();
  let used = 0;
  for (const row of rows) {
    const abs = Math.abs(row.points);
    if (row.type === "reverse" && row.reversesEntryId !== null)
      reversed.set(
        row.reversesEntryId,
        (reversed.get(row.reversesEntryId) ?? 0) + abs,
      );
    else if (row.type === "expire" && row.reversesEntryId !== null) {
      expired.set(
        row.reversesEntryId,
        (expired.get(row.reversesEntryId) ?? 0) + abs,
      );
      expireRows.set(
        row.reversesEntryId,
        (expireRows.get(row.reversesEntryId) ?? 0) + 1,
      );
    } else if (row.type === "redeem") used += abs;
    else if (
      row.type === "adjust" &&
      row.points > 0 &&
      row.reversesEntryId !== null &&
      redeemIds.has(row.reversesEntryId)
    )
      used -= row.points;
    else if (
      row.type === "adjust" &&
      row.points < 0 &&
      row.reversesEntryId === null
    )
      used += abs;
  }
  // Reversals and expire rows that outrun their grant (a refund after the
  // grant already expired) were taken from the balance of other grants: count
  // the excess as used so those grants are not treated as whole.
  for (const grant of grants) {
    used += Math.max(
      (reversed.get(grant.id) ?? 0) +
        (expired.get(grant.id) ?? 0) -
        grant.points,
      0,
    );
  }
  let remainingUse = Math.max(used, 0);
  return grants.map((grant) => {
    // Points an earlier expire row removed are gone: they cannot absorb a later
    // redemption, so a redeem after one grant expired lands on the next grant.
    const net = Math.max(
      grant.points -
        (reversed.get(grant.id) ?? 0) -
        (expired.get(grant.id) ?? 0),
      0,
    );
    const allocated = Math.min(net, remainingUse);
    remainingUse -= allocated;
    return {
      id: grant.id,
      expiresAt: grant.expiresAt!,
      unused: net - allocated,
      expireRowCount: expireRows.get(grant.id) ?? 0,
    };
  });
}

/**
 * Expires what is past `expires_at` for one profile, in the caller's
 * transaction. Returns the number of points expired by this call.
 */
export async function expirePointsForProfile(
  tx: Tx,
  tenantId: string,
  profileId: string,
  now: Date,
): Promise<number> {
  const profile = await withProfileLock(tx, tenantId, profileId);
  const context = memberTenantContext(tenantId);
  const grants = await loadGrantStates(tx, tenantId, profileId);
  let balance = Number(profile.pointsBalance);
  let total = 0;
  for (const grant of grants) {
    if (grant.expiresAt.getTime() > now.getTime()) continue;
    const due = grant.unused;
    if (due <= 0) continue;
    const points = Math.min(due, balance);
    if (points <= 0) continue;
    const result = await postLedgerEntry(
      tx,
      context,
      {
        tenantId,
        customerProfileId: profileId,
        type: "expire",
        points: -points,
        sourceType: "expiry",
        sourceId: sourceUuid(`${grant.id}:${grant.expireRowCount + 1}`),
        reversesEntryId: grant.id,
        businessDate: businessDateOf(now, DAY_CLOCK),
      },
      now,
    );
    if (result.inserted) {
      balance += result.entry.points;
      total += points;
    }
  }
  return total;
}

/** Points that expire within `days` after `now`, and the earliest such date. */
export async function expiringSoonOf(
  tx: Tx,
  tenantId: string,
  profileId: string,
  now: Date,
  days = 30,
): Promise<{ points: number; earliestExpiresAt: string | null }> {
  const horizon = now.getTime() + days * 86_400_000;
  const [profile] = await tx
    .select({ balance: customerProfiles.pointsBalance })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantIdSchema.parse(tenantId)),
        eq(customerProfiles.id, profileId),
      ),
    );
  const balance = Number(profile?.balance ?? 0);
  const grants = await loadGrantStates(tx, tenantId, profileId);
  let points = 0;
  let earliest: Date | null = null;
  for (const grant of grants) {
    const time = grant.expiresAt.getTime();
    if (time <= now.getTime() || time > horizon) continue;
    const left = grant.unused;
    if (left <= 0) continue;
    points += left;
    if (earliest === null || grant.expiresAt < earliest)
      earliest = grant.expiresAt;
  }
  return {
    points: Math.min(points, balance),
    earliestExpiresAt: earliest?.toISOString() ?? null,
  };
}

/** "MM-DD" values that celebrate today (Asia/Jakarta); 29 Feb on 28 Feb of a
 * non-leap year. */
export function birthdayMonthDaysOf(now: Date): string[] {
  const date = businessDateOf(now, DAY_CLOCK);
  const year = Number(date.slice(0, 4));
  const monthDay = date.slice(5);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return monthDay === "02-28" && !leap ? ["02-28", "02-29"] : [monthDay];
}

/**
 * Profiles worth a visit in the daily sweep, ordered by id after `afterId`:
 * a positive balance with an expired grant, or a birthday today.
 */
export async function listExpiryCandidateProfileIds(
  tx: Tx,
  tenantId: string,
  now: Date,
  options: { afterId?: string | null; limit?: number } = {},
): Promise<string[]> {
  const tenant = tenantIdSchema.parse(tenantId);
  const monthDays = birthdayMonthDaysOf(now);
  const birthday = sql.join(
    monthDays.map((value) => sql`${value}`),
    sql`, `,
  );
  const rows = await tx
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenant),
        options.afterId ? gt(customerProfiles.id, options.afterId) : undefined,
        sql`(
          (${customerProfiles.pointsBalance} > 0 AND EXISTS (
            SELECT 1 FROM ${pointLedger} l
             WHERE l.tenant_id = ${customerProfiles.tenantId}
               AND l.customer_profile_id = ${customerProfiles.id}
               AND l.type IN ('earn', 'bonus', 'adjust')
               AND l.points > 0
               AND l.reverses_entry_id IS NULL
               AND l.expires_at <= ${now.toISOString()}::timestamptz
          ))
          OR (${customerProfiles.membershipStatus} = 'active'
              AND ${customerProfiles.birthMonthDay} IN (${birthday}))
        )`,
      ),
    )
    .orderBy(asc(customerProfiles.id))
    .limit(options.limit ?? 100);
  return rows.map((row) => row.id);
}

/**
 * Birthday bonus for one profile, once per year (UUIDv5 of profile and
 * year). True when a bonus row was written by this call.
 */
export async function grantBirthdayBonus(
  tx: Tx,
  tenantId: string,
  profileId: string,
  now: Date,
): Promise<boolean> {
  const tenant = tenantIdSchema.parse(tenantId);
  const profile = await withProfileLock(tx, tenantId, profileId);
  if (profile.membershipStatus !== "active") return false;
  if (
    profile.birthMonthDay === null ||
    !birthdayMonthDaysOf(now).includes(profile.birthMonthDay)
  )
    return false;
  if (profile.tierId === null) return false;
  const [program] = await tx
    .select({
      isActive: loyaltyPrograms.isActive,
      expiryMonths: loyaltyPrograms.expiryMonths,
    })
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenant))
    .limit(1);
  if (!program?.isActive) return false;
  if (!(await loyaltyConsentActive(tx, tenantId, profileId, now))) return false;
  const [tier] = await tx
    .select({
      benefits: loyaltyTiers.benefits,
      isActive: loyaltyTiers.isActive,
    })
    .from(loyaltyTiers)
    .where(
      and(
        eq(loyaltyTiers.tenantId, tenant),
        eq(loyaltyTiers.id, profile.tierId),
      ),
    )
    .limit(1);
  if (!tier?.isActive) return false;
  const points = tier.benefits.birthdayRewardPoints;
  if (points <= 0) return false;
  const date = businessDateOf(now, DAY_CLOCK);
  const result = await postLedgerEntry(
    tx,
    memberTenantContext(tenantId),
    {
      tenantId,
      customerProfileId: profileId,
      type: "bonus",
      points,
      sourceType: "birthday",
      sourceId: sourceUuid(`${profileId}:${date.slice(0, 4)}`),
      expiresAt: addMonthsUtc(now, program.expiryMonths),
      businessDate: date,
    },
    now,
  );
  return result.inserted;
}
