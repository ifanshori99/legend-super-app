// Tier multiplier step of the loyalty earn consumer (legend-111j,
// docs/design/ws08-member-loyalty.md §M6 step 8; tiers from legend-3zd1).

import { and, eq } from "drizzle-orm";
import type { TenantId } from "@starter/shared/core";
import { loyaltyTiers } from "../db/schema/crm-tiers.ts";
import type { EarnStepContext } from "./loyalty-earn-step-context.ts";

/** Basis points of the earn multiplier: 10 000 = 1x. */
const NEUTRAL_MULTIPLIER_BP = 10_000;

/**
 * The profile's tier multiplier. A profile without a tier, or whose tier is
 * missing or inactive, earns at 1x.
 */
export async function tierMultiplierBp(
  context: EarnStepContext,
): Promise<number> {
  const tierId = context.profile.tierId;
  if (tierId === null) return NEUTRAL_MULTIPLIER_BP;
  const [tier] = await context.tx
    .select({
      benefits: loyaltyTiers.benefits,
      isActive: loyaltyTiers.isActive,
    })
    .from(loyaltyTiers)
    .where(
      and(
        eq(loyaltyTiers.tenantId, context.tenantId as TenantId),
        eq(loyaltyTiers.id, tierId),
      ),
    )
    .limit(1);
  if (!tier || !tier.isActive) return NEUTRAL_MULTIPLIER_BP;
  return tier.benefits.pointsMultiplierBp;
}
