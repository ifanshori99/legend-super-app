// Nightly loyalty balance check (legend-111j, LOY-02; docs/design/ws08-member-loyalty.md
// §M5). The database trigger keeps `customer_profiles.points_balance` equal to
// the sum of `point_ledger.points`; this job proves it. A profile whose two
// differ gets a `balance_mismatch` anomaly (outlet null), at most once per
// profile per Asia/Jakarta calendar day, so a rerun or a second worker writes
// nothing new. The sweep runs from the worker tick after 02:00 Asia/Jakarta,
// once per tenant per day.

import { sql } from "drizzle-orm";
import { businessDateOf, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordLoyaltyAnomaly } from "../services/loyalty-anomaly.service.ts";

type Database = Parameters<typeof withTenant>[0];

const TIME_ZONE = "Asia/Jakarta";
/** Calendar day in Asia/Jakarta (cutoff 00:00). */
const DAY_CLOCK = { timeZone: TIME_ZONE, cutoff: "00:00" } as const;
/** The same clock with the 02:00 start: a different day means "before 02:00". */
const START_CLOCK = { timeZone: TIME_ZONE, cutoff: "02:00" } as const;

export type LoyaltyBalanceCheckResult = {
  businessDate: string;
  mismatches: number;
  recorded: number;
};

/** Asia/Jakarta calendar day, or null before 02:00 that day. */
export function loyaltyBalanceCheckDay(now: Date): string | null {
  const day = businessDateOf(now, DAY_CLOCK);
  return businessDateOf(now, START_CLOCK) === day ? day : null;
}

export async function runLoyaltyBalanceCheck(
  database: Database,
  context: ScopedTenantContext,
  now: Date,
): Promise<LoyaltyBalanceCheckResult> {
  const tenantId = context.tenant.tenantId;
  const day = businessDateOf(now, DAY_CLOCK);
  return withTenant(database, context, async (tx) => {
    // The check and insert must share a cross-worker lock: two transactions
    // can otherwise both observe that today's anomaly has not been written.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loyalty-balance-check:${tenantId}:${day}`}, 0))`,
    );
    const result = await tx.execute(sql`
      SELECT p.id::text AS profile_id,
             p.points_balance::text AS balance,
             COALESCE(l.total, 0)::text AS ledger_sum
        FROM customer_profiles p
        LEFT JOIN (
          SELECT customer_profile_id, SUM(points) AS total
            FROM point_ledger
           WHERE tenant_id = ${tenantId}::uuid
           GROUP BY customer_profile_id
        ) l ON l.customer_profile_id = p.id
       WHERE p.tenant_id = ${tenantId}::uuid
         AND p.points_balance <> COALESCE(l.total, 0)
    `);
    let recorded = 0;
    for (const row of result.rows) {
      const profileId = String(row.profile_id);
      const seen = await tx.execute(sql`
        SELECT 1 FROM loyalty_anomalies
         WHERE tenant_id = ${tenantId}::uuid
           AND kind = 'balance_mismatch'
           AND customer_profile_id = ${profileId}::uuid
           AND business_date = ${day}::date
         LIMIT 1
      `);
      if (seen.rows.length > 0) continue;
      await recordLoyaltyAnomaly(tx, {
        tenantId,
        kind: "balance_mismatch",
        outletId: null,
        customerProfileId: profileId,
        businessDate: day,
        details: {
          pointsBalance: Number(row.balance),
          ledgerSum: Number(row.ledger_sum),
        },
      });
      recorded += 1;
    }
    return {
      businessDate: day,
      mismatches: result.rows.length,
      recorded,
    };
  });
}

const lastDayByTenant = new Map<string, string>();

/**
 * Worker sweep: runs `runLoyaltyBalanceCheck` once per tenant per Asia/Jakarta
 * day, after 02:00. A failed run is retried on the next tick.
 */
export async function runLoyaltyBalanceCheckSweep(
  context: ScopedTenantContext,
  now: Date,
): Promise<LoyaltyBalanceCheckResult | null> {
  const day = loyaltyBalanceCheckDay(now);
  if (day === null) return null;
  const tenantId = context.tenant.tenantId;
  if (lastDayByTenant.get(tenantId) === day) return null;
  const result = await runLoyaltyBalanceCheck(db, context, now);
  lastDayByTenant.set(tenantId, day);
  return result;
}
