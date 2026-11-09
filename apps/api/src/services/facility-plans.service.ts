// Subscription plan list for the WFC and Wi-Fi screens (PRD v1.7 §25; bead
// legend-1cj0; contract `listSubscriptionPlans`). Admin plan writes live in
// facility-products.service.ts and the config read model returns every plan
// (staff); this read returns only the active ones, the plans a guest can
// start. Runs inside `withTenant` (RLS hides facilities of other outlets) and
// re-checks `facility.booth.operate` on the facility's outlet (TEN-03).
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import type { SubscriptionPlan } from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertFacilityPermission,
  loadFacility,
  OPERATE_PERMISSION,
} from "./facility-shared.ts";
import { listFacilitySubscriptionPlans } from "./facility-products.service.ts";

export async function listActiveSubscriptionPlans(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { facilityId: string },
): Promise<{ plans: SubscriptionPlan[] }> {
  const actor = userIdSchema.parse(actorUserId);
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, query.facilityId);
    await assertFacilityPermission(
      tx,
      context,
      actor,
      OPERATE_PERMISSION,
      facility.outletId,
    );
    const plans = await listFacilitySubscriptionPlans(
      tx,
      context.tenant.tenantId,
      facility.id,
    );
    return { plans: plans.filter((plan) => plan.isActive) };
  });
}
