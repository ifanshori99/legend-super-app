// Point expiry and birthday bonus (legend-3zd1, docs/design/ws08-member-loyalty.md
// §M5 B13, docs/briefs/sub-3zd1-slices.md potongan 3). Every ledger write goes
// through `postLedgerEntry` under `withProfileLock`; `points_balance` is never
// written here.
//
// Expiry: grants (earn, bonus, positive adjust without `reverses_entry_id`)
// are consumed oldest `expires_at` first by redeems, manual negative adjusts
// and reversals, replaying the ledger in `posting_seq` order so a redeem only
// uses grants that existed when it was posted (legend-w5by9); what is left
// past `expires_at` and not yet expired becomes one `expire` row per grant
// (`reverses_entry_id` = the grant). A rerun without new data writes nothing.

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
   * Grant points still alive after replaying the ledger in posting order:
   * minus what redemptions, reversals and expire rows took from it, plus what
   * restores gave back.
   */
  unused: number;
  expireRowCount: number;
};

/** One grant during the replay; `expiresAt` null never expires. */
type Lot = { id: string; expiresAt: Date | null; left: number };

/** Points one consuming row took from one lot. */
type Allocation = { lot: Lot; points: number };

/** FIFO order: earliest `expires_at` first (no expiry last), then id. */
function fifoOrder(a: Lot, b: Lot): number {
  const left = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const right = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left < right ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Grant states in FIFO order (`expires_at`, then id), from a replay of the
 * whole ledger in `posting_seq` order (legend-w5by9). A redemption or a
 * negative manual adjust only consumes grants that were already posted, oldest
 * `expires_at` first, and remembers which grants it took from; a restore of
 * that redemption gives the points back to those grants, latest-expiring
 * first. A reversal or expire row takes from its own grant; what it takes
 * beyond that grant's live points came out of the balance, so it consumes the
 * other live grants FIFO.
 */
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
    )
    .orderBy(asc(pointLedger.postingSeq));

  const lots = new Map<string, Lot>();
  /** All lots, kept in FIFO order. */
  const fifo: Lot[] = [];
  /** What each consuming row took, in the order it took it. */
  const taken = new Map<string, Allocation[]>();
  const expireRows = new Map<string, number>();

  const consume = (points: number): Allocation[] => {
    const allocations: Allocation[] = [];
    let rest = points;
    for (const lot of fifo) {
      if (rest <= 0) break;
      const take = Math.min(lot.left, rest);
      if (take <= 0) continue;
      lot.left -= take;
      rest -= take;
      allocations.push({ lot, points: take });
    }
    return allocations;
  };

  const takeFromGrant = (lot: Lot, points: number): void => {
    const own = Math.min(lot.left, points);
    lot.left -= own;
    consume(points - own);
  };

  for (const row of rows) {
    const isGrant =
      (row.type === "earn" ||
        row.type === "bonus" ||
        (row.type === "adjust" && row.points > 0)) &&
      row.reversesEntryId === null;
    if (isGrant) {
      const lot: Lot = {
        id: row.id,
        expiresAt: row.expiresAt,
        left: row.points,
      };
      lots.set(row.id, lot);
      const at = fifo.findIndex((other) => fifoOrder(lot, other) < 0);
      fifo.splice(at === -1 ? fifo.length : at, 0, lot);
      continue;
    }
    const target =
      row.reversesEntryId === null ? undefined : lots.get(row.reversesEntryId);
    if (row.type === "expire" && row.reversesEntryId !== null)
      expireRows.set(
        row.reversesEntryId,
        (expireRows.get(row.reversesEntryId) ?? 0) + 1,
      );
    if (row.points < 0) {
      const points = -row.points;
      if (target !== undefined) takeFromGrant(target, points);
      else taken.set(row.id, consume(points));
      continue;
    }
    // A restore: the points go back where the reversed row took them from.
    const allocations =
      row.reversesEntryId === null ? undefined : taken.get(row.reversesEntryId);
    if (allocations === undefined) continue;
    let rest = row.points;
    for (let index = allocations.length - 1; index >= 0 && rest > 0; index--) {
      const allocation = allocations[index]!;
      const back = Math.min(allocation.points, rest);
      allocation.points -= back;
      allocation.lot.left += back;
      rest -= back;
    }
  }

  return fifo
    .filter((lot) => lot.expiresAt !== null)
    .map((lot) => ({
      id: lot.id,
      expiresAt: lot.expiresAt!,
      unused: lot.left,
      expireRowCount: expireRows.get(lot.id) ?? 0,
    }));
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
