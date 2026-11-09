// Reward redemption expiry sweep (legend-m4p5; docs/briefs/sub-290c-slices.md).
// A pending redemption past `expires_at` is settled by `expireDueRedemptions`:
// a voucher already used becomes `fulfilled`, any other becomes `expired` with
// points and stock restored. The sweep runs from the worker tick after 02:00
// Asia/Jakarta, once per tenant per day, in batches. A rerun finds nothing due
// and posts nothing.

import { businessDateOf, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { expireDueRedemptions } from "../services/reward-redemption.service.ts";

type Database = Parameters<typeof withTenant>[0];

const TIME_ZONE = "Asia/Jakarta";
/** Calendar day in Asia/Jakarta (cutoff 00:00). */
const DAY_CLOCK = { timeZone: TIME_ZONE, cutoff: "00:00" } as const;
/** The same clock with the 02:00 start: a different day means "before 02:00". */
const START_CLOCK = { timeZone: TIME_ZONE, cutoff: "02:00" } as const;

const BATCH_SIZE = 100;
/** Upper bound of batches per run; the next day's run takes the rest. */
const MAX_BATCHES = 50;

export type RedemptionExpiryResult = {
  businessDate: string;
  expired: number;
  fulfilled: number;
};

/** Asia/Jakarta calendar day, or null before 02:00 that day. */
export function redemptionExpiryDay(now: Date): string | null {
  const day = businessDateOf(now, DAY_CLOCK);
  return businessDateOf(now, START_CLOCK) === day ? day : null;
}

export async function runRedemptionExpiry(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
): Promise<RedemptionExpiryResult> {
  const businessDate = businessDateOf(now, DAY_CLOCK);
  let expired = 0;
  let fulfilled = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await withTenant(database, context, (tx) =>
      expireDueRedemptions(tx, context, now, BATCH_SIZE),
    );
    expired += result.expired;
    fulfilled += result.fulfilled;
    if (result.expired + result.fulfilled < BATCH_SIZE) break;
  }
  return { businessDate, expired, fulfilled };
}

const lastDayByTenant = new Map<string, string>();

/**
 * Worker sweep: runs `runRedemptionExpiry` once per tenant per Asia/Jakarta
 * day, after 02:00. A failed run is retried on the next tick.
 */
export async function runRedemptionExpirySweep(
  context: ScopedTenantContext,
  now: Date,
): Promise<RedemptionExpiryResult | null> {
  const day = redemptionExpiryDay(now);
  if (day === null) return null;
  const tenantId = context.tenant.tenantId;
  if (lastDayByTenant.get(tenantId) === day) return null;
  const result = await runRedemptionExpiry(db, context, now);
  lastDayByTenant.set(tenantId, day);
  return result;
}
