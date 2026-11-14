import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { EvalCase } from "./types.ts";

type CustomerEvalOptions = {
  tenantId: string;
  brandId?: string;
  outletId: string;
  creatorId: string;
  caseUsers?: ReadonlyMap<string, string>;
  entries: readonly EvalCase[];
};

// The eval clock is 2031-06-01 (ai-eval.test.ts NOW). Last visits are fixed
// dates: 2031-05-20 is within 30 days, 2031-04-15 is 47 days earlier.
const GOLD = 7;
const SILVER_RECENT = 2;
const SILVER_OLDER = 4;

/** Active member profiles in two loyalty tiers, enough per segment (>= the
 * minimum size) for the tier, recency and spend segment cases. Aggregates
 * only are ever read back. The caller owns the tenant-scoped transaction.
 */
export async function seedCustomerEval(
  client: PoolClient,
  options: CustomerEvalOptions,
): Promise<void> {
  const { tenantId, outletId } = options;
  const wanted = options.entries.some(
    (entry) =>
      entry.kind === "numeric" &&
      entry.expectTool?.name === "get_customer_segments" &&
      (options.caseUsers === undefined || options.caseUsers.has(entry.id)),
  );
  if (!wanted) return;

  const silverId = randomUUID();
  const goldId = randomUUID();
  for (const [id, name, rank] of [
    [silverId, "Silver", 1],
    [goldId, "Gold", 2],
  ] as const)
    await client.query(
      `INSERT INTO loyalty_tiers
         (id, tenant_id, name, rank, threshold_spend_idr, threshold_visits, benefits)
       VALUES ($1, $2, $3, $4, 0, 0, '{}'::jsonb)`,
      [id, tenantId, name, rank],
    );

  const profiles: {
    tierId: string;
    spend: number;
    visits: number;
    lastVisit: string;
  }[] = [];
  for (let i = 0; i < GOLD; i += 1)
    profiles.push({
      tierId: goldId,
      spend: 6_000_000 + i * 250_000,
      visits: 12 + i,
      lastVisit: "2031-05-20T03:00:00Z",
    });
  for (let i = 0; i < SILVER_RECENT + SILVER_OLDER; i += 1)
    profiles.push({
      tierId: silverId,
      spend: 2_000_000 + i * 100_000,
      visits: 5 + i,
      lastVisit:
        i < SILVER_RECENT ? "2031-05-25T03:00:00Z" : "2031-04-15T03:00:00Z",
    });

  for (const [index, profile] of profiles.entries())
    await client.query(
      `INSERT INTO customer_profiles
         (id, tenant_id, name, membership_status, whatsapp_verified_at,
          lifetime_spend_idr, visits_count, first_visit_at, last_visit_at,
          home_outlet_id, tier_id)
       VALUES ($1, $2, $3, 'active', '2031-01-01T00:00:00Z', $4, $5,
               '2031-01-02T03:00:00Z', $6, $7, $8)`,
      [
        randomUUID(),
        tenantId,
        `Pelanggan evaluasi ${index + 1}`,
        profile.spend,
        profile.visits,
        profile.lastVisit,
        outletId,
        profile.tierId,
      ],
    );
}
