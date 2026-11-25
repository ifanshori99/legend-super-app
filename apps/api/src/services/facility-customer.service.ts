// Guest-facing facility reads (PRD v1.7 §3 F22/F25, §25; beads legend-zjfi,
// legend-humf; FAC-11). The catalog and the entry lookup are public: the tenant
// comes from the host (TEN-02), the caller is anonymous, and every row returned
// passes through an explicit allow-list mapper so staff configuration (overtime
// and cancellation rules, tax rule, device ids, provider plan ids, entitlement
// rules) cannot leak by adding a column to the config schema. Reads only: no
// audit entry.
//
// The entry token is the facility's public id: facilities and units have no QR
// token column yet. Anything that is not a UUID of this tenant answers the same
// 404 as an unknown facility.
import { and, asc, eq } from "drizzle-orm";
import { uuidSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  facilityCatalogSchema,
  facilityEntrySchema,
  type FacilityCatalog,
  type FacilityEntry,
  type PublicSubscriptionPlan,
  type SubscriptionPlan,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { facilityAreas } from "../db/schema/facility.ts";
import { withTenant } from "../db/tenant.ts";
import {
  loadFacility,
  notFound,
  outletTimeZone,
  type FacilityRow,
  type Tx,
} from "./facility-shared.ts";
import {
  listFacilityAddons,
  listFacilityProducts,
  listFacilitySubscriptionPlans,
} from "./facility-products.service.ts";
import { assertFacilityOpen } from "./facility-shower-gate.ts";

async function toPublicFacility(
  tx: Tx,
  context: ScopedTenantContext,
  row: FacilityRow,
) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sessionMinutes: row.sessionMinutes,
    operatingHours: row.operatingHours,
    outletId: row.outletId,
    timeZone: await outletTimeZone(tx, context, row.outletId),
  };
}

/** Allow-list of the plan fields a guest sees (no provider plan id, no scope). */
function toPublicPlan(plan: SubscriptionPlan): PublicSubscriptionPlan {
  return {
    id: plan.id,
    name: plan.name,
    priceIdr: plan.priceIdr,
    quotaPerPeriod: plan.quotaPerPeriod,
    interval: plan.interval,
    maxPerDay: plan.maxPerDay,
  };
}

/** Price board of one facility: active products, enabled add-ons, active plans. */
export async function getFacilityCatalog(
  context: ScopedTenantContext,
  query: { facilityId: string },
): Promise<FacilityCatalog> {
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, query.facilityId);
    assertFacilityOpen(facility);
    const tenantId = context.tenant.tenantId;
    const products = await listFacilityProducts(tx, tenantId, facility.id);
    const addons = await listFacilityAddons(tx, tenantId, facility.id);
    const plans = await listFacilitySubscriptionPlans(
      tx,
      tenantId,
      facility.id,
    );
    return facilityCatalogSchema.parse({
      facility: await toPublicFacility(tx, context, facility),
      products: products
        .filter((product) => product.isActive)
        .map((product) => ({
          id: product.id,
          name: product.name,
          type: product.type,
          priceIdr: product.priceIdr,
          sessions: product.sessions,
          maxPerDay: product.maxPerDay,
        })),
      addons: addons
        .filter((addon) => addon.isEnabled)
        .map((addon) => ({
          id: addon.id,
          name: addon.name,
          priceIdr: addon.priceIdr,
          sortOrder: addon.sortOrder,
        })),
      plans: plans.filter((plan) => plan.isActive).map(toPublicPlan),
    });
  });
}

/**
 * Active plans of one facility for the Wi-Fi portal and WFC screens (public,
 * same allow-list mapper as the catalog; contract `listSubscriptionPlans`).
 */
export async function listPublicSubscriptionPlans(
  context: ScopedTenantContext,
  query: { facilityId: string },
): Promise<{ plans: PublicSubscriptionPlan[] }> {
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, query.facilityId);
    assertFacilityOpen(facility);
    const plans = await listFacilitySubscriptionPlans(
      tx,
      context.tenant.tenantId,
      facility.id,
    );
    return { plans: plans.filter((plan) => plan.isActive).map(toPublicPlan) };
  });
}

/** Resolves a door/table QR token to its facility and area choices. */
export async function resolveFacilityEntry(
  context: ScopedTenantContext,
  token: string,
): Promise<FacilityEntry> {
  const id = uuidSchema.safeParse(token);
  if (!id.success) throw notFound("Fasilitas");
  return withTenant(db, context, async (tx) => {
    const facility = await loadFacility(tx, context, id.data);
    assertFacilityOpen(facility);
    const areas = await tx
      .select()
      .from(facilityAreas)
      .where(
        and(
          eq(facilityAreas.tenantId, context.tenant.tenantId),
          eq(facilityAreas.facilityId, facility.id),
        ),
      )
      .orderBy(asc(facilityAreas.sortOrder), asc(facilityAreas.name));
    return facilityEntrySchema.parse({
      facility: await toPublicFacility(tx, context, facility),
      areas: areas.map((area) => ({
        id: area.id,
        name: area.name,
        sortOrder: area.sortOrder,
      })),
    });
  });
}
